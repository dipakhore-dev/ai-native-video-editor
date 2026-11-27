from __future__ import annotations

import asyncio
import hmac
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from ..config import ProcessorSettings, get_settings
from ..schemas import (
    AudioCaptionsGenerateResponse,
    AudioCaptionsStatusResponse,
    JobStatusResponse,
)
from ..services.ffprobe_service import VideoMetadataError
from ..services.job_store import job_store
from ..services.whisper_service import (
    CaptionsCancelledError,
    SubtitleGenerationError,
    get_captions_runtime_status,
    transcribe_audio_captions,
    validate_subtitle_language,
)
from ..utils.file_cleanup import (
    ALLOWED_AUDIO_EXTENSIONS,
    FileValidationError,
    cleanup_path,
    cleanup_stale_job_dirs,
    get_directory_size_bytes,
    resolve_within_base,
    sanitize_filename,
    validate_upload_headers,
    validate_uploaded_file_magic,
    write_stream_with_limit,
)

router = APIRouter(prefix="/api/v1/captions", tags=["captions"])

_CLIENT_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _assert_key_matches(provided_key: Optional[str], settings: ProcessorSettings) -> bool:
    if settings.app_env == "production" and not settings.api_key:
        return False
    if not settings.api_key:
        return True
    if not provided_key:
        return False
    return hmac.compare_digest(provided_key.encode("utf-8"), settings.api_key.encode("utf-8"))


def verify_captions_processor_key(
    x_processor_key: Optional[str] = Header(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> None:
    if settings.app_env == "production" and not settings.api_key:
        raise HTTPException(
            status_code=503,
            detail="Processor API key is not configured for production mode.",
        )
    if not _assert_key_matches(x_processor_key, settings):
        raise HTTPException(status_code=401, detail="Invalid or missing processor API key.")


def _check_captions_temp_quota(settings: ProcessorSettings) -> None:
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
            raise SubtitleGenerationError(
                "Video processor temporary workspace is temporarily full. Retry once active jobs finish.",
                status_code=503,
            )


def _prepare_captions_job_dir(settings: ProcessorSettings, job_id: str) -> Path:
    safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", job_id)[:64] or "cap"
    job_dir = resolve_within_base(settings.temp_dir, settings.temp_dir / f"job_{safe_job_id}")
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


@router.get(
    "/status",
    response_model=AudioCaptionsStatusResponse,
    dependencies=[Depends(verify_captions_processor_key)],
)
def captions_status_endpoint(
    settings: ProcessorSettings = Depends(get_settings),
) -> AudioCaptionsStatusResponse:
    status_payload = get_captions_runtime_status(
        model_size=settings.whisper_model_size,
        device=settings.whisper_device,
        compute_type=settings.whisper_compute_type,
        local_files_only=settings.whisper_local_files_only,
        max_audio_mb=settings.captions_max_audio_mb,
        max_duration_sec=settings.captions_max_duration_sec,
        max_concurrent_jobs=settings.captions_max_concurrent_jobs,
    )
    return AudioCaptionsStatusResponse(**status_payload)


@router.get(
    "/jobs/{job_id}",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_captions_processor_key)],
)
def get_captions_job_status_endpoint(job_id: str) -> JobStatusResponse:
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Caption transcription job not found.")
    return JobStatusResponse(**job)


@router.post(
    "/jobs/{job_id}/cancel",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_captions_processor_key)],
)
def cancel_captions_job_endpoint(
    job_id: str,
    allow_precreate: bool = Query(default=False),
) -> JobStatusResponse:
    safe_allow_precreate = bool(allow_precreate and _CLIENT_JOB_ID_RE.match(job_id))
    job = job_store.request_cancel(job_id, allow_precreate=safe_allow_precreate)
    if not job:
        raise HTTPException(status_code=404, detail="Caption transcription job not found.")
    return JobStatusResponse(**job)


@router.post(
    "/generate",
    response_model=AudioCaptionsGenerateResponse,
    dependencies=[Depends(verify_captions_processor_key)],
)
async def generate_audio_captions_endpoint(
    request: Request,
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    word_timestamps: bool = Form(default=False),
    client_job_id: Optional[str] = Form(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> AudioCaptionsGenerateResponse:
    raw_cid = (client_job_id or request.headers.get("x-captions-job-id") or "").strip()
    job_id = raw_cid if _CLIENT_JOB_ID_RE.match(raw_cid) else uuid.uuid4().hex

    _check_captions_temp_quota(settings)
    job_store.create(
        job_id,
        operation="captions_generate",
        stage="queued",
        stage_label="Preparing local voiceover transcription",
        measurable=False,
        if_missing=True,
    )
    job_dir = _prepare_captions_job_dir(settings, job_id)
    job_store.register_job_dir(job_id, job_dir)
    cancel_event = job_store.get_cancel_event(job_id)
    disconnect_task: Optional[asyncio.Task[None]] = None

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
            raise CaptionsCancelledError()

        normalized_language = validate_subtitle_language(language)
        safe_name = sanitize_filename(file.filename or "voiceover.wav")
        ext = Path(safe_name).suffix.lower()
        if ext and ext not in ALLOWED_AUDIO_EXTENSIONS:
            raise FileValidationError(
                f"Unsupported audio extension '{ext}' for caption transcription. Allowed: {', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))}.",
                status_code=400,
            )
        validate_upload_headers(
            safe_name,
            file.content_type,
            allow_audio=True,
            allow_images=False,
        )

        input_path = resolve_within_base(job_dir, job_dir / f"input_{safe_name}")
        file.file.seek(0)
        max_bytes = settings.captions_max_audio_mb * 1024 * 1024
        write_stream_with_limit(file.file, input_path, max_bytes)
        detected_kind = validate_uploaded_file_magic(
            input_path,
            original_filename=safe_name,
            allow_audio=True,
            allow_images=False,
        )
        if detected_kind != "audio":
            raise FileValidationError(
                "Caption transcription endpoint accepts audio files only (WAV, MP3, M4A, OGG, FLAC).",
                status_code=400,
            )

        client_host = getattr(request.client, "host", None)
        if client_host and client_host != "testclient":
            disconnect_task = asyncio.create_task(_watch_client_disconnect())

        def _on_progress(stage: str, label: str, pct: int, measurable: bool) -> None:
            job_store.update(
                job_id,
                status="processing",
                progress=pct,
                stage=stage,
                stage_label=label,
                measurable=measurable,
            )

        def _run_worker() -> dict:
            job_store.mark_worker_started(job_id)
            try:
                return transcribe_audio_captions(
                    input_path,
                    job_dir,
                    language=normalized_language,
                    model_size=settings.whisper_model_size,
                    device=settings.whisper_device,
                    compute_type=settings.whisper_compute_type,
                    local_files_only=settings.whisper_local_files_only,
                    ffmpeg_bin=settings.ffmpeg_bin,
                    ffprobe_bin=settings.ffprobe_bin,
                    max_duration_sec=settings.captions_max_duration_sec,
                    max_segments=settings.captions_max_segments_per_scene,
                    max_concurrent_jobs=settings.captions_max_concurrent_jobs,
                    word_timestamps=bool(word_timestamps),
                    cancel_event=cancel_event,
                    progress_cb=_on_progress,
                )
            finally:
                job_store.mark_worker_finished(job_id)

        result = await run_in_threadpool(_run_worker)

        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            raise CaptionsCancelledError()

        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
            disconnect_task = None

        job_store.update(
            job_id,
            status="completed",
            progress=100,
            stage="completed",
            stage_label="Audio captions ready",
            measurable=True,
            result={
                "model": result["model"],
                "language": result["language"],
                "segmentCount": len(result["segments"]),
                "durationSeconds": result["duration_seconds"],
            },
        )
        return AudioCaptionsGenerateResponse(status="completed", job_id=job_id, **result)

    except CaptionsCancelledError as exc:
        job_store.mark_worker_finished(job_id)
        job_store.update(
            job_id,
            status="cancelled",
            cancelled=True,
            stage="cancelled",
            stage_label="Caption transcription cancelled",
            measurable=False,
            error=str(exc),
        )
        raise
    except (FileValidationError, VideoMetadataError, SubtitleGenerationError) as exc:
        job_store.mark_worker_finished(job_id)
        job_store.update(
            job_id,
            status="failed",
            progress=100,
            stage="failed",
            stage_label="Caption transcription failed",
            measurable=False,
            error=str(exc),
        )
        raise
    except Exception as exc:
        job_store.mark_worker_finished(job_id)
        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            cancel_exc = CaptionsCancelledError()
            job_store.update(
                job_id,
                status="cancelled",
                cancelled=True,
                stage="cancelled",
                stage_label="Caption transcription cancelled",
                measurable=False,
                error=str(cancel_exc),
            )
            raise cancel_exc from exc
        job_store.update(
            job_id,
            status="failed",
            progress=100,
            stage="failed",
            stage_label="Caption transcription failed",
            measurable=False,
            error="Unexpected audio caption transcription error.",
        )
        raise HTTPException(
            status_code=500, detail="Audio caption transcription failed unexpectedly."
        ) from exc
    finally:
        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
        cleanup_path(job_dir)
        await file.close()
