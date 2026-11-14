from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProcessorSettings:
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
    whisper_model_size: str
    whisper_device: str
    whisper_compute_type: str


def get_settings() -> ProcessorSettings:
    max_mb = max(1, int(os.getenv("MAX_UPLOAD_MB", "500")))
    probe_timeout = max(5, int(os.getenv("FFPROBE_TIMEOUT_SEC", "30")))
    ffmpeg_timeout = max(15, int(os.getenv("FFMPEG_TIMEOUT_SEC", "180")))
    max_short_sec = max(10.0, float(os.getenv("MAX_SHORT_VIDEO_SEC", "300")))
    port_raw = os.getenv("PORT") or os.getenv("VIDEO_PROCESSOR_PORT") or "8001"
    return ProcessorSettings(
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
        whisper_model_size=os.getenv("WHISPER_MODEL_SIZE", "base").strip() or "base",
        whisper_device=os.getenv("WHISPER_DEVICE", "cpu").strip() or "cpu",
        whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8",
    )
