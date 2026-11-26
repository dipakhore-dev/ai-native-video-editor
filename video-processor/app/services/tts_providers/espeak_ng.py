from __future__ import annotations

import os
import re
import shutil
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


_SAFE_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$")


def resolve_espeak_ng_binary(configured_path: str = "") -> Optional[str]:
    candidate = (configured_path or "").strip()
    if candidate:
        p = Path(candidate)
        if p.is_file():
            return str(p)
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        return None

    for name in ("espeak-ng", "espeak-ng.exe"):
        resolved = shutil.which(name)
        if resolved:
            return resolved

    if sys.platform == "win32" or os.name == "nt":
        for win_candidate in (
            Path(r"C:\Program Files\eSpeak NG\espeak-ng.exe"),
            Path(r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe"),
        ):
            if win_candidate.is_file():
                return str(win_candidate)

    return None


def parse_espeak_voices_output(stdout_text: str) -> list[TtsVoiceInfo]:
    voices: list[TtsVoiceInfo] = []
    seen_ids: set[str] = set()

    for raw_line in (stdout_text or "").splitlines():
        line = raw_line.strip()
        if not line or line.lower().startswith("pty"):
            continue

        # Standard eSpeak NG --voices format:
        # Pty  Language  Age/Gender  VoiceName  File  Other Languages
        parts = re.split(r"\s+", line)
        if len(parts) < 5:
            continue

        lang_tag = parts[1].strip()
        age_gender = parts[2].strip()
        voice_name = parts[3].strip()
        voice_file = parts[4].strip()

        mapped_lang = map_language_tag_to_tts_code(lang_tag)
        if mapped_lang is None:
            continue

        # Prefer clean voice specifier recognized by `espeak-ng -v <spec>`
        spec = lang_tag if _SAFE_VOICE_ID_RE.match(lang_tag) else Path(voice_file).name
        if not _SAFE_VOICE_ID_RE.match(spec):
            continue

        voice_id = f"espeak:{spec}"
        if voice_id in seen_ids:
            continue
        seen_ids.add(voice_id)

        gender: Optional[str] = None
        if "/" in age_gender:
            g_part = age_gender.split("/", 1)[1].strip().upper()
            if g_part == "M":
                gender = "male"
            elif g_part == "F":
                gender = "female"

        clean_name = voice_name.replace("_", " ").replace("-", " ").strip() or spec
        voices.append(
            TtsVoiceInfo(
                voice_id=voice_id,
                provider="espeak_ng",
                label=f"{clean_name} ({lang_tag})",
                language=mapped_lang,
                language_tag=lang_tag,
                gender=gender,
                quality="formant",
                sample_rate_hz=22050,
                description="eSpeak NG lightweight offline formant voice",
            )
        )

    return voices


class EspeakNgProvider:
    provider_id: TtsProviderId = "espeak_ng"
    label: str = "eSpeak NG (Offline Formant TTS)"
    license: str = "GPL-3.0-or-later"

    def __init__(self, configured_path: str = "") -> None:
        self._configured_path = configured_path

    def _query_voices(self, binary_path: str) -> list[TtsVoiceInfo]:
        all_voices: list[TtsVoiceInfo] = []
        seen: set[str] = set()
        # Query general voice list plus explicit en/hi/bn filters to catch non-default data packs
        for arg in ("--voices", "--voices=en", "--voices=hi", "--voices=bn"):
            try:
                proc = subprocess.run(
                    [binary_path, arg],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=5,
                    check=False,
                    shell=False,
                )
            except Exception:
                continue
            if proc.returncode != 0:
                continue
            for item in parse_espeak_voices_output(proc.stdout):
                if item.voice_id not in seen:
                    seen.add(item.voice_id)
                    all_voices.append(item)
        return all_voices

    def detect(self) -> TtsProviderInfo:
        binary = resolve_espeak_ng_binary(self._configured_path)
        if not binary:
            return TtsProviderInfo(
                provider="espeak_ng",
                label=self.label,
                available=False,
                installed=False,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="eSpeak NG executable was not found on PATH or ESPEAK_NG_PATH.",
            )

        voices = self._query_voices(binary)
        langs = sorted({v.language for v in voices})
        # Preserve canonical en, hi, bn ordering
        ordered_langs: list[TtsLanguageCode] = [
            code for code in ("en", "hi", "bn") if code in langs
        ]  # type: ignore[assignment]

        if not voices:
            return TtsProviderInfo(
                provider="espeak_ng",
                label=self.label,
                available=False,
                installed=True,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="eSpeak NG is installed, but no English, Hindi, or Bengali voices were reported.",
            )

        return TtsProviderInfo(
            provider="espeak_ng",
            label=self.label,
            available=True,
            installed=True,
            license=self.license,
            supported_languages=ordered_langs,
            voice_count=len(voices),
            message=f"eSpeak NG active with {len(voices)} voice(s) across {', '.join(ordered_langs)}.",
        )

    def list_voices(self, language: Optional[TtsLanguageCode] = None) -> list[TtsVoiceInfo]:
        binary = resolve_espeak_ng_binary(self._configured_path)
        if not binary:
            return []
        voices = self._query_voices(binary)
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

        binary = resolve_espeak_ng_binary(self._configured_path)
        if not binary:
            raise TtsError(
                "eSpeak NG is not installed on this machine.",
                status_code=503,
                code="tts_unavailable",
            )

        available_voices = self._query_voices(binary)
        lang_voices = [v for v in available_voices if v.language == language]
        if not lang_voices:
            raise TtsError(
                f"eSpeak NG does not have a voice installed for language '{language}'.",
                status_code=422,
                code="unsupported_language",
            )

        selected_voice: Optional[TtsVoiceInfo] = None
        if voice_id:
            selected_voice = next((v for v in lang_voices if v.voice_id == voice_id), None)
            if selected_voice is None:
                raise TtsError(
                    f"Requested eSpeak NG voice '{voice_id}' is not available for language '{language}'.",
                    status_code=400,
                    code="voice_not_found",
                )
        else:
            # Prefer exact base language code (en, hi, bn) or en-us if available
            preferred_ids = (f"espeak:{language}", "espeak:en-us", "espeak:en-gb")
            for pref in preferred_ids:
                match = next((v for v in lang_voices if v.voice_id == pref), None)
                if match is not None:
                    selected_voice = match
                    break
            if selected_voice is None:
                selected_voice = lang_voices[0]

        voice_spec = selected_voice.voice_id.removeprefix("espeak:")
        if not _SAFE_VOICE_ID_RE.match(voice_spec):
            raise TtsError("Invalid eSpeak NG voice identifier.", status_code=400, code="voice_not_found")

        wpm = max(80, min(320, int(round(175 * speaking_rate))))
        espeak_pitch = max(10, min(90, int(round(50 + pitch * 2))))

        cmd = [
            binary,
            "-v",
            voice_spec,
            "-s",
            str(wpm),
            "-p",
            str(espeak_pitch),
            "--stdin",
            "-w",
            str(output_wav_path),
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
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                **popen_kwargs,  # type: ignore[arg-type]
            )
            if process_cb is not None:
                process_cb(proc)

            if proc.stdin is not None:
                proc.stdin.write(text.encode("utf-8"))
                proc.stdin.close()

            deadline = time.monotonic() + max(5, timeout_sec)
            while proc.poll() is None:
                if cancel_event is not None and cancel_event.is_set():
                    terminate_subprocess_tree(proc)
                    raise TtsCancelledError()
                if time.monotonic() > deadline:
                    terminate_subprocess_tree(proc)
                    raise TtsError(
                        f"eSpeak NG timed out after {timeout_sec}s while generating voiceover.",
                        status_code=504,
                        code="timeout",
                    )
                time.sleep(0.05)

            if cancel_event is not None and cancel_event.is_set():
                raise TtsCancelledError()

            stderr_bytes = proc.stderr.read() if proc.stderr is not None else b""
            stderr_text = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
            if proc.returncode != 0:
                detail = sanitize_error_text(stderr_text, "eSpeak NG failed to synthesize audio.")
                raise TtsError(detail, status_code=500, code="synthesis_failed")

            if not output_wav_path.exists() or output_wav_path.stat().st_size == 0:
                raise TtsError(
                    "eSpeak NG produced an empty audio file.",
                    status_code=500,
                    code="synthesis_failed",
                )
            return selected_voice
        except (TtsError, TtsCancelledError):
            raise
        except OSError as exc:
            raise TtsError(
                f"Failed to launch eSpeak NG: {sanitize_error_text(str(exc), 'execution failed')}",
                status_code=500,
                code="synthesis_failed",
            ) from exc
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
