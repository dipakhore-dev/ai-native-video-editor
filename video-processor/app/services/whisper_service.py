from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from typing import Any, Optional

from .ffprobe_service import check_binary, extract_video_metadata
from .job_store import sanitize_error_text


SUPPORTED_SUBTITLE_LANGUAGES: frozenset[str] = frozenset({
    "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs",
    "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi",
    "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy",
    "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb",
    "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
    "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru",
    "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw",
    "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi",
    "yi", "yo", "yue", "zh",
})

_ENGLISH_ONLY_MULTILINGUAL_MAP: dict[str, str] = {
    "tiny.en": "tiny",
    "base.en": "base",
    "small.en": "small",
    "medium.en": "medium",
    "distil-small.en": "small",
    "distil-medium.en": "medium",
    "distil-large-v2": "small",
    "distil-large-v3": "small",
}


class SubtitleGenerationError(Exception):
    """Raised when local faster-whisper subtitle generation cannot proceed."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_faster_whisper_available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def validate_subtitle_language(language: Optional[str]) -> Optional[str]:
    if language is None:
        return None
    normalized = language.strip().lower()
    if not normalized or normalized == "auto":
        return None
    if normalized not in SUPPORTED_SUBTITLE_LANGUAGES:
        raise SubtitleGenerationError(
            f"Unsupported subtitle language '{language.strip()}'. Supported codes include 'en', 'hi', 'bn', 'es', 'fr', 'de', 'ja', or empty for Auto-Detect.",
            status_code=400,
        )
    return normalized


def resolve_multilingual_model_size(
    model_size: Optional[str],
    language: Optional[str] = None,
) -> str:
    raw = (model_size or "").strip() or "small"
    lowered = raw.lower()
    # Always require a multilingual model when language is non-English (e.g. 'bn') or Auto-Detect (None)
    if lowered in _ENGLISH_ONLY_MULTILINGUAL_MAP:
        return _ENGLISH_ONLY_MULTILINGUAL_MAP[lowered]
    if lowered.endswith(".en"):
        stripped = raw[:-3].strip()
        return stripped or "small"
    if language is not None and language.strip().lower() != "en" and ".en" in lowered:
        return "small"
    return raw


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
            "-protocol_whitelist",
            "file,pipe",
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
        try:
            _cached_models[key] = WhisperModel(model_size, device=device, compute_type=compute_type)
        except Exception as exc:
            raise SubtitleGenerationError(
                f"Failed to load faster-whisper model '{model_size}' ({device}/{compute_type}): {exc}",
                status_code=500,
            ) from exc
    return _cached_models[key]


def transcribe_video_subtitles(
    input_path: Path,
    work_dir: Path,
    *,
    language: Optional[str] = None,
    model_size: str = "small",
    device: str = "cpu",
    compute_type: str = "int8",
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    max_duration_sec: float = 300.0,
) -> dict[str, Any]:
    normalized_language = validate_subtitle_language(language)
    resolved_model_size = resolve_multilingual_model_size(model_size, normalized_language)

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

    model = _get_whisper_model(resolved_model_size, device, compute_type)
    try:
        raw_segments, info = model.transcribe(
            str(wav_path),
            language=normalized_language,
            vad_filter=True,
        )

        segments: list[dict[str, Any]] = []
        for idx, seg in enumerate(raw_segments, start=1):
            text = (seg.text or "").strip()
            if not text:
                continue
            start_val = max(0.0, round(float(seg.start), 3))
            end_val = max(start_val + 0.05, round(float(seg.end), 3))
            segments.append(
                {
                    "id": idx,
                    "start": start_val,
                    "end": end_val,
                    "text": text,
                }
            )
    except SubtitleGenerationError:
        raise
    except Exception as exc:
        raise SubtitleGenerationError(
            f"Subtitle transcription failed: {sanitize_error_text(str(exc), 'transcription error')}",
            status_code=422,
        ) from exc

    return {
        "model": f"faster-whisper-{resolved_model_size}",
        "language": str(getattr(info, "language", normalized_language or "unknown")),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
        "duration_seconds": float(meta["duration_seconds"]),
        "segments": segments,
        "srt": format_srt(segments),
        "vtt": format_vtt(segments),
    }
