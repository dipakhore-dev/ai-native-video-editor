from __future__ import annotations

import logging
import math
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Literal, Optional, Sequence

from .ffprobe_service import check_binary, extract_audio_metadata, extract_video_metadata

logger = logging.getLogger("video_processor.ffmpeg")


AspectRatioTarget = Literal["16:9", "9:16", "1:1"]
FitMode = Literal["crop", "pad"]
ResolutionTarget = Literal["720p", "1080p"]
ExportProfileId = Literal["fast_preview", "balanced", "high_quality"]
EncodingModeTarget = Literal["auto", "cpu", "gpu"]

StageProgressCallback = Callable[[str, str, int, bool], None]
SubprocessProgressCallback = Callable[[float, bool], None]
ProcessAttachCallback = Callable[[Optional[subprocess.Popen[str]]], None]

EXPORT_PROFILES: dict[str, dict[str, object]] = {
    "fast_preview": {
        "id": "fast_preview",
        "label": "Fast Preview",
        "resolution": "720p",
        "x264_preset": "ultrafast",
        "crf": 26,
        "nvenc_preset": "p1",
        "nvenc_cq": 28,
        "qsv_preset": "veryfast",
        "qsv_quality": 27,
        "amf_quality": "speed",
        "amf_qp": 27,
        "audio_bitrate": "128k",
        "description": "720p H.264 ultrafast (CRF 26) — fastest render for quick drafts and reviews.",
    },
    "balanced": {
        "id": "balanced",
        "label": "Balanced",
        "resolution": "1080p",
        "x264_preset": "veryfast",
        "crf": 22,
        "nvenc_preset": "p4",
        "nvenc_cq": 23,
        "qsv_preset": "faster",
        "qsv_quality": 23,
        "amf_quality": "balanced",
        "amf_qp": 22,
        "audio_bitrate": "192k",
        "description": "1080p H.264 veryfast (CRF 22) — crisp quality with fast speed and moderate file size.",
    },
    "high_quality": {
        "id": "high_quality",
        "label": "High Quality",
        "resolution": "1080p",
        "x264_preset": "medium",
        "crf": 19,
        "nvenc_preset": "p6",
        "nvenc_cq": 19,
        "qsv_preset": "medium",
        "qsv_quality": 19,
        "amf_quality": "quality",
        "amf_qp": 19,
        "audio_bitrate": "192k",
        "description": "1080p H.264 medium (CRF 19) — highest detail retention and compression efficiency.",
    },
}

_LEGACY_PROFILE_SPEC: dict[str, object] = {
    "id": "balanced",
    "label": "Balanced",
    "resolution": "720p",
    "x264_preset": "veryfast",
    "crf": 22,
    "nvenc_preset": "p4",
    "nvenc_cq": 23,
    "qsv_preset": "faster",
    "qsv_quality": 23,
    "amf_quality": "balanced",
    "amf_qp": 22,
    "audio_bitrate": "192k",
}

_HARDWARE_ENCODER_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("h264_nvenc", "NVIDIA NVENC"),
    ("h264_qsv", "Intel Quick Sync (QSV)"),
    ("h264_amf", "AMD AMF"),
)
_HW_PROBE_CACHE_LOCK = threading.Lock()
_HW_PROBE_CACHE: dict[str, tuple[float, dict[str, object]]] = {}
_HW_PROBE_TTL_SEC = 300.0


def clear_hardware_encoder_cache() -> None:
    with _HW_PROBE_CACHE_LOCK:
        _HW_PROBE_CACHE.clear()


def _sanitize_probe_detail(stderr_text: str, returncode: int) -> str:
    if returncode == 0:
        return "Ready"
    lower = (stderr_text or "").lower()
    if "unknown encoder" in lower or "encoder" in lower and "not found" in lower:
        return "Encoder not compiled in this FFmpeg build"
    if any(tok in lower for tok in ("cuda", "nvenc", "driver", "unsupported device", "cannot load", "no nvenc")):
        return "GPU driver or device unavailable"
    if any(tok in lower for tok in ("mfx", "qsv", "vaapi", "d3d11", "dxva", "amf", "init")):
        return "Hardware acceleration device not initialized"
    return "Hardware encoder initialization unavailable"


def detect_hardware_h264_encoders(
    ffmpeg_bin: str = "ffmpeg",
    *,
    force_refresh: bool = False,
) -> dict[str, object]:
    ffmpeg_path = check_binary(ffmpeg_bin)
    if not ffmpeg_path:
        return {
            "software_encoder": "libx264",
            "available_hardware_encoders": [],
            "recommended_encoder": "libx264",
            "encoders": {
                name: {"available": False, "label": label, "detail": "ffmpeg binary unavailable"}
                for name, label in _HARDWARE_ENCODER_CANDIDATES
            },
        }

    now = time.monotonic()
    if not force_refresh:
        with _HW_PROBE_CACHE_LOCK:
            cached = _HW_PROBE_CACHE.get(ffmpeg_path)
            if cached and (now - cached[0]) < _HW_PROBE_TTL_SEC:
                return cached[1]

    available_hw: list[str] = []
    encoders_info: dict[str, dict[str, object]] = {}
    for enc_name, enc_label in _HARDWARE_ENCODER_CANDIDATES:
        cmd = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:d=0.1:r=24",
            "-pix_fmt",
            "nv12" if enc_name == "h264_qsv" else "yuv420p",
            "-c:v",
            enc_name,
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ]
        ok = False
        detail = "Hardware encoder initialization unavailable"
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            ok = proc.returncode == 0
            detail = _sanitize_probe_detail(proc.stderr or "", proc.returncode)
        except Exception:
            ok = False
            detail = "Hardware encoder probe failed"

        if ok:
            available_hw.append(enc_name)
        encoders_info[enc_name] = {
            "available": ok,
            "label": enc_label,
            "detail": detail,
        }

    result: dict[str, object] = {
        "software_encoder": "libx264",
        "available_hardware_encoders": available_hw,
        "recommended_encoder": available_hw[0] if available_hw else "libx264",
        "encoders": encoders_info,
    }
    with _HW_PROBE_CACHE_LOCK:
        _HW_PROBE_CACHE[ffmpeg_path] = (now, result)
    return result


def resolve_export_profile_spec(
    export_profile: str | None,
    resolution: ResolutionTarget,
) -> tuple[Optional[ExportProfileId], ResolutionTarget, dict[str, object]]:
    if export_profile is None or not str(export_profile).strip():
        return (None, resolution, {**_LEGACY_PROFILE_SPEC, "resolution": resolution})
    norm = str(export_profile).strip().lower()
    if norm not in EXPORT_PROFILES:
        raise VideoProcessingError(
            f"Unsupported export profile '{export_profile}'. Choose 'fast_preview', 'balanced', or 'high_quality'.",
            status_code=400,
        )
    spec = EXPORT_PROFILES[norm]
    eff_res: ResolutionTarget = "1080p" if spec["resolution"] == "1080p" else "720p"
    return (norm, eff_res, spec)  # type: ignore[return-value]


def normalize_encoding_mode(encoding_mode: str | None) -> EncodingModeTarget:
    if encoding_mode is None or not str(encoding_mode).strip():
        return "auto"
    norm = str(encoding_mode).strip().lower()
    if norm not in ("auto", "cpu", "gpu"):
        raise VideoProcessingError(
            f"Unsupported encoding mode '{encoding_mode}'. Choose 'auto', 'cpu', or 'gpu'.",
            status_code=400,
        )
    return norm  # type: ignore[return-value]


def _select_video_encoder(
    encoding_mode: EncodingModeTarget,
    ffmpeg_bin: str,
) -> tuple[str, bool]:
    if encoding_mode == "cpu":
        return ("libx264", False)
    caps = detect_hardware_h264_encoders(ffmpeg_bin)
    hw_list = caps.get("available_hardware_encoders") or []
    if isinstance(hw_list, list) and len(hw_list) > 0:
        return (str(hw_list[0]), False)
    return ("libx264", encoding_mode == "gpu")


def _build_video_encode_args(
    encoder: str,
    profile_spec: dict[str, object],
) -> list[str]:
    if encoder == "h264_nvenc":
        return [
            "-c:v",
            "h264_nvenc",
            "-preset",
            str(profile_spec.get("nvenc_preset", "p4")),
            "-rc",
            "vbr",
            "-cq",
            str(profile_spec.get("nvenc_cq", 23)),
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
    if encoder == "h264_qsv":
        return [
            "-c:v",
            "h264_qsv",
            "-preset",
            str(profile_spec.get("qsv_preset", "faster")),
            "-global_quality",
            str(profile_spec.get("qsv_quality", 23)),
            "-pix_fmt",
            "nv12",
        ]
    if encoder == "h264_amf":
        return [
            "-c:v",
            "h264_amf",
            "-quality",
            str(profile_spec.get("amf_quality", "balanced")),
            "-rc",
            "cqp",
            "-qp_i",
            str(profile_spec.get("amf_qp", 22)),
            "-qp_p",
            str(profile_spec.get("amf_qp", 22)),
            "-pix_fmt",
            "yuv420p",
        ]
    return [
        "-c:v",
        "libx264",
        "-preset",
        str(profile_spec.get("x264_preset", "veryfast")),
        "-crf",
        str(profile_spec.get("crf", 22)),
        "-pix_fmt",
        "yuv420p",
    ]


class _ExportProfiler:
    """Lightweight time.perf_counter() profiler separating Python and FFmpeg execution times."""

    def __init__(self) -> None:
        self.export_start = time.perf_counter()
        self.ffmpeg_exec_sec = 0.0
        self.stages: dict[str, dict[str, object]] = {}

    def record(
        self,
        stage_name: str,
        *,
        total_sec: float,
        ffmpeg_sec: float = 0.0,
        active: bool = True,
        note: str = "",
    ) -> None:
        safe_total = max(0.0, float(total_sec))
        safe_ffmpeg = max(0.0, min(safe_total, float(ffmpeg_sec)))
        safe_python = max(0.0, safe_total - safe_ffmpeg)
        self.ffmpeg_exec_sec += safe_ffmpeg
        entry: dict[str, object] = {
            "total_sec": round(safe_total, 4),
            "python_sec": round(safe_python, 4),
            "ffmpeg_sec": round(safe_ffmpeg, 4),
            "active": bool(active),
        }
        if note:
            entry["note"] = note
        self.stages[stage_name] = entry

    def finalize(self) -> dict[str, object]:
        total_export_sec = max(0.0, time.perf_counter() - self.export_start)
        ffmpeg_sec = min(total_export_sec, self.ffmpeg_exec_sec)
        python_sec = max(0.0, total_export_sec - ffmpeg_sec)
        return {
            "total_export_sec": round(total_export_sec, 4),
            "ffmpeg_execution_sec": round(ffmpeg_sec, 4),
            "python_processing_sec": round(python_sec, 4),
            "stages": self.stages,
        }


class VideoProcessingError(Exception):
    """Raised when FFmpeg validation or video processing fails."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


class VideoProcessingCancelledError(VideoProcessingError):
    """Raised when a user cancels an active FFmpeg processing job."""

    def __init__(self, message: str = "Export cancelled by user.") -> None:
        super().__init__(message, status_code=499)


def _require_ffmpeg(ffmpeg_bin: str) -> str:
    resolved = check_binary(ffmpeg_bin)
    if not resolved:
        raise VideoProcessingError(
            f"ffmpeg binary '{ffmpeg_bin}' is not installed or not on PATH.",
            status_code=503,
        )
    return resolved


def _parse_ffmpeg_time_line(key: str, val: str) -> Optional[float]:
    try:
        if key in ("out_time_us", "out_time_ms"):
            us = int(val)
            if us >= 0:
                return us / 1_000_000.0
        elif key == "out_time":
            parts = val.strip().split(":")
            if len(parts) == 3:
                hrs = float(parts[0])
                mins = float(parts[1])
                secs = float(parts[2])
                return max(0.0, hrs * 3600.0 + mins * 60.0 + secs)
    except (TypeError, ValueError):
        return None
    return None


def _format_ffmpeg_failure(stderr_lines: Sequence[str]) -> str:
    if not stderr_lines:
        return "Unknown FFmpeg error."
    tail = stderr_lines[-1]
    diagnostic_lines: list[str] = []
    for line in stderr_lines[-12:]:
        lower = line.lower()
        if any(
            token in lower
            for token in (
                "unrecognized option",
                "option not found",
                "error splitting",
                "invalid",
                "no such",
                "failed",
                "cannot",
                "unable to",
                "unknown",
                "conversion failed",
            )
        ):
            if line not in diagnostic_lines:
                diagnostic_lines.append(line)
    if diagnostic_lines:
        return " | ".join(diagnostic_lines[-3:])
    return tail


def _run_ffmpeg_with_progress(
    cmd: list[str],
    timeout_sec: int,
    *,
    cwd: Path | None = None,
    expected_duration_sec: float | None = None,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise VideoProcessingCancelledError()

    if len(cmd) >= 2:
        progress_cmd = [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]
    else:
        progress_cmd = list(cmd)

    formatted_cmd = " ".join(shlex.quote(str(arg)) for arg in progress_cmd)
    logger.debug("Executing FFmpeg command (cwd=%s): %s", cwd, formatted_cmd)

    try:
        proc = subprocess.Popen(
            progress_cmd,
            cwd=str(cwd) if cwd is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
        )
    except OSError as exc:
        logger.error("Failed to spawn FFmpeg (%s): %s", formatted_cmd, exc)
        raise VideoProcessingError(f"Failed to execute ffmpeg: {exc}", status_code=500) from exc

    if process_cb is not None:
        process_cb(proc)

    stderr_lines: list[str] = []
    last_reported_frac = -1.0
    measurable = bool(expected_duration_sec is not None and expected_duration_sec > 0.05)

    def _consume_stderr() -> None:
        if not proc.stderr:
            return
        try:
            for line in proc.stderr:
                stripped = line.strip()
                if stripped:
                    stderr_lines.append(stripped)
                    if len(stderr_lines) > 250:
                        del stderr_lines[: len(stderr_lines) - 250]
        except Exception:
            pass

    def _consume_stdout() -> None:
        nonlocal last_reported_frac
        if not proc.stdout:
            return
        try:
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()

                if key in ("out_time_us", "out_time_ms", "out_time"):
                    sec = _parse_ffmpeg_time_line(key, val)
                    if sec is not None and progress_cb is not None:
                        if measurable and expected_duration_sec:
                            frac = max(0.0, min(0.99, sec / expected_duration_sec))
                            if frac >= last_reported_frac + 0.005 or last_reported_frac < 0:
                                last_reported_frac = frac
                                progress_cb(frac, True)
                        elif last_reported_frac < 0:
                            last_reported_frac = 0.0
                            progress_cb(0.0, False)
                elif key == "progress" and val == "end" and progress_cb is not None:
                    last_reported_frac = 1.0
                    progress_cb(1.0, measurable)
        except Exception:
            pass

    out_thread = threading.Thread(target=_consume_stdout, daemon=True)
    err_thread = threading.Thread(target=_consume_stderr, daemon=True)
    out_thread.start()
    err_thread.start()

    start_mono = time.monotonic()
    timed_out = False
    cancelled = False

    def _terminate_process_cleanly() -> None:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except Exception:
                pass

    try:
        while True:
            rc = proc.poll()
            if rc is not None:
                break
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                _terminate_process_cleanly()
                break
            if time.monotonic() - start_mono > timeout_sec:
                timed_out = True
                _terminate_process_cleanly()
                break
            time.sleep(0.08)

        if cancelled or timed_out:
            # Close pipes first so Windows pipe reader threads unblock immediately
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    try:
                        pipe.close()
                    except Exception:
                        pass
            out_thread.join(timeout=1.0)
            err_thread.join(timeout=1.0)
        else:
            out_thread.join(timeout=2.0)
            err_thread.join(timeout=2.0)
    finally:
        for pipe in (proc.stdout, proc.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except Exception:
                    pass
        if process_cb is not None:
            process_cb(None)

    if cancelled or (cancel_event is not None and cancel_event.is_set()):
        raise VideoProcessingCancelledError()

    if timed_out:
        logger.error("FFmpeg timed out after %ss. Command: %s", timeout_sec, formatted_cmd)
        raise VideoProcessingError(
            f"FFmpeg timed out after {timeout_sec}s while processing video.",
            status_code=504,
        )

    if proc.returncode != 0:
        recent_stderr = "\n".join(stderr_lines[-30:]) if stderr_lines else "(empty stderr)"
        logger.error(
            "FFmpeg failed with exit code %s.\nCommand: %s\nStderr:\n%s",
            proc.returncode,
            formatted_cmd,
            recent_stderr,
        )
        summary = _format_ffmpeg_failure(stderr_lines)
        raise VideoProcessingError(f"FFmpeg processing failed: {summary}", status_code=422)


def _run_ffmpeg(
    cmd: list[str],
    timeout_sec: int,
    *,
    cwd: Path | None = None,
    expected_duration_sec: float | None = None,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> None:
    _run_ffmpeg_with_progress(
        cmd,
        timeout_sec,
        cwd=cwd,
        expected_duration_sec=expected_duration_sec,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        process_cb=process_cb,
    )


def _assert_short_video_limit(
    file_path: Path,
    *,
    ffprobe_bin: str,
    max_duration_sec: float,
) -> dict:
    meta = extract_video_metadata(file_path, ffprobe_bin=ffprobe_bin)
    duration = float(meta["duration_seconds"])
    if duration > max_duration_sec:
        raise VideoProcessingError(
            f"Video duration ({duration:.1f}s) exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )
    return meta


def _assert_short_audio_limit(
    file_path: Path,
    *,
    ffprobe_bin: str,
    max_duration_sec: float,
) -> dict:
    meta = extract_audio_metadata(file_path, ffprobe_bin=ffprobe_bin)
    duration = float(meta["duration_seconds"])
    if duration > max_duration_sec:
        raise VideoProcessingError(
            f"Audio duration ({duration:.1f}s) exceeds synchronous short-media limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )
    return meta


def generate_thumbnail(
    input_path: Path,
    output_path: Path,
    *,
    timestamp_sec: float = 0.5,
    width: int = 640,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 60,
    max_duration_sec: float = 300.0,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    meta = _assert_short_video_limit(
        input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
    )
    duration = float(meta["duration_seconds"])
    clamped_ts = max(0.0, min(timestamp_sec, max(0.0, duration - 0.05))) if duration > 0.1 else 0.0
    safe_width = max(64, min(width, 1920))
    if safe_width % 2 != 0:
        safe_width += 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_path,
        "-y",
        "-ss",
        f"{clamped_ts:.3f}",
        "-i",
        str(input_path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={safe_width}:-2",
        "-q:v",
        "3",
        str(output_path),
    ]
    _run_ffmpeg(cmd, timeout_sec)
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise VideoProcessingError("Thumbnail extraction produced an empty image.", status_code=500)
    return {
        "timestamp_seconds": round(clamped_ts, 3),
        "width": safe_width,
        "size_bytes": output_path.stat().st_size,
    }


def trim_video(
    input_path: Path,
    output_path: Path,
    *,
    start_sec: float,
    end_sec: float,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 180,
    max_duration_sec: float = 300.0,
    enforce_source_limit: bool = True,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    if enforce_source_limit:
        meta = _assert_short_video_limit(
            input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
        )
    else:
        meta = extract_video_metadata(input_path, ffprobe_bin=ffprobe_bin)
    source_duration = float(meta["duration_seconds"])

    if start_sec < 0 or end_sec <= start_sec:
        raise VideoProcessingError("Invalid trim timestamps: require 0 <= start_sec < end_sec.", status_code=400)
    if source_duration > 0 and start_sec >= source_duration:
        raise VideoProcessingError(
            f"start_sec ({start_sec:.2f}s) must be less than video duration ({source_duration:.2f}s).",
            status_code=400,
        )

    effective_end = min(end_sec, source_duration) if source_duration > 0 else end_sec
    clip_duration = effective_end - start_sec
    if clip_duration < 0.1:
        raise VideoProcessingError("Trimmed duration must be at least 0.1 seconds.", status_code=400)
    if clip_duration > max_duration_sec:
        raise VideoProcessingError(
            f"Trimmed clip duration ({clip_duration:.1f}s) exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_path,
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(input_path),
        "-t",
        f"{clip_duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
    ]
    if meta["has_audio"]:
        cmd.extend(["-c:a", "aac", "-b:a", "128k"])
    else:
        cmd.append("-an")
    cmd.extend(["-movflags", "+faststart", str(output_path)])

    _run_ffmpeg(
        cmd,
        timeout_sec,
        expected_duration_sec=clip_duration,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        process_cb=process_cb,
    )
    out_meta = extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)
    return out_meta


def _trim_audio_segment(
    input_path: Path,
    output_wav_path: Path,
    *,
    start_sec: float,
    end_sec: float,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 180,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    span = end_sec - start_sec
    if start_sec < 0 or span < 0.05:
        raise VideoProcessingError(
            "Invalid audio trim timestamps: require 0 <= start_sec < end_sec.",
            status_code=400,
        )

    output_wav_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_path,
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(input_path),
        "-t",
        f"{span:.3f}",
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(output_wav_path),
    ]
    _run_ffmpeg(
        cmd,
        timeout_sec,
        expected_duration_sec=span,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        process_cb=process_cb,
    )
    return extract_audio_metadata(output_wav_path, ffprobe_bin=ffprobe_bin)


def resize_crop_aspect_ratio(
    input_path: Path,
    output_path: Path,
    *,
    aspect_ratio: AspectRatioTarget | None = None,
    target_width: int | None = None,
    target_height: int | None = None,
    fit_mode: FitMode = "crop",
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 180,
    max_duration_sec: float = 300.0,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    meta = _assert_short_video_limit(
        input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
    )

    preset_dims: dict[AspectRatioTarget, tuple[int, int]] = {
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "1:1": (720, 720),
    }

    if aspect_ratio is not None:
        w, h = preset_dims[aspect_ratio]
    elif target_width and target_height:
        w = max(128, min(target_width, 1920))
        h = max(128, min(target_height, 1920))
        if w % 2 != 0:
            w += 1
        if h % 2 != 0:
            h += 1
    else:
        raise VideoProcessingError(
            "Provide either aspect_ratio ('16:9', '9:16', '1:1') or target_width & target_height.",
            status_code=400,
        )

    if fit_mode == "pad":
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
        )
    else:
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
    ]
    if meta["has_audio"]:
        cmd.extend(["-c:a", "aac", "-b:a", "128k"])
    else:
        cmd.append("-an")
    cmd.extend(["-movflags", "+faststart", str(output_path)])

    _run_ffmpeg(cmd, timeout_sec)
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)


def merge_video_clips(
    input_paths: Sequence[Path],
    output_path: Path,
    *,
    target_width: int = 1280,
    target_height: int = 720,
    fps: int = 30,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 240,
    max_total_duration_sec: float = 300.0,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    if len(input_paths) < 2:
        raise VideoProcessingError("Merging requires at least 2 video clips.", status_code=400)
    if len(input_paths) > 8:
        raise VideoProcessingError("Synchronous merge supports up to 8 clips.", status_code=400)

    metas = [
        extract_video_metadata(p, ffprobe_bin=ffprobe_bin)
        for p in input_paths
    ]
    total_duration = sum(float(m["duration_seconds"]) for m in metas)
    if total_duration > max_total_duration_sec:
        raise VideoProcessingError(
            f"Combined duration ({total_duration:.1f}s) exceeds synchronous limit ({max_total_duration_sec:.0f}s).",
            status_code=400,
        )

    w = target_width if target_width % 2 == 0 else target_width + 1
    h = target_height if target_height % 2 == 0 else target_height + 1
    include_audio = all(bool(m["has_audio"]) for m in metas)

    cmd = [ffmpeg_path, "-y"]
    filter_parts: list[str] = []
    concat_inputs: list[str] = []

    for idx, p in enumerate(input_paths):
        cmd.extend(["-i", str(p)])
        filter_parts.append(
            f"[{idx}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps},format=yuv420p[v{idx}]"
        )
        if include_audio:
            filter_parts.append(
                f"[{idx}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{idx}]"
            )
            concat_inputs.append(f"[v{idx}][a{idx}]")
        else:
            concat_inputs.append(f"[v{idx}]")

    n = len(input_paths)
    if include_audio:
        filter_parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=1[outv][outa]")
        map_args = ["-map", "[outv]", "-map", "[outa]", "-c:a", "aac", "-b:a", "128k"]
    else:
        filter_parts.append(f"{''.join(concat_inputs)}concat=n={n}:v=1:a=0[outv]")
        map_args = ["-map", "[outv]", "-an"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd.extend(["-filter_complex", ";".join(filter_parts)])
    cmd.extend(map_args)
    cmd.extend([
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-movflags",
        "+faststart",
        str(output_path),
    ])

    _run_ffmpeg(cmd, timeout_sec)
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)


def export_mp4(
    input_path: Path,
    output_path: Path,
    *,
    resolution: ResolutionTarget = "720p",
    fps: int = 30,
    aspect_ratio: AspectRatioTarget | None = None,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 240,
    max_duration_sec: float = 300.0,
    progress_cb: Optional[StageProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict:
    if cancel_event is not None and cancel_event.is_set():
        raise VideoProcessingCancelledError()
    if progress_cb is not None:
        progress_cb("probing", "Inspecting media streams", 5, False)

    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    meta = _assert_short_video_limit(
        input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
    )
    safe_fps = fps if fps in (24, 30, 60) else 30
    dur_sec = float(meta.get("duration_seconds") or 0.0)

    if aspect_ratio == "9:16":
        dims = (1080, 1920) if resolution == "1080p" else (720, 1280)
    elif aspect_ratio == "1:1":
        dims = (1080, 1080) if resolution == "1080p" else (720, 720)
    elif aspect_ratio == "16:9":
        dims = (1920, 1080) if resolution == "1080p" else (1280, 720)
    else:
        max_h = 1080 if resolution == "1080p" else 720
        src_w = int(meta["video"]["width"])
        src_h = int(meta["video"]["height"])
        scale_factor = min(1.0, max_h / src_h) if src_h > max_h else 1.0
        out_w = max(2, int(round(src_w * scale_factor / 2) * 2))
        out_h = max(2, int(round(src_h * scale_factor / 2) * 2))
        dims = (out_w, out_h)

    w, h = dims
    vf = (
        f"scale={w}:{h}:force_original_aspect_ratio=increase,"
        f"crop={w}:{h},setsar=1,fps={safe_fps}"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
    ]
    if meta["has_audio"]:
        cmd.extend(["-c:a", "aac", "-b:a", "128k"])
    else:
        cmd.append("-an")
    cmd.extend(["-movflags", "+faststart", str(output_path)])

    def _on_sub_progress(frac: float, measurable: bool) -> None:
        if progress_cb is not None:
            pct = 10 + int(round(frac * 85)) if measurable else 15
            progress_cb("rendering_v1", "Rendering MP4 video", pct, measurable)

    if progress_cb is not None:
        progress_cb("rendering_v1", "Rendering MP4 video", 10, dur_sec > 0.05)

    _run_ffmpeg(
        cmd,
        timeout_sec,
        expected_duration_sec=dur_sec if dur_sec > 0.05 else None,
        progress_cb=_on_sub_progress,
        cancel_event=cancel_event,
        process_cb=process_cb,
    )
    if progress_cb is not None:
        progress_cb("finalizing", "Finalizing MP4 metadata", 98, False)
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)


def _resolve_export_dimensions(
    resolution: ResolutionTarget,
    aspect_ratio: AspectRatioTarget | None,
) -> tuple[int, int]:
    if aspect_ratio == "9:16":
        return (1080, 1920) if resolution == "1080p" else (720, 1280)
    if aspect_ratio == "1:1":
        return (1080, 1080) if resolution == "1080p" else (720, 720)
    return (1920, 1080) if resolution == "1080p" else (1280, 720)


def _resolve_effective_fades(
    duration_sec: float,
    fade_in_sec: float,
    fade_out_sec: float,
) -> tuple[float, float]:
    dur = max(0.0, float(duration_sec))
    if dur <= 0.02:
        return (0.0, 0.0)
    f_in = max(0.0, float(fade_in_sec or 0.0))
    f_out = max(0.0, float(fade_out_sec or 0.0))
    total = f_in + f_out
    if total > dur and total > 0:
        scale = dur / total
        f_in = round(f_in * scale, 3)
        f_out = round(f_out * scale, 3)
    return (f_in, f_out)


def _merge_speech_intervals(
    raw_intervals: Sequence[dict] | None,
    subtitles: Sequence[dict] | None,
    padding_sec: float = 0.15,
) -> list[tuple[float, float]]:
    pairs: list[tuple[float, float]] = []
    if isinstance(raw_intervals, (list, tuple)) and len(raw_intervals) > 0:
        for iv in raw_intervals:
            if not isinstance(iv, dict):
                continue
            try:
                s = max(0.0, float(iv.get("start", 0.0)))
                e = float(iv.get("end", 0.0))
            except (TypeError, ValueError):
                continue
            if e > s:
                pairs.append((round(s, 3), round(e, 3)))
    elif isinstance(subtitles, (list, tuple)):
        for cue in subtitles:
            if not isinstance(cue, dict) or not str(cue.get("text", "")).strip():
                continue
            try:
                s = max(0.0, float(cue.get("start", 0.0)) - padding_sec)
                e = float(cue.get("end", 0.0)) + padding_sec
            except (TypeError, ValueError):
                continue
            if e > s:
                pairs.append((round(s, 3), round(e, 3)))

    if not pairs:
        return []

    pairs.sort(key=lambda item: (item[0], item[1]))
    merged: list[tuple[float, float]] = [pairs[0]]
    for s, e in pairs[1:]:
        prev_s, prev_e = merged[-1]
        if s <= prev_e + 0.05:
            merged[-1] = (prev_s, max(prev_e, e))
        else:
            merged.append((s, e))
    return merged


def _build_interval_ducking_expr(
    intervals: Sequence[tuple[float, float]],
    duck_amount: float,
) -> str:
    floor_gain = max(0.05, round(1.0 - max(0.0, min(0.95, float(duck_amount))), 4))
    terms = [f"between(t\\,{s:.3f}\\,{e:.3f})" for s, e in intervals[:48]]
    active_expr = f"min(1\\,{'+'.join(terms)})"
    return f"1-{(1.0 - floor_gain):.4f}*{active_expr}"


_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

_XFADE_TRANSITION_MAP: dict[str, str] = {
    "fade": "fadeblack",
    "dissolve": "fade",
    "wipeleft": "wipeleft",
    "wiperight": "wiperight",
    "slideleft": "slideleft",
    "slideright": "slideright",
    "zoomin": "circleopen",
}

_EFFECT_PRESET_SPECS: dict[str, dict[str, float]] = {
    "none": {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0, "rs": 0.0, "gs": 0.0, "bs": 0.0},
    "cinematic": {"brightness": -0.04, "contrast": 1.15, "saturation": 0.90, "rs": 0.03, "gs": 0.0, "bs": -0.04},
    "bw": {"brightness": 0.0, "contrast": 1.14, "saturation": 0.0, "rs": 0.0, "gs": 0.0, "bs": 0.0},
    "vintage": {"brightness": 0.03, "contrast": 0.92, "saturation": 0.72, "rs": 0.14, "gs": 0.04, "bs": -0.14},
    "warm": {"brightness": 0.02, "contrast": 1.05, "saturation": 1.12, "rs": 0.10, "gs": 0.02, "bs": -0.10},
    "cool": {"brightness": -0.01, "contrast": 1.06, "saturation": 0.95, "rs": -0.08, "gs": 0.0, "bs": 0.12},
    "vivid": {"brightness": 0.02, "contrast": 1.16, "saturation": 1.38, "rs": 0.0, "gs": 0.0, "bs": 0.0},
}


def _is_image_clip(clip: dict, src_path: Path) -> bool:
    if str(clip.get("kind", "")).lower() == "image":
        return True
    mime = str(clip.get("sourceMimeType", "")).lower()
    if mime.startswith("image/"):
        return True
    return src_path.suffix.lower() in _IMAGE_EXTENSIONS


def _normalize_transition(raw: object, max_duration: float = 2.0) -> tuple[str, float]:
    if not isinstance(raw, dict):
        return ("none", 0.0)
    t_type = str(raw.get("type") or "none").lower().strip()
    if t_type == "none" or t_type not in _XFADE_TRANSITION_MAP:
        return ("none", 0.0)
    try:
        dur = float(raw.get("durationSec", 0.6))
    except (TypeError, ValueError):
        dur = 0.6
    dur = max(0.2, min(2.0, dur))
    capped = min(dur, max(0.0, max_duration))
    if capped < 0.1:
        return ("none", 0.0)
    return (t_type, round(capped, 3))


def _build_visual_effects_filter_steps(
    effects: object,
    *,
    opacity: float = 1.0,
    is_overlay: bool = False,
) -> list[str]:
    fx = effects if isinstance(effects, dict) else {}
    preset = str(fx.get("preset") or "none").lower().strip()
    preset_spec = _EFFECT_PRESET_SPECS.get(preset, _EFFECT_PRESET_SPECS["none"])

    try:
        user_b = max(-0.5, min(0.5, float(fx.get("brightness", 0.0) or 0.0)))
    except (TypeError, ValueError):
        user_b = 0.0
    try:
        user_c = max(0.5, min(1.8, float(fx.get("contrast", 1.0) if fx.get("contrast") is not None else 1.0)))
    except (TypeError, ValueError):
        user_c = 1.0
    try:
        user_s = max(0.0, min(2.0, float(fx.get("saturation", 1.0) if fx.get("saturation") is not None else 1.0)))
    except (TypeError, ValueError):
        user_s = 1.0
    try:
        user_blur = max(0.0, min(10.0, float(fx.get("blur", 0.0) or 0.0)))
    except (TypeError, ValueError):
        user_blur = 0.0

    eff_b = max(-0.5, min(0.5, user_b + preset_spec["brightness"]))
    eff_c = max(0.4, min(2.0, user_c * preset_spec["contrast"]))
    eff_s = 0.0 if preset == "bw" else max(0.0, min(2.5, user_s * preset_spec["saturation"]))

    steps: list[str] = []
    if abs(eff_b) > 0.005 or abs(eff_c - 1.0) > 0.005 or abs(eff_s - 1.0) > 0.005:
        steps.append(f"eq=brightness={eff_b:.3f}:contrast={eff_c:.3f}:saturation={eff_s:.3f}")

    rs = preset_spec["rs"]
    gs = preset_spec["gs"]
    bs = preset_spec["bs"]
    if abs(rs) > 0.005 or abs(gs) > 0.005 or abs(bs) > 0.005:
        steps.append(
            f"colorbalance=rs={rs:.3f}:gs={gs:.3f}:bs={bs:.3f}:rm={rs * 0.6:.3f}:gm={gs * 0.6:.3f}:bm={bs * 0.6:.3f}"
        )

    if user_blur > 0.05:
        sigma = round(max(0.2, user_blur * 1.2), 2)
        steps.append(f"gblur=sigma={sigma:.2f}")

    clamped_op = max(0.0, min(1.0, float(opacity)))
    if is_overlay:
        steps.append("format=rgba")
        if clamped_op < 0.995:
            steps.append(f"colorchannelmixer=aa={clamped_op:.3f}")
    elif clamped_op < 0.995:
        steps.append(
            f"format=rgb24,colorchannelmixer=rr={clamped_op:.3f}:gg={clamped_op:.3f}:bb={clamped_op:.3f}"
        )

    return steps


def _build_atempo_filters(speed: float) -> list[str]:
    safe = max(0.25, min(4.0, float(speed)))
    if abs(safe - 1.0) <= 0.005:
        return []
    steps: list[str] = []
    remaining = safe
    while remaining > 2.0:
        steps.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        steps.append("atempo=0.5")
        remaining /= 0.5
    if abs(remaining - 1.0) > 0.005:
        steps.append(f"atempo={remaining:.5f}")
    return steps


def _build_audio_clip_chain(
    input_label: str,
    *,
    src_in: float,
    src_out: float,
    volume: float,
    fade_in: float,
    fade_out: float,
    speed: float = 1.0,
) -> str:
    safe_speed = max(0.5, min(2.0, float(speed or 1.0)))
    src_span = max(0.05, src_out - src_in)
    seg_dur = max(0.05, src_span / safe_speed)
    eff_in, eff_out = _resolve_effective_fades(seg_dur, fade_in, fade_out)
    filters = [
        f"atrim=start={src_in:.3f}:end={src_out:.3f}",
        "asetpts=PTS-STARTPTS",
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        *_build_atempo_filters(safe_speed),
        f"volume={max(0.0, min(2.0, volume)):.4f}",
    ]
    if eff_in > 0.01:
        filters.append(f"afade=t=in:st=0:d={eff_in:.3f}:curve=tri")
    if eff_out > 0.01:
        fade_out_start = max(0.0, seg_dur - eff_out)
        filters.append(f"afade=t=out:st={fade_out_start:.3f}:d={eff_out:.3f}:curve=tri")
    return f"[{input_label}]{','.join(filters)}"


def _render_unified_visual_mp4(
    v1_segments: Sequence[dict],
    v2_overlays: Sequence[dict],
    output_path: Path,
    *,
    width: int,
    height: int,
    fps: int,
    ass_path: Path | None,
    ass_cwd: Path | None,
    profile_spec: dict[str, object],
    encoder: str,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    timeout_sec: int,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
    profiler: Optional[_ExportProfiler] = None,
) -> tuple[dict, list[float], str, bool]:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    safe_fps = fps if fps in (24, 30, 60) else 30

    seam_start = time.perf_counter()
    seam_transitions: list[tuple[str, float]] = []
    for idx in range(len(v1_segments) - 1):
        left = v1_segments[idx]
        right = v1_segments[idx + 1]
        max_seam = min(left["seg_dur"] * 0.45, right["seg_dur"] * 0.45)
        t_out_type, t_out_dur = _normalize_transition(left.get("transition_out"), max_seam)
        t_in_type, t_in_dur = _normalize_transition(right.get("transition_in"), max_seam)
        if t_out_type != "none":
            seam_transitions.append((t_out_type, t_out_dur))
        elif t_in_type != "none":
            seam_transitions.append((t_in_type, t_in_dur))
        else:
            seam_transitions.append(("none", 0.0))

    cmd = [ffmpeg_path, "-y"]
    filter_parts: list[str] = []
    has_speed_clip = False
    has_effects_or_tr = False

    for idx, seg in enumerate(v1_segments):
        seg_path = Path(seg["src_path"]).resolve()
        seg_dur = float(seg["seg_dur"])
        seg_speed = max(0.5, min(2.0, float(seg.get("speed", 1.0) or 1.0)))
        if seg["is_image"]:
            cmd.extend(["-loop", "1", "-t", f"{seg_dur:.3f}", "-i", str(seg_path)])
        else:
            src_in = max(0.0, float(seg.get("src_in", 0.0)))
            src_out = float(seg.get("src_out", seg_dur * seg_speed))
            src_span = max(0.08, src_out - src_in)
            src_dur = float(seg["src_meta"].get("duration_seconds", 0.0))
            if src_in > 0.02:
                cmd.extend(["-ss", f"{src_in:.3f}"])
            if src_dur <= 0 or src_span < src_dur - 0.02:
                cmd.extend(["-t", f"{src_span:.3f}"])
            cmd.extend(["-i", str(seg_path)])

        if len(v1_segments) == 1:
            chain_steps = [
                f"scale={width}:{height}:force_original_aspect_ratio=increase",
                f"crop={width}:{height}",
            ]
        else:
            chain_steps = [
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black",
            ]
        chain_steps.append("setsar=1")
        if not seg["is_image"]:
            if abs(seg_speed - 1.0) > 0.005:
                has_speed_clip = True
                chain_steps.append(f"setpts=(PTS-STARTPTS)/{seg_speed:.6f}")
            else:
                chain_steps.append("setpts=PTS-STARTPTS")
        chain_steps.append(f"fps={safe_fps}")

        fx_steps = _build_visual_effects_filter_steps(
            seg.get("effects"),
            opacity=float(seg.get("opacity", 1.0)),
            is_overlay=False,
        )
        if fx_steps:
            has_effects_or_tr = True
            chain_steps.extend(fx_steps)

        if idx == 0:
            edge_in_type, edge_in_dur = _normalize_transition(
                seg.get("transition_in"), seg_dur * 0.45
            )
            if edge_in_type != "none":
                has_effects_or_tr = True
                chain_steps.append(f"fade=t=in:st=0:d={edge_in_dur:.3f}")
        if idx == len(v1_segments) - 1:
            edge_out_type, edge_out_dur = _normalize_transition(
                seg.get("transition_out"), seg_dur * 0.45
            )
            if edge_out_type != "none":
                has_effects_or_tr = True
                fade_st = max(0.0, seg_dur - edge_out_dur)
                chain_steps.append(f"fade=t=out:st={fade_st:.3f}:d={edge_out_dur:.3f}")

        chain_steps.extend(["format=yuv420p", "settb=AVTB", "setpts=PTS-STARTPTS"])
        is_single_no_post = len(v1_segments) == 1 and not v2_overlays and ass_path is None
        out_label = "[outv]" if is_single_no_post else ("[v1_base]" if len(v1_segments) == 1 else f"[v{idx}]")
        filter_parts.append(f"[{idx}:v]{','.join(chain_steps)}{out_label}")

    seam_overlaps = [d if t != "none" else 0.0 for t, d in seam_transitions]
    expected_v1_dur = max(
        0.1,
        sum(float(s["seg_dur"]) for s in v1_segments) - sum(seam_overlaps),
    )

    v1_done_label = "[outv]" if (len(v1_segments) == 1 and not v2_overlays and ass_path is None) else "[v1_base]"
    if len(v1_segments) > 1:
        v1_target = "[v1_base]" if (v2_overlays or ass_path is not None) else "[outv]"
        v1_done_label = v1_target
        has_seam_xfade = any(t != "none" and d > 0.05 for t, d in seam_transitions)
        if has_seam_xfade:
            has_effects_or_tr = True
        if not has_seam_xfade:
            concat_inputs = "".join(f"[v{i}]" for i in range(len(v1_segments)))
            filter_parts.append(f"{concat_inputs}concat=n={len(v1_segments)}:v=1:a=0{v1_target}")
        else:
            cur_label = "[v0]"
            cur_dur = float(v1_segments[0]["seg_dur"])
            for idx in range(len(v1_segments) - 1):
                nxt_label = f"[v{idx + 1}]"
                nxt_dur = float(v1_segments[idx + 1]["seg_dur"])
                t_type, t_dur = seam_transitions[idx]
                out_lbl = v1_target if idx == len(v1_segments) - 2 else f"[vx{idx + 1}]"
                if t_type != "none" and t_dur > 0.05:
                    ff_tr = _XFADE_TRANSITION_MAP.get(t_type, "fade")
                    offset = max(0.0, cur_dur - t_dur)
                    filter_parts.append(
                        f"{cur_label}{nxt_label}xfade=transition={ff_tr}:duration={t_dur:.3f}:offset={offset:.3f}{out_lbl}"
                    )
                    cur_dur = max(0.1, cur_dur + nxt_dur - t_dur)
                else:
                    filter_parts.append(f"{cur_label}{nxt_label}concat=n=2:v=1:a=0{out_lbl}")
                    cur_dur += nxt_dur
                cur_label = out_lbl

    fx_build_sec = time.perf_counter() - seam_start
    if profiler is not None:
        profiler.record(
            "playback_speed_processing",
            total_sec=0.0,
            active=has_speed_clip,
            note="Fused into single-pass visual filtergraph" if has_speed_clip else "No speed != 1.0",
        )
        profiler.record(
            "effects_and_transitions",
            total_sec=fx_build_sec,
            active=has_effects_or_tr,
            note="Fused into single-pass visual filtergraph" if has_effects_or_tr else "No custom effects/transitions",
        )

    v2_prep_start = time.perf_counter()
    cur_comp_label = v1_done_label
    next_input_idx = len(v1_segments)
    for idx, ov in enumerate(v2_overlays):
        in_idx = next_input_idx + idx
        tl_start = max(0.0, float(ov["tl_start"]))
        tl_end = min(expected_v1_dur, float(ov["tl_end"]))
        clip_dur = max(0.1, tl_end - tl_start)
        ov_speed = max(0.5, min(2.0, float(ov.get("speed", 1.0) or 1.0)))
        ov_src_path = Path(ov["src_path"]).resolve()

        if ov["is_image"]:
            cmd.extend(["-loop", "1", "-t", f"{clip_dur:.3f}", "-i", str(ov_src_path)])
            ov_steps = [f"setpts=PTS-STARTPTS+{tl_start:.3f}/TB"]
        else:
            src_in = max(0.0, float(ov["src_in"]))
            src_out = float(ov["src_out"])
            src_span = max(0.05, src_out - src_in)
            src_dur = float(ov["src_meta"].get("duration_seconds", 0.0))
            if src_in > 0.02:
                cmd.extend(["-ss", f"{src_in:.3f}"])
            if src_dur <= 0 or src_span < src_dur - 0.02:
                cmd.extend(["-t", f"{src_span:.3f}"])
            cmd.extend(["-i", str(ov_src_path)])
            ov_steps = [
                f"setpts=(PTS-STARTPTS)/{ov_speed:.6f}+{tl_start:.3f}/TB",
            ]

        x_frac, y_frac, box_w, box_h, lock_aspect = _normalize_overlay_transform(
            ov.get("overlay_transform"),
            width,
            height,
        )
        if lock_aspect:
            scale_step = f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease"
        else:
            scale_step = f"scale={box_w}:{box_h},setsar=1"

        ov_steps.extend([scale_step, f"fps={safe_fps}"])
        ov_steps.extend(
            _build_visual_effects_filter_steps(
                ov.get("effects"),
                opacity=float(ov.get("opacity", 1.0)),
                is_overlay=True,
            )
        )

        tr_in_type, tr_in_dur = _normalize_transition(ov.get("transition_in"), clip_dur * 0.45)
        tr_out_type, tr_out_dur = _normalize_transition(ov.get("transition_out"), clip_dur * 0.45)
        if tr_in_type != "none":
            ov_steps.append(f"fade=t=in:st={tl_start:.3f}:d={tr_in_dur:.3f}:alpha=1")
        if tr_out_type != "none":
            out_st = max(tl_start, tl_end - tr_out_dur)
            ov_steps.append(f"fade=t=out:st={out_st:.3f}:d={tr_out_dur:.3f}:alpha=1")

        ov_lbl = f"[ov_{idx}]"
        is_last_ov = idx == len(v2_overlays) - 1
        next_lbl = "[outv]" if (is_last_ov and ass_path is None) else (
            "[comp_v]" if is_last_ov else f"[base{idx + 1}]"
        )
        filter_parts.append(f"[{in_idx}:v]{','.join(ov_steps)}{ov_lbl}")
        filter_parts.append(
            f"{cur_comp_label}{ov_lbl}overlay=x='round(W*{x_frac:.5f}-w/2)':y='round(H*{y_frac:.5f}-h/2)':enable='between(t,{tl_start:.3f},{tl_end:.3f})':eof_action=pass{next_lbl}"
        )
        cur_comp_label = next_lbl

    if profiler is not None:
        profiler.record(
            "v2_overlay_compositing",
            total_sec=time.perf_counter() - v2_prep_start if v2_overlays else 0.0,
            active=len(v2_overlays) > 0,
            note="Fused into single-pass visual filtergraph" if v2_overlays else "No V2 overlays",
        )

    if ass_path is not None:
        filter_parts.append(f"{cur_comp_label}ass={ass_path.name}[outv]")
        cur_comp_label = "[outv]"

    resolved_out = output_path.resolve()
    resolved_out.parent.mkdir(parents=True, exist_ok=True)
    base_cmd = [
        *cmd,
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        cur_comp_label,
        "-an",
    ]
    tail_args = ["-movflags", "+faststart", str(resolved_out)]

    active_encoder = encoder
    fallback_used = False
    encode_cmd = [*base_cmd, *_build_video_encode_args(active_encoder, profile_spec), *tail_args]

    ffmpeg_run_start = time.perf_counter()
    try:
        _run_ffmpeg(
            encode_cmd,
            timeout_sec,
            cwd=ass_cwd.resolve() if ass_cwd is not None else None,
            expected_duration_sec=expected_v1_dur,
            progress_cb=progress_cb,
            cancel_event=cancel_event,
            process_cb=process_cb,
        )
    except VideoProcessingCancelledError:
        raise
    except VideoProcessingError as exc:
        if active_encoder != "libx264" and exc.status_code != 504:
            logger.warning(
                "Hardware encoder '%s' failed during export (%s); falling back to libx264.",
                active_encoder,
                exc,
            )
            active_encoder = "libx264"
            fallback_used = True
            fallback_cmd = [*base_cmd, *_build_video_encode_args("libx264", profile_spec), *tail_args]
            _run_ffmpeg(
                fallback_cmd,
                timeout_sec,
                cwd=ass_cwd.resolve() if ass_cwd is not None else None,
                expected_duration_sec=expected_v1_dur,
                progress_cb=progress_cb,
                cancel_event=cancel_event,
                process_cb=process_cb,
            )
        else:
            raise
    ffmpeg_run_sec = time.perf_counter() - ffmpeg_run_start

    probe_start = time.perf_counter()
    out_meta = extract_video_metadata(resolved_out, ffprobe_bin=ffprobe_bin)
    probe_sec = time.perf_counter() - probe_start

    if profiler is not None:
        profiler.record(
            "visual_single_pass_encode",
            total_sec=ffmpeg_run_sec + probe_sec,
            ffmpeg_sec=ffmpeg_run_sec,
            active=True,
            note=f"encoder={active_encoder}, fallback={fallback_used}",
        )

    return out_meta, seam_overlaps, active_encoder, fallback_used


def _normalize_overlay_transform(
    raw: dict | None,
    canvas_w: int,
    canvas_h: int,
) -> tuple[float, float, int, int, bool]:
    ov = raw if isinstance(raw, dict) else {}
    try:
        x_pct = max(0.0, min(100.0, float(ov.get("x", 50.0))))
    except (TypeError, ValueError):
        x_pct = 50.0
    try:
        y_pct = max(0.0, min(100.0, float(ov.get("y", 50.0))))
    except (TypeError, ValueError):
        y_pct = 50.0
    try:
        width_pct = max(5.0, min(100.0, float(ov.get("widthPct", 100.0))))
    except (TypeError, ValueError):
        width_pct = 100.0
    try:
        height_pct = max(5.0, min(100.0, float(ov.get("heightPct", 100.0))))
    except (TypeError, ValueError):
        height_pct = 100.0
    try:
        scale = max(0.1, min(2.0, float(ov.get("scale", 1.0))))
    except (TypeError, ValueError):
        scale = 1.0
    lock_aspect = bool(ov.get("lockAspectRatio", True))

    eff_w_pct = max(5.0, min(100.0, width_pct * scale))
    eff_h_pct = max(5.0, min(100.0, height_pct * scale))

    box_w = max(4, int(round(canvas_w * (eff_w_pct / 100.0))))
    box_h = max(4, int(round(canvas_h * (eff_h_pct / 100.0))))
    box_w -= box_w % 2
    box_h -= box_h % 2
    return x_pct / 100.0, y_pct / 100.0, max(2, box_w), max(2, box_h), lock_aspect

_VALID_TRANSITION_TYPES = set(_XFADE_TRANSITION_MAP.keys()) | {"none"}
_VALID_EFFECT_PRESETS = set(_EFFECT_PRESET_SPECS.keys())


def _require_finite_float(raw: object, label: str) -> float:
    try:
        val = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise VideoProcessingError(f"{label} must be a valid number.", status_code=400) from exc
    if not math.isfinite(val):
        raise VideoProcessingError(f"{label} must be a finite number.", status_code=400)
    return val


def validate_timeline_export_spec(
    timeline_spec: dict,
    *,
    num_files: int,
    resolution: ResolutionTarget = "720p",
    fps: int = 30,
    aspect_ratio: AspectRatioTarget | None = None,
) -> tuple[
    ResolutionTarget,
    int,
    AspectRatioTarget | None,
    set[str],
    list[dict],
    list[dict],
    list[dict],
    list[dict],
    list[int],
    list[int],
    list[int],
]:
    if not isinstance(timeline_spec, dict):
        raise VideoProcessingError("timeline_spec must be a JSON object.", status_code=400)

    project_meta = timeline_spec.get("project") if isinstance(timeline_spec.get("project"), dict) else {}
    fmt = str(timeline_spec.get("format") or project_meta.get("format") or "mp4").lower().strip()
    if fmt != "mp4":
        raise VideoProcessingError(
            f"Format '{fmt}' is not supported. Synchronous FFmpeg export supports MP4 (H.264) only.",
            status_code=400,
        )

    proj_res = str(project_meta.get("resolution") or resolution)
    proj_w = project_meta.get("width")
    proj_h = project_meta.get("height")
    if (
        proj_res.upper() == "4K"
        or (isinstance(proj_w, (int, float)) and proj_w > 1920)
        or (isinstance(proj_h, (int, float)) and proj_h > 1920)
    ):
        raise VideoProcessingError(
            "4K export is not supported in synchronous local MP4 export. Select 720p or 1080p.",
            status_code=400,
        )

    raw_profile = timeline_spec.get("exportProfile")
    if raw_profile is not None and str(raw_profile).strip():
        _, profile_res, _ = resolve_export_profile_spec(str(raw_profile), resolution)
        eff_resolution: ResolutionTarget = profile_res
    else:
        eff_resolution = (
            "1080p" if (resolution == "1080p" or proj_res == "1080p") else "720p"
        )

    raw_enc_mode = timeline_spec.get("encodingMode")
    if raw_enc_mode is not None:
        normalize_encoding_mode(str(raw_enc_mode))

    raw_fps = project_meta.get("fps") or fps
    try:
        eff_fps = int(raw_fps)
    except (TypeError, ValueError) as exc:
        raise VideoProcessingError("Invalid export frame rate.", status_code=400) from exc
    if eff_fps not in (24, 30, 60):
        raise VideoProcessingError(
            f"Frame rate {eff_fps} fps is not supported. Use 24, 30, or 60 fps.",
            status_code=400,
        )

    raw_ar = aspect_ratio or project_meta.get("aspectRatio")
    if raw_ar is not None and raw_ar not in ("16:9", "9:16", "1:1"):
        raise VideoProcessingError(
            f"Aspect ratio '{raw_ar}' is not supported. Use 16:9, 9:16, or 1:1.",
            status_code=400,
        )
    eff_aspect: AspectRatioTarget | None = raw_ar

    tracks = timeline_spec.get("tracks") or []
    muted_tracks = {
        str(t.get("id"))
        for t in tracks
        if isinstance(t, dict) and bool(t.get("muted"))
    }

    clips = timeline_spec.get("clips")
    if not isinstance(clips, list) or len(clips) == 0:
        raise VideoProcessingError("Timeline contains no clips to export.", status_code=400)
    if len(clips) > 24:
        raise VideoProcessingError(
            "Synchronous local MP4 export supports up to 24 timeline clips.",
            status_code=400,
        )

    v1_clips: list[dict] = []
    v2_clips: list[dict] = []
    text_clips: list[dict] = []
    audio_clips: list[dict] = []

    for clip in clips:
        if not isinstance(clip, dict):
            raise VideoProcessingError("Invalid clip entry in timelineSpec.", status_code=400)
        name = str(clip.get("sourceName") or clip.get("name") or clip.get("id") or "clip")
        track_id = str(clip.get("trackId") or "")
        kind = str(clip.get("kind") or "")

        if kind in ("video", "image") and track_id == "track_v1":
            v1_clips.append(clip)
        elif kind in ("image", "video") and track_id == "track_v2":
            v2_clips.append(clip)
        elif kind == "text" and track_id == "track_t1":
            text_clips.append(clip)
        elif kind == "audio" and track_id == "track_a1":
            audio_clips.append(clip)
        else:
            raise VideoProcessingError(
                f"Timeline clip '{name}' (type '{kind}' on '{track_id}') is not supported on this track.",
                status_code=400,
            )

        raw_speed = clip.get("speed")
        speed = _require_finite_float(1.0 if raw_speed is None else raw_speed, f"Clip '{name}' speed")
        if speed < 0.5 or speed > 2.0:
            raise VideoProcessingError(
                f"Clip '{name}' playback speed ({speed}x) must be between 0.5x and 2.0x.",
                status_code=400,
            )

        raw_volume = clip.get("volume")
        volume = _require_finite_float(1.0 if raw_volume is None else raw_volume, f"Clip '{name}' volume")
        if volume < 0.0 or volume > 2.0:
            raise VideoProcessingError(
                f"Clip '{name}' volume ({int(round(volume * 100))}%) must be between 0% and 200%.",
                status_code=400,
            )

        fade_in = _require_finite_float(clip.get("fadeInSec") or 0.0, f"Clip '{name}' fadeInSec")
        fade_out = _require_finite_float(clip.get("fadeOutSec") or 0.0, f"Clip '{name}' fadeOutSec")
        if fade_in < 0.0 or fade_in > 30.0 or fade_out < 0.0 or fade_out > 30.0:
            raise VideoProcessingError(
                f"Clip '{name}' fade durations must be between 0s and 30s.",
                status_code=400,
            )

        duck_amt = clip.get("duckingAmount")
        if duck_amt is not None:
            duck_val = _require_finite_float(duck_amt, f"Clip '{name}' duckingAmount")
            if duck_val < 0.0 or duck_val > 0.95:
                raise VideoProcessingError(
                    f"Clip '{name}' ducking amount must be between 0% and 95%.",
                    status_code=400,
                )

        raw_opacity = clip.get("opacity")
        opacity = _require_finite_float(1.0 if raw_opacity is None else raw_opacity, f"Clip '{name}' opacity")
        if opacity < 0.0 or opacity > 1.0:
            raise VideoProcessingError(
                f"Clip '{name}' opacity must be between 0% and 100%.",
                status_code=400,
            )

        for label, tr_key in (("transitionIn", "transitionIn"), ("transitionOut", "transitionOut")):
            tr = clip.get(tr_key)
            if tr is None:
                continue
            if not isinstance(tr, dict):
                raise VideoProcessingError(f"Clip '{name}' {label} must be an object.", status_code=400)
            tr_type = str(tr.get("type") or "none").lower().strip()
            if tr_type not in _VALID_TRANSITION_TYPES:
                raise VideoProcessingError(
                    f"Clip '{name}' has unsupported {label} type '{tr_type}'.",
                    status_code=400,
                )
            if tr.get("durationSec") is not None:
                tr_dur = _require_finite_float(tr.get("durationSec"), f"Clip '{name}' {label} durationSec")
                if tr_dur < 0.2 or tr_dur > 2.0:
                    raise VideoProcessingError(
                        f"Clip '{name}' {label} duration must be between 0.2s and 2.0s.",
                        status_code=400,
                    )

        fx = clip.get("effects")
        if fx is not None:
            if not isinstance(fx, dict):
                raise VideoProcessingError(f"Clip '{name}' effects must be an object.", status_code=400)
            preset = str(fx.get("preset") or "none").lower().strip()
            if preset not in _VALID_EFFECT_PRESETS:
                raise VideoProcessingError(
                    f"Clip '{name}' has unsupported effect preset '{preset}'.",
                    status_code=400,
                )
            if fx.get("brightness") is not None:
                b = _require_finite_float(fx.get("brightness"), f"Clip '{name}' brightness")
                if b < -0.5 or b > 0.5:
                    raise VideoProcessingError(f"Clip '{name}' brightness must be between -0.5 and 0.5.", status_code=400)
            if fx.get("contrast") is not None:
                c = _require_finite_float(fx.get("contrast"), f"Clip '{name}' contrast")
                if c < 0.5 or c > 1.8:
                    raise VideoProcessingError(f"Clip '{name}' contrast must be between 0.5 and 1.8.", status_code=400)
            if fx.get("saturation") is not None:
                s = _require_finite_float(fx.get("saturation"), f"Clip '{name}' saturation")
                if s < 0.0 or s > 2.0:
                    raise VideoProcessingError(f"Clip '{name}' saturation must be between 0 and 2.", status_code=400)
            if fx.get("blur") is not None:
                bl = _require_finite_float(fx.get("blur"), f"Clip '{name}' blur")
                if bl < 0.0 or bl > 10.0:
                    raise VideoProcessingError(f"Clip '{name}' blur must be between 0 and 10.", status_code=400)

        ov = clip.get("overlayTransform")
        if ov is not None:
            if not isinstance(ov, dict):
                raise VideoProcessingError(f"Clip '{name}' overlayTransform must be an object.", status_code=400)
            for axis, key in (("X position", "x"), ("Y position", "y")):
                if ov.get(key) is not None:
                    val = _require_finite_float(ov.get(key), f"Clip '{name}' overlay {axis}")
                    if val < 0.0 or val > 100.0:
                        raise VideoProcessingError(f"Clip '{name}' overlay {axis} must be between 0% and 100%.", status_code=400)
            for dim_label, key in (("width", "widthPct"), ("height", "heightPct")):
                if ov.get(key) is not None:
                    val = _require_finite_float(ov.get(key), f"Clip '{name}' overlay {dim_label}")
                    if val < 5.0 or val > 100.0:
                        raise VideoProcessingError(f"Clip '{name}' overlay {dim_label} must be between 5% and 100%.", status_code=400)
            if ov.get("scale") is not None:
                sc = _require_finite_float(ov.get("scale"), f"Clip '{name}' overlay scale")
                if sc < 0.1 or sc > 2.0:
                    raise VideoProcessingError(f"Clip '{name}' overlay scale must be between 0.1 and 2.0.", status_code=400)

    if len(v1_clips) == 0:
        raise VideoProcessingError(
            "Timeline must contain at least one video or image clip on track V1 to export MP4.",
            status_code=400,
        )
    if len(v1_clips) > 8 or len(v2_clips) > 8 or len(text_clips) > 8 or len(audio_clips) > 8:
        raise VideoProcessingError(
            "Synchronous local MP4 export supports up to 8 clips per track.",
            status_code=400,
        )

    sorted_v1 = sorted(
        v1_clips,
        key=lambda c: (float(c.get("timelineStartSec", 0.0)), str(c.get("id", ""))),
    )
    sorted_v2 = sorted(
        v2_clips,
        key=lambda c: (float(c.get("timelineStartSec", 0.0)), str(c.get("id", ""))),
    )
    sorted_t1 = sorted(
        text_clips,
        key=lambda c: (float(c.get("timelineStartSec", 0.0)), str(c.get("id", ""))),
    )
    sorted_a1 = sorted(
        audio_clips,
        key=lambda c: (float(c.get("timelineStartSec", 0.0)), str(c.get("id", ""))),
    )

    first_start = _require_finite_float(sorted_v1[0].get("timelineStartSec", 0.0), "V1 first clip timelineStartSec")
    if first_start > 0.15:
        raise VideoProcessingError(
            "Timeline starts with an empty gap before the first V1 clip. Move the first clip to 00:00 before exporting.",
            status_code=400,
        )

    for idx in range(len(sorted_v1) - 1):
        cur = sorted_v1[idx]
        nxt = sorted_v1[idx + 1]
        cur_start = _require_finite_float(cur.get("timelineStartSec", 0.0), f"V1 clip #{idx + 1} timelineStartSec")
        default_end = cur_start + _require_finite_float(cur.get("durationSec", 0.0), f"V1 clip #{idx + 1} durationSec")
        cur_end = _require_finite_float(cur.get("timelineEndSec", default_end), f"V1 clip #{idx + 1} timelineEndSec")
        nxt_start = _require_finite_float(nxt.get("timelineStartSec", 0.0), f"V1 clip #{idx + 2} timelineStartSec")
        gap = nxt_start - cur_end
        if gap < -0.05:
            raise VideoProcessingError(
                "Overlapping clips on track V1 are not supported in FFmpeg MP4 export. Arrange clips sequentially without overlap.",
                status_code=400,
            )
        if gap > 0.15:
            raise VideoProcessingError(
                "Empty timeline gaps between clips on track V1 are not supported in FFmpeg MP4 export. Close gaps before exporting.",
                status_code=400,
            )

    def _resolve_file_index(clip: dict) -> int:
        raw_idx = clip.get("fileIndex")
        if raw_idx is None:
            if num_files == 1:
                return 0
            raise VideoProcessingError(
                "Each clip in timelineSpec must specify 'fileIndex' when uploading multiple media files.",
                status_code=400,
            )
        if isinstance(raw_idx, bool):
            raise VideoProcessingError("Invalid fileIndex in timelineSpec clip.", status_code=400)
        try:
            f_idx = int(raw_idx)
        except (TypeError, ValueError) as exc:
            raise VideoProcessingError("Invalid fileIndex in timelineSpec clip.", status_code=400) from exc
        if f_idx < 0 or f_idx >= num_files:
            raise VideoProcessingError(
                f"Clip references missing uploaded media file index {f_idx}.",
                status_code=400,
            )
        return f_idx

    v1_file_indices = [_resolve_file_index(c) for c in sorted_v1]
    v2_file_indices = [_resolve_file_index(c) for c in sorted_v2]
    a1_file_indices = [_resolve_file_index(c) for c in sorted_a1]

    raw_intervals = timeline_spec.get("speechIntervals")
    if isinstance(raw_intervals, list):
        for idx, iv in enumerate(raw_intervals):
            if not isinstance(iv, dict):
                raise VideoProcessingError(f"Speech interval #{idx + 1} is invalid.", status_code=400)
            s = _require_finite_float(iv.get("start"), f"Speech interval #{idx + 1} start")
            e = _require_finite_float(iv.get("end"), f"Speech interval #{idx + 1} end")
            if s < 0 or e <= s:
                raise VideoProcessingError(
                    f"Speech interval #{idx + 1} has invalid start/end timestamps.",
                    status_code=400,
                )

    if bool(timeline_spec.get("burnSubtitles")):
        subtitles = timeline_spec.get("subtitles")
        if not isinstance(subtitles, list) or len(subtitles) == 0:
            raise VideoProcessingError(
                "Subtitle burn-in is enabled, but there are no subtitle cues to burn.",
                status_code=400,
            )
        for idx, cue in enumerate(subtitles):
            if not isinstance(cue, dict):
                raise VideoProcessingError("Invalid subtitle cue object.", status_code=400)
            s = _require_finite_float(cue.get("start"), f"Subtitle cue #{idx + 1} start")
            e = _require_finite_float(cue.get("end"), f"Subtitle cue #{idx + 1} end")
            if s < 0 or e <= s:
                raise VideoProcessingError(
                    f"Subtitle cue #{idx + 1} has invalid range ({s:.2f}s to {e:.2f}s).",
                    status_code=400,
                )
            if not str(cue.get("text", "")).strip():
                raise VideoProcessingError(
                    f"Subtitle cue #{idx + 1} has empty text.",
                    status_code=400,
                )
        sub_style = timeline_spec.get("subtitleStyle")
        if isinstance(sub_style, dict):
            if sub_style.get("fontSize") is not None:
                fs = _require_finite_float(sub_style.get("fontSize"), "Subtitle fontSize")
                if fs < 12 or fs > 72:
                    raise VideoProcessingError("Subtitle fontSize must be between 12 and 72.", status_code=400)
            if sub_style.get("position") is not None and str(sub_style.get("position")).lower() not in ("bottom", "middle", "top"):
                raise VideoProcessingError("Subtitle position must be 'bottom', 'middle', or 'top'.", status_code=400)
            if sub_style.get("backgroundOpacity") is not None:
                bo = _require_finite_float(sub_style.get("backgroundOpacity"), "Subtitle backgroundOpacity")
                if bo < 0.0 or bo > 1.0:
                    raise VideoProcessingError("Subtitle backgroundOpacity must be between 0 and 1.", status_code=400)

    return (
        eff_resolution,
        eff_fps,
        eff_aspect,
        muted_tracks,
        sorted_v1,
        sorted_v2,
        sorted_t1,
        sorted_a1,
        v1_file_indices,
        v2_file_indices,
        a1_file_indices,
    )


def export_timeline_mp4(
    uploaded_files: Sequence[Path],
    output_path: Path,
    *,
    timeline_spec: dict | None = None,
    resolution: ResolutionTarget = "720p",
    fps: int = 30,
    aspect_ratio: AspectRatioTarget | None = None,
    export_profile: ExportProfileId | None = None,
    encoding_mode: EncodingModeTarget = "auto",
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 240,
    max_duration_sec: float = 300.0,
    progress_cb: Optional[StageProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict:
    if cancel_event is not None and cancel_event.is_set():
        raise VideoProcessingCancelledError()

    if not uploaded_files:
        raise VideoProcessingError("Upload at least one video file to export.", status_code=400)

    raw_profile_arg: str | None = export_profile
    if raw_profile_arg is None and isinstance(timeline_spec, dict) and timeline_spec.get("exportProfile"):
        raw_profile_arg = str(timeline_spec.get("exportProfile"))
    raw_enc_arg: str | None = encoding_mode
    if (
        (raw_enc_arg is None or raw_enc_arg == "auto")
        and isinstance(timeline_spec, dict)
        and timeline_spec.get("encodingMode")
    ):
        raw_enc_arg = str(timeline_spec.get("encodingMode"))

    resolved_profile_id, profile_res, profile_spec = resolve_export_profile_spec(
        raw_profile_arg,
        resolution,
    )
    eff_encoding_mode = normalize_encoding_mode(raw_enc_arg)
    target_resolution: ResolutionTarget = profile_res if resolved_profile_id is not None else resolution

    if timeline_spec is None:
        return export_mp4(
            uploaded_files[0],
            output_path,
            resolution=target_resolution,
            fps=fps,
            aspect_ratio=aspect_ratio,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
            max_duration_sec=max_duration_sec,
            progress_cb=progress_cb,
            cancel_event=cancel_event,
            process_cb=process_cb,
        )

    profiler = _ExportProfiler()

    if progress_cb is not None:
        progress_cb("probing", "Inspecting media streams", 5, False)

    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    (
        spec_resolution,
        eff_fps,
        eff_aspect,
        muted_tracks,
        sorted_v1,
        sorted_v2,
        sorted_t1,
        sorted_a1,
        v1_file_indices,
        v2_file_indices,
        a1_file_indices,
    ) = validate_timeline_export_spec(
        timeline_spec,
        num_files=len(uploaded_files),
        resolution=target_resolution,
        fps=fps,
        aspect_ratio=aspect_ratio,
    )
    eff_resolution: ResolutionTarget = profile_res if resolved_profile_id is not None else spec_resolution

    probe_start = time.perf_counter()
    v1_source_metas: dict[int, dict] = {}
    for clip, f_idx in zip(sorted_v1, v1_file_indices):
        if f_idx in v1_source_metas:
            continue
        if _is_image_clip(clip, uploaded_files[f_idx]):
            v1_source_metas[f_idx] = {"duration_seconds": 0.0, "has_audio": False, "is_image": True}
        else:
            v1_source_metas[f_idx] = extract_video_metadata(
                uploaded_files[f_idx],
                ffprobe_bin=ffprobe_bin,
            )

    v2_source_metas: dict[int, dict] = {}
    for clip, f_idx in zip(sorted_v2, v2_file_indices):
        if f_idx in v2_source_metas:
            continue
        if f_idx in v1_source_metas:
            v2_source_metas[f_idx] = v1_source_metas[f_idx]
            continue
        if _is_image_clip(clip, uploaded_files[f_idx]):
            v2_source_metas[f_idx] = {"duration_seconds": 0.0, "has_audio": False, "is_image": True}
        else:
            v2_source_metas[f_idx] = extract_video_metadata(
                uploaded_files[f_idx],
                ffprobe_bin=ffprobe_bin,
            )

    a1_source_metas: dict[int, dict] = {}
    for f_idx in set(a1_file_indices):
        if f_idx in v1_source_metas and bool(v1_source_metas[f_idx].get("has_audio")):
            a1_source_metas[f_idx] = v1_source_metas[f_idx]
        else:
            a1_source_metas[f_idx] = extract_audio_metadata(
                uploaded_files[f_idx],
                ffprobe_bin=ffprobe_bin,
            )
    profiler.record("metadata_probing", total_sec=time.perf_counter() - probe_start, active=True)

    v1_prep_start = time.perf_counter()
    v1_prepared_clips: list[dict] = []
    total_v1_duration = 0.0
    for idx, clip in enumerate(sorted_v1):
        f_idx = v1_file_indices[idx]
        src_path = uploaded_files[f_idx]
        src_meta = v1_source_metas[f_idx]
        is_image = bool(src_meta.get("is_image"))
        clip_speed = 1.0 if is_image else max(0.5, min(2.0, float(clip.get("speed", 1.0) or 1.0)))
        clip_name = str(clip.get("sourceName") or clip.get("name") or f"V1 clip #{idx + 1}")

        if is_image:
            seg_dur = max(0.2, min(60.0, float(clip.get("durationSec", 5.0))))
            src_in = 0.0
            effective_out = seg_dur
        else:
            src_duration = float(src_meta["duration_seconds"])
            src_in = float(clip.get("sourceInSec", 0.0))
            default_out = (
                src_in + float(clip["durationSec"]) * clip_speed
                if "durationSec" in clip
                else src_duration
            )
            src_out = float(clip.get("sourceOutSec", default_out))
            if src_in < 0 or src_out <= src_in:
                raise VideoProcessingError(
                    f"Invalid trim range ({src_in:.2f}s to {src_out:.2f}s) on clip '{clip_name}'.",
                    status_code=400,
                )
            if src_duration > 0 and src_in >= src_duration:
                raise VideoProcessingError(
                    f"Clip start offset ({src_in:.2f}s) exceeds source video duration ({src_duration:.2f}s).",
                    status_code=400,
                )
            effective_out = min(src_out, src_duration) if src_duration > 0 else src_out
            src_span = effective_out - src_in
            if src_span < 0.08:
                raise VideoProcessingError("Clip source range must be at least 0.1 seconds.", status_code=400)
            if src_span > max_duration_sec:
                raise VideoProcessingError(
                    f"Processed video segment duration ({src_span:.1f}s) on '{clip_name}' exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
                    status_code=400,
                )
            seg_dur = src_span / clip_speed
            if seg_dur < 0.1:
                raise VideoProcessingError("Clip duration must be at least 0.1 seconds.", status_code=400)
            if seg_dur > max_duration_sec:
                raise VideoProcessingError(
                    f"Timeline segment duration ({seg_dur:.1f}s) on '{clip_name}' exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
                    status_code=400,
                )

        total_v1_duration += seg_dur
        v1_prepared_clips.append({
            "src_path": src_path,
            "src_meta": src_meta,
            "is_image": is_image,
            "src_in": src_in,
            "src_out": effective_out,
            "seg_dur": seg_dur,
            "speed": clip_speed,
            "volume": float(clip.get("volume", 1.0)),
            "muted": bool(clip.get("muted", False)) or ("track_v1" in muted_tracks) or is_image,
            "fade_in": float(clip.get("fadeInSec", 0.0) or 0.0),
            "fade_out": float(clip.get("fadeOutSec", 0.0) or 0.0),
            "opacity": float(clip.get("opacity", 1.0)),
            "transition_in": clip.get("transitionIn"),
            "transition_out": clip.get("transitionOut"),
            "effects": clip.get("effects"),
        })

    if total_v1_duration > max_duration_sec:
        raise VideoProcessingError(
            f"Combined timeline duration ({total_v1_duration:.1f}s) exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )

    profiler.record(
        "v1_clip_preparation_and_trimming",
        total_sec=time.perf_counter() - v1_prep_start,
        active=True,
        note="Direct input-side -ss/-t seeking (zero intermediate H.264 pre-encode)",
    )

    # Estimate rendered visual duration (accounts for V1 seam xfade overlaps) before filtering V2/T1
    est_overlaps: list[float] = []
    for idx in range(len(v1_prepared_clips) - 1):
        left = v1_prepared_clips[idx]
        right = v1_prepared_clips[idx + 1]
        max_seam = min(left["seg_dur"] * 0.45, right["seg_dur"] * 0.45)
        t_out_type, t_out_dur = _normalize_transition(left.get("transition_out"), max_seam)
        t_in_type, t_in_dur = _normalize_transition(right.get("transition_in"), max_seam)
        if t_out_type != "none":
            est_overlaps.append(t_out_dur)
        elif t_in_type != "none":
            est_overlaps.append(t_in_dur)
        else:
            est_overlaps.append(0.0)
    expected_v1_dur = max(0.1, total_v1_duration - sum(est_overlaps))

    # Validate & prepare active V2 overlays upfront so they fuse cleanly into single visual pass
    v2_track_muted = "track_v2" in muted_tracks
    active_v2_overlays: list[dict] = []
    if not v2_track_muted:
        for idx, clip in enumerate(sorted_v2):
            if float(clip.get("opacity", 1.0)) <= 0.005:
                continue
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            tl_dur = max(0.1, float(clip.get("durationSec", 1.0)))
            tl_end = min(expected_v1_dur, tl_start + tl_dur)
            if tl_start >= expected_v1_dur - 0.02 or tl_end - tl_start < 0.05:
                continue
            f_idx = v2_file_indices[idx]
            src_path = uploaded_files[f_idx]
            src_meta = v2_source_metas[f_idx]
            is_image = bool(src_meta.get("is_image"))
            ov_speed = 1.0 if is_image else max(0.5, min(2.0, float(clip.get("speed", 1.0) or 1.0)))
            src_in = max(0.0, float(clip.get("sourceInSec", 0.0)))
            src_dur = float(src_meta.get("duration_seconds", 0.0))
            src_out = src_in + (tl_end - tl_start) * ov_speed
            if not is_image and src_dur > 0:
                if src_in >= src_dur:
                    continue
                src_out = min(src_out, src_dur)
                if src_out <= src_in + 0.05:
                    continue
                tl_end = min(expected_v1_dur, tl_start + (src_out - src_in) / ov_speed)
            if not is_image and (src_out - src_in) > max_duration_sec:
                clip_name = str(clip.get("sourceName") or clip.get("name") or f"V2 clip #{idx + 1}")
                raise VideoProcessingError(
                    f"Processed overlay segment duration ({src_out - src_in:.1f}s) on '{clip_name}' exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
                    status_code=400,
                )

            active_v2_overlays.append({
                "src_path": src_path,
                "src_meta": src_meta,
                "is_image": is_image,
                "tl_start": tl_start,
                "tl_end": tl_end,
                "src_in": src_in,
                "src_out": src_out,
                "speed": ov_speed,
                "opacity": float(clip.get("opacity", 1.0)),
                "volume": float(clip.get("volume", 1.0)),
                "muted": bool(clip.get("muted", False)) or v2_track_muted or is_image,
                "fade_in": float(clip.get("fadeInSec", 0.0) or 0.0),
                "fade_out": float(clip.get("fadeOutSec", 0.0) or 0.0),
                "transition_in": clip.get("transitionIn"),
                "transition_out": clip.get("transitionOut"),
                "effects": clip.get("effects"),
                "overlay_transform": clip.get("overlayTransform"),
            })

    # Validate & prepare active A1 workload upfront
    a1_track_muted = "track_a1" in muted_tracks
    if not a1_track_muted:
        for idx, clip in enumerate(sorted_a1):
            if bool(clip.get("muted", False)) or float(clip.get("volume", 1.0)) <= 0.001:
                continue
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            if tl_start >= total_v1_duration - 0.02:
                continue
            f_idx = a1_file_indices[idx]
            src_meta = a1_source_metas[f_idx]
            src_duration = float(src_meta["duration_seconds"])
            a1_speed = max(0.5, min(2.0, float(clip.get("speed", 1.0) or 1.0)))
            src_in = max(0.0, float(clip.get("sourceInSec", 0.0)))
            default_out = (
                src_in + float(clip["durationSec"]) * a1_speed
                if "durationSec" in clip
                else src_duration
            )
            src_out = float(clip.get("sourceOutSec", default_out))
            if src_out <= src_in or (src_duration > 0 and src_in >= src_duration):
                continue
            effective_out = min(src_out, src_duration) if src_duration > 0 else src_out
            src_span = effective_out - src_in
            rendered_clip_dur = src_span / a1_speed
            clip_name = str(clip.get("sourceName") or clip.get("name") or f"A1 clip #{idx + 1}")
            if src_span > max_duration_sec:
                raise VideoProcessingError(
                    f"Audio segment duration ({src_span:.1f}s) on '{clip_name}' exceeds synchronous short-media limit ({max_duration_sec:.0f}s).",
                    status_code=400,
                )
            if rendered_clip_dur > max_duration_sec:
                raise VideoProcessingError(
                    f"Audio timeline duration ({rendered_clip_dur:.1f}s) on '{clip_name}' exceeds synchronous short-media limit ({max_duration_sec:.0f}s).",
                    status_code=400,
                )

    t1_track_muted = "track_t1" in muted_tracks
    burn_subs = bool(timeline_spec.get("burnSubtitles"))
    if burn_subs:
        subtitles = timeline_spec.get("subtitles")
        if not isinstance(subtitles, list) or len(subtitles) == 0:
            raise VideoProcessingError(
                "Subtitle burn-in is enabled, but there are no subtitle cues to burn.",
                status_code=400,
            )
    else:
        subtitles = []

    active_t1_overlays: list[dict] = []
    if not t1_track_muted:
        for clip in sorted_t1:
            t_style = clip.get("textStyle") if isinstance(clip.get("textStyle"), dict) else {}
            text_val = str(t_style.get("text") or clip.get("name") or "").strip()
            if not text_val:
                continue
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            tl_dur = max(0.1, float(clip.get("durationSec", 1.0)))
            tl_end = min(expected_v1_dur, tl_start + tl_dur)
            if tl_start >= expected_v1_dur - 0.02 or tl_end - tl_start < 0.05:
                continue
            opacity = float(clip.get("opacity", 1.0))
            if opacity <= 0.005:
                continue
            active_t1_overlays.append({
                "start": tl_start,
                "end": tl_end,
                "opacity": opacity,
                "transition_in": clip.get("transitionIn"),
                "transition_out": clip.get("transitionOut"),
                "textStyle": {**t_style, "text": text_val},
            })

    needs_ass_pass = burn_subs or len(active_t1_overlays) > 0

    # Resolve target canvas dimensions up front (preserving single-clip auto-aspect behavior)
    target_w, target_h = _resolve_export_dimensions(eff_resolution, eff_aspect)
    if len(v1_prepared_clips) == 1 and eff_aspect is None and not v1_prepared_clips[0]["is_image"]:
        single_meta = v1_prepared_clips[0]["src_meta"]
        max_h = 1080 if eff_resolution == "1080p" else 720
        src_w = int(single_meta["video"]["width"])
        src_h = int(single_meta["video"]["height"])
        scale_factor = min(1.0, max_h / src_h) if src_h > max_h else 1.0
        target_w = max(2, int(round(src_w * scale_factor / 2) * 2))
        target_h = max(2, int(round(src_h * scale_factor / 2) * 2))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="_timeline_work_", dir=str(output_path.parent)))

    try:

        ass_path: Path | None = None
        t1_prep_start = time.perf_counter()
        if needs_ass_pass:
            style = (
                timeline_spec.get("subtitleStyle")
                if isinstance(timeline_spec.get("subtitleStyle"), dict)
                else {}
            )
            ass_path = work_dir / "overlays_and_subtitles.ass"
            _write_ass_subtitles(
                subtitles if burn_subs else [],
                style,
                ass_path,
                width=target_w,
                height=target_h,
                text_overlays=active_t1_overlays,
            )
        profiler.record(
            "t1_text_rendering",
            total_sec=time.perf_counter() - t1_prep_start if needs_ass_pass else 0.0,
            active=needs_ass_pass,
            note="ASS script generated upfront and burned inside single visual pass" if needs_ass_pass else "No T1/subtitles",
        )

        # Determine audible clips before visual render so silent timelines can write directly to output_path
        active_a1_clips: list[dict] = []
        for idx, clip in enumerate(sorted_a1):
            if a1_track_muted or bool(clip.get("muted", False)):
                continue
            vol = float(clip.get("volume", 1.0))
            if vol <= 0.001:
                continue
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            if tl_start >= expected_v1_dur - 0.02:
                continue

            f_idx = a1_file_indices[idx]
            src_path = uploaded_files[f_idx]
            src_meta = a1_source_metas[f_idx]
            src_duration = float(src_meta["duration_seconds"])
            a1_speed = max(0.5, min(2.0, float(clip.get("speed", 1.0) or 1.0)))
            src_in = max(0.0, float(clip.get("sourceInSec", 0.0)))
            default_out = (
                src_in + float(clip["durationSec"]) * a1_speed
                if "durationSec" in clip
                else src_duration
            )
            src_out = float(clip.get("sourceOutSec", default_out))
            if src_out <= src_in or (src_duration > 0 and src_in >= src_duration):
                continue
            effective_out = min(src_out, src_duration) if src_duration > 0 else src_out
            if effective_out - src_in < 0.05:
                continue

            active_a1_clips.append({
                "src_path": src_path,
                "src_duration": src_duration,
                "src_in": src_in,
                "src_out": effective_out,
                "tl_start": tl_start,
                "speed": a1_speed,
                "volume": vol,
                "fade_in": float(clip.get("fadeInSec", 0.0) or 0.0),
                "fade_out": float(clip.get("fadeOutSec", 0.0) or 0.0),
                "ducking_enabled": bool(clip.get("duckingEnabled", False)),
                "ducking_amount": float(
                    clip.get("duckingAmount", 0.6) if clip.get("duckingAmount") is not None else 0.6
                ),
            })

        v1_has_any_audible = any(
            bool(item["src_meta"].get("has_audio")) and not item["muted"] and item["volume"] > 0.001
            for item in v1_prepared_clips
        )
        active_v2_audio_clips = [
            item
            for item in active_v2_overlays
            if not item["is_image"]
            and bool(item["src_meta"].get("has_audio"))
            and not item["muted"]
            and item["volume"] > 0.001
        ]
        has_output_audio = v1_has_any_audible or len(active_a1_clips) > 0 or len(active_v2_audio_clips) > 0

        stage_weights: list[tuple[str, float]] = [("visual", 82.0)]
        if has_output_audio:
            stage_weights.append(("audio", 18.0))
        total_weight = sum(w for _, w in stage_weights) or 1.0
        stage_ranges: dict[str, tuple[int, int]] = {}
        cursor_pct = 10.0
        for key, w in stage_weights:
            span = (w / total_weight) * 86.0
            stage_ranges[key] = (int(round(cursor_pct)), int(round(cursor_pct + span)))
            cursor_pct += span

        def _emit_stage_progress(key: str, stage: str, label: str, frac: float, measurable: bool) -> None:
            if progress_cb is None:
                return
            start_p, end_p = stage_ranges.get(key, (10, 96))
            pct = start_p + int(round(max(0.0, min(1.0, frac)) * max(1, end_p - start_p))) if measurable else start_p
            progress_cb(stage, label, pct, measurable)

        chosen_encoder, pre_fallback = _select_video_encoder(eff_encoding_mode, ffmpeg_bin)
        visual_label_parts = ["V1 timeline"]
        if active_v2_overlays:
            visual_label_parts.append("V2 overlays")
        if needs_ass_pass:
            visual_label_parts.append("subtitles/titles")
        visual_stage_label = f"Rendering {' & '.join(visual_label_parts)}"

        visual_target_path = work_dir / "visual_only.mp4" if has_output_audio else output_path
        _emit_stage_progress("visual", "rendering_v1", visual_stage_label, 0.0, True)
        visual_meta, seam_overlaps, encoder_used, runtime_fallback = _render_unified_visual_mp4(
            v1_prepared_clips,
            active_v2_overlays,
            visual_target_path,
            width=target_w,
            height=target_h,
            fps=eff_fps,
            ass_path=ass_path,
            ass_cwd=work_dir if ass_path is not None else None,
            profile_spec=profile_spec,
            encoder=chosen_encoder,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
            progress_cb=lambda frac, m: _emit_stage_progress(
                "visual", "rendering_v1", visual_stage_label, frac, m
            ),
            cancel_event=cancel_event,
            process_cb=process_cb,
            profiler=profiler,
        )
        fallback_used = pre_fallback or runtime_fallback
        rendered_duration = float(visual_meta["duration_seconds"]) or expected_v1_dur

        if not has_output_audio:
            profiler.record("audio_segment_pretrimming", total_sec=0.0, active=False)
            profiler.record("audio_mixing_and_ducking", total_sec=0.0, active=False)
            profiler.record("final_encoding_and_muxing", total_sec=0.0, active=True, note="Direct visual-only MP4 output")
            rendered_meta = visual_meta
        else:
            _emit_stage_progress("audio", "mixing_audio", "Mixing audio & muxing MP4", 0.0, True)
            audio_prep_start = time.perf_counter()

            needs_sidechain_key = (
                len(active_a1_clips) > 0
                and any(c["ducking_enabled"] for c in active_a1_clips)
                and v1_has_any_audible
            )
            speech_intervals = _merge_speech_intervals(
                timeline_spec.get("speechIntervals"),
                timeline_spec.get("subtitles"),
            )

            audio_cmd = [ffmpeg_path, "-y", "-i", str(visual_target_path)]
            audio_filters: list[str] = []
            input_idx = 1

            v1_mix_label: str | None = None
            v1_key_label: str | None = None

            if v1_has_any_audible:
                v1_seg_labels: list[str] = []
                for s_idx, item in enumerate(v1_prepared_clips):
                    seg_dur = float(item["seg_dur"])
                    has_src_audio = bool(item["src_meta"].get("has_audio"))
                    if not has_src_audio or item["muted"] or item["volume"] <= 0.001:
                        audio_filters.append(
                            f"anullsrc=channel_layout=stereo:sample_rate=44100:d={seg_dur:.3f}[v1a_{s_idx}]"
                        )
                    else:
                        v1_audio_path = Path(item["src_path"]).resolve()
                        v1_a_in = float(item["src_in"])
                        v1_a_out = float(item["src_out"])
                        v1_src_dur = float(item["src_meta"].get("duration_seconds", 0.0))
                        v1_span = max(0.05, v1_a_out - v1_a_in)
                        cur_in_idx = input_idx
                        if (
                            v1_a_in > 0.05
                            or (v1_src_dur > 0 and v1_a_out < v1_src_dur - 0.05)
                            or v1_src_dur > max_duration_sec
                        ):
                            audio_cmd.extend(["-ss", f"{v1_a_in:.3f}", "-t", f"{v1_span:.3f}", "-i", str(v1_audio_path)])
                            chain_in, chain_out = 0.0, v1_span
                        else:
                            audio_cmd.extend(["-i", str(v1_audio_path)])
                            chain_in, chain_out = v1_a_in, v1_a_out
                        input_idx += 1
                        chain = _build_audio_clip_chain(
                            f"{cur_in_idx}:a",
                            src_in=chain_in,
                            src_out=chain_out,
                            volume=item["volume"],
                            fade_in=item["fade_in"],
                            fade_out=item["fade_out"],
                            speed=item["speed"],
                        )
                        audio_filters.append(f"{chain}[v1a_{s_idx}]")
                    v1_seg_labels.append(f"[v1a_{s_idx}]")

                if len(v1_seg_labels) == 1:
                    v1_joined = v1_seg_labels[0]
                elif not any(d > 0.05 for d in seam_overlaps):
                    v1_joined = f"{''.join(v1_seg_labels)}concat=n={len(v1_seg_labels)}:v=0:a=1"
                else:
                    cur_albl = v1_seg_labels[0]
                    for s_idx in range(len(v1_seg_labels) - 1):
                        nxt_albl = v1_seg_labels[s_idx + 1]
                        overlap_d = seam_overlaps[s_idx] if s_idx < len(seam_overlaps) else 0.0
                        out_albl = f"[v1aj_{s_idx + 1}]"
                        if overlap_d > 0.05:
                            audio_filters.append(
                                f"{cur_albl}{nxt_albl}acrossfade=d={overlap_d:.3f}:c1=tri:c2=tri{out_albl}"
                            )
                        else:
                            audio_filters.append(f"{cur_albl}{nxt_albl}concat=n=2:v=0:a=1{out_albl}")
                        cur_albl = out_albl
                    v1_joined = cur_albl

                v1_base_chain = (
                    f"{v1_joined}apad=whole_dur={rendered_duration:.3f},atrim=0:{rendered_duration:.3f}"
                    if v1_joined.startswith("[") and not v1_joined.endswith("=1")
                    else f"{v1_joined},apad=whole_dur={rendered_duration:.3f},atrim=0:{rendered_duration:.3f}"
                )
                if needs_sidechain_key and len(speech_intervals) == 0:
                    audio_filters.append(f"{v1_base_chain},asplit=2[v1_out][v1_sc_raw]")
                    v1_mix_label = "[v1_out]"
                    v1_key_label = "[v1_sc_raw]"
                else:
                    audio_filters.append(f"{v1_base_chain}[v1_out]")
                    v1_mix_label = "[v1_out]"

            a1_clip_labels: list[str] = []
            sidechain_duck_clips = [
                c for c in active_a1_clips if c["ducking_enabled"] and len(speech_intervals) == 0 and v1_key_label
            ]
            sc_key_splits: list[str] = []
            if sidechain_duck_clips and v1_key_label:
                if len(sidechain_duck_clips) == 1:
                    sc_key_splits = ["[v1_sc_0]"]
                    audio_filters.append(
                        f"{v1_key_label}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[v1_sc_0]"
                    )
                else:
                    sc_raw_splits = [f"[v1_sc_raw_{i}]" for i in range(len(sidechain_duck_clips))]
                    sc_key_splits = [f"[v1_sc_{i}]" for i in range(len(sidechain_duck_clips))]
                    audio_filters.append(
                        f"{v1_key_label}asplit={len(sidechain_duck_clips)}{''.join(sc_raw_splits)}"
                    )
                    for raw_lbl, fmt_lbl in zip(sc_raw_splits, sc_key_splits):
                        audio_filters.append(
                            f"{raw_lbl}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo{fmt_lbl}"
                        )

            sc_split_cursor = 0
            for a_idx, item in enumerate(active_a1_clips):
                a1_src_path = Path(item["src_path"]).resolve()
                a1_in = float(item["src_in"])
                a1_out = float(item["src_out"])
                a1_src_dur = float(item.get("src_duration", 0.0))
                a1_span = max(0.05, a1_out - a1_in)
                cur_in_idx = input_idx
                if (
                    a1_in > 0.05
                    or (a1_src_dur > 0 and a1_out < a1_src_dur - 0.05)
                    or a1_src_dur > max_duration_sec
                ):
                    audio_cmd.extend(["-ss", f"{a1_in:.3f}", "-t", f"{a1_span:.3f}", "-i", str(a1_src_path)])
                    chain_in, chain_out = 0.0, a1_span
                else:
                    audio_cmd.extend(["-i", str(a1_src_path)])
                    chain_in, chain_out = a1_in, a1_out
                input_idx += 1

                base_chain = _build_audio_clip_chain(
                    f"{cur_in_idx}:a",
                    src_in=chain_in,
                    src_out=chain_out,
                    volume=item["volume"],
                    fade_in=item["fade_in"],
                    fade_out=item["fade_out"],
                    speed=item["speed"],
                )
                cur_label = f"[a1_base_{a_idx}]"
                audio_filters.append(f"{base_chain}{cur_label}")

                if item["tl_start"] > 0.01:
                    delay_ms = int(round(item["tl_start"] * 1000))
                    delayed_label = f"[a1_del_{a_idx}]"
                    audio_filters.append(f"{cur_label}adelay={delay_ms}|{delay_ms}{delayed_label}")
                    cur_label = delayed_label

                padded_label = f"[a1_pad_{a_idx}]"
                audio_filters.append(
                    f"{cur_label}apad=whole_dur={rendered_duration:.3f},atrim=0:{rendered_duration:.3f},"
                    f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo{padded_label}"
                )
                cur_label = padded_label

                if item["ducking_enabled"] and item["ducking_amount"] > 0.01:
                    if speech_intervals:
                        duck_expr = _build_interval_ducking_expr(speech_intervals, item["ducking_amount"])
                        ducked_label = f"[a1_duck_{a_idx}]"
                        audio_filters.append(
                            f"{cur_label}volume='{duck_expr}':eval=frame{ducked_label}"
                        )
                        cur_label = ducked_label
                    elif sc_split_cursor < len(sc_key_splits):
                        key_lbl = sc_key_splits[sc_split_cursor]
                        sc_split_cursor += 1
                        duck_mix = max(0.1, min(1.0, item["ducking_amount"]))
                        ducked_label = f"[a1_scduck_{a_idx}]"
                        audio_filters.append(
                            f"{cur_label}{key_lbl}sidechaincompress=threshold=0.04:ratio=6:attack=40:release=350:mix={duck_mix:.2f}{ducked_label}"
                        )
                        cur_label = ducked_label

                a1_clip_labels.append(cur_label)

            v2_audio_labels: list[str] = []
            for v2_idx, item in enumerate(active_v2_audio_clips):
                v2_src_path = Path(item["src_path"]).resolve()
                v2_in = float(item["src_in"])
                v2_out = float(item["src_out"])
                v2_span = max(0.05, v2_out - v2_in)
                v2_src_dur = float(item["src_meta"].get("duration_seconds", 0.0))
                cur_in_idx = input_idx
                if v2_in > 0.02 or (v2_src_dur > 0 and v2_out < v2_src_dur - 0.02) or v2_src_dur > max_duration_sec:
                    audio_cmd.extend(["-ss", f"{v2_in:.3f}", "-t", f"{v2_span:.3f}", "-i", str(v2_src_path)])
                    chain_in, chain_out = 0.0, v2_span
                else:
                    audio_cmd.extend(["-i", str(v2_src_path)])
                    chain_in, chain_out = v2_in, v2_out
                input_idx += 1

                base_chain = _build_audio_clip_chain(
                    f"{cur_in_idx}:a",
                    src_in=chain_in,
                    src_out=chain_out,
                    volume=item["volume"],
                    fade_in=item["fade_in"],
                    fade_out=item["fade_out"],
                    speed=item["speed"],
                )
                cur_label = f"[v2a_base_{v2_idx}]"
                audio_filters.append(f"{base_chain}{cur_label}")

                if item["tl_start"] > 0.01:
                    delay_ms = int(round(item["tl_start"] * 1000))
                    delayed_label = f"[v2a_del_{v2_idx}]"
                    audio_filters.append(f"{cur_label}adelay={delay_ms}|{delay_ms}{delayed_label}")
                    cur_label = delayed_label

                padded_label = f"[v2a_pad_{v2_idx}]"
                audio_filters.append(
                    f"{cur_label}apad=whole_dur={rendered_duration:.3f},atrim=0:{rendered_duration:.3f},"
                    f"aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo{padded_label}"
                )
                v2_audio_labels.append(padded_label)

            mix_inputs: list[str] = []
            if v1_mix_label:
                mix_inputs.append(v1_mix_label)
            mix_inputs.extend(v2_audio_labels)
            mix_inputs.extend(a1_clip_labels)

            any_boost = (
                any(
                    item["volume"] > 1.02
                    for item in v1_prepared_clips
                    if not item["muted"]
                )
                or any(c["volume"] > 1.02 for c in active_a1_clips)
                or any(c["volume"] > 1.02 for c in active_v2_audio_clips)
            )

            if len(mix_inputs) == 1:
                if any_boost:
                    audio_filters.append(
                        f"{mix_inputs[0]}alimiter=limit=0.98:attack=5:release=50:level=0[final_a]"
                    )
                else:
                    audio_filters.append(f"{mix_inputs[0]}acopy[final_a]")
            else:
                audio_filters.append(
                    f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=0:normalize=0,"
                    f"alimiter=limit=0.98:attack=5:release=50:level=0,atrim=0:{rendered_duration:.3f}[final_a]"
                )

            audio_prep_sec = time.perf_counter() - audio_prep_start
            profiler.record(
                "audio_segment_pretrimming",
                total_sec=audio_prep_sec,
                active=True,
                note="Direct input-side -ss/-t audio seeking (zero intermediate WAV disk pass)",
            )
            profiler.record(
                "audio_mixing_and_ducking",
                total_sec=0.0,
                active=len(mix_inputs) > 1 or any(c["ducking_enabled"] for c in active_a1_clips),
                note="Fused into final audio filtergraph + -c:v copy mux pass",
            )

            resolved_final_out = output_path.resolve()
            resolved_final_out.parent.mkdir(parents=True, exist_ok=True)
            audio_bitrate = str(profile_spec.get("audio_bitrate", "192k"))
            filter_graph = ";".join(audio_filters)
            audio_cmd.extend([
                "-filter_complex",
                filter_graph,
                "-map",
                "0:v:0",
                "-map",
                "[final_a]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                audio_bitrate,
                "-shortest",
                "-movflags",
                "+faststart",
                str(resolved_final_out),
            ])
            mux_ffmpeg_start = time.perf_counter()
            _run_ffmpeg(
                audio_cmd,
                timeout_sec,
                expected_duration_sec=rendered_duration,
                progress_cb=lambda frac, m: _emit_stage_progress(
                    "audio", "mixing_audio", "Mixing audio & muxing MP4", frac, m
                ),
                cancel_event=cancel_event,
                process_cb=process_cb,
            )
            mux_ffmpeg_sec = time.perf_counter() - mux_ffmpeg_start
            final_probe_start = time.perf_counter()
            rendered_meta = extract_video_metadata(resolved_final_out, ffprobe_bin=ffprobe_bin)
            final_probe_sec = time.perf_counter() - final_probe_start
            profiler.record(
                "final_encoding_and_muxing",
                total_sec=mux_ffmpeg_sec + final_probe_sec,
                ffmpeg_sec=mux_ffmpeg_sec,
                active=True,
                note="Direct audio mix + -c:v copy MP4 mux + faststart",
            )

        perf_summary = profiler.finalize()
        logger.info(
            "MP4 export profile=%s encoder=%s fallback=%s resolution=%s fps=%d duration=%.2fs total=%.3fs ffmpeg=%.3fs python=%.3fs stages=%s",
            resolved_profile_id or "legacy",
            encoder_used,
            fallback_used,
            eff_resolution,
            eff_fps,
            float(rendered_meta.get("duration_seconds") or 0.0),
            perf_summary["total_export_sec"],
            perf_summary["ffmpeg_execution_sec"],
            perf_summary["python_processing_sec"],
            {k: v.get("total_sec") for k, v in perf_summary["stages"].items()},
        )

        if progress_cb is not None:
            progress_cb("finalizing", "Finalizing MP4 metadata", 98, False)

        rendered_meta["export_profile"] = resolved_profile_id or "legacy"
        rendered_meta["encoder_used"] = encoder_used
        rendered_meta["hardware_fallback_used"] = fallback_used
        rendered_meta["performance"] = perf_summary
        return rendered_meta
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _hex_to_ass_color(hex_color: str, opacity: float = 1.0) -> str:
    raw = (hex_color or "#FFFFFF").strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in raw):
        raw = "FFFFFF"
    rr = raw[0:2].upper()
    gg = raw[2:4].upper()
    bb = raw[4:6].upper()
    clamped = max(0.0, min(1.0, float(opacity)))
    # ASS alpha is inverted: 00 = opaque, FF = transparent
    aa = f"{int(round((1.0 - clamped) * 255)):02X}"
    return f"&H{aa}{bb}{gg}{rr}"


def _format_ass_timestamp(seconds: float) -> str:
    total_cs = max(0, int(round(float(seconds) * 100)))
    cs = total_cs % 100
    sec = (total_cs // 100) % 60
    mins = (total_cs // 6000) % 60
    hrs = total_cs // 360000
    return f"{hrs}:{mins:02d}:{sec:02d}.{cs:02d}"


def _escape_ass_text(text: str) -> str:
    cleaned = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = cleaned.replace("{", r"\{").replace("}", r"\}")
    return cleaned.replace("\n", r"\N").strip()


def _contains_bengali_unicode(items: Sequence[dict]) -> bool:
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", ""))
        if not text and isinstance(item.get("textStyle"), dict):
            text = str(item["textStyle"].get("text", ""))
        if any("\u0980" <= ch <= "\u09ff" for ch in text):
            return True
    return False


def _detect_bengali_font_name() -> str:
    env_font = os.getenv("SUBTITLE_BENGALI_FONT", "").strip()
    if env_font:
        return env_font.replace(",", " ").strip()

    if os.name == "nt" or sys.platform.startswith("win"):
        windir = Path(os.getenv("WINDIR", r"C:\Windows"))
        local_appdata = os.getenv("LOCALAPPDATA", "")
        font_dirs = [windir / "Fonts"]
        if local_appdata:
            font_dirs.insert(0, Path(local_appdata) / "Microsoft" / "Windows" / "Fonts")

        windows_candidates = [
            ("Noto Sans Bengali", ("NotoSansBengali-Regular.ttf", "NotoSansBengali-Medium.ttf", "NotoSansBengali.ttf")),
            ("Nirmala UI", ("Nirmala.ttf", "Nirmala.ttc", "NirmalaUI.ttf")),
            ("Vrinda", ("vrinda.ttf", "vrindab.ttf")),
        ]
        for family_name, filenames in windows_candidates:
            for directory in font_dirs:
                for fname in filenames:
                    if (directory / fname).exists():
                        return family_name
        return "Nirmala UI"

    fc_list = shutil.which("fc-list")
    if fc_list:
        try:
            proc = subprocess.run(
                [fc_list, ":lang=bn", "--format=%{family}\n"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                families = [
                    line.split(",")[0].strip()
                    for line in proc.stdout.splitlines()
                    if line.strip()
                ]
                for preferred in ("Noto Sans Bengali", "Noto Serif Bengali", "Kalpurush", "Nirmala UI", "Vrinda"):
                    if preferred in families:
                        return preferred
                if families:
                    return families[0]
        except Exception:
            pass

    return "Noto Sans Bengali"


def _resolve_ass_font_name(items: Sequence[dict], style: dict) -> str:
    explicit = str(style.get("fontFamily", "") or "").strip()
    if explicit:
        cleaned = explicit.replace(",", " ").replace("\n", " ").replace("\r", " ").strip()
        if cleaned:
            return cleaned
    if _contains_bengali_unicode(items):
        return _detect_bengali_font_name()
    return "Arial"


def _write_ass_subtitles(
    subtitles: Sequence[dict],
    style: dict,
    ass_path: Path,
    *,
    width: int,
    height: int,
    text_overlays: Sequence[dict] = (),
) -> None:
    font_size_ui = float(style.get("fontSize", 28))
    font_size_ui = max(12.0, min(72.0, font_size_ui))
    ass_font_size = max(18, int(round(font_size_ui * (height / 540.0))))
    ass_font_name = _resolve_ass_font_name([*subtitles, *text_overlays], style)

    text_color = _hex_to_ass_color(str(style.get("color", "#FFFFFF")), 1.0)
    bg_opacity = float(style.get("backgroundOpacity", 0.75))
    bg_opacity = max(0.0, min(1.0, bg_opacity))
    bg_color_hex = str(style.get("backgroundColor", "#09090B"))

    if bg_opacity > 0.05:
        border_style = 3
        outline_colour = _hex_to_ass_color(bg_color_hex, bg_opacity)
        back_colour = "&HFF000000"
        outline_width = 8
        shadow_depth = 0
    else:
        border_style = 1
        outline_colour = "&H00000000"
        back_colour = "&H80000000"
        outline_width = 2
        shadow_depth = 1

    position = str(style.get("position", "bottom")).lower()
    if position == "top":
        alignment = 8
        margin_v = max(24, int(round(height * 0.07)))
    elif position == "middle":
        alignment = 5
        margin_v = 0
    else:
        alignment = 2
        margin_v = max(24, int(round(height * 0.07)))

    margin_h = max(24, int(round(width * 0.05)))

    style_lines = [
        f"Style: Default,{ass_font_name},{ass_font_size},{text_color},&H000000FF,{outline_colour},{back_colour},1,0,0,0,100,100,0,0,{border_style},{outline_width},{shadow_depth},{alignment},{margin_h},{margin_h},{margin_v},1"
    ]
    event_lines: list[str] = []

    # Layer 1: T1 Text Overlay clips (rendered with \pos(x,y) + optional fade)
    for t_idx, ov in enumerate(text_overlays):
        ts = ov.get("textStyle") if isinstance(ov.get("textStyle"), dict) else {}
        escaped = _escape_ass_text(str(ts.get("text", "")))
        if not escaped:
            continue
        clip_op = max(0.05, min(1.0, float(ov.get("opacity", 1.0))))
        ov_font_ui = max(12.0, min(120.0, float(ts.get("fontSize", 32))))
        ov_ass_size = max(18, int(round(ov_font_ui * (height / 540.0))))
        ov_color = _hex_to_ass_color(str(ts.get("color", "#FFFFFF")), clip_op)
        ov_bg_op = max(0.0, min(1.0, float(ts.get("backgroundOpacity", 0.6)))) * clip_op
        ov_bg_hex = str(ts.get("backgroundColor", "#09090B"))
        if ov_bg_op > 0.05:
            ov_bs = 3
            ov_out_col = _hex_to_ass_color(ov_bg_hex, ov_bg_op)
            ov_back_col = "&HFF000000"
            ov_out_w = 10
            ov_shadow = 0
        else:
            ov_bs = 1
            ov_out_col = "&H00000000"
            ov_back_col = "&H80000000"
            ov_out_w = 2
            ov_shadow = 1

        ov_style_name = f"T1_{t_idx}"
        style_lines.append(
            f"Style: {ov_style_name},{ass_font_name},{ov_ass_size},{ov_color},&H000000FF,{ov_out_col},{ov_back_col},1,0,0,0,100,100,0,0,{ov_bs},{ov_out_w},{ov_shadow},5,16,16,16,1"
        )

        ov_start = float(ov["start"])
        ov_end = float(ov["end"])
        ov_dur = max(0.1, ov_end - ov_start)
        _, in_d = _normalize_transition(ov.get("transition_in"), ov_dur * 0.45)
        _, out_d = _normalize_transition(ov.get("transition_out"), ov_dur * 0.45)
        fade_tag = f"\\fad({int(round(in_d * 1000))},{int(round(out_d * 1000))})" if (in_d > 0.05 or out_d > 0.05) else ""

        pos_x = int(round((max(0.0, min(100.0, float(ts.get("x", 50.0)))) / 100.0) * width))
        pos_y = int(round((max(0.0, min(100.0, float(ts.get("y", 82.0)))) / 100.0) * height))
        event_lines.append(
            f"Dialogue: 1,{_format_ass_timestamp(ov_start)},{_format_ass_timestamp(ov_end)},{ov_style_name},,0,0,0,,{{\\an5\\pos({pos_x},{pos_y}){fade_tag}}}{escaped}"
        )

    valid_cues = 0
    for idx, cue in enumerate(subtitles):
        if not isinstance(cue, dict):
            raise VideoProcessingError("Invalid subtitle cue object.", status_code=400)
        try:
            start_sec = float(cue["start"])
            end_sec = float(cue["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise VideoProcessingError(
                f"Subtitle cue #{idx + 1} is missing valid numeric start/end timestamps.",
                status_code=400,
            ) from exc
        if start_sec < 0 or end_sec <= start_sec:
            raise VideoProcessingError(
                f"Subtitle cue #{idx + 1} has invalid range ({start_sec:.2f}s to {end_sec:.2f}s).",
                status_code=400,
            )
        escaped_text = _escape_ass_text(str(cue.get("text", "")))
        if not escaped_text:
            continue
        start_ts = _format_ass_timestamp(start_sec)
        end_ts = _format_ass_timestamp(end_sec)
        event_lines.append(f"Dialogue: 0,{start_ts},{end_ts},Default,,0,0,0,,{escaped_text}")
        valid_cues += 1

    if len(subtitles) > 0 and valid_cues == 0 and len(event_lines) == 0:
        raise VideoProcessingError(
            "Subtitle burn-in is enabled, but all subtitle cues have empty text.",
            status_code=400,
        )

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *style_lines,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *event_lines,
    ]

    ass_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def burn_subtitles_into_mp4(
    input_path: Path,
    output_path: Path,
    ass_path: Path,
    *,
    has_audio: bool = True,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 240,
    expected_duration_sec: float | None = None,
    progress_cb: Optional[SubprocessProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    process_cb: Optional[ProcessAttachCallback] = None,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    resolved_in = input_path.resolve()
    resolved_out = output_path.resolve()
    resolved_ass = ass_path.resolve()
    resolved_out.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ffmpeg_path,
        "-y",
        "-i",
        str(resolved_in),
        "-vf",
        f"ass={resolved_ass.name}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
    ]
    if has_audio:
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.append("-an")
    cmd.extend(["-movflags", "+faststart", str(resolved_out)])

    _run_ffmpeg(
        cmd,
        timeout_sec,
        cwd=resolved_ass.parent,
        expected_duration_sec=expected_duration_sec,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        process_cb=process_cb,
    )
    return extract_video_metadata(resolved_out, ffprobe_bin=ffprobe_bin)

