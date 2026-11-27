from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from .ffprobe_service import check_binary, extract_audio_metadata, extract_video_metadata
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

STORYBOARD_CAPTION_LANGUAGES: tuple[str, ...] = ("en", "hi", "bn")

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

_WHISPER_REPO_NAMES: dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}


class SubtitleGenerationError(Exception):
    """Raised when local faster-whisper subtitle generation cannot proceed."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


class CaptionsCancelledError(SubtitleGenerationError):
    """Raised when audio caption transcription is cancelled cooperatively."""

    def __init__(self, message: str = "Audio caption transcription cancelled.") -> None:
        super().__init__(message, status_code=499)


_cached_models: dict[tuple[str, str, str], Any] = {}
_model_load_lock = threading.Lock()
_caption_sem_lock = threading.Lock()
_caption_sem_capacity: int = 0
_caption_sem: Optional[threading.BoundedSemaphore] = None


def _get_caption_semaphore(capacity: int) -> threading.BoundedSemaphore:
    global _caption_sem_capacity, _caption_sem
    safe_cap = max(1, min(2, int(capacity)))
    with _caption_sem_lock:
        if _caption_sem is None or _caption_sem_capacity != safe_cap:
            _caption_sem_capacity = safe_cap
            _caption_sem = threading.BoundedSemaphore(safe_cap)
        return _caption_sem


def is_faster_whisper_available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def validate_subtitle_language(language: Optional[str]) -> Optional[str]:
    if language is None:
        return None
    normalized = language.strip().lower()
    if not normalized or normalized == "auto":
        return None
    lang_aliases = {"english": "en", "hindi": "hi", "bengali": "bn"}
    normalized = lang_aliases.get(normalized, normalized)
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
    # Always enforce a multilingual model (never English-only *.en) so English, Hindi, Bengali, and auto work with one shared CPU model.
    if lowered in _ENGLISH_ONLY_MULTILINGUAL_MAP:
        return _ENGLISH_ONLY_MULTILINGUAL_MAP[lowered]
    if lowered.endswith(".en"):
        stripped = raw[:-3].strip()
        return stripped or "small"
    if language is not None and language.strip().lower() != "en" and ".en" in lowered:
        return "small"
    return raw


def check_whisper_local_model_ready(
    model_size: Optional[str] = None,
    device: str = "cpu",
    compute_type: str = "int8",
) -> dict[str, Any]:
    resolved_model = resolve_multilingual_model_size(model_size)
    installed = is_faster_whisper_available()
    in_memory = (resolved_model, device, compute_type) in _cached_models
    if not installed:
        return {
            "installed": False,
            "model": resolved_model,
            "in_memory": False,
            "local_model_cached": False,
            "ready": False,
            "detail": "faster-whisper is not installed in the Python environment.",
        }

    if in_memory:
        return {
            "installed": True,
            "model": resolved_model,
            "in_memory": True,
            "local_model_cached": True,
            "ready": True,
            "detail": f"faster-whisper '{resolved_model}' model loaded in memory.",
        }

    local_cached = False
    try:
        model_path = Path(resolved_model)
        if model_path.is_dir() and (model_path / "model.bin").is_file():
            local_cached = True
    except OSError:
        local_cached = False

    if not local_cached:
        repo_id = _WHISPER_REPO_NAMES.get(resolved_model)
        if repo_id and importlib.util.find_spec("huggingface_hub") is not None:
            try:
                from huggingface_hub import try_to_load_from_cache  # type: ignore import-not-found

                found = try_to_load_from_cache(repo_id=repo_id, filename="model.bin")
                if isinstance(found, str) and Path(found).is_file():
                    local_cached = True
            except Exception:
                local_cached = False

    if not local_cached:
        repo_dir_name = _WHISPER_REPO_NAMES.get(resolved_model, resolved_model).replace("/", "--")
        hf_home = Path(
            os.getenv("HF_HUB_CACHE")
            or os.getenv("HUGGINGFACE_HUB_CACHE")
            or (Path(os.getenv("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub")
        )
        candidate_dir = hf_home / f"models--{repo_dir_name}" / "snapshots"
        try:
            if candidate_dir.is_dir():
                for snap in candidate_dir.iterdir():
                    if (snap / "model.bin").is_file():
                        local_cached = True
                        break
        except OSError:
            local_cached = False

    return {
        "installed": True,
        "model": resolved_model,
        "in_memory": False,
        "local_model_cached": local_cached,
        "ready": local_cached,
        "detail": (
            f"faster-whisper '{resolved_model}' is cached locally and ready for CPU transcription."
            if local_cached
            else f"faster-whisper is installed, but '{resolved_model}' is not cached locally yet."
        ),
    }


def get_captions_runtime_status(
    *,
    model_size: str = "small",
    device: str = "cpu",
    compute_type: str = "int8",
    local_files_only: bool = True,
    max_audio_mb: int = 20,
    max_duration_sec: float = 90.0,
    max_concurrent_jobs: int = 1,
) -> dict[str, Any]:
    probe = check_whisper_local_model_ready(model_size, device, compute_type)
    installed = bool(probe["installed"])
    local_ready = bool(probe["ready"])
    audio_available = installed and (local_ready or not local_files_only)

    if not installed:
        msg = (
            "Audio transcription unavailable: faster-whisper is not installed in video-processor/.venv. "
            "Script-based caption generation remains available at ₹0."
        )
    elif local_ready:
        msg = (
            f"Local faster-whisper ('{probe['model']}', {device}/{compute_type}) is ready for "
            "offline multilingual audio transcription (English, Hindi, Bengali)."
        )
    elif local_files_only:
        msg = (
            f"faster-whisper is installed, but '{probe['model']}' is not downloaded in the local cache "
            "(WHISPER_LOCAL_FILES_ONLY=true prevents unexpected network downloads). "
            "Pre-cache the model once or switch WHISPER_LOCAL_FILES_ONLY=false; script-based captions remain ready."
        )
    else:
        msg = (
            f"faster-whisper is installed (model '{probe['model']}' will download on first run because "
            "WHISPER_LOCAL_FILES_ONLY=false)."
        )

    return {
        "enabled": True,
        "script_mode_available": True,
        "audio_transcription_available": audio_available,
        "faster_whisper_installed": installed,
        "local_model_ready": local_ready,
        "local_files_only": local_files_only,
        "model": str(probe["model"]),
        "device": device,
        "compute_type": compute_type,
        "max_audio_mb": max_audio_mb,
        "max_duration_sec": max_duration_sec,
        "max_concurrent_jobs": max_concurrent_jobs,
        "supported_languages": list(STORYBOARD_CAPTION_LANGUAGES),
        "message": msg,
    }


def _sanitize_cue_text(raw: str) -> str:
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", raw or "")
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = cleaned.replace("-->", "->")
    lines = [line.strip() for line in cleaned.split("\n") if line.strip()]
    lines = [line if not line.upper().startswith("WEBVTT") else f" {line}" for line in lines]
    return "\n".join(lines).strip()


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
    for idx, seg in enumerate(segments, start=1):
        text = _sanitize_cue_text(str(seg.get("text", "")))
        if not text:
            continue
        start_ts = _format_srt_timestamp(float(seg["start"]))
        end_ts = _format_srt_timestamp(float(seg["end"]))
        cue_id = seg.get("id", idx)
        blocks.append(f"{cue_id}\n{start_ts} --> {end_ts}\n{text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def format_vtt(segments: list[dict[str, Any]]) -> str:
    lines = ["WEBVTT", ""]
    for seg in segments:
        text = _sanitize_cue_text(str(seg.get("text", "")))
        if not text:
            continue
        start_ts = _format_vtt_timestamp(float(seg["start"]))
        end_ts = _format_vtt_timestamp(float(seg["end"]))
        lines.append(f"{start_ts} --> {end_ts}")
        lines.append(text)
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
    allow_audio_only: bool = False,
) -> dict[str, Any]:
    if allow_audio_only:
        meta = extract_audio_metadata(input_path, ffprobe_bin=ffprobe_bin)
    else:
        meta = extract_video_metadata(input_path, ffprobe_bin=ffprobe_bin)

    if not meta.get("has_audio"):
        raise SubtitleGenerationError(
            "Uploaded media has no audio track to transcribe.",
            status_code=422,
        )
    if float(meta["duration_seconds"]) <= 0:
        raise SubtitleGenerationError(
            "Uploaded audio duration must be greater than 0 seconds.",
            status_code=422,
        )
    if float(meta["duration_seconds"]) > max_duration_sec:
        raise SubtitleGenerationError(
            f"Media duration ({meta['duration_seconds']:.1f}s) exceeds local limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )

    # Reuse already-compatible 16kHz mono PCM WAV without redundant FFmpeg transcode
    audio_info = meta.get("audio") if isinstance(meta.get("audio"), dict) else {}
    if (
        allow_audio_only
        and input_path.suffix.lower() == ".wav"
        and str(audio_info.get("codec_name") or "").lower() == "pcm_s16le"
        and audio_info.get("sample_rate") == 16000
        and audio_info.get("channels") == 1
    ):
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        if input_path.resolve() != wav_path.resolve():
            wav_path.write_bytes(input_path.read_bytes())
        return meta

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
            "Failed to extract 16kHz mono audio for speech transcription.",
            status_code=422,
        )
    return meta


def _get_whisper_model(
    model_size: str,
    device: str,
    compute_type: str,
    *,
    local_files_only: bool = False,
) -> Any:
    if not is_faster_whisper_available():
        raise SubtitleGenerationError(
            "faster-whisper is not installed in the Python environment. Run `pip install faster-whisper` inside video-processor/.venv.",
            status_code=503,
        )

    from faster_whisper import WhisperModel  # type: ignore import-not-found

    key = (model_size, device, compute_type)
    with _model_load_lock:
        if key not in _cached_models:
            try:
                _cached_models[key] = WhisperModel(
                    model_size,
                    device=device,
                    compute_type=compute_type,
                    local_files_only=local_files_only,
                )
            except Exception as exc:
                err_lower = str(exc).lower()
                if local_files_only and (
                    "local" in err_lower
                    or "snapshot" in err_lower
                    or "not found" in err_lower
                    or "cached" in err_lower
                    or "offline" in err_lower
                ):
                    raise SubtitleGenerationError(
                        f"Local faster-whisper model '{model_size}' is not cached locally and WHISPER_LOCAL_FILES_ONLY=true blocked downloading it.",
                        status_code=503,
                    ) from exc
                raise SubtitleGenerationError(
                    f"Failed to load faster-whisper model '{model_size}' ({device}/{compute_type}): {sanitize_error_text(str(exc), 'model load error')}",
                    status_code=500,
                ) from exc
    return _cached_models[key]


def _check_cancel(cancel_event: Optional[threading.Event]) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise CaptionsCancelledError()


def _transcribe_wav_internal(
    wav_path: Path,
    *,
    duration_seconds: float,
    normalized_language: Optional[str],
    resolved_model_size: str,
    device: str,
    compute_type: str,
    local_files_only: bool,
    word_timestamps: bool,
    max_segments: int,
    max_concurrent_jobs: int,
    cancel_event: Optional[threading.Event],
    progress_cb: Optional[Callable[[str, str, int, bool], None]],
) -> dict[str, Any]:
    _check_cancel(cancel_event)

    sem = _get_caption_semaphore(max_concurrent_jobs)
    acquired = sem.acquire(timeout=2.0)
    if not acquired:
        raise SubtitleGenerationError(
            "Audio caption transcription worker is busy with another scene. Wait for it to finish and retry.",
            status_code=429,
        )

    try:
        _check_cancel(cancel_event)
        if progress_cb:
            progress_cb("loading_model", "Preparing local Whisper model", 45, False)

        model = _get_whisper_model(
            resolved_model_size,
            device,
            compute_type,
            local_files_only=local_files_only,
        )
        _check_cancel(cancel_event)

        if progress_cb:
            progress_cb("transcribing", "Transcribing scene voiceover locally", 65, False)

        raw_segments, info = model.transcribe(
            str(wav_path),
            language=normalized_language,
            task="transcribe",
            vad_filter=True,
            word_timestamps=word_timestamps,
        )

        segments: list[dict[str, Any]] = []
        for idx, seg in enumerate(raw_segments, start=1):
            _check_cancel(cancel_event)
            text = _sanitize_cue_text(str(getattr(seg, "text", "") or ""))
            if not text:
                continue
            start_val = max(0.0, min(duration_seconds, round(float(seg.start), 3)))
            end_val = min(
                max(duration_seconds, start_val + 0.05),
                max(start_val + 0.05, round(float(seg.end), 3)),
            )

            seg_item: dict[str, Any] = {
                "id": len(segments) + 1,
                "start": start_val,
                "end": round(end_val, 3),
                "text": text,
            }

            if word_timestamps:
                raw_words = getattr(seg, "words", None) or []
                words_out: list[dict[str, Any]] = []
                for w in raw_words:
                    w_text = _sanitize_cue_text(str(getattr(w, "word", "") or ""))
                    if not w_text:
                        continue
                    w_start = max(start_val, round(float(getattr(w, "start", start_val)), 3))
                    w_end = max(w_start + 0.01, round(float(getattr(w, "end", w_start + 0.05)), 3))
                    words_out.append({
                        "word": w_text,
                        "start": w_start,
                        "end": w_end,
                    })
                if words_out:
                    seg_item["words"] = words_out

            segments.append(seg_item)
            if len(segments) >= max_segments:
                break

        _check_cancel(cancel_event)
    except SubtitleGenerationError:
        raise
    except Exception as exc:
        raise SubtitleGenerationError(
            f"Subtitle transcription failed: {sanitize_error_text(str(exc), 'transcription error')}",
            status_code=422,
        ) from exc
    finally:
        sem.release()

    return {
        "model": f"faster-whisper-{resolved_model_size}",
        "language": str(getattr(info, "language", normalized_language or "unknown")),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
        "duration_seconds": float(duration_seconds),
        "word_timestamps_included": bool(
            word_timestamps and any("words" in s for s in segments)
        ),
        "segments": segments,
        "srt": format_srt(segments),
        "vtt": format_vtt(segments),
    }


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
    local_files_only: bool = False,
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
        allow_audio_only=False,
    )

    result = _transcribe_wav_internal(
        wav_path,
        duration_seconds=float(meta["duration_seconds"]),
        normalized_language=normalized_language,
        resolved_model_size=resolved_model_size,
        device=device,
        compute_type=compute_type,
        local_files_only=local_files_only,
        word_timestamps=False,
        max_segments=500,
        max_concurrent_jobs=1,
        cancel_event=None,
        progress_cb=None,
    )
    return {
        "model": result["model"],
        "language": result["language"],
        "language_probability": result["language_probability"],
        "duration_seconds": result["duration_seconds"],
        "segments": result["segments"],
        "srt": result["srt"],
        "vtt": result["vtt"],
    }


def transcribe_audio_captions(
    input_path: Path,
    work_dir: Path,
    *,
    language: Optional[str] = None,
    model_size: str = "small",
    device: str = "cpu",
    compute_type: str = "int8",
    local_files_only: bool = True,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    max_duration_sec: float = 90.0,
    max_segments: int = 100,
    max_concurrent_jobs: int = 1,
    word_timestamps: bool = False,
    cancel_event: Optional[threading.Event] = None,
    progress_cb: Optional[Callable[[str, str, int, bool], None]] = None,
) -> dict[str, Any]:
    _check_cancel(cancel_event)
    normalized_language = validate_subtitle_language(language)
    resolved_model_size = resolve_multilingual_model_size(model_size, normalized_language)

    if not is_faster_whisper_available():
        raise SubtitleGenerationError(
            "faster-whisper is not installed in the Python environment. Run `pip install faster-whisper` inside video-processor/.venv.",
            status_code=503,
        )

    if progress_cb:
        progress_cb("extracting_audio", "Preparing 16kHz mono voiceover audio", 30, False)

    wav_path = work_dir / "voiceover_16k.wav"
    meta = extract_mono_wav_for_whisper(
        input_path,
        wav_path,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        max_duration_sec=max_duration_sec,
        allow_audio_only=True,
    )

    return _transcribe_wav_internal(
        wav_path,
        duration_seconds=float(meta["duration_seconds"]),
        normalized_language=normalized_language,
        resolved_model_size=resolved_model_size,
        device=device,
        compute_type=compute_type,
        local_files_only=local_files_only,
        word_timestamps=word_timestamps,
        max_segments=max_segments,
        max_concurrent_jobs=max_concurrent_jobs,
        cancel_event=cancel_event,
        progress_cb=progress_cb,
    )
