from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Optional, Protocol
import subprocess
import threading


TtsLanguageCode = Literal["en", "hi", "bn"]
TtsProviderId = Literal["piper", "espeak_ng", "windows_sapi"]
TtsAudioFormat = Literal["wav", "mp3"]

SUPPORTED_TTS_LANGUAGES: tuple[TtsLanguageCode, ...] = ("en", "hi", "bn")

ProcessAttachCallback = Callable[[Optional[subprocess.Popen[Any]]], None]


class TtsError(Exception):
    """Raised when local TTS validation, provider lookup, or synthesis fails."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 400,
        code: str = "tts_error",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class TtsCancelledError(Exception):
    """Raised when an active TTS synthesis job is cancelled."""

    def __init__(self, message: str = "Voiceover synthesis cancelled by user.") -> None:
        super().__init__(message)
        self.status_code = 499


@dataclass(frozen=True)
class TtsVoiceInfo:
    voice_id: str
    provider: TtsProviderId
    label: str
    language: TtsLanguageCode
    language_tag: str
    gender: Optional[str] = None
    quality: str = "standard"
    sample_rate_hz: Optional[int] = None
    description: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "voice_id": self.voice_id,
            "provider": self.provider,
            "label": self.label,
            "language": self.language,
            "language_tag": self.language_tag,
            "gender": self.gender,
            "quality": self.quality,
            "sample_rate_hz": self.sample_rate_hz,
            "description": self.description,
        }


@dataclass(frozen=True)
class TtsProviderInfo:
    provider: TtsProviderId
    label: str
    available: bool
    installed: bool
    license: str
    supported_languages: list[TtsLanguageCode] = field(default_factory=list)
    voice_count: int = 0
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "label": self.label,
            "available": self.available,
            "installed": self.installed,
            "license": self.license,
            "supported_languages": list(self.supported_languages),
            "voice_count": self.voice_count,
            "message": self.message,
        }


@dataclass(frozen=True)
class TtsSynthesisResult:
    output_path: Path
    provider: TtsProviderId
    voice_id: str
    voice_label: str
    language: TtsLanguageCode
    sample_rate_hz: int
    channels: int
    audio_format: TtsAudioFormat
    mime_type: str
    duration_seconds: float
    size_bytes: int


class TtsProviderAdapter(Protocol):
    provider_id: TtsProviderId
    label: str
    license: str

    def detect(self) -> TtsProviderInfo: ...

    def list_voices(self, language: Optional[TtsLanguageCode] = None) -> list[TtsVoiceInfo]: ...

    def synthesize(
        self,
        *,
        text: str,
        language: TtsLanguageCode,
        voice_id: Optional[str],
        speaking_rate: float,
        pitch: float,
        output_wav_path: Path,
        timeout_sec: int,
        cancel_event: Optional[threading.Event] = None,
        process_cb: Optional[ProcessAttachCallback] = None,
    ) -> TtsVoiceInfo: ...


_LANGUAGE_ALIASES: dict[str, TtsLanguageCode] = {
    "en": "en",
    "en-us": "en",
    "en_us": "en",
    "en-gb": "en",
    "en_gb": "en",
    "en-in": "en",
    "en_in": "en",
    "en-au": "en",
    "english": "en",
    "hi": "hi",
    "hi-in": "hi",
    "hi_in": "hi",
    "hindi": "hi",
    "bn": "bn",
    "bn-bd": "bn",
    "bn_bd": "bn",
    "bn-in": "bn",
    "bn_in": "bn",
    "bengali": "bn",
    "bangla": "bn",
}


def normalize_tts_language(raw: Optional[str]) -> TtsLanguageCode:
    if not raw or not str(raw).strip():
        raise TtsError("Language is required (English 'en', Hindi 'hi', or Bengali 'bn').", status_code=400, code="invalid_language")
    norm = str(raw).strip().lower().replace(" ", "")
    mapped = _LANGUAGE_ALIASES.get(norm)
    if mapped is not None:
        return mapped
    prefix = norm.split("-")[0].split("_")[0]
    mapped = _LANGUAGE_ALIASES.get(prefix)
    if mapped is not None:
        return mapped
    raise TtsError(
        f"Unsupported TTS language '{raw}'. Supported languages: English (en), Hindi (hi), Bengali (bn).",
        status_code=400,
        code="unsupported_language",
    )


def map_language_tag_to_tts_code(raw_tag: Optional[str]) -> Optional[TtsLanguageCode]:
    if not raw_tag:
        return None
    norm = str(raw_tag).strip().lower()
    if norm in _LANGUAGE_ALIASES:
        return _LANGUAGE_ALIASES[norm]
    prefix = norm.split("-")[0].split("_")[0]
    return _LANGUAGE_ALIASES.get(prefix)


def validate_tts_text(raw_text: Any, *, max_chars: int = 1500) -> str:
    if not isinstance(raw_text, str):
        raise TtsError("Narration text must be a string.", status_code=400, code="invalid_text")

    for ch in raw_text:
        code = ord(ch)
        if code == 0 or (code < 32 and ch not in ("\n", "\r", "\t")) or code == 127:
            raise TtsError(
                "Narration text contains unsupported control characters.",
                status_code=400,
                code="invalid_text",
            )

    cleaned = raw_text.strip()
    if not cleaned:
        raise TtsError("Scene narration text cannot be empty.", status_code=400, code="empty_text")

    if len(cleaned) > max_chars:
        raise TtsError(
            f"Narration text exceeds the maximum allowed length of {max_chars} characters.",
            status_code=400,
            code="text_too_long",
        )
    return cleaned


def validate_tts_params(
    *,
    speaking_rate: float = 1.0,
    pitch: float = 0.0,
    output_format: str = "wav",
) -> tuple[float, float, TtsAudioFormat]:
    try:
        rate_val = float(speaking_rate)
    except (TypeError, ValueError) as exc:
        raise TtsError("Speaking rate must be a finite number.", status_code=400, code="invalid_rate") from exc
    if rate_val < 0.6 or rate_val > 1.5:
        raise TtsError(
            "Speaking rate must be between 0.6x and 1.5x.",
            status_code=400,
            code="invalid_rate",
        )

    try:
        pitch_val = float(pitch)
    except (TypeError, ValueError) as exc:
        raise TtsError("Pitch adjustment must be a finite number.", status_code=400, code="invalid_pitch") from exc
    if pitch_val < -20.0 or pitch_val > 20.0:
        raise TtsError(
            "Pitch adjustment must be between -20 and +20.",
            status_code=400,
            code="invalid_pitch",
        )

    fmt_norm = str(output_format or "wav").strip().lower()
    if fmt_norm not in ("wav", "mp3"):
        raise TtsError(
            f"Unsupported audio format '{output_format}'. Choose 'wav' or 'mp3'.",
            status_code=400,
            code="invalid_format",
        )

    return round(rate_val, 3), round(pitch_val, 2), fmt_norm  # type: ignore[return-value]
