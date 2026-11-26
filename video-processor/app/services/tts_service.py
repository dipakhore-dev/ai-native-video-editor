from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from ..config import ProcessorSettings
from .ffprobe_service import VideoMetadataError, check_binary, extract_audio_metadata
from .job_store import sanitize_error_text, terminate_subprocess_tree
from .tts_providers import (
    EspeakNgProvider,
    PiperTtsProvider,
    WindowsSapiProvider,
    TtsCancelledError,
    TtsError,
    TtsProviderInfo,
    TtsSynthesisResult,
    TtsVoiceInfo,
    normalize_tts_language,
    validate_tts_params,
    validate_tts_text,
)
from .tts_providers.base import ProcessAttachCallback, TtsLanguageCode, TtsProviderId


_MP3_PROBE_LOCK = threading.Lock()
_MP3_PROBE_CACHE: dict[str, tuple[float, bool]] = {}

_TTS_SEMAPHORE_LOCK = threading.Lock()
_TTS_SEMAPHORE_CAPACITY = 0
_TTS_SEMAPHORE: Optional[threading.BoundedSemaphore] = None


def _get_tts_semaphore(capacity: int) -> threading.BoundedSemaphore:
    global _TTS_SEMAPHORE_CAPACITY, _TTS_SEMAPHORE
    with _TTS_SEMAPHORE_LOCK:
        if _TTS_SEMAPHORE is None or _TTS_SEMAPHORE_CAPACITY != capacity:
            _TTS_SEMAPHORE_CAPACITY = capacity
            _TTS_SEMAPHORE = threading.BoundedSemaphore(capacity)
        return _TTS_SEMAPHORE


def acquire_tts_slot(settings: ProcessorSettings) -> threading.BoundedSemaphore:
    sem = _get_tts_semaphore(max(1, settings.tts_max_concurrent_jobs))
    acquired = sem.acquire(timeout=2.0)
    if not acquired:
        raise TtsError(
            "Local voiceover queue is busy. Wait for the active synthesis request to complete.",
            status_code=429,
            code="tts_busy",
        )
    return sem


def check_ffmpeg_mp3_support(ffmpeg_bin: str) -> bool:
    resolved = check_binary(ffmpeg_bin)
    if not resolved:
        return False
    now = time.monotonic()
    with _MP3_PROBE_LOCK:
        cached = _MP3_PROBE_CACHE.get(resolved)
        if cached and (now - cached[0]) < 300.0:
            return cached[1]

    supported = False
    try:
        proc = subprocess.run(
            [resolved, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            shell=False,
        )
        if proc.returncode == 0:
            supported = "libmp3lame" in (proc.stdout or "")
    except Exception:
        supported = False

    with _MP3_PROBE_LOCK:
        _MP3_PROBE_CACHE[resolved] = (now, supported)
    return supported


def _build_providers(settings: ProcessorSettings) -> list[Any]:
    return [
        PiperTtsProvider(
            executable_path=settings.piper_executable_path,
            models_dir=settings.piper_models_dir,
        ),
        EspeakNgProvider(configured_path=settings.espeak_ng_path),
        WindowsSapiProvider(enabled=settings.tts_windows_sapi_enabled),
    ]


def get_tts_status(settings: ProcessorSettings) -> dict[str, Any]:
    try:
        default_lang = normalize_tts_language(settings.tts_default_language)
    except TtsError:
        default_lang = "en"

    mp3_ok = check_ffmpeg_mp3_support(settings.ffmpeg_bin)

    if not settings.tts_enabled or settings.tts_provider == "none":
        return {
            "enabled": False,
            "available": False,
            "configured_provider": settings.tts_provider,
            "active_provider": None,
            "default_language": default_lang,
            "supported_languages": [],
            "mp3_supported": mp3_ok,
            "max_text_chars": settings.tts_max_text_chars,
            "max_audio_mb": settings.tts_max_audio_mb,
            "providers": [],
            "message": "Local text-to-speech is disabled by server configuration (TTS_ENABLED=false or TTS_PROVIDER=none).",
        }

    providers = _build_providers(settings)
    infos: list[TtsProviderInfo] = [p.detect() for p in providers]

    available_infos = [
        info
        for info in infos
        if info.available
        and (settings.tts_provider == "auto" or info.provider == settings.tts_provider)
    ]

    supported_langs_set = {lang for info in available_infos for lang in info.supported_languages}
    supported_languages: list[TtsLanguageCode] = [
        code for code in ("en", "hi", "bn") if code in supported_langs_set
    ]  # type: ignore[assignment]

    active_provider: Optional[str] = available_infos[0].provider if available_infos else None
    is_available = len(available_infos) > 0 and check_binary(settings.ffmpeg_bin) is not None and check_binary(settings.ffprobe_bin) is not None

    if not check_binary(settings.ffmpeg_bin) or not check_binary(settings.ffprobe_bin):
        message = "FFmpeg and FFprobe are required for voiceover audio validation and normalization."
        is_available = False
    elif is_available:
        message = f"Local offline TTS ready ({active_provider}; languages: {', '.join(supported_languages)})."
    elif settings.tts_provider != "auto":
        message = (
            f"Configured TTS provider '{settings.tts_provider}' is not installed or has no supported voices."
        )
    else:
        message = (
            "No local TTS engine detected. Install eSpeak NG or configure Piper ONNX models to enable free offline voiceover synthesis."
        )

    return {
        "enabled": True,
        "available": is_available,
        "configured_provider": settings.tts_provider,
        "active_provider": active_provider if is_available else None,
        "default_language": default_lang,
        "supported_languages": supported_languages,
        "mp3_supported": mp3_ok,
        "max_text_chars": settings.tts_max_text_chars,
        "max_audio_mb": settings.tts_max_audio_mb,
        "providers": [info.to_dict() for info in infos],
        "message": message,
    }


def list_tts_voices(
    settings: ProcessorSettings,
    *,
    language: Optional[str] = None,
    provider: Optional[str] = None,
) -> dict[str, Any]:
    norm_lang: Optional[TtsLanguageCode] = (
        normalize_tts_language(language) if language is not None and str(language).strip() else None
    )
    norm_provider = (provider or "").strip().lower() or None
    if norm_provider and norm_provider not in ("auto", "piper", "espeak_ng", "windows_sapi"):
        raise TtsError(f"Unsupported TTS provider filter '{provider}'.", status_code=400, code="invalid_provider")

    status = get_tts_status(settings)
    if not status["enabled"]:
        return {
            "available": False,
            "provider": norm_provider,
            "language": norm_lang,
            "voices": [],
            "supported_languages": [],
            "message": status["message"],
        }

    voices: list[TtsVoiceInfo] = []
    for adapter in _build_providers(settings):
        if norm_provider and norm_provider != "auto" and adapter.provider_id != norm_provider:
            continue
        if settings.tts_provider not in ("auto", "none") and adapter.provider_id != settings.tts_provider:
            continue
        voices.extend(adapter.list_voices(language=norm_lang))

    return {
        "available": bool(status["available"]) and len(voices) > 0,
        "provider": norm_provider or status.get("active_provider"),
        "language": norm_lang,
        "voices": [v.to_dict() for v in voices],
        "supported_languages": status["supported_languages"],
        "message": (
            f"Found {len(voices)} local voice(s)."
            if voices
            else status["message"]
        ),
    }


def normalize_synthesized_audio(
    raw_wav_path: Path,
    output_path: Path,
    *,
    output_format: str = "wav",
    sample_rate_hz: int = 22050,
    channels: int = 1,
    max_audio_bytes: int = 25 * 1024 * 1024,
    max_duration_sec: float = 300.0,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 45,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict[str, Any]:
    if cancel_event is not None and cancel_event.is_set():
        raise TtsCancelledError()

    ffmpeg_path = check_binary(ffmpeg_bin)
    ffprobe_path = check_binary(ffprobe_bin)
    if not ffmpeg_path or not ffprobe_path:
        raise TtsError(
            "FFmpeg and FFprobe are required to validate and normalize synthesized voiceover audio.",
            status_code=503,
            code="ffmpeg_unavailable",
        )

    if not raw_wav_path.exists() or not raw_wav_path.is_file() or raw_wav_path.stat().st_size == 0:
        raise TtsError(
            "Synthesized raw audio file is missing or empty.",
            status_code=500,
            code="synthesis_failed",
        )

    fmt = output_format.strip().lower()
    if fmt == "mp3":
        if not check_ffmpeg_mp3_support(ffmpeg_bin):
            raise TtsError(
                "MP3 output requires FFmpeg compiled with libmp3lame. Use WAV (default) instead.",
                status_code=400,
                code="mp3_unsupported",
            )
        codec_args = ["-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3"]
    else:
        codec_args = ["-c:a", "pcm_s16le", "-f", "wav"]

    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(raw_wav_path),
        "-vn",
        "-ar",
        str(sample_rate_hz),
        "-ac",
        str(channels),
        *codec_args,
        str(output_path),
    ]

    popen_kwargs: dict[str, object] = {}
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if creationflags:
            popen_kwargs["creationflags"] = creationflags
    else:
        popen_kwargs["start_new_session"] = True

    proc: Optional[subprocess.Popen[bytes]] = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            **popen_kwargs,  # type: ignore[arg-type]
        )
        if process_cb is not None:
            process_cb(proc)

        deadline = time.monotonic() + max(5, timeout_sec)
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                terminate_subprocess_tree(proc)
                raise TtsCancelledError()
            if time.monotonic() > deadline:
                terminate_subprocess_tree(proc)
                raise TtsError(
                    "FFmpeg audio normalization timed out.",
                    status_code=504,
                    code="timeout",
                )
            time.sleep(0.05)

        if cancel_event is not None and cancel_event.is_set():
            raise TtsCancelledError()

        stderr_bytes = proc.stderr.read() if proc.stderr is not None else b""
        stderr_text = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
        if proc.returncode != 0:
            raise TtsError(
                sanitize_error_text(stderr_text, "FFmpeg failed to normalize synthesized voiceover audio."),
                status_code=500,
                code="normalization_failed",
            )
    finally:
        if process_cb is not None:
            process_cb(None)
        if proc is not None:
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    try:
                        pipe.close()
                    except Exception:
                        pass

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise TtsError(
            "Normalized voiceover audio file is empty.",
            status_code=500,
            code="validation_failed",
        )

    size_bytes = output_path.stat().st_size
    if size_bytes > max_audio_bytes:
        raise TtsError(
            f"Generated audio exceeds maximum allowed size ({max_audio_bytes // (1024 * 1024)} MB).",
            status_code=413,
            code="audio_too_large",
        )

    try:
        meta = extract_audio_metadata(
            output_path,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=15,
        )
    except VideoMetadataError as exc:
        raise TtsError(
            sanitize_error_text(str(exc), "Generated audio failed FFprobe stream verification."),
            status_code=422,
            code="validation_failed",
        ) from exc

    duration = float(meta.get("duration_seconds") or 0.0)
    if duration <= 0.0:
        raise TtsError(
            "Generated voiceover audio has zero playable duration.",
            status_code=422,
            code="validation_failed",
        )
    if duration > max_duration_sec:
        raise TtsError(
            f"Generated voiceover duration ({duration:.2f}s) exceeds max allowed duration ({max_duration_sec:.0f}s).",
            status_code=422,
            code="validation_failed",
        )

    audio_stream = meta.get("audio") or {}
    return {
        "duration_seconds": round(duration, 3),
        "size_bytes": size_bytes,
        "sample_rate_hz": int(audio_stream.get("sample_rate") or sample_rate_hz),
        "channels": int(audio_stream.get("channels") or channels),
        "format": fmt,
    }


def _select_provider_and_synthesize(
    settings: ProcessorSettings,
    *,
    text: str,
    language: TtsLanguageCode,
    requested_provider: Optional[str],
    voice_id: Optional[str],
    speaking_rate: float,
    pitch: float,
    raw_wav_path: Path,
    cancel_event: Optional[threading.Event],
    process_cb: Optional[ProcessAttachCallback],
) -> TtsVoiceInfo:
    eff_provider = (requested_provider or settings.tts_provider or "auto").strip().lower()
    if eff_provider == "none" or not settings.tts_enabled:
        raise TtsError(
            "Local TTS is disabled in server configuration.",
            status_code=503,
            code="tts_disabled",
        )

    adapters = {
        adapter.provider_id: adapter for adapter in _build_providers(settings)
    }

    if eff_provider != "auto":
        if eff_provider not in adapters:
            raise TtsError(
                f"Unknown TTS provider '{eff_provider}'.",
                status_code=400,
                code="invalid_provider",
            )
        adapter = adapters[eff_provider]  # type: ignore[index]
        return adapter.synthesize(
            text=text,
            language=language,
            voice_id=voice_id,
            speaking_rate=speaking_rate,
            pitch=pitch,
            output_wav_path=raw_wav_path,
            timeout_sec=settings.tts_request_timeout_sec,
            cancel_event=cancel_event,
            process_cb=process_cb,
        )

    # Auto-resolution: if voice_id has a provider prefix, route cleanly if available
    if voice_id:
        if voice_id.startswith("piper:"):
            return adapters["piper"].synthesize(
                text=text,
                language=language,
                voice_id=voice_id,
                speaking_rate=speaking_rate,
                pitch=pitch,
                output_wav_path=raw_wav_path,
                timeout_sec=settings.tts_request_timeout_sec,
                cancel_event=cancel_event,
                process_cb=process_cb,
            )
        if voice_id.startswith("espeak:"):
            return adapters["espeak_ng"].synthesize(
                text=text,
                language=language,
                voice_id=voice_id,
                speaking_rate=speaking_rate,
                pitch=pitch,
                output_wav_path=raw_wav_path,
                timeout_sec=settings.tts_request_timeout_sec,
                cancel_event=cancel_event,
                process_cb=process_cb,
            )
        if voice_id.startswith("sapi:"):
            return adapters["windows_sapi"].synthesize(
                text=text,
                language=language,
                voice_id=voice_id,
                speaking_rate=speaking_rate,
                pitch=pitch,
                output_wav_path=raw_wav_path,
                timeout_sec=settings.tts_request_timeout_sec,
                cancel_event=cancel_event,
                process_cb=process_cb,
            )

    # Prefer higher quality Piper ONNX if installed with matching language, else eSpeak NG, else Windows SAPI5
    order: tuple[TtsProviderId, ...] = ("piper", "espeak_ng", "windows_sapi")
    any_installed = False
    for pid in order:
        adapter = adapters[pid]
        info = adapter.detect()
        if info.installed:
            any_installed = True
        if info.available and language in info.supported_languages:
            return adapter.synthesize(
                text=text,
                language=language,
                voice_id=voice_id,
                speaking_rate=speaking_rate,
                pitch=pitch,
                output_wav_path=raw_wav_path,
                timeout_sec=settings.tts_request_timeout_sec,
                cancel_event=cancel_event,
                process_cb=process_cb,
            )

    if any_installed:
        raise TtsError(
            f"Installed local TTS engines do not have a voice for language '{language}'. No silent English fallback is used for Hindi or Bengali.",
            status_code=422,
            code="unsupported_language",
        )
    raise TtsError(
        "No local TTS engine is installed (eSpeak NG or Piper). Install a free local TTS binary to generate voiceovers.",
        status_code=503,
        code="tts_unavailable",
    )


def synthesize_tts_audio(
    settings: ProcessorSettings,
    job_dir: Path,
    *,
    text: str,
    language: str,
    provider: Optional[str] = None,
    voice_id: Optional[str] = None,
    speaking_rate: float = 1.0,
    pitch: float = 0.0,
    output_format: str = "wav",
    cancel_event: Optional[threading.Event] = None,
    progress_cb: Optional[Callable[[str, str, int, bool], None]] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> TtsSynthesisResult:
    if not settings.tts_enabled or settings.tts_provider == "none":
        raise TtsError(
            "Local TTS is disabled in server configuration.",
            status_code=503,
            code="tts_disabled",
        )

    cleaned_text = validate_tts_text(text, max_chars=settings.tts_max_text_chars)
    norm_lang = normalize_tts_language(language)
    rate_val, pitch_val, fmt = validate_tts_params(
        speaking_rate=speaking_rate,
        pitch=pitch,
        output_format=output_format,
    )

    if fmt == "mp3" and not check_ffmpeg_mp3_support(settings.ffmpeg_bin):
        raise TtsError(
            "MP3 export requires libmp3lame in FFmpeg. Switch output format to WAV.",
            status_code=400,
            code="mp3_unsupported",
        )

    sem = acquire_tts_slot(settings)
    try:
        if cancel_event is not None and cancel_event.is_set():
            raise TtsCancelledError()

        if progress_cb is not None:
            progress_cb("synthesizing", "Synthesizing speech locally", 30, True)

        raw_wav_path = job_dir / "raw_tts.wav"
        voice_used = _select_provider_and_synthesize(
            settings,
            text=cleaned_text,
            language=norm_lang,
            requested_provider=provider,
            voice_id=voice_id,
            speaking_rate=rate_val,
            pitch=pitch_val,
            raw_wav_path=raw_wav_path,
            cancel_event=cancel_event,
            process_cb=process_cb,
        )

        if cancel_event is not None and cancel_event.is_set():
            raise TtsCancelledError()

        if progress_cb is not None:
            progress_cb("normalizing", "Normalizing & verifying audio stream", 75, True)

        ext = "mp3" if fmt == "mp3" else "wav"
        final_path = job_dir / f"voiceover_normalized.{ext}"
        norm_meta = normalize_synthesized_audio(
            raw_wav_path,
            final_path,
            output_format=fmt,
            sample_rate_hz=22050,
            channels=1,
            max_audio_bytes=settings.tts_max_audio_mb * 1024 * 1024,
            max_duration_sec=max(60.0, settings.max_short_video_sec),
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            timeout_sec=settings.tts_request_timeout_sec,
            cancel_event=cancel_event,
            process_cb=process_cb,
        )

        if progress_cb is not None:
            progress_cb("completed", "Voiceover audio verified", 100, True)

        return TtsSynthesisResult(
            output_path=final_path,
            provider=voice_used.provider,
            voice_id=voice_used.voice_id,
            voice_label=voice_used.label,
            language=norm_lang,
            sample_rate_hz=int(norm_meta["sample_rate_hz"]),
            channels=int(norm_meta["channels"]),
            audio_format=fmt,
            mime_type="audio/mpeg" if fmt == "mp3" else "audio/wav",
            duration_seconds=float(norm_meta["duration_seconds"]),
            size_bytes=int(norm_meta["size_bytes"]),
        )
    finally:
        sem.release()
