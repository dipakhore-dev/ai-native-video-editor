from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

from ...utils.file_cleanup import FileValidationError, resolve_within_base
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


_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_VOICE_JSON_BYTES = 1024 * 1024


def resolve_piper_binary(configured_path: str = "") -> Optional[str]:
    candidate = (configured_path or "").strip()
    if candidate:
        p = Path(candidate)
        if p.is_file():
            return str(p)
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        return None

    for name in ("piper", "piper.exe"):
        resolved = shutil.which(name)
        if resolved:
            return resolved
    return None


def _read_piper_model_metadata(onnx_path: Path, base_dir: Path) -> Optional[dict[str, Any]]:
    candidates = [
        Path(f"{onnx_path}.json"),
        onnx_path.with_suffix(".json"),
    ]
    for cfg_path in candidates:
        try:
            resolved_cfg = resolve_within_base(base_dir, cfg_path)
        except FileValidationError:
            continue
        if not resolved_cfg.is_file():
            continue
        try:
            if resolved_cfg.stat().st_size > _MAX_VOICE_JSON_BYTES:
                continue
            return json.loads(resolved_cfg.read_text(encoding="utf-8"))
        except Exception:
            continue
    return None


def discover_piper_models(models_dir: str) -> tuple[list[TtsVoiceInfo], dict[str, Path]]:
    raw_dir = (models_dir or "").strip()
    if not raw_dir:
        return [], {}
    base_dir = Path(raw_dir)
    if not base_dir.exists() or not base_dir.is_dir():
        return [], {}

    voices: list[TtsVoiceInfo] = []
    model_paths: dict[str, Path] = {}
    seen_ids: set[str] = set()

    try:
        candidates = sorted(base_dir.rglob("*.onnx"))
    except OSError:
        return [], {}

    for onnx_path in candidates:
        try:
            resolved_onnx = resolve_within_base(base_dir, onnx_path)
        except FileValidationError:
            continue
        if not resolved_onnx.is_file():
            continue

        meta = _read_piper_model_metadata(resolved_onnx, base_dir)
        rel_stem = resolved_onnx.relative_to(base_dir.resolve()).with_suffix("").as_posix()
        lang_tag = ""
        sample_rate_hz: Optional[int] = None
        quality = "medium"
        dataset_name = ""

        if isinstance(meta, dict):
            lang_obj = meta.get("language")
            if isinstance(lang_obj, dict):
                lang_tag = str(lang_obj.get("code") or lang_obj.get("name_english") or "").strip()
            audio_obj = meta.get("audio")
            if isinstance(audio_obj, dict):
                raw_sr = audio_obj.get("sample_rate")
                if isinstance(raw_sr, (int, float)) and raw_sr > 0:
                    sample_rate_hz = int(raw_sr)
                raw_q = audio_obj.get("quality")
                if isinstance(raw_q, str) and raw_q.strip():
                    quality = raw_q.strip().lower()
            dataset_name = str(meta.get("dataset") or "").strip()

        if not lang_tag:
            # Infer from conventional Piper model filename prefix e.g. en_US-lessac-medium.onnx
            lang_prefix_match = re.match(r"^([a-z]{2}[_-][A-Z]{2})-", resolved_onnx.stem)
            if lang_prefix_match:
                lang_tag = lang_prefix_match.group(1)

        mapped_lang = map_language_tag_to_tts_code(lang_tag)
        if mapped_lang is None:
            continue

        slug = _SLUG_RE.sub("_", rel_stem).strip("_")[:120]
        if not slug:
            continue
        voice_id = f"piper:{slug}"
        if voice_id in seen_ids:
            continue
        seen_ids.add(voice_id)

        pretty_name = dataset_name or resolved_onnx.stem.replace("_", " ").replace("-", " ").strip()
        voices.append(
            TtsVoiceInfo(
                voice_id=voice_id,
                provider="piper",
                label=f"{pretty_name} ({lang_tag or mapped_lang}, {quality})",
                language=mapped_lang,
                language_tag=lang_tag or mapped_lang,
                quality=quality,
                sample_rate_hz=sample_rate_hz or 22050,
                description="Piper local ONNX neural voice",
            )
        )
        model_paths[voice_id] = resolved_onnx

    return voices, model_paths


class PiperTtsProvider:
    provider_id: TtsProviderId = "piper"
    label: str = "Piper TTS (Local Neural ONNX)"
    license: str = "GPL-3.0-or-later (piper1-gpl) / per-voice model license"

    def __init__(self, executable_path: str = "", models_dir: str = "") -> None:
        self._executable_path = executable_path
        self._models_dir = models_dir

    def detect(self) -> TtsProviderInfo:
        binary = resolve_piper_binary(self._executable_path)
        voices, _ = discover_piper_models(self._models_dir)
        langs: list[TtsLanguageCode] = [
            code for code in ("en", "hi", "bn") if any(v.language == code for v in voices)
        ]  # type: ignore[assignment]

        if not binary:
            return TtsProviderInfo(
                provider="piper",
                label=self.label,
                available=False,
                installed=False,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="Piper executable not configured (set PIPER_EXECUTABLE_PATH and PIPER_MODELS_DIR).",
            )

        if not voices:
            return TtsProviderInfo(
                provider="piper",
                label=self.label,
                available=False,
                installed=True,
                license=self.license,
                supported_languages=[],
                voice_count=0,
                message="Piper binary found, but no valid .onnx voice models were discovered in PIPER_MODELS_DIR.",
            )

        return TtsProviderInfo(
            provider="piper",
            label=self.label,
            available=True,
            installed=True,
            license=self.license,
            supported_languages=langs,
            voice_count=len(voices),
            message=f"Piper active with {len(voices)} local ONNX voice(s) ({', '.join(langs)}).",
        )

    def list_voices(self, language: Optional[TtsLanguageCode] = None) -> list[TtsVoiceInfo]:
        binary = resolve_piper_binary(self._executable_path)
        if not binary:
            return []
        voices, _ = discover_piper_models(self._models_dir)
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

        binary = resolve_piper_binary(self._executable_path)
        if not binary:
            raise TtsError(
                "Piper TTS executable is not configured or installed.",
                status_code=503,
                code="tts_unavailable",
            )

        voices, model_paths = discover_piper_models(self._models_dir)
        lang_voices = [v for v in voices if v.language == language]
        if not lang_voices:
            raise TtsError(
                f"No Piper .onnx voice model is installed for language '{language}'.",
                status_code=422,
                code="unsupported_language",
            )

        selected_voice: Optional[TtsVoiceInfo] = None
        if voice_id:
            selected_voice = next((v for v in lang_voices if v.voice_id == voice_id), None)
            if selected_voice is None:
                raise TtsError(
                    f"Requested Piper voice '{voice_id}' is not installed for language '{language}'.",
                    status_code=400,
                    code="voice_not_found",
                )
        else:
            selected_voice = lang_voices[0]

        model_path = model_paths.get(selected_voice.voice_id)
        if model_path is None or not model_path.is_file():
            raise TtsError("Selected Piper voice model file is unavailable.", status_code=404, code="voice_not_found")

        # Piper length_scale < 1.0 speeds speech up; > 1.0 slows it down
        length_scale = max(0.65, min(1.67, 1.0 / max(0.6, speaking_rate)))
        cmd = [
            binary,
            "--model",
            str(model_path),
            "--length_scale",
            f"{length_scale:.3f}",
            "--output_file",
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
                        f"Piper TTS timed out after {timeout_sec}s while generating voiceover.",
                        status_code=504,
                        code="timeout",
                    )
                time.sleep(0.05)

            if cancel_event is not None and cancel_event.is_set():
                raise TtsCancelledError()

            stderr_bytes = proc.stderr.read() if proc.stderr is not None else b""
            stderr_text = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""
            if proc.returncode != 0:
                detail = sanitize_error_text(stderr_text, "Piper TTS failed to synthesize audio.")
                raise TtsError(detail, status_code=500, code="synthesis_failed")

            if not output_wav_path.exists() or output_wav_path.stat().st_size == 0:
                raise TtsError(
                    "Piper TTS produced an empty audio file.",
                    status_code=500,
                    code="synthesis_failed",
                )
            return selected_voice
        except (TtsError, TtsCancelledError):
            raise
        except OSError as exc:
            raise TtsError(
                f"Failed to launch Piper TTS: {sanitize_error_text(str(exc), 'execution failed')}",
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
