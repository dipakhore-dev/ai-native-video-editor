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
    tts_enabled: bool = True
    tts_provider: str = "auto"
    tts_default_language: str = "en"
    tts_max_text_chars: int = 1500
    tts_max_concurrent_jobs: int = 1
    tts_request_timeout_sec: int = 45
    tts_max_audio_mb: int = 25
    espeak_ng_path: str = ""
    piper_executable_path: str = ""
    piper_models_dir: str = ""
    tts_windows_sapi_enabled: bool = False
    whisper_local_files_only: bool = True
    captions_max_audio_mb: int = 20
    captions_max_duration_sec: float = 90.0
    captions_max_concurrent_jobs: int = 1
    captions_request_timeout_sec: int = 120
    captions_max_segments_per_scene: int = 100


def _parse_bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    norm = raw.strip().lower()
    if norm in ("1", "true", "yes", "on"):
        return True
    if norm in ("0", "false", "no", "off"):
        return False
    return default


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
    tts_enabled = _parse_bool_env("TTS_ENABLED", True)
    tts_provider = (os.getenv("TTS_PROVIDER", "auto") or "auto").strip().lower() or "auto"
    tts_default_language = (os.getenv("TTS_DEFAULT_LANGUAGE", "en") or "en").strip().lower() or "en"
    tts_max_text_chars = max(100, min(5000, int(os.getenv("TTS_MAX_TEXT_CHARS", "1500"))))
    tts_max_concurrent_jobs = max(1, min(4, int(os.getenv("TTS_MAX_CONCURRENT_JOBS", "1"))))
    tts_request_timeout_sec = max(5, min(180, int(os.getenv("TTS_REQUEST_TIMEOUT_SEC", "45"))))
    tts_max_audio_mb = max(1, min(100, int(os.getenv("TTS_MAX_AUDIO_MB", "25"))))
    tts_windows_sapi_enabled = _parse_bool_env("TTS_WINDOWS_SAPI_ENABLED", os.name == "nt")
    whisper_local_files_only = _parse_bool_env("WHISPER_LOCAL_FILES_ONLY", True)
    captions_max_audio_mb = max(1, min(100, int(os.getenv("CAPTIONS_MAX_AUDIO_MB", "20"))))
    captions_max_duration_sec = max(5.0, min(300.0, float(os.getenv("CAPTIONS_MAX_DURATION_SEC", "90"))))
    captions_max_concurrent_jobs = max(1, min(2, int(os.getenv("CAPTIONS_MAX_CONCURRENT_JOBS", "1"))))
    captions_request_timeout_sec = max(10, min(300, int(os.getenv("CAPTIONS_REQUEST_TIMEOUT_SEC", "120"))))
    captions_max_segments_per_scene = max(10, min(250, int(os.getenv("CAPTIONS_MAX_SEGMENTS_PER_SCENE", "100"))))

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
        tts_enabled=tts_enabled,
        tts_provider=tts_provider,
        tts_default_language=tts_default_language,
        tts_max_text_chars=tts_max_text_chars,
        tts_max_concurrent_jobs=tts_max_concurrent_jobs,
        tts_request_timeout_sec=tts_request_timeout_sec,
        tts_max_audio_mb=tts_max_audio_mb,
        espeak_ng_path=os.getenv("ESPEAK_NG_PATH", "").strip(),
        piper_executable_path=os.getenv("PIPER_EXECUTABLE_PATH", "").strip(),
        piper_models_dir=os.getenv("PIPER_MODELS_DIR", "").strip(),
        tts_windows_sapi_enabled=tts_windows_sapi_enabled,
        whisper_local_files_only=whisper_local_files_only,
        captions_max_audio_mb=captions_max_audio_mb,
        captions_max_duration_sec=captions_max_duration_sec,
        captions_max_concurrent_jobs=captions_max_concurrent_jobs,
        captions_request_timeout_sec=captions_request_timeout_sec,
        captions_max_segments_per_scene=captions_max_segments_per_scene,
    )


def validate_runtime_settings(settings: ProcessorSettings) -> list[str]:
    errors: list[str] = []
    if settings.port < 1 or settings.port > 65535:
        errors.append("PORT must be between 1 and 65535.")
    if settings.max_upload_bytes < 1024 * 1024:
        errors.append("MAX_UPLOAD_MB must be at least 1 MB.")
    if settings.max_concurrent_exports < 1:
        errors.append("MAX_CONCURRENT_EXPORTS must be at least 1.")
    if settings.tts_provider not in ("auto", "espeak_ng", "piper", "windows_sapi", "none"):
        errors.append(
            "TTS_PROVIDER must be one of: auto, espeak_ng, piper, windows_sapi, none."
        )
    if settings.tts_max_text_chars < 50 or settings.tts_max_text_chars > 5000:
        errors.append("TTS_MAX_TEXT_CHARS must be between 50 and 5000.")
    if settings.tts_max_concurrent_jobs < 1 or settings.tts_max_concurrent_jobs > 4:
        errors.append("TTS_MAX_CONCURRENT_JOBS must be between 1 and 4.")
    if settings.captions_max_concurrent_jobs < 1 or settings.captions_max_concurrent_jobs > 2:
        errors.append("CAPTIONS_MAX_CONCURRENT_JOBS must be 1 or 2.")
    if settings.captions_max_audio_mb < 1 or settings.captions_max_audio_mb > 100:
        errors.append("CAPTIONS_MAX_AUDIO_MB must be between 1 and 100.")
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
