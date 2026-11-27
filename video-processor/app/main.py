from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .config import ProcessorSettings, get_settings, validate_runtime_settings
from .routes.captions import router as captions_router
from .routes.tts import router as tts_router
from .schemas import (
    HealthResponse,
    JobStatusResponse,
    SubtitleGenerationResponse,
    VideoMetadataResponse,
)
from .services.ffmpeg_service import (
    EXPORT_PROFILES,
    VideoProcessingCancelledError,
    VideoProcessingError,
    detect_hardware_h264_encoders,
    export_mp4,
    export_timeline_mp4,
    generate_thumbnail,
    merge_video_clips,
    normalize_encoding_mode,
    resize_crop_aspect_ratio,
    resolve_export_profile_spec,
    trim_video,
    validate_timeline_export_spec,
)
from .services.ffprobe_service import VideoMetadataError, check_binary, extract_video_metadata
from .services.job_store import job_store, sanitize_error_text
from .services.tts_providers.base import TtsCancelledError, TtsError
from .services.tts_service import get_tts_status
from .services.whisper_service import (
    CaptionsCancelledError,
    SubtitleGenerationError,
    is_faster_whisper_available,
    transcribe_video_subtitles,
    validate_subtitle_language,
)
from .utils.file_cleanup import (
    FileValidationError,
    cleanup_path,
    cleanup_stale_job_dirs,
    get_directory_size_bytes,
    managed_job_temp_dir,
    resolve_within_base,
    validate_upload_headers,
    validate_uploaded_file_magic,
    write_stream_with_limit,
)

logger = logging.getLogger("video_processor.app")

_CLIENT_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

_export_semaphore_lock = threading.Lock()
_export_semaphore_capacity: int = 0
_export_semaphore: Optional[threading.BoundedSemaphore] = None


def _get_export_semaphore(capacity: int) -> threading.BoundedSemaphore:
    global _export_semaphore_capacity, _export_semaphore
    with _export_semaphore_lock:
        if _export_semaphore is None or _export_semaphore_capacity != capacity:
            _export_semaphore_capacity = capacity
            _export_semaphore = threading.BoundedSemaphore(capacity)
        return _export_semaphore


def acquire_export_slot(settings: ProcessorSettings) -> threading.BoundedSemaphore:
    sem = _get_export_semaphore(settings.max_concurrent_exports)
    acquired = sem.acquire(timeout=settings.export_queue_wait_sec)
    if not acquired:
        raise VideoProcessingError(
            "Video processor export queue is busy. Please wait for the active export to finish.",
            status_code=429,
        )
    return sem


def assert_processor_key_matches(
    provided_key: Optional[str],
    settings: ProcessorSettings,
) -> bool:
    if settings.app_env == "production" and not settings.api_key:
        return False
    if not settings.api_key:
        return True
    if not provided_key:
        return False
    return hmac.compare_digest(provided_key.encode("utf-8"), settings.api_key.encode("utf-8"))


def check_temp_storage_quota(settings: ProcessorSettings) -> None:
    max_bytes = settings.max_temp_storage_mb * 1024 * 1024
    used_bytes = get_directory_size_bytes(settings.temp_dir)
    if used_bytes >= max_bytes:
        cleanup_stale_job_dirs(
            settings.temp_dir,
            max_age_sec=min(settings.temp_cleanup_max_age_sec, 300),
            active_job_ids=job_store.list_active_job_ids(),
        )
        used_bytes = get_directory_size_bytes(settings.temp_dir)
        if used_bytes >= max_bytes:
            raise VideoProcessingError(
                "Video processor temporary workspace is temporarily full. Retry once active jobs finish.",
                status_code=503,
            )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    config_errors = validate_runtime_settings(settings)
    if config_errors:
        for msg in config_errors:
            logger.error("Configuration error: %s", msg)
        raise RuntimeError("; ".join(config_errors))

    settings.temp_dir.mkdir(parents=True, exist_ok=True)
    cleanup_stale_job_dirs(
        settings.temp_dir,
        max_age_sec=settings.temp_cleanup_max_age_sec,
        active_job_ids=job_store.list_active_job_ids(),
    )

    stop_cleanup = asyncio.Event()

    async def _periodic_cleanup() -> None:
        while not stop_cleanup.is_set():
            try:
                await asyncio.wait_for(stop_cleanup.wait(), timeout=600.0)
                break
            except asyncio.TimeoutError:
                cur_settings = get_settings()
                cleanup_stale_job_dirs(
                    cur_settings.temp_dir,
                    max_age_sec=cur_settings.temp_cleanup_max_age_sec,
                    active_job_ids=job_store.list_active_job_ids(),
                )

    cleanup_task = asyncio.create_task(_periodic_cleanup())
    try:
        yield
    finally:
        stop_cleanup.set()
        cleanup_task.cancel()
        await asyncio.gather(cleanup_task, return_exceptions=True)
        job_store.terminate_all_active("Video processor shutting down cleanly.")
        cleanup_stale_job_dirs(
            settings.temp_dir,
            max_age_sec=0,
            active_job_ids=job_store.list_active_job_ids(),
        )


app = FastAPI(
    title="AI Studio Local Video Processor",
    description="Free local Python FastAPI microservice powered by FFmpeg, FFprobe, and faster-whisper.",
    version="0.2.0",
    lifespan=lifespan,
)


app.include_router(tts_router)
app.include_router(captions_router)


@app.middleware("http")
async def pre_register_export_job_middleware(request: Request, call_next):
    if request.method == "POST" and request.url.path in (
        "/api/v1/export-mp4",
        "/api/v1/tts/generate",
        "/api/v1/captions/generate",
    ):
        settings = get_settings()
        provided_key = request.headers.get("x-processor-key")
        if assert_processor_key_matches(provided_key, settings):
            if request.url.path == "/api/v1/tts/generate":
                raw_header_id = (request.headers.get("x-tts-job-id") or "").strip()
                op_name = "tts_generate"
                stage_label = "Preparing voiceover synthesis"
            elif request.url.path == "/api/v1/captions/generate":
                raw_header_id = (request.headers.get("x-captions-job-id") or "").strip()
                op_name = "captions_generate"
                stage_label = "Preparing voiceover transcription"
            else:
                raw_header_id = (request.headers.get("x-export-job-id") or "").strip()
                op_name = "export_mp4"
                stage_label = "Receiving uploaded media"
            if _CLIENT_JOB_ID_RE.match(raw_header_id):
                job_store.create(
                    raw_header_id,
                    operation=op_name,
                    stage="uploading",
                    stage_label=stage_label,
                    measurable=False,
                    if_missing=True,
                )
    return await call_next(request)


def verify_processor_key(
    x_processor_key: Optional[str] = Header(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> None:
    if settings.app_env == "production" and not settings.api_key:
        raise HTTPException(
            status_code=503,
            detail="Processor API key is not configured for production mode.",
        )
    if not assert_processor_key_matches(x_processor_key, settings):
        raise HTTPException(status_code=401, detail="Invalid or missing processor API key.")


@app.exception_handler(FileValidationError)
async def handle_file_validation_error(_request, exc: FileValidationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": sanitize_error_text(str(exc))})


@app.exception_handler(VideoMetadataError)
async def handle_metadata_error(_request, exc: VideoMetadataError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": sanitize_error_text(str(exc))})


@app.exception_handler(VideoProcessingCancelledError)
async def handle_cancelled_error(_request, exc: VideoProcessingCancelledError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": sanitize_error_text(str(exc), "Export cancelled by user."), "cancelled": True},
    )


@app.exception_handler(VideoProcessingError)
async def handle_processing_error(_request, exc: VideoProcessingError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": sanitize_error_text(str(exc))})


@app.exception_handler(CaptionsCancelledError)
async def handle_captions_cancelled_error(_request, exc: CaptionsCancelledError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": sanitize_error_text(str(exc), "Audio caption transcription cancelled."), "cancelled": True},
    )


@app.exception_handler(SubtitleGenerationError)
async def handle_subtitle_error(_request, exc: SubtitleGenerationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": sanitize_error_text(str(exc))})


@app.exception_handler(TtsCancelledError)
async def handle_tts_cancelled_error(_request, exc: TtsCancelledError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": sanitize_error_text(str(exc), "Voiceover synthesis cancelled."), "cancelled": True},
    )


@app.exception_handler(TtsError)
async def handle_tts_error(_request, exc: TtsError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": sanitize_error_text(str(exc)), "code": exc.code},
    )


@app.get("/health", response_model=HealthResponse)
def health(settings: ProcessorSettings = Depends(get_settings)) -> HealthResponse:
    ffmpeg_path = check_binary(settings.ffmpeg_bin)
    ffprobe_path = check_binary(settings.ffprobe_bin)
    whisper_ok = is_faster_whisper_available()
    tts_status = get_tts_status(settings)
    tts_providers = [
        str(p["provider"])
        for p in tts_status.get("providers", [])
        if isinstance(p, dict) and p.get("available")
    ]
    ready = bool(ffmpeg_path and ffprobe_path)
    hw_caps = (
        detect_hardware_h264_encoders(settings.ffmpeg_bin)
        if ffmpeg_path
        else {
            "available_hardware_encoders": [],
            "recommended_encoder": "libx264",
            "encoders": {},
        }
    )
    return HealthResponse(
        status="ok" if ready else "degraded",
        ffmpeg_available=bool(ffmpeg_path),
        ffprobe_available=bool(ffprobe_path),
        faster_whisper_available=whisper_ok,
        ffmpeg_path=None,
        ffprobe_path=None,
        hardware_encoders=list(hw_caps.get("available_hardware_encoders") or []),  # type: ignore[arg-type]
        recommended_encoder=str(hw_caps.get("recommended_encoder") or "libx264"),
        encoder_capabilities=dict(hw_caps.get("encoders") or {}),  # type: ignore[arg-type]
        export_profiles=EXPORT_PROFILES,
        tts_available=bool(tts_status.get("available")),
        tts_providers=tts_providers,
    )


@app.get(
    "/api/v1/jobs/{job_id}",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_processor_key)],
)
def get_job_status(job_id: str) -> JobStatusResponse:
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Processing job not found.")
    return JobStatusResponse(**job)


@app.post(
    "/api/v1/jobs/{job_id}/cancel",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_processor_key)],
)
def cancel_job(
    job_id: str,
    allow_precreate: bool = Query(default=False),
) -> JobStatusResponse:
    safe_allow_precreate = bool(allow_precreate and _CLIENT_JOB_ID_RE.match(job_id))
    job = job_store.request_cancel(job_id, allow_precreate=safe_allow_precreate)
    if not job:
        raise HTTPException(status_code=404, detail="Processing job not found.")
    return JobStatusResponse(**job)


def _prepare_job_dir(settings: ProcessorSettings, job_id: str) -> Path:
    safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", job_id)[:64] or "job"
    job_dir = resolve_within_base(settings.temp_dir, settings.temp_dir / f"job_{safe_job_id}")
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


async def _save_single_upload(
    file: UploadFile,
    dest_dir: Path,
    max_bytes: int,
    prefix: str = "input_",
    allow_audio: bool = False,
    allow_images: bool = False,
) -> tuple[str, Path]:
    safe_name = validate_upload_headers(
        file.filename,
        file.content_type,
        allow_audio=allow_audio,
        allow_images=allow_images,
    )
    target_path = resolve_within_base(dest_dir, dest_dir / f"{prefix}{safe_name}")
    file.file.seek(0)
    write_stream_with_limit(file.file, target_path, max_bytes)
    try:
        validate_uploaded_file_magic(
            target_path,
            original_filename=safe_name,
            allow_audio=allow_audio,
            allow_images=allow_images,
        )
    except Exception:
        cleanup_path(target_path)
        raise
    return safe_name, target_path


@app.post(
    "/api/v1/metadata",
    response_model=VideoMetadataResponse,
    dependencies=[Depends(verify_processor_key)],
)
async def extract_metadata_endpoint(
    file: UploadFile = File(...),
    settings: ProcessorSettings = Depends(get_settings),
) -> VideoMetadataResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="metadata_extraction")

    try:
        check_temp_storage_quota(settings)
        safe_name = validate_upload_headers(file.filename, file.content_type)
        job_store.update(job_id, status="processing", progress=25)

        with managed_job_temp_dir(settings.temp_dir, job_id) as temp_dir:
            target_path = resolve_within_base(temp_dir, temp_dir / safe_name)
            file.file.seek(0)
            write_stream_with_limit(file.file, target_path, settings.max_upload_bytes)
            validate_uploaded_file_magic(
                target_path,
                original_filename=safe_name,
                allow_audio=False,
                allow_images=False,
            )
            job_store.update(job_id, progress=60)

            metadata = extract_video_metadata(
                target_path,
                original_filename=safe_name,
                ffprobe_bin=settings.ffprobe_bin,
                timeout_sec=settings.ffprobe_timeout_sec,
            )

        job_store.update(job_id, status="completed", progress=100, result=metadata)
        return VideoMetadataResponse(status="completed", job_id=job_id, metadata=metadata)

    except (FileValidationError, VideoMetadataError, VideoProcessingError) as exc:
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    except Exception as exc:
        logger.exception("Unexpected metadata extraction error: %s", exc)
        job_store.update(job_id, status="failed", progress=100, error="Unexpected metadata extraction error.")
        raise HTTPException(status_code=500, detail="Unexpected error inspecting uploaded video.") from exc
    finally:
        await file.close()


@app.post(
    "/api/v1/thumbnail",
    dependencies=[Depends(verify_processor_key)],
)
async def thumbnail_endpoint(
    file: UploadFile = File(...),
    timestamp_sec: float = Form(default=0.5),
    width: int = Form(default=640),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="thumbnail")
    job_dir = _prepare_job_dir(settings, job_id)

    try:
        check_temp_storage_quota(settings)
        job_store.update(job_id, status="processing", progress=20)
        safe_name, input_path = await _save_single_upload(
            file, job_dir, settings.max_upload_bytes
        )
        output_path = job_dir / "thumbnail.jpg"
        info = generate_thumbnail(
            input_path,
            output_path,
            timestamp_sec=timestamp_sec,
            width=width,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            timeout_sec=settings.ffmpeg_timeout_sec,
            max_duration_sec=settings.max_short_video_sec,
        )
        job_store.update(job_id, status="completed", progress=100, result=info)
        return FileResponse(
            path=output_path,
            media_type="image/jpeg",
            filename=f"{Path(safe_name).stem}_thumb.jpg",
            headers={"X-Processor-Job-Id": job_id},
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except Exception as exc:
        cleanup_path(job_dir)
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    finally:
        await file.close()


@app.post(
    "/api/v1/trim",
    dependencies=[Depends(verify_processor_key)],
)
async def trim_endpoint(
    file: UploadFile = File(...),
    start_sec: float = Form(...),
    end_sec: float = Form(...),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="trim")
    job_dir = _prepare_job_dir(settings, job_id)

    try:
        check_temp_storage_quota(settings)
        job_store.update(job_id, status="processing", progress=20)
        safe_name, input_path = await _save_single_upload(
            file, job_dir, settings.max_upload_bytes
        )
        output_path = job_dir / f"{Path(safe_name).stem}_trimmed.mp4"
        out_meta = trim_video(
            input_path,
            output_path,
            start_sec=start_sec,
            end_sec=end_sec,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            timeout_sec=settings.ffmpeg_timeout_sec,
            max_duration_sec=settings.max_short_video_sec,
        )
        job_store.update(job_id, status="completed", progress=100, result=out_meta)
        return FileResponse(
            path=output_path,
            media_type="video/mp4",
            filename=output_path.name,
            headers={"X-Processor-Job-Id": job_id},
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except Exception as exc:
        cleanup_path(job_dir)
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    finally:
        await file.close()


@app.post(
    "/api/v1/aspect-ratio",
    dependencies=[Depends(verify_processor_key)],
)
async def aspect_ratio_endpoint(
    file: UploadFile = File(...),
    aspect_ratio: Optional[Literal["16:9", "9:16", "1:1"]] = Form(default=None),
    target_width: Optional[int] = Form(default=None),
    target_height: Optional[int] = Form(default=None),
    fit_mode: Literal["crop", "pad"] = Form(default="crop"),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="aspect_ratio")
    job_dir = _prepare_job_dir(settings, job_id)

    try:
        check_temp_storage_quota(settings)
        job_store.update(job_id, status="processing", progress=20)
        safe_name, input_path = await _save_single_upload(
            file, job_dir, settings.max_upload_bytes
        )
        output_path = job_dir / f"{Path(safe_name).stem}_formatted.mp4"
        out_meta = resize_crop_aspect_ratio(
            input_path,
            output_path,
            aspect_ratio=aspect_ratio,
            target_width=target_width,
            target_height=target_height,
            fit_mode=fit_mode,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            timeout_sec=settings.ffmpeg_timeout_sec,
            max_duration_sec=settings.max_short_video_sec,
        )
        job_store.update(job_id, status="completed", progress=100, result=out_meta)
        return FileResponse(
            path=output_path,
            media_type="video/mp4",
            filename=output_path.name,
            headers={"X-Processor-Job-Id": job_id},
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except Exception as exc:
        cleanup_path(job_dir)
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    finally:
        await file.close()


@app.post(
    "/api/v1/merge",
    dependencies=[Depends(verify_processor_key)],
)
async def merge_endpoint(
    files: list[UploadFile] = File(...),
    target_width: int = Form(default=1280),
    target_height: int = Form(default=720),
    fps: int = Form(default=30),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="merge")
    job_dir = _prepare_job_dir(settings, job_id)

    try:
        check_temp_storage_quota(settings)
        job_store.update(job_id, status="processing", progress=20)
        input_paths: list[Path] = []
        for idx, upload in enumerate(files):
            _, saved = await _save_single_upload(
                upload, job_dir, settings.max_upload_bytes, prefix=f"clip_{idx}_"
            )
            input_paths.append(saved)

        output_path = job_dir / "merged_output.mp4"
        out_meta = merge_video_clips(
            input_paths,
            output_path,
            target_width=target_width,
            target_height=target_height,
            fps=fps,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            timeout_sec=settings.ffmpeg_timeout_sec,
            max_total_duration_sec=settings.max_short_video_sec,
        )
        job_store.update(job_id, status="completed", progress=100, result=out_meta)
        return FileResponse(
            path=output_path,
            media_type="video/mp4",
            filename="merged_output.mp4",
            headers={"X-Processor-Job-Id": job_id},
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except Exception as exc:
        cleanup_path(job_dir)
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    finally:
        for upload in files:
            await upload.close()


@app.post(
    "/api/v1/export-mp4",
    dependencies=[Depends(verify_processor_key)],
)
async def export_mp4_endpoint(
    request: Request,
    file: Optional[UploadFile] = File(default=None),
    files: Optional[list[UploadFile]] = File(default=None),
    resolution: Literal["720p", "1080p"] = Form(default="720p"),
    fps: int = Form(default=30),
    aspect_ratio: Optional[Literal["16:9", "9:16", "1:1"]] = Form(default=None),
    aspect_ratio_camel: Optional[Literal["16:9", "9:16", "1:1"]] = Form(default=None, alias="aspectRatio"),
    export_profile: Optional[str] = Form(default=None),
    export_profile_camel: Optional[str] = Form(default=None, alias="exportProfile"),
    encoding_mode: Optional[str] = Form(default=None),
    encoding_mode_camel: Optional[str] = Form(default=None, alias="encodingMode"),
    timeline_spec: Optional[str] = Form(default=None),
    timeline_spec_camel: Optional[str] = Form(default=None, alias="timelineSpec"),
    client_job_id: Optional[str] = Form(default=None),
    client_job_id_camel: Optional[str] = Form(default=None, alias="clientJobId"),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    uploads = [*(files or []), *([file] if file is not None else [])]
    eff_aspect_ratio = aspect_ratio or aspect_ratio_camel
    raw_profile = export_profile if export_profile is not None else export_profile_camel
    raw_enc_mode = encoding_mode if encoding_mode is not None else encoding_mode_camel
    raw_spec = timeline_spec if timeline_spec is not None else timeline_spec_camel
    raw_cid = (client_job_id or client_job_id_camel or "").strip()

    try:
        if not uploads:
            raise FileValidationError(
                'Upload at least one video file using form field "files" or "file".',
                status_code=400,
            )

        check_temp_storage_quota(settings)

        eff_profile_id, eff_profile_resolution, _ = resolve_export_profile_spec(
            raw_profile,
            resolution,
        )
        eff_encoding_mode = normalize_encoding_mode(raw_enc_mode)
        eff_resolution = eff_profile_resolution if eff_profile_id is not None else resolution

        for upload in uploads:
            validate_upload_headers(
                upload.filename,
                upload.content_type,
                allow_audio=True,
                allow_images=True,
            )

        parsed_spec: dict | None = None
        if raw_spec is not None:
            if not raw_spec.strip():
                raise VideoProcessingError("timeline_spec cannot be empty when provided.", status_code=400)
            try:
                loaded = json.loads(raw_spec)
            except json.JSONDecodeError as exc:
                raise VideoProcessingError(
                    "Invalid timeline_spec JSON payload.",
                    status_code=400,
                ) from exc
            if not isinstance(loaded, dict):
                raise VideoProcessingError(
                    "timeline_spec must be a JSON object.",
                    status_code=400,
                )
            validate_timeline_export_spec(
                loaded,
                num_files=len(uploads),
                resolution=eff_resolution,
                fps=fps,
                aspect_ratio=eff_aspect_ratio,
            )
            parsed_spec = loaded
    except Exception:
        for upload in uploads:
            await upload.close()
        raise

    raw_header_cid = (request.headers.get("x-export-job-id") or "").strip()
    eff_raw_cid = raw_cid or raw_header_cid
    job_id = eff_raw_cid if _CLIENT_JOB_ID_RE.match(eff_raw_cid) else uuid.uuid4().hex
    job_store.create(
        job_id,
        operation="export_mp4",
        stage="uploading",
        stage_label="Receiving uploaded media",
        measurable=False,
        if_missing=True,
    )
    job_dir = _prepare_job_dir(settings, job_id)
    job_store.register_job_dir(job_id, job_dir)
    cancel_event = job_store.get_cancel_event(job_id)
    disconnect_task: Optional[asyncio.Task[None]] = None
    acquired_semaphore: Optional[threading.BoundedSemaphore] = None

    async def _watch_client_disconnect() -> None:
        try:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    return
                if await request.is_disconnected():
                    job_store.request_cancel(job_id)
                    return
                await asyncio.sleep(0.15)
        except asyncio.CancelledError:
            return
        except Exception:
            return

    try:
        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            raise VideoProcessingCancelledError()

        acquired_semaphore = await run_in_threadpool(acquire_export_slot, settings)

        client_host = getattr(request.client, "host", None)
        if client_host and client_host != "testclient":
            disconnect_task = asyncio.create_task(_watch_client_disconnect())

        job_store.update(
            job_id,
            status="processing",
            progress=5,
            stage="uploading",
            stage_label="Staging uploaded media",
            measurable=False,
        )
        saved_paths: list[Path] = []
        first_stem = "sequence"
        for idx, upload in enumerate(uploads):
            if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
                raise VideoProcessingCancelledError()
            safe_name, saved_path = await _save_single_upload(
                upload,
                job_dir,
                settings.max_upload_bytes,
                prefix=f"clip_{idx}_",
                allow_audio=True,
                allow_images=True,
            )
            if idx == 0:
                first_stem = Path(safe_name).stem or "sequence"
            saved_paths.append(saved_path)

        project_name = (
            str((parsed_spec or {}).get("project", {}).get("name") or "").strip()
            if isinstance((parsed_spec or {}).get("project"), dict)
            else ""
        )
        safe_project_stem = (
            "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in project_name).strip("_")
            or first_stem
        )
        output_path = job_dir / f"{safe_project_stem}_export.mp4"

        def _on_stage_progress(stage: str, label: str, pct: int, measurable: bool) -> None:
            job_store.update(
                job_id,
                status="processing",
                progress=pct,
                stage=stage,
                stage_label=label,
                measurable=measurable,
            )

        def _on_process_attach(proc) -> None:
            job_store.attach_process(job_id, proc)

        def _run_export_worker() -> dict:
            job_store.mark_worker_started(job_id)
            try:
                return export_timeline_mp4(
                    saved_paths,
                    output_path,
                    timeline_spec=parsed_spec,
                    resolution=eff_resolution,
                    fps=fps,
                    aspect_ratio=eff_aspect_ratio,
                    export_profile=eff_profile_id,
                    encoding_mode=eff_encoding_mode,
                    ffmpeg_bin=settings.ffmpeg_bin,
                    ffprobe_bin=settings.ffprobe_bin,
                    timeout_sec=settings.ffmpeg_timeout_sec,
                    max_duration_sec=settings.max_short_video_sec,
                    progress_cb=_on_stage_progress,
                    cancel_event=cancel_event,
                    process_cb=_on_process_attach,
                )
            finally:
                job_store.mark_worker_finished(job_id)

        out_meta = await run_in_threadpool(_run_export_worker)

        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            raise VideoProcessingCancelledError()

        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
            disconnect_task = None

        job_store.update(
            job_id,
            status="completed",
            progress=100,
            stage="completed",
            stage_label="Export complete",
            measurable=True,
            result=out_meta,
        )
        return FileResponse(
            path=output_path,
            media_type="video/mp4",
            filename=output_path.name,
            headers={
                "X-Processor-Job-Id": job_id,
                "X-Export-Profile": str(out_meta.get("export_profile") or eff_profile_id or "legacy"),
                "X-Export-Encoder": str(out_meta.get("encoder_used") or "libx264"),
                "X-Export-Fallback": "1" if out_meta.get("hardware_fallback_used") else "0",
            },
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except VideoProcessingCancelledError as exc:
        job_store.mark_worker_finished(job_id)
        cleanup_path(job_dir)
        job_store.update(
            job_id,
            status="cancelled",
            cancelled=True,
            stage="cancelled",
            stage_label="Export cancelled",
            measurable=False,
            error=str(exc),
        )
        raise
    except Exception as exc:
        job_store.mark_worker_finished(job_id)
        cleanup_path(job_dir)
        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            cancel_exc = VideoProcessingCancelledError()
            job_store.update(
                job_id,
                status="cancelled",
                cancelled=True,
                stage="cancelled",
                stage_label="Export cancelled",
                measurable=False,
                error=str(cancel_exc),
            )
            raise cancel_exc from exc
        job_store.update(
            job_id,
            status="failed",
            progress=100,
            stage="failed",
            stage_label="Export failed",
            measurable=False,
            error=str(exc),
        )
        raise
    finally:
        if acquired_semaphore is not None:
            acquired_semaphore.release()
        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
        for upload in uploads:
            await upload.close()


@app.post(
    "/api/v1/subtitles",
    response_model=SubtitleGenerationResponse,
    dependencies=[Depends(verify_processor_key)],
)
async def subtitles_endpoint(
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> SubtitleGenerationResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="subtitles")

    try:
        check_temp_storage_quota(settings)
        normalized_language = validate_subtitle_language(language)
        safe_name = validate_upload_headers(file.filename, file.content_type)
        job_store.update(job_id, status="processing", progress=20)

        with managed_job_temp_dir(settings.temp_dir, job_id) as temp_dir:
            input_path = resolve_within_base(temp_dir, temp_dir / safe_name)
            file.file.seek(0)
            write_stream_with_limit(file.file, input_path, settings.max_upload_bytes)
            validate_uploaded_file_magic(
                input_path,
                original_filename=safe_name,
                allow_audio=True,
                allow_images=False,
            )
            job_store.update(job_id, progress=50)

            result = transcribe_video_subtitles(
                input_path,
                temp_dir,
                language=normalized_language,
                model_size=settings.whisper_model_size,
                device=settings.whisper_device,
                compute_type=settings.whisper_compute_type,
                ffmpeg_bin=settings.ffmpeg_bin,
                ffprobe_bin=settings.ffprobe_bin,
                max_duration_sec=settings.max_short_video_sec,
            )

        job_store.update(job_id, status="completed", progress=100, result=result)
        return SubtitleGenerationResponse(status="completed", job_id=job_id, **result)

    except (FileValidationError, VideoMetadataError, SubtitleGenerationError, VideoProcessingError) as exc:
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    except Exception as exc:
        logger.exception("Unexpected subtitle generation error: %s", exc)
        job_store.update(job_id, status="failed", progress=100, error="Unexpected subtitle generation error.")
        raise HTTPException(status_code=500, detail="Subtitle generation failed unexpectedly.") from exc
    finally:
        await file.close()
