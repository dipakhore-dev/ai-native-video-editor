from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from ..job_store import sanitize_error_text, terminate_subprocess_tree
from .base import (
    ProcessAttachCallback,
    TtsCancelledError,
    TtsError,
    TtsLanguageCode,
    TtsProviderId,
    TtsProviderInfo,
    TtsVoiceInfo,
    map_language_tag_to_tts_code,
)


_LIST_VOICES_SCRIPT = """
import json, pyttsx3
engine = pyttsx3.init()
voices = []
for v in (engine.getProperty('voices') or []):
    langs = []
    for raw_l in (getattr(v, 'languages', None) or []):
        if isinstance(raw_l, (bytes, bytearray)):
            langs.append(raw_l.decode('utf-8', errors='ignore'))
        else:
            langs.append(str(raw_l))
    voices.append({
        'id': str(getattr(v, 'id', '')),
        'name': str(getattr(v, 'name', '')),
        'languages': langs,
    })
print(json.dumps(voices))
"""

_SYNTH_SCRIPT = """
import json, sys, pyttsx3
payload = json.loads(sys.stdin.read())
engine = pyttsx3.init()
if payload.get('voice_id'):
    engine.setProperty('voice', payload['voice_id'])
engine.setProperty('rate', int(payload.get('rate', 175)))
engine.save_to_file(payload['text'], payload['output_path'])
engine.runAndWait()
"""


def is_windows_sapi_supported(enabled: bool) -> bool:
    if not enabled:
        return False
    if sys.platform != "win32" and os.name != "nt":
        return False
    return importlib.util.find_spec("pyttsx3") is not None


class WindowsSapiProvider:
    provider_id: TtsProviderId = "windows_sapi"
    label: str = "Windows SAPI5 (pyttsx3 Fallback)"
    license: str = "MPL-2.0 (pyttsx3) / Windows Built-in SAPI5"

    def __init__(self, enabled: bool = False) -> None:
        self._enabled = enabled

    def _query_voices(self) -> tuple[list[TtsVoiceInfo], dict[str, str]]:
        if not is_windows_sapi_supported(self._enabled):
            return [], {}
        try:
            proc = subprocess.run(
                [sys.executable, "-c", _LIST_VOICES_SCRIPT],
                capture_output=True,
                text=True,
                timeout=6,
                check=False,
                shell=False,
            )
            if proc.returncode != 0 or not proc.stdout.strip():
                return [], {}
            raw_list = json.loads(proc.stdout.strip())
        except Exception:
            return [], {}

        voices: list[TtsVoiceInfo] = []
        raw_id_map: dict[str, str] = {}
        for idx, item in enumerate(raw_list if isinstance(raw_list, list) else []):
            if not isinstance(item, dict):
                continue
            raw_id = str(item.get("id") or "").strip()
            name = str(item.get("name") or f"SAPI Voice {idx + 1}").strip()
            raw_langs = item.get("languages") or []
            mapped_lang: Optional[TtsLanguageCode] = None
            lang_tag = "en-US"
            for candidate in raw_langs:
                mapped = map_language_tag_to_tts_code(str(candidate))
                if mapped:
                    mapped_lang = mapped
                    lang_tag = str(candidate)
                    break
            if mapped_lang is None:
                lower_name = name.lower()
                if "hindi" in lower_name or "hemant" in lower_name or "kalpana" in lower_name:
                    mapped_lang = "hi"
                    lang_tag = "hi-IN"
                elif "bengali" in lower_name or "bangla" in lower_name:
                    mapped_lang = "bn"
                    lang_tag = "bn-IN"
                elif "english" in lower_name or "zira" in lower_name or "david" in lower_name or "mark" in lower_name:
                    mapped_lang = "en"
                    lang_tag = "en-US"
            if mapped_lang is None:
                continue

            safe_id = f"sapi:{idx}"
            raw_id_map[safe_id] = raw_id
            voices.append(
                TtsVoiceInfo(
                    voice_id=safe_id,
                    provider="windows_sapi",
                    label=name,
                    language=mapped_lang,
                    language_tag=lang_tag,
                    quality="system",
                    sample_rate_hz=22050,
                    description="Windows built-in SAPI5 voice",
                )
            )
        return voices, raw_id_map

    def detect(self) -> TtsProviderInfo:
        if sys.platform != "win32" and os.name != "nt":
            return TtsProviderInfo(
                provider="windows_sapi",
                label=self.label,
                available=False,
                installed=False,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="Windows SAPI5 is only available on Windows hosts.",
            )
        if not is_windows_sapi_supported(self._enabled):
            return TtsProviderInfo(
                provider="windows_sapi",
                label=self.label,
                available=False,
                installed=False,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="Windows SAPI5 optional fallback is disabled or pyttsx3 is not installed.",
            )
        voices, _ = self._query_voices()
        langs: list[TtsLanguageCode] = [
            code for code in ("en", "hi", "bn") if any(v.language == code for v in voices)
        ]  # type: ignore[assignment]
        return TtsProviderInfo(
            provider="windows_sapi",
            label=self.label,
            available=len(voices) > 0,
            installed=True,
            license=self.license,
            supported_languages=langs,
            voice_count=len(voices),
            message=f"Windows SAPI5 active with {len(voices)} installed system voice(s)."
            if voices
            else "pyttsx3 detected no matching en/hi/bn Windows SAPI5 voices.",
        )

    def list_voices(self, language: Optional[TtsLanguageCode] = None) -> list[TtsVoiceInfo]:
        voices, _ = self._query_voices()
        if language:
            return [v for v in voices if v.language == language]
        return voices

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
    ) -> TtsVoiceInfo:
        if cancel_event is not None and cancel_event.is_set():
            raise TtsCancelledError()
        if not is_windows_sapi_supported(self._enabled):
            raise TtsError(
                "Windows SAPI5 TTS fallback is unavailable on this platform.",
                status_code=503,
                code="tts_unavailable",
            )

        voices, raw_id_map = self._query_voices()
        lang_voices = [v for v in voices if v.language == language]
        if not lang_voices:
            raise TtsError(
                f"No Windows SAPI5 voice is installed for language '{language}'.",
                status_code=422,
                code="unsupported_language",
            )

        selected = (
            next((v for v in lang_voices if v.voice_id == voice_id), None)
            if voice_id
            else lang_voices[0]
        )
        if selected is None:
            raise TtsError(
                f"Requested Windows SAPI5 voice '{voice_id}' is unavailable for '{language}'.",
                status_code=400,
                code="voice_not_found",
            )

        rate_wpm = max(90, min(300, int(round(175 * speaking_rate))))
        payload = json.dumps(
            {
                "text": text,
                "voice_id": raw_id_map.get(selected.voice_id, ""),
                "rate": rate_wpm,
                "output_path": str(output_wav_path),
            }
        )

        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        proc: Optional[subprocess.Popen[bytes]] = None
        try:
            proc = subprocess.Popen(
                [sys.executable, "-c", _SYNTH_SCRIPT],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                **({"creationflags": creationflags} if creationflags else {}),
            )
            if process_cb is not None:
                process_cb(proc)

            if proc.stdin is not None:
                proc.stdin.write(payload.encode("utf-8"))
                proc.stdin.close()

            deadline = time.monotonic() + max(5, timeout_sec)
            while proc.poll() is None:
                if cancel_event is not None and cancel_event.is_set():
                    terminate_subprocess_tree(proc)
                    raise TtsCancelledError()
                if time.monotonic() > deadline:
                    terminate_subprocess_tree(proc)
                    raise TtsError(
                        f"Windows SAPI5 synthesis timed out after {timeout_sec}s.",
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
                    sanitize_error_text(stderr_text, "Windows SAPI5 synthesis failed."),
                    status_code=500,
                    code="synthesis_failed",
                )
            if not output_wav_path.exists() or output_wav_path.stat().st_size == 0:
                raise TtsError("Windows SAPI5 produced an empty audio file.", status_code=500, code="synthesis_failed")
            return selected
        finally:
            if process_cb is not None:
                process_cb(None)
            if proc is not None:
                for pipe in (proc.stdin, proc.stdout, proc.stderr):
                    if pipe is not None:
                        try:
                            pipe.close()
                        except Exception:
                            pass
