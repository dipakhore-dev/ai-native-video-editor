from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Literal, Sequence

from .ffprobe_service import check_binary, extract_audio_metadata, extract_video_metadata


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


def _run_ffmpeg(cmd: list[str], timeout_sec: int, *, cwd: Path | None = None) -> None:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd is not None else None,
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


def _build_audio_clip_chain(
    input_label: str,
    *,
    src_in: float,
    src_out: float,
    volume: float,
    fade_in: float,
    fade_out: float,
) -> str:
    seg_dur = max(0.05, src_out - src_in)
    eff_in, eff_out = _resolve_effective_fades(seg_dur, fade_in, fade_out)
    filters = [
        f"atrim=start={src_in:.3f}:end={src_out:.3f}",
        "asetpts=PTS-STARTPTS",
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo",
        f"volume={max(0.0, min(2.0, volume)):.4f}",
    ]
    if eff_in > 0.01:
        filters.append(f"afade=t=in:st=0:d={eff_in:.3f}:curve=tri")
    if eff_out > 0.01:
        fade_out_start = max(0.0, seg_dur - eff_out)
        filters.append(f"afade=t=out:st={fade_out_start:.3f}:d={eff_out:.3f}:curve=tri")
    return f"[{input_label}]{','.join(filters)}"


def _render_v1_visual_mp4(
    v1_segments: Sequence[dict],
    output_path: Path,
    *,
    resolution: ResolutionTarget,
    fps: int,
    aspect_ratio: AspectRatioTarget | None,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    timeout_sec: int,
) -> tuple[dict, list[float]]:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    target_w, target_h = _resolve_export_dimensions(resolution, aspect_ratio)
    safe_fps = fps if fps in (24, 30, 60) else 30

    if len(v1_segments) == 1 and aspect_ratio is None and not v1_segments[0]["is_image"]:
        meta = extract_video_metadata(v1_segments[0]["visual_path"], ffprobe_bin=ffprobe_bin)
        max_h = 1080 if resolution == "1080p" else 720
        src_w = int(meta["video"]["width"])
        src_h = int(meta["video"]["height"])
        scale_factor = min(1.0, max_h / src_h) if src_h > max_h else 1.0
        target_w = max(2, int(round(src_w * scale_factor / 2) * 2))
        target_h = max(2, int(round(src_h * scale_factor / 2) * 2))

    # Determine seam transitions between adjacent V1 segments
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

    for idx, seg in enumerate(v1_segments):
        seg_path = seg["visual_path"]
        seg_dur = float(seg["seg_dur"])
        if seg["is_image"]:
            cmd.extend(["-loop", "1", "-t", f"{seg_dur:.3f}", "-i", str(seg_path)])
        else:
            cmd.extend(["-i", str(seg_path)])

        if len(v1_segments) == 1:
            chain_steps = [
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase",
                f"crop={target_w}:{target_h}",
            ]
        else:
            chain_steps = [
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease",
                f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:black",
            ]
        chain_steps.extend(["setsar=1", f"fps={safe_fps}"])
        chain_steps.extend(
            _build_visual_effects_filter_steps(
                seg.get("effects"),
                opacity=float(seg.get("opacity", 1.0)),
                is_overlay=False,
            )
        )

        # Edge fade-in on first clip and fade-out on last clip
        if idx == 0:
            edge_in_type, edge_in_dur = _normalize_transition(
                seg.get("transition_in"), seg_dur * 0.45
            )
            if edge_in_type != "none":
                chain_steps.append(f"fade=t=in:st=0:d={edge_in_dur:.3f}")
        if idx == len(v1_segments) - 1:
            edge_out_type, edge_out_dur = _normalize_transition(
                seg.get("transition_out"), seg_dur * 0.45
            )
            if edge_out_type != "none":
                fade_st = max(0.0, seg_dur - edge_out_dur)
                chain_steps.append(f"fade=t=out:st={fade_st:.3f}:d={edge_out_dur:.3f}")

        chain_steps.extend(["format=yuv420p", "settb=AVTB", "setpts=PTS-STARTPTS"])
        out_label = "[outv]" if len(v1_segments) == 1 else f"[v{idx}]"
        filter_parts.append(f"[{idx}:v]{','.join(chain_steps)}{out_label}")

    if len(v1_segments) > 1:
        has_seam_xfade = any(t != "none" and d > 0.05 for t, d in seam_transitions)
        if not has_seam_xfade:
            concat_inputs = "".join(f"[v{i}]" for i in range(len(v1_segments)))
            filter_parts.append(f"{concat_inputs}concat=n={len(v1_segments)}:v=1:a=0[outv]")
        else:
            cur_label = "[v0]"
            cur_dur = float(v1_segments[0]["seg_dur"])
            for idx in range(len(v1_segments) - 1):
                nxt_label = f"[v{idx + 1}]"
                nxt_dur = float(v1_segments[idx + 1]["seg_dur"])
                t_type, t_dur = seam_transitions[idx]
                out_lbl = "[outv]" if idx == len(v1_segments) - 2 else f"[vx{idx + 1}]"
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

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd.extend([
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "[outv]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ])
    _run_ffmpeg(cmd, timeout_sec)
    seam_overlaps = [d if t != "none" else 0.0 for t, d in seam_transitions]
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin), seam_overlaps


def _composite_v2_overlays_mp4(
    base_video_path: Path,
    v2_overlays: Sequence[dict],
    output_path: Path,
    *,
    width: int,
    height: int,
    fps: int,
    rendered_duration: float,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    timeout_sec: int,
) -> dict:
    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    cmd = [ffmpeg_path, "-y", "-i", str(base_video_path)]
    filter_parts: list[str] = ["[0:v]setpts=PTS-STARTPTS[base0]"]
    cur_label = "[base0]"

    for idx, ov in enumerate(v2_overlays):
        in_idx = idx + 1
        tl_start = max(0.0, float(ov["tl_start"]))
        tl_end = min(rendered_duration, float(ov["tl_end"]))
        clip_dur = max(0.1, tl_end - tl_start)

        if ov["is_image"]:
            cmd.extend(["-loop", "1", "-t", f"{clip_dur:.3f}", "-i", str(ov["src_path"])])
            ov_steps = []
        else:
            cmd.extend(["-i", str(ov["src_path"])])
            ov_steps = [f"trim=start={ov['src_in']:.3f}:end={ov['src_out']:.3f}"]

        ov_steps.extend([
            f"setpts=PTS-STARTPTS+{tl_start:.3f}/TB",
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"fps={fps}",
        ])
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
        next_lbl = "[outv]" if idx == len(v2_overlays) - 1 else f"[base{idx + 1}]"
        filter_parts.append(f"[{in_idx}:v]{','.join(ov_steps)}{ov_lbl}")
        filter_parts.append(
            f"{cur_label}{ov_lbl}overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,{tl_start:.3f},{tl_end:.3f})':eof_action=pass{next_lbl}"
        )
        cur_label = next_lbl

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd.extend([
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        cur_label,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ])
    _run_ffmpeg(cmd, timeout_sec)
    return extract_video_metadata(output_path, ffprobe_bin=ffprobe_bin)


def export_timeline_mp4(
    uploaded_files: Sequence[Path],
    output_path: Path,
    *,
    timeline_spec: dict | None = None,
    resolution: ResolutionTarget = "720p",
    fps: int = 30,
    aspect_ratio: AspectRatioTarget | None = None,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout_sec: int = 240,
    max_duration_sec: float = 300.0,
) -> dict:
    if not uploaded_files:
        raise VideoProcessingError("Upload at least one video file to export.", status_code=400)

    if timeline_spec is None:
        return export_mp4(
            uploaded_files[0],
            output_path,
            resolution=resolution,
            fps=fps,
            aspect_ratio=aspect_ratio,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
            max_duration_sec=max_duration_sec,
        )

    ffmpeg_path = _require_ffmpeg(ffmpeg_bin)
    project_meta = timeline_spec.get("project") if isinstance(timeline_spec.get("project"), dict) else {}
    fmt = str(timeline_spec.get("format") or project_meta.get("format") or "mp4").lower()
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

    eff_resolution: ResolutionTarget = (
        "1080p" if (resolution == "1080p" or proj_res == "1080p") else "720p"
    )

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

        speed = float(clip.get("speed", 1.0))
        if abs(speed - 1.0) > 0.01:
            raise VideoProcessingError(
                f"Clip '{name}' uses {speed}x speed. Variable playback speed is not supported in FFmpeg MP4 export yet; set speed to 1.0x.",
                status_code=400,
            )

        volume = float(clip.get("volume", 1.0))
        if volume < 0.0 or volume > 2.0:
            raise VideoProcessingError(
                f"Clip '{name}' volume ({int(round(volume * 100))}%) must be between 0% and 200%.",
                status_code=400,
            )

        fade_in = float(clip.get("fadeInSec", 0.0) or 0.0)
        fade_out = float(clip.get("fadeOutSec", 0.0) or 0.0)
        if fade_in < 0.0 or fade_in > 30.0 or fade_out < 0.0 or fade_out > 30.0:
            raise VideoProcessingError(
                f"Clip '{name}' fade durations must be between 0s and 30s.",
                status_code=400,
            )

        duck_amt = clip.get("duckingAmount")
        if duck_amt is not None and (float(duck_amt) < 0.0 or float(duck_amt) > 0.95):
            raise VideoProcessingError(
                f"Clip '{name}' ducking amount must be between 0% and 95%.",
                status_code=400,
            )

        opacity = float(clip.get("opacity", 1.0))
        if opacity < 0.0 or opacity > 1.0:
            raise VideoProcessingError(
                f"Clip '{name}' opacity must be between 0% and 100%.",
                status_code=400,
            )

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

    first_start = float(sorted_v1[0].get("timelineStartSec", 0.0))
    if first_start > 0.15:
        raise VideoProcessingError(
            "Timeline starts with an empty gap before the first V1 clip. Move the first clip to 00:00 before exporting.",
            status_code=400,
        )

    for idx in range(len(sorted_v1) - 1):
        cur = sorted_v1[idx]
        nxt = sorted_v1[idx + 1]
        cur_start = float(cur.get("timelineStartSec", 0.0))
        cur_end = float(cur.get("timelineEndSec", cur_start + float(cur.get("durationSec", 0.0))))
        nxt_start = float(nxt.get("timelineStartSec", 0.0))
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
            if len(uploaded_files) == 1:
                return 0
            raise VideoProcessingError(
                "Each clip in timelineSpec must specify 'fileIndex' when uploading multiple media files.",
                status_code=400,
            )
        try:
            f_idx = int(raw_idx)
        except (TypeError, ValueError) as exc:
            raise VideoProcessingError("Invalid fileIndex in timelineSpec clip.", status_code=400) from exc
        if f_idx < 0 or f_idx >= len(uploaded_files):
            raise VideoProcessingError(
                f"Clip references missing uploaded media file index {f_idx}.",
                status_code=400,
            )
        return f_idx

    v1_file_indices = [_resolve_file_index(c) for c in sorted_v1]
    v2_file_indices = [_resolve_file_index(c) for c in sorted_v2]
    a1_file_indices = [_resolve_file_index(c) for c in sorted_a1]

    v1_source_metas: dict[int, dict] = {}
    for clip, f_idx in zip(sorted_v1, v1_file_indices):
        if f_idx in v1_source_metas:
            continue
        if _is_image_clip(clip, uploaded_files[f_idx]):
            v1_source_metas[f_idx] = {"duration_seconds": 0.0, "has_audio": False, "is_image": True}
        else:
            v1_source_metas[f_idx] = _assert_short_video_limit(
                uploaded_files[f_idx],
                ffprobe_bin=ffprobe_bin,
                max_duration_sec=max_duration_sec,
            )

    v2_source_metas: dict[int, dict] = {}
    for clip, f_idx in zip(sorted_v2, v2_file_indices):
        if f_idx in v2_source_metas:
            continue
        if _is_image_clip(clip, uploaded_files[f_idx]):
            v2_source_metas[f_idx] = {"duration_seconds": 0.0, "has_audio": False, "is_image": True}
        else:
            v2_source_metas[f_idx] = _assert_short_video_limit(
                uploaded_files[f_idx],
                ffprobe_bin=ffprobe_bin,
                max_duration_sec=max_duration_sec,
            )

    a1_source_metas: dict[int, dict] = {}
    for f_idx in set(a1_file_indices):
        a1_source_metas[f_idx] = _assert_short_audio_limit(
            uploaded_files[f_idx],
            ffprobe_bin=ffprobe_bin,
            max_duration_sec=max_duration_sec,
        )

    v1_prepared_clips: list[dict] = []
    total_v1_duration = 0.0
    for idx, clip in enumerate(sorted_v1):
        f_idx = v1_file_indices[idx]
        src_path = uploaded_files[f_idx]
        src_meta = v1_source_metas[f_idx]
        is_image = bool(src_meta.get("is_image"))

        if is_image:
            seg_dur = max(0.2, min(60.0, float(clip.get("durationSec", 5.0))))
            src_in = 0.0
            effective_out = seg_dur
        else:
            src_duration = float(src_meta["duration_seconds"])
            src_in = float(clip.get("sourceInSec", 0.0))
            default_out = (
                src_in + float(clip["durationSec"])
                if "durationSec" in clip
                else src_duration
            )
            src_out = float(clip.get("sourceOutSec", default_out))
            if src_in < 0 or src_out <= src_in:
                raise VideoProcessingError(
                    f"Invalid trim range ({src_in:.2f}s to {src_out:.2f}s) on clip '{clip.get('sourceName') or idx}'.",
                    status_code=400,
                )
            if src_duration > 0 and src_in >= src_duration:
                raise VideoProcessingError(
                    f"Clip start offset ({src_in:.2f}s) exceeds source video duration ({src_duration:.2f}s).",
                    status_code=400,
                )
            effective_out = min(src_out, src_duration) if src_duration > 0 else src_out
            seg_dur = effective_out - src_in
            if seg_dur < 0.1:
                raise VideoProcessingError("Clip duration must be at least 0.1 seconds.", status_code=400)

        total_v1_duration += seg_dur
        v1_prepared_clips.append({
            "src_path": src_path,
            "src_meta": src_meta,
            "is_image": is_image,
            "src_in": src_in,
            "src_out": effective_out,
            "seg_dur": seg_dur,
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

    work_dir = output_path.parent / "_timeline_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    v1_visual_segments: list[dict] = []

    for idx, item in enumerate(v1_prepared_clips):
        src_path = item["src_path"]
        is_image = bool(item["is_image"])
        if is_image:
            visual_path = src_path
        else:
            src_duration = float(item["src_meta"]["duration_seconds"])
            src_in = float(item["src_in"])
            effective_out = float(item["src_out"])
            needs_trim = src_in > 0.05 or (src_duration > 0 and effective_out < src_duration - 0.05)

            if needs_trim:
                trimmed_path = work_dir / f"v1_seg_{idx}_trim.mp4"
                trim_video(
                    src_path,
                    trimmed_path,
                    start_sec=src_in,
                    end_sec=effective_out,
                    ffmpeg_bin=ffmpeg_bin,
                    ffprobe_bin=ffprobe_bin,
                    timeout_sec=timeout_sec,
                    max_duration_sec=max_duration_sec,
                )
                visual_path = trimmed_path
            else:
                visual_path = src_path

        v1_visual_segments.append({
            "visual_path": visual_path,
            "is_image": is_image,
            "seg_dur": item["seg_dur"],
            "opacity": item["opacity"],
            "transition_in": item["transition_in"],
            "transition_out": item["transition_out"],
            "effects": item["effects"],
        })

    # Render V1 visual frames (with effects, opacity & xfade transitions)
    v1_visual_mp4 = work_dir / "v1_visual_only.mp4"
    visual_meta, seam_overlaps = _render_v1_visual_mp4(
        v1_visual_segments,
        v1_visual_mp4,
        resolution=eff_resolution,
        fps=eff_fps,
        aspect_ratio=eff_aspect,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        timeout_sec=timeout_sec,
    )
    rendered_duration = float(visual_meta["duration_seconds"]) or total_v1_duration
    out_w = int(visual_meta["video"]["width"])
    out_h = int(visual_meta["video"]["height"])

    # Composite active V2 overlays onto visual track
    v2_track_muted = "track_v2" in muted_tracks
    active_v2_overlays: list[dict] = []
    if not v2_track_muted:
        for idx, clip in enumerate(sorted_v2):
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            tl_dur = max(0.1, float(clip.get("durationSec", 1.0)))
            tl_end = min(rendered_duration, tl_start + tl_dur)
            if tl_start >= rendered_duration - 0.02 or tl_end - tl_start < 0.05:
                continue
            opacity = float(clip.get("opacity", 1.0))
            if opacity <= 0.005:
                continue

            f_idx = v2_file_indices[idx]
            src_path = uploaded_files[f_idx]
            src_meta = v2_source_metas[f_idx]
            is_image = bool(src_meta.get("is_image"))
            src_in = max(0.0, float(clip.get("sourceInSec", 0.0)))
            src_dur = float(src_meta.get("duration_seconds", 0.0))
            src_out = src_in + (tl_end - tl_start)
            if not is_image and src_dur > 0:
                src_out = min(src_out, src_dur)
                if src_out <= src_in + 0.05:
                    continue

            active_v2_overlays.append({
                "src_path": src_path,
                "is_image": is_image,
                "tl_start": tl_start,
                "tl_end": tl_end,
                "src_in": src_in,
                "src_out": src_out,
                "opacity": opacity,
                "transition_in": clip.get("transitionIn"),
                "transition_out": clip.get("transitionOut"),
                "effects": clip.get("effects"),
            })

    if active_v2_overlays:
        visual_only_mp4 = work_dir / "v1_v2_composited.mp4"
        visual_meta = _composite_v2_overlays_mp4(
            v1_visual_mp4,
            active_v2_overlays,
            visual_only_mp4,
            width=out_w,
            height=out_h,
            fps=eff_fps,
            rendered_duration=rendered_duration,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
        )
    else:
        visual_only_mp4 = v1_visual_mp4

    # Prepare active T1 text overlays
    t1_track_muted = "track_t1" in muted_tracks
    active_t1_overlays: list[dict] = []
    if not t1_track_muted:
        for clip in sorted_t1:
            t_style = clip.get("textStyle") if isinstance(clip.get("textStyle"), dict) else {}
            text_val = str(t_style.get("text") or clip.get("name") or "").strip()
            if not text_val:
                continue
            tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
            tl_dur = max(0.1, float(clip.get("durationSec", 1.0)))
            tl_end = min(rendered_duration, tl_start + tl_dur)
            if tl_start >= rendered_duration - 0.02 or tl_end - tl_start < 0.05:
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

    # Prepare A1 active audio clips
    a1_track_muted = "track_a1" in muted_tracks
    active_a1_clips: list[dict] = []
    for idx, clip in enumerate(sorted_a1):
        if a1_track_muted or bool(clip.get("muted", False)):
            continue
        vol = float(clip.get("volume", 1.0))
        if vol <= 0.001:
            continue
        tl_start = max(0.0, float(clip.get("timelineStartSec", 0.0)))
        if tl_start >= rendered_duration - 0.02:
            continue

        f_idx = a1_file_indices[idx]
        src_path = uploaded_files[f_idx]
        src_meta = a1_source_metas[f_idx]
        src_duration = float(src_meta["duration_seconds"])
        src_in = max(0.0, float(clip.get("sourceInSec", 0.0)))
        default_out = (
            src_in + float(clip["durationSec"])
            if "durationSec" in clip
            else src_duration
        )
        src_out = float(clip.get("sourceOutSec", default_out))
        if src_out <= src_in:
            continue
        if src_duration > 0 and src_in >= src_duration:
            continue
        effective_out = min(src_out, src_duration) if src_duration > 0 else src_out
        if effective_out - src_in < 0.05:
            continue

        active_a1_clips.append({
            "src_path": src_path,
            "src_in": src_in,
            "src_out": effective_out,
            "tl_start": tl_start,
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
    needs_sidechain_key = (
        len(active_a1_clips) > 0
        and any(c["ducking_enabled"] for c in active_a1_clips)
        and v1_has_any_audible
    )
    speech_intervals = _merge_speech_intervals(
        timeline_spec.get("speechIntervals"),
        timeline_spec.get("subtitles"),
    )

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

    needs_ass_pass = burn_subs or len(active_t1_overlays) > 0
    raw_export_path = work_dir / "pre_ass_pass.mp4" if needs_ass_pass else output_path
    raw_export_path.parent.mkdir(parents=True, exist_ok=True)

    has_output_audio = v1_has_any_audible or len(active_a1_clips) > 0

    if not has_output_audio:
        shutil.copy2(visual_only_mp4, raw_export_path)
        rendered_meta = extract_video_metadata(raw_export_path, ffprobe_bin=ffprobe_bin)
    else:
        audio_cmd = [ffmpeg_path, "-y"]
        audio_filters: list[str] = []
        input_idx = 0

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
                    cur_in_idx = input_idx
                    audio_cmd.extend(["-i", str(item["src_path"])])
                    input_idx += 1
                    chain = _build_audio_clip_chain(
                        f"{cur_in_idx}:a",
                        src_in=item["src_in"],
                        src_out=item["src_out"],
                        volume=item["volume"],
                        fade_in=item["fade_in"],
                        fade_out=item["fade_out"],
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
            cur_in_idx = input_idx
            audio_cmd.extend(["-i", str(item["src_path"])])
            input_idx += 1

            base_chain = _build_audio_clip_chain(
                f"{cur_in_idx}:a",
                src_in=item["src_in"],
                src_out=item["src_out"],
                volume=item["volume"],
                fade_in=item["fade_in"],
                fade_out=item["fade_out"],
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

        mix_inputs: list[str] = []
        if v1_mix_label:
            mix_inputs.append(v1_mix_label)
        mix_inputs.extend(a1_clip_labels)

        any_boost = any(
            item["volume"] > 1.02
            for item in v1_prepared_clips
            if not item["muted"]
        ) or any(c["volume"] > 1.02 for c in active_a1_clips)

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

        filter_script_path = work_dir / "audio_mix_filter.txt"
        filter_script_path.write_text(";\n".join(audio_filters), encoding="utf-8")

        mixed_audio_wav = work_dir / "mixed_audio.wav"
        audio_cmd.extend([
            "-filter_complex_script",
            str(filter_script_path),
            "-map",
            "[final_a]",
            "-c:a",
            "pcm_s16le",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(mixed_audio_wav),
        ])
        _run_ffmpeg(audio_cmd, timeout_sec)

        mux_cmd = [
            ffmpeg_path,
            "-y",
            "-i",
            str(visual_only_mp4),
            "-i",
            str(mixed_audio_wav),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(raw_export_path),
        ]
        _run_ffmpeg(mux_cmd, timeout_sec)
        rendered_meta = extract_video_metadata(raw_export_path, ffprobe_bin=ffprobe_bin)

    if needs_ass_pass:
        style = (
            timeline_spec.get("subtitleStyle")
            if isinstance(timeline_spec.get("subtitleStyle"), dict)
            else {}
        )
        final_w = int(rendered_meta["video"]["width"])
        final_h = int(rendered_meta["video"]["height"])
        ass_path = work_dir / "overlays_and_subtitles.ass"
        _write_ass_subtitles(
            subtitles if burn_subs else [],
            style,
            ass_path,
            width=final_w,
            height=final_h,
            text_overlays=active_t1_overlays,
        )
        return burn_subtitles_into_mp4(
            raw_export_path,
            output_path,
            ass_path,
            has_audio=bool(rendered_meta.get("has_audio")),
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
        )

    return rendered_meta


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

    _run_ffmpeg(cmd, timeout_sec, cwd=resolved_ass.parent)
    return extract_video_metadata(resolved_out, ffprobe_bin=ffprobe_bin)

