from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional


class VideoMetadataError(Exception):
    """Raised when ffprobe validation or extraction fails."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def check_binary(binary_name: str) -> Optional[str]:
    return shutil.which(binary_name)


def _parse_frame_rate(raw_rate: Optional[str]) -> float:
    if not raw_rate or raw_rate in ("0/0", "N/A"):
        return 0.0
    if "/" in raw_rate:
        num_str, den_str = raw_rate.split("/", 1)
        try:
            num = float(num_str)
            den = float(den_str)
            if den == 0:
                return 0.0
            return round(num / den, 3)
        except ValueError:
            return 0.0
    try:
        return round(float(raw_rate), 3)
    except ValueError:
        return 0.0


def _parse_optional_int(value: Any) -> Optional[int]:
    if value is None or value == "" or value == "N/A":
        return None
    try:
        parsed = int(float(value))
        return parsed if parsed >= 0 else None
    except (TypeError, ValueError):
        return None


def _parse_optional_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "" or value == "N/A":
        return default
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and parsed >= 0 else default
    except (TypeError, ValueError):
        return default


def _infer_aspect_ratio_label(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "unknown"
    ratio = width / height
    known = {
        "16:9": 16 / 9,
        "9:16": 9 / 16,
        "1:1": 1.0,
        "4:3": 4 / 3,
        "4:5": 4 / 5,
        "21:9": 21 / 9,
    }
    for label, target in known.items():
        if abs(ratio - target) <= 0.03:
            return label
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def _extract_rotation(video_stream: dict[str, Any]) -> int:
    tags = video_stream.get("tags") or {}
    if "rotate" in tags:
        rot = _parse_optional_int(tags.get("rotate"))
        if rot is not None:
            return rot % 360

    for side_item in video_stream.get("side_data_list") or []:
        if isinstance(side_item, dict) and "rotation" in side_item:
            try:
                return int(float(side_item["rotation"])) % 360
            except (TypeError, ValueError):
                pass
    return 0


def extract_video_metadata(
    file_path: Path,
    *,
    original_filename: Optional[str] = None,
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 30,
) -> dict[str, Any]:
    if not file_path.exists() or not file_path.is_file():
        raise VideoMetadataError("Video file does not exist for metadata inspection.", status_code=400)

    if file_path.stat().st_size == 0:
        raise VideoMetadataError("Video file is empty (0 bytes).", status_code=400)

    resolved_ffprobe = check_binary(ffprobe_bin)
    if not resolved_ffprobe:
        raise VideoMetadataError(
            f"ffprobe binary '{ffprobe_bin}' is not installed or not on PATH.",
            status_code=503,
        )

    cmd = [
        resolved_ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise VideoMetadataError(
            f"ffprobe timed out after {timeout_sec}s while inspecting video.",
            status_code=504,
        ) from exc
    except OSError as exc:
        raise VideoMetadataError(f"Failed to execute ffprobe: {exc}", status_code=500) from exc

    if proc.returncode != 0:
        err_detail = (proc.stderr or "").strip()
        raise VideoMetadataError(
            f"File is not a valid or readable media container{': ' + err_detail if err_detail else '.'}",
            status_code=422,
        )

    try:
        probe_data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise VideoMetadataError("ffprobe returned malformed JSON metadata.", status_code=502) from exc

    streams = probe_data.get("streams") or []
    fmt = probe_data.get("format") or {}
    if not streams:
        raise VideoMetadataError("No media streams found in uploaded file.", status_code=422)

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if not video_stream:
        raise VideoMetadataError(
            "Uploaded file does not contain a video stream.",
            status_code=422,
        )

    width = _parse_optional_int(video_stream.get("width"))
    height = _parse_optional_int(video_stream.get("height"))
    if not width or not height:
        raise VideoMetadataError(
            "Video stream has invalid or missing resolution dimensions.",
            status_code=422,
        )

    duration = _parse_optional_float(
        fmt.get("duration") if fmt.get("duration") is not None else video_stream.get("duration"),
        default=0.0,
    )
    size_bytes = _parse_optional_int(fmt.get("size")) or file_path.stat().st_size
    rotation = _extract_rotation(video_stream)
    effective_width, effective_height = (height, width) if rotation in (90, 270) else (width, height)

    video_info = {
        "index": int(video_stream.get("index", 0)),
        "codec_name": str(video_stream.get("codec_name") or "unknown"),
        "codec_long_name": video_stream.get("codec_long_name"),
        "profile": video_stream.get("profile"),
        "width": width,
        "height": height,
        "fps": _parse_frame_rate(
            video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
        ),
        "avg_frame_rate": video_stream.get("avg_frame_rate"),
        "pixel_format": video_stream.get("pix_fmt"),
        "bit_rate": _parse_optional_int(video_stream.get("bit_rate")),
        "display_aspect_ratio": video_stream.get("display_aspect_ratio"),
        "rotation": rotation,
    }

    audio_info = None
    if audio_stream:
        audio_info = {
            "index": int(audio_stream.get("index", 1)),
            "codec_name": str(audio_stream.get("codec_name") or "unknown"),
            "codec_long_name": audio_stream.get("codec_long_name"),
            "sample_rate": _parse_optional_int(audio_stream.get("sample_rate")),
            "channels": _parse_optional_int(audio_stream.get("channels")),
            "channel_layout": audio_stream.get("channel_layout"),
            "bit_rate": _parse_optional_int(audio_stream.get("bit_rate")),
        }

    return {
        "filename": original_filename or file_path.name,
        "format_name": str(fmt.get("format_name") or "unknown"),
        "format_long_name": fmt.get("format_long_name"),
        "duration_seconds": round(duration, 3),
        "size_bytes": size_bytes,
        "bit_rate": _parse_optional_int(fmt.get("bit_rate")),
        "has_video": True,
        "has_audio": audio_info is not None,
        "aspect_ratio_label": _infer_aspect_ratio_label(effective_width, effective_height),
        "video": video_info,
        "audio": audio_info,
        "stream_count": len(streams),
    }
