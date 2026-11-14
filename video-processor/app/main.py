from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .config import ProcessorSettings, get_settings
from .schemas import HealthResponse, JobStatusResponse, VideoMetadataResponse
from .services.ffprobe_service import VideoMetadataError, check_binary, extract_video_metadata
from .services.job_store import job_store
from .utils.file_cleanup import (
    FileValidationError,
    managed_job_temp_dir,
    validate_upload_headers,
    write_stream_with_limit,
)

app = FastAPI(
    title="AI Studio Video Processor",
    description="Python FastAPI microservice for FFmpeg/FFprobe video processing.",
    version="0.1.0",
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


@app.get("/health", response_model=HealthResponse)
def health(settings: ProcessorSettings = Depends(get_settings)) -> HealthResponse:
    ffmpeg_path = check_binary(settings.ffmpeg_bin)
    ffprobe_path = check_binary(settings.ffprobe_bin)
    ready = bool(ffmpeg_path and ffprobe_path)
    return HealthResponse(
        status="ok" if ready else "degraded",
        ffmpeg_available=bool(ffmpeg_path),
        ffprobe_available=bool(ffprobe_path),
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
            target_path: Path = temp_dir / safe_name
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
