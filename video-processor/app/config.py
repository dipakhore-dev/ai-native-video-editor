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


def get_settings() -> ProcessorSettings:
    max_mb = max(1, int(os.getenv("MAX_UPLOAD_MB", "500")))
    timeout_sec = max(5, int(os.getenv("FFPROBE_TIMEOUT_SEC", "30")))
    port_raw = os.getenv("PORT") or os.getenv("VIDEO_PROCESSOR_PORT") or "8080"
    return ProcessorSettings(
        host=os.getenv("VIDEO_PROCESSOR_HOST", "0.0.0.0"),
        port=int(port_raw),
        api_key=os.getenv("VIDEO_PROCESSOR_API_KEY", "").strip(),
        ffmpeg_bin=os.getenv("FFMPEG_BIN", "ffmpeg").strip() or "ffmpeg",
        ffprobe_bin=os.getenv("FFPROBE_BIN", "ffprobe").strip() or "ffprobe",
        temp_dir=Path(os.getenv("TEMP_DIR", "/tmp/ai-studio-video-processor")),
        max_upload_bytes=max_mb * 1024 * 1024,
        ffprobe_timeout_sec=timeout_sec,
    )
