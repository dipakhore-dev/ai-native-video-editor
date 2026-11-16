from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from .config import ProcessorSettings, get_settings
from .schemas import (
    HealthResponse,
    JobStatusResponse,
    SubtitleGenerationResponse,
    VideoMetadataResponse,
)
from .services.ffmpeg_service import (
    VideoProcessingError,
    export_mp4,
    export_timeline_mp4,
    generate_thumbnail,
    merge_video_clips,
    resize_crop_aspect_ratio,
    trim_video,
)
from .services.ffprobe_service import VideoMetadataError, check_binary, extract_video_metadata
from .services.job_store import job_store
from .services.whisper_service import (
    SubtitleGenerationError,
    is_faster_whisper_available,
    transcribe_video_subtitles,
    validate_subtitle_language,
)
from .utils.file_cleanup import (
    FileValidationError,
    cleanup_path,
    managed_job_temp_dir,
    validate_upload_headers,
    write_stream_with_limit,
)

app = FastAPI(
    title="AI Studio Local Video Processor",
    description="Free local Python FastAPI microservice powered by FFmpeg, FFprobe, and faster-whisper.",
    version="0.2.0",
)


def verify_processor_key(
    x_processor_key: Optional[str] = Header(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> None:
    if settings.api_key and x_processor_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing processor API key.")


@app.exception_handler(FileValidationError)
async def handle_file_validation_error(_request, exc: FileValidationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc)})


@app.exception_handler(VideoMetadataError)
async def handle_metadata_error(_request, exc: VideoMetadataError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc)})


@app.exception_handler(VideoProcessingError)
async def handle_processing_error(_request, exc: VideoProcessingError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc)})


@app.exception_handler(SubtitleGenerationError)
async def handle_subtitle_error(_request, exc: SubtitleGenerationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc)})


@app.get("/health", response_model=HealthResponse)
def health(settings: ProcessorSettings = Depends(get_settings)) -> HealthResponse:
    ffmpeg_path = check_binary(settings.ffmpeg_bin)
    ffprobe_path = check_binary(settings.ffprobe_bin)
    whisper_ok = is_faster_whisper_available()
    ready = bool(ffmpeg_path and ffprobe_path)
    return HealthResponse(
        status="ok" if ready else "degraded",
        ffmpeg_available=bool(ffmpeg_path),
        ffprobe_available=bool(ffprobe_path),
        faster_whisper_available=whisper_ok,
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
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


def _prepare_job_dir(settings: ProcessorSettings, job_id: str) -> Path:
    job_dir = settings.temp_dir / f"job_{job_id}"
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
    target_path = dest_dir / f"{prefix}{safe_name}"
    file.file.seek(0)
    write_stream_with_limit(file.file, target_path, max_bytes)
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
        safe_name = validate_upload_headers(file.filename, file.content_type)
        job_store.update(job_id, status="processing", progress=25)

        with managed_job_temp_dir(settings.temp_dir, job_id) as temp_dir:
            target_path = temp_dir / safe_name
            file.file.seek(0)
            write_stream_with_limit(file.file, target_path, settings.max_upload_bytes)
            job_store.update(job_id, progress=60)

            metadata = extract_video_metadata(
                target_path,
                original_filename=safe_name,
                ffprobe_bin=settings.ffprobe_bin,
                timeout_sec=settings.ffprobe_timeout_sec,
            )

        job_store.update(job_id, status="completed", progress=100, result=metadata)
        return VideoMetadataResponse(status="completed", job_id=job_id, metadata=metadata)

    except (FileValidationError, VideoMetadataError) as exc:
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    except Exception as exc:
        job_store.update(job_id, status="failed", progress=100, error="Unexpected metadata extraction error.")
        raise HTTPException(status_code=500, detail=f"Unexpected error inspecting video: {exc}") from exc
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
    file: Optional[UploadFile] = File(default=None),
    files: Optional[list[UploadFile]] = File(default=None),
    resolution: Literal["720p", "1080p"] = Form(default="720p"),
    fps: int = Form(default=30),
    aspect_ratio: Optional[Literal["16:9", "9:16", "1:1"]] = Form(default=None),
    timeline_spec: Optional[str] = Form(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    job_id = uuid.uuid4().hex
    job_store.create(job_id, operation="export_mp4")
    job_dir = _prepare_job_dir(settings, job_id)
    uploads = [*(files or []), *([file] if file is not None else [])]

    try:
        if not uploads:
            raise FileValidationError(
                'Upload at least one video file using form field "files" or "file".',
                status_code=400,
            )

        parsed_spec: dict | None = None
        if timeline_spec and timeline_spec.strip():
            try:
                loaded = json.loads(timeline_spec)
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
            parsed_spec = loaded

        job_store.update(job_id, status="processing", progress=20)
        saved_paths: list[Path] = []
        first_stem = "sequence"
        for idx, upload in enumerate(uploads):
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

        out_meta = export_timeline_mp4(
            saved_paths,
            output_path,
            timeline_spec=parsed_spec,
            resolution=resolution,
            fps=fps,
            aspect_ratio=aspect_ratio,
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
        normalized_language = validate_subtitle_language(language)
        safe_name = validate_upload_headers(file.filename, file.content_type)
        job_store.update(job_id, status="processing", progress=20)

        with managed_job_temp_dir(settings.temp_dir, job_id) as temp_dir:
            input_path = temp_dir / safe_name
            file.file.seek(0)
            write_stream_with_limit(file.file, input_path, settings.max_upload_bytes)
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

    except (FileValidationError, VideoMetadataError, SubtitleGenerationError) as exc:
        job_store.update(job_id, status="failed", progress=100, error=str(exc))
        raise
    except Exception as exc:
        job_store.update(job_id, status="failed", progress=100, error="Unexpected subtitle generation error.")
        raise HTTPException(status_code=500, detail=f"Subtitle generation failed: {exc}") from exc
    finally:
        await file.close()
