from __future__ import annotations

import asyncio
import hmac
import re
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from ..config import ProcessorSettings, get_settings
from ..schemas import (
    JobStatusResponse,
    TtsGenerateRequest,
    TtsStatusResponse,
    TtsVoicesResponse,
)
from ..services.job_store import job_store
from ..services.tts_providers.base import TtsCancelledError, TtsError
from ..services.tts_service import get_tts_status, list_tts_voices, synthesize_tts_audio
from ..utils.file_cleanup import (
    cleanup_path,
    cleanup_stale_job_dirs,
    get_directory_size_bytes,
    resolve_within_base,
)

router = APIRouter(prefix="/api/v1/tts", tags=["tts"])

_CLIENT_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _assert_key_matches(provided_key: Optional[str], settings: ProcessorSettings) -> bool:
    if settings.app_env == "production" and not settings.api_key:
        return False
    if not settings.api_key:
        return True
    if not provided_key:
        return False
    return hmac.compare_digest(provided_key.encode("utf-8"), settings.api_key.encode("utf-8"))


def verify_tts_processor_key(
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


def _prepare_tts_job_dir(settings: ProcessorSettings, job_id: str) -> Path:
    safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", job_id)[:64] or "tts"
    job_dir = resolve_within_base(settings.temp_dir, settings.temp_dir / f"job_{safe_job_id}")
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def _check_tts_temp_quota(settings: ProcessorSettings) -> None:
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
            raise TtsError(
                "Video processor temporary workspace is temporarily full. Retry once active jobs finish.",
                status_code=503,
                code="storage_full",
            )


@router.get(
    "/status",
    response_model=TtsStatusResponse,
    dependencies=[Depends(verify_tts_processor_key)],
)
def tts_status_endpoint(settings: ProcessorSettings = Depends(get_settings)) -> TtsStatusResponse:
    return TtsStatusResponse(**get_tts_status(settings))


@router.get(
    "/voices",
    response_model=TtsVoicesResponse,
    dependencies=[Depends(verify_tts_processor_key)],
)
def tts_voices_endpoint(
    language: Optional[str] = Query(default=None),
    provider: Optional[str] = Query(default=None),
    settings: ProcessorSettings = Depends(get_settings),
) -> TtsVoicesResponse:
    return TtsVoicesResponse(**list_tts_voices(settings, language=language, provider=provider))


@router.get(
    "/jobs/{job_id}",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_tts_processor_key)],
)
def get_tts_job_status_endpoint(job_id: str) -> JobStatusResponse:
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="TTS synthesis job not found.")
    return JobStatusResponse(**job)


@router.post(
    "/jobs/{job_id}/cancel",
    response_model=JobStatusResponse,
    dependencies=[Depends(verify_tts_processor_key)],
)
def cancel_tts_job_endpoint(
    job_id: str,
    allow_precreate: bool = Query(default=False),
) -> JobStatusResponse:
    safe_allow_precreate = bool(allow_precreate and _CLIENT_JOB_ID_RE.match(job_id))
    job = job_store.request_cancel(job_id, allow_precreate=safe_allow_precreate)
    if not job:
        raise HTTPException(status_code=404, detail="TTS synthesis job not found.")
    return JobStatusResponse(**job)


@router.post(
    "/generate",
    dependencies=[Depends(verify_tts_processor_key)],
)
async def tts_generate_endpoint(
    request: Request,
    payload: TtsGenerateRequest,
    settings: ProcessorSettings = Depends(get_settings),
) -> FileResponse:
    raw_cid = (payload.client_job_id or request.headers.get("x-tts-job-id") or "").strip()
    job_id = raw_cid if _CLIENT_JOB_ID_RE.match(raw_cid) else uuid.uuid4().hex

    _check_tts_temp_quota(settings)
    job_store.create(
        job_id,
        operation="tts_generate",
        stage="queued",
        stage_label="Preparing local voiceover synthesis",
        measurable=False,
        if_missing=True,
    )
    job_dir = _prepare_tts_job_dir(settings, job_id)
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
            raise TtsCancelledError()

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

        def _on_process(proc) -> None:
            job_store.attach_process(job_id, proc)

        def _run_worker():
            job_store.mark_worker_started(job_id)
            try:
                return synthesize_tts_audio(
                    settings,
                    job_dir,
                    text=payload.text,
                    language=payload.language,
                    provider=payload.provider,
                    voice_id=payload.voice_id,
                    speaking_rate=payload.speaking_rate,
                    pitch=payload.pitch,
                    output_format=payload.format,
                    cancel_event=cancel_event,
                    progress_cb=_on_progress,
                    process_cb=_on_process,
                )
            finally:
                job_store.mark_worker_finished(job_id)

        result = await run_in_threadpool(_run_worker)

        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            raise TtsCancelledError()

        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
            disconnect_task = None

        job_store.update(
            job_id,
            status="completed",
            progress=100,
            stage="completed",
            stage_label="Voiceover audio verified",
            measurable=True,
            result={
                "provider": result.provider,
                "voice_id": result.voice_id,
                "language": result.language,
                "duration_seconds": result.duration_seconds,
                "sample_rate_hz": result.sample_rate_hz,
                "channels": result.channels,
                "format": result.audio_format,
                "size_bytes": result.size_bytes,
            },
        )

        return FileResponse(
            path=result.output_path,
            media_type=result.mime_type,
            filename=f"voiceover_{result.language}_{job_id[:8]}.{result.audio_format}",
            headers={
                "X-Processor-Job-Id": job_id,
                "X-TTS-Provider": result.provider,
                "X-TTS-Voice-Id": quote(result.voice_id, safe="A-Za-z0-9._:-"),
                "X-TTS-Voice-Label": quote(result.voice_label, safe="A-Za-z0-9._- ()"),
                "X-TTS-Language": result.language,
                "X-TTS-Duration": f"{result.duration_seconds:.3f}",
                "X-TTS-Sample-Rate": str(result.sample_rate_hz),
                "X-TTS-Channels": str(result.channels),
                "X-TTS-Format": result.audio_format,
            },
            background=BackgroundTask(cleanup_path, job_dir),
        )
    except TtsCancelledError as exc:
        job_store.mark_worker_finished(job_id)
        cleanup_path(job_dir)
        job_store.update(
            job_id,
            status="cancelled",
            cancelled=True,
            stage="cancelled",
            stage_label="Voiceover cancelled",
            measurable=False,
            error=str(exc),
        )
        raise
    except Exception as exc:
        job_store.mark_worker_finished(job_id)
        cleanup_path(job_dir)
        if (cancel_event is not None and cancel_event.is_set()) or job_store.is_cancelled(job_id):
            cancel_exc = TtsCancelledError()
            job_store.update(
                job_id,
                status="cancelled",
                cancelled=True,
                stage="cancelled",
                stage_label="Voiceover cancelled",
                measurable=False,
                error=str(cancel_exc),
            )
            raise cancel_exc from exc
        job_store.update(
            job_id,
            status="failed",
            progress=100,
            stage="failed",
            stage_label="Voiceover generation failed",
            measurable=False,
            error=str(exc),
        )
        raise
    finally:
        if disconnect_task is not None:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)
