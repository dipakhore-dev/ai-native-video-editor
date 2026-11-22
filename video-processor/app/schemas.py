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
