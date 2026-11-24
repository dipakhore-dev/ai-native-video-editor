from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProcessorSettings:
    app_env: str
    host: str
    port: int
    api_key: str
    ffmpeg_bin: str
    ffprobe_bin: str
    temp_dir: Path
    max_upload_bytes: int
    ffprobe_timeout_sec: int
    ffmpeg_timeout_sec: int
    max_short_video_sec: float
    max_concurrent_exports: int
    export_queue_wait_sec: float
    max_temp_storage_mb: int
    temp_cleanup_max_age_sec: int
    whisper_model_size: str
    whisper_device: str
    whisper_compute_type: str


def get_settings() -> ProcessorSettings:
    max_mb = max(1, int(os.getenv("MAX_UPLOAD_MB", "500")))
    probe_timeout = max(5, int(os.getenv("FFPROBE_TIMEOUT_SEC", "30")))
    ffmpeg_timeout = max(15, int(os.getenv("FFMPEG_TIMEOUT_SEC", "300")))
    max_short_sec = max(10.0, float(os.getenv("MAX_SHORT_VIDEO_SEC", "300")))
    max_concurrent = max(1, min(16, int(os.getenv("MAX_CONCURRENT_EXPORTS", "2"))))
    queue_wait = max(0.0, min(60.0, float(os.getenv("EXPORT_QUEUE_WAIT_SEC", "2.0"))))
    max_temp_mb = max(64, int(os.getenv("MAX_TEMP_STORAGE_MB", "2048")))
    cleanup_age_sec = max(60, int(os.getenv("TEMP_CLEANUP_MAX_AGE_SEC", "3600")))
    port_raw = os.getenv("PORT") or os.getenv("VIDEO_PROCESSOR_PORT") or "8001"
    app_env = (os.getenv("APP_ENV") or os.getenv("NODE_ENV") or "development").strip().lower() or "development"
    return ProcessorSettings(
        app_env=app_env,
        host=os.getenv("VIDEO_PROCESSOR_HOST", "127.0.0.1"),
        port=int(port_raw),
        api_key=os.getenv("VIDEO_PROCESSOR_API_KEY", "").strip(),
        ffmpeg_bin=os.getenv("FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg",
        ffprobe_bin=os.getenv("FFPROBE_BIN", "ffprobe").strip() or "ffprobe",
        temp_dir=Path(os.getenv("TEMP_DIR", "/tmp/ai-studio-video-processor")),
        max_upload_bytes=max_mb * 1024 * 1024,
        ffprobe_timeout_sec=probe_timeout,
        ffmpeg_timeout_sec=ffmpeg_timeout,
        max_short_video_sec=max_short_sec,
        max_concurrent_exports=max_concurrent,
        export_queue_wait_sec=queue_wait,
        max_temp_storage_mb=max_temp_mb,
        temp_cleanup_max_age_sec=cleanup_age_sec,
        whisper_model_size=os.getenv("WHISPER_MODEL_SIZE", "small").strip() or "small",
        whisper_device=os.getenv("WHISPER_DEVICE", "cpu").strip() or "cpu",
        whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8",
    )


def validate_runtime_settings(settings: ProcessorSettings) -> list[str]:
    errors: list[str] = []
    if settings.port < 1 or settings.port > 65535:
        errors.append("PORT must be between 1 and 65535.")
    if settings.max_upload_bytes < 1024 * 1024:
        errors.append("MAX_UPLOAD_MB must be at least 1 MB.")
    if settings.max_concurrent_exports < 1:
        errors.append("MAX_CONCURRENT_EXPORTS must be at least 1.")
    if settings.app_env == "production":
        if (
            not settings.api_key
            or len(settings.api_key) < 16
            or settings.api_key.startswith("REPLACE_WITH")
        ):
            errors.append(
                "Production startup blocked: VIDEO_PROCESSOR_API_KEY (minimum 16 characters) is required when APP_ENV=production."
            )
    return errors
