from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Literal, Sequence

from .ffprobe_service import check_binary, extract_video_metadata


AspectRatioTarget = Literal["16:9", "9:16", "1:1"]
FitMode = Literal["crop", "pad"]
ResolutionTarget = Literal["720p", "1080p"]


class VideoProcessingError(Exception):
    """Raised when FFmpeg validation or video processing fails."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def _require_ffmpeg(ffmpeg_bin: str) -> str:
    resolved = check_binary(ffmpeg_bin)
    if not resolved:
        raise VideoProcessingError(
            f"ffmpeg binary '{ffmpeg_bin}' is not installed or not on PATH.",
            status_code=503,
        )
    return resolved


def _run_ffmpeg(cmd: list[str], timeout_sec: int) -> None:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise VideoProcessingError(
            f"FFmpeg timed out after {timeout_sec}s while processing video.",
            status_code=504,
        ) from exc
    except OSError as exc:
        raise VideoProcessingError(f"Failed to execute ffmpeg: {exc}", status_code=500) from exc

    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        tail = detail[-1] if detail else "Unknown FFmpeg error."
        raise VideoProcessingError(f"FFmpeg processing failed: {tail}", status_code=422)


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
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    meta = _assert_short_video_limit(
        input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
    )
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

    _run_ffmpeg(cmd, timeout_sec)
    out_meta = extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)
    return out_meta


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
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    meta = _assert_short_video_limit(
        input_path, ffprobe_bin=ffprobe_bin, max_duration_sec=max_duration_sec
    )
    safe_fps = fps if fps in (24, 30, 60) else 30

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

    _run_ffmpeg(cmd, timeout_sec)
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)
