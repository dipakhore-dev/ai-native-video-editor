from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from typing import Any, Optional

from .ffprobe_service import check_binary, extract_video_metadata


class SubtitleGenerationError(Exception):
    """Raised when local faster-whisper subtitle generation cannot proceed."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_faster_whisper_available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def _format_srt_timestamp(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours = ms_total // 3_600_000
    minutes = (ms_total % 3_600_000) // 60_000
    secs = (ms_total % 60_000) // 1000
    ms = ms_total % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _format_vtt_timestamp(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours = ms_total // 3_600_000
    minutes = (ms_total % 3_600_000) // 60_000
    secs = (ms_total % 60_000) // 1000
    ms = ms_total % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def format_srt(segments: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for seg in segments:
        start_ts = _format_srt_timestamp(float(seg["start"]))
        end_ts = _format_srt_timestamp(float(seg["end"]))
        blocks.append(f"{seg['id']}\n{start_ts} --> {end_ts}\n{seg['text']}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def format_vtt(segments: list[dict[str, Any]]) -> str:
    lines = ["WEBVTT", ""]
    for seg in segments:
        start_ts = _format_vtt_timestamp(float(seg["start"]))
        end_ts = _format_vtt_timestamp(float(seg["end"]))
        lines.append(f"{start_ts} --> {end_ts}")
        lines.append(str(seg["text"]))
        lines.append("")
    return "\n".join(lines)


def extract_mono_wav_for_whisper(
    input_path: Path,
    wav_path: Path,
    *,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 120,
    max_duration_sec: float = 300.0,
) -> dict[str, Any]:
    meta = extract_video_metadata(input_path, ffprobe_bin=ffprobe_bin)
    if not meta["has_audio"]:
        raise SubtitleGenerationError(
            "Uploaded video has no audio track to transcribe.",
            status_code=422,
        )
    if float(meta["duration_seconds"]) > max_duration_sec:
        raise SubtitleGenerationError(
            f"Video duration ({meta['duration_seconds']:.1f}s) exceeds local subtitle limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )

    ffmpeg_path = check_binary(ffmpeg_bin)
    if not ffmpeg_path:
        raise SubtitleGenerationError(
            f"ffmpeg binary '{ffmpeg_bin}' is not installed or not on PATH.",
            status_code=503,
        )

    wav_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            ffmpeg_path,
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(wav_path),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        check=False,
    )
    if proc.returncode != 0 or not wav_path.exists() or wav_path.stat().st_size == 0:
        raise SubtitleGenerationError(
            "Failed to extract audio track from video for subtitle transcription.",
            status_code=422,
        )
    return meta


_cached_models: dict[tuple[str, str, str], Any] = {}


def _get_whisper_model(model_size: str, device: str, compute_type: str) -> Any:
    if not is_faster_whisper_available():
        raise SubtitleGenerationError(
            "faster-whisper is not installed in the Python environment. Run `pip install faster-whisper` inside video-processor/.venv.",
            status_code=503,
        )

    from faster_whisper import WhisperModel  # type: ignore import-not-found

    key = (model_size, device, compute_type)
    if key not in _cached_models:
        _cached_models[key] = WhisperModel(model_size, device=device, compute_type=compute_type)
    return _cached_models[key]


def transcribe_video_subtitles(
    input_path: Path,
    work_dir: Path,
    *,
    language: Optional[str] = None,
    model_size: str = "base",
    device: str = "cpu",
    compute_type: str = "int8",
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    max_duration_sec: float = 300.0,
) -> dict[str, Any]:
    if not is_faster_whisper_available():
        raise SubtitleGenerationError(
            "faster-whisper is not installed in the Python environment. Run `pip install faster-whisper` inside video-processor/.venv.",
            status_code=503,
        )

    wav_path = work_dir / "audio_16k.wav"
    meta = extract_mono_wav_for_whisper(
        input_path,
        wav_path,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        max_duration_sec=max_duration_sec,
    )

    model = _get_whisper_model(model_size, device, compute_type)
    raw_segments, info = model.transcribe(
        str(wav_path),
        language=language or None,
        vad_filter=True,
    )

    segments: list[dict[str, Any]] = []
    for idx, seg in enumerate(raw_segments, start=1):
        text = (seg.text or "").strip()
        if not text:
            continue
        segments.append(
            {
                "id": idx,
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": text,
            }
        )

    return {
        "model": f"faster-whisper-{model_size}",
        "language": str(getattr(info, "language", language or "unknown")),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
        "duration_seconds": float(meta["duration_seconds"]),
        "segments": segments,
        "srt": format_srt(segments),
        "vtt": format_vtt(segments),
    }
