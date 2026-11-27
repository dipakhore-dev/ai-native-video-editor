from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class VideoStreamInfo(BaseModel):
    index: int
    codec_name: str
    codec_long_name: Optional[str] = None
    profile: Optional[str] = None
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    fps: float = Field(ge=0)
    avg_frame_rate: Optional[str] = None
    pixel_format: Optional[str] = None
    bit_rate: Optional[int] = Field(default=None, ge=0)
    display_aspect_ratio: Optional[str] = None
    rotation: int = 0


class AudioStreamInfo(BaseModel):
    index: int
    codec_name: str
    codec_long_name: Optional[str] = None
    sample_rate: Optional[int] = Field(default=None, ge=0)
    channels: Optional[int] = Field(default=None, ge=0)
    channel_layout: Optional[str] = None
    bit_rate: Optional[int] = Field(default=None, ge=0)


class VideoMetadataPayload(BaseModel):
    filename: str
    format_name: str
    format_long_name: Optional[str] = None
    duration_seconds: float = Field(ge=0)
    size_bytes: int = Field(ge=0)
    bit_rate: Optional[int] = Field(default=None, ge=0)
    has_video: bool
    has_audio: bool
    aspect_ratio_label: Optional[str] = None
    video: Optional[VideoStreamInfo] = None
    audio: Optional[AudioStreamInfo] = None
    stream_count: int = Field(ge=1)


class VideoMetadataResponse(BaseModel):
    status: Literal["completed"] = "completed"
    job_id: str
    metadata: VideoMetadataPayload


class SubtitleSegment(BaseModel):
    id: int = Field(ge=1)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str


class SubtitleGenerationResponse(BaseModel):
    status: Literal["completed"] = "completed"
    job_id: str
    model: str
    language: str
    language_probability: float = Field(ge=0, le=1)
    duration_seconds: float = Field(ge=0)
    segments: list[SubtitleSegment]
    srt: str
    vtt: str


class JobStatusResponse(BaseModel):
    job_id: str
    operation: str
    status: Literal["queued", "processing", "completed", "failed", "cancelled"]
    progress: int = Field(ge=0, le=100)
    stage: str = "processing"
    stage_label: str = "Processing"
    measurable: bool = False
    elapsed_ms: int = Field(default=0, ge=0)
    cancelled: bool = False
    created_at: str
    updated_at: str
    error: Optional[str] = None
    result: Optional[dict] = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str = "ai-studio-video-processor"
    ffmpeg_available: bool
    ffprobe_available: bool
    faster_whisper_available: bool
    ffmpeg_path: Optional[str] = None
    ffprobe_path: Optional[str] = None
    hardware_encoders: list[str] = Field(default_factory=list)
    recommended_encoder: str = "libx264"
    encoder_capabilities: dict[str, dict[str, object]] = Field(default_factory=dict)
    export_profiles: dict[str, dict[str, object]] = Field(default_factory=dict)
    tts_available: bool = False
    tts_providers: list[str] = Field(default_factory=list)


class TtsVoiceItem(BaseModel):
    voice_id: str
    provider: str
    label: str
    language: Literal["en", "hi", "bn"]
    language_tag: str
    gender: Optional[str] = None
    quality: str = "standard"
    sample_rate_hz: Optional[int] = None
    description: Optional[str] = None


class TtsProviderStatusItem(BaseModel):
    provider: Literal["piper", "espeak_ng", "windows_sapi"]
    label: str
    available: bool
    installed: bool
    license: str
    supported_languages: list[Literal["en", "hi", "bn"]] = Field(default_factory=list)
    voice_count: int = 0
    message: str


class TtsStatusResponse(BaseModel):
    enabled: bool
    available: bool
    configured_provider: str
    active_provider: Optional[str] = None
    default_language: Literal["en", "hi", "bn"] = "en"
    supported_languages: list[Literal["en", "hi", "bn"]] = Field(default_factory=list)
    mp3_supported: bool = False
    max_text_chars: int = 1500
    max_audio_mb: int = 25
    providers: list[TtsProviderStatusItem] = Field(default_factory=list)
    message: str


class TtsVoicesResponse(BaseModel):
    available: bool
    provider: Optional[str] = None
    language: Optional[Literal["en", "hi", "bn"]] = None
    voices: list[TtsVoiceItem] = Field(default_factory=list)
    supported_languages: list[Literal["en", "hi", "bn"]] = Field(default_factory=list)
    message: str


class TtsGenerateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language: str = Field(default="en", min_length=2, max_length=32)
    provider: Optional[str] = Field(default=None, max_length=32)
    voice_id: Optional[str] = Field(default=None, max_length=160)
    speaking_rate: float = Field(default=1.0, ge=0.6, le=1.5)
    pitch: float = Field(default=0.0, ge=-20.0, le=20.0)
    format: Literal["wav", "mp3"] = "wav"
    client_job_id: Optional[str] = Field(default=None, max_length=64)


class CaptionWordTimestamp(BaseModel):
    word: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class CaptionSegmentItem(BaseModel):
    id: int = Field(ge=1)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str
    words: Optional[list[CaptionWordTimestamp]] = None


class AudioCaptionsStatusResponse(BaseModel):
    enabled: bool = True
    script_mode_available: bool = True
    audio_transcription_available: bool
    faster_whisper_installed: bool
    local_model_ready: bool
    local_files_only: bool
    model: str
    device: str
    compute_type: str
    max_audio_mb: int
    max_duration_sec: float
    max_concurrent_jobs: int
    supported_languages: list[str]
    message: str


class AudioCaptionsGenerateResponse(BaseModel):
    status: Literal["completed"] = "completed"
    job_id: str
    model: str
    language: str
    language_probability: float = Field(ge=0, le=1)
    duration_seconds: float = Field(ge=0)
    word_timestamps_included: bool = False
    segments: list[CaptionSegmentItem]
    srt: str
    vtt: str


