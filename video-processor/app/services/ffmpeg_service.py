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
    if len(clips) > 8:
        raise VideoProcessingError(
            "Synchronous local MP4 export supports up to 8 timeline clips.",
            status_code=400,
        )

    for clip in clips:
        if not isinstance(clip, dict):
            raise VideoProcessingError("Invalid clip entry in timelineSpec.", status_code=400)
        name = str(clip.get("sourceName") or clip.get("name") or clip.get("id") or "clip")
        track_id = str(clip.get("trackId") or "")
        kind = str(clip.get("kind") or "")

        if track_id in muted_tracks:
            raise VideoProcessingError(
                f"Track '{track_id}' is muted but contains '{name}'. Unmute the track or remove its clips before exporting.",
                status_code=400,
            )
        if kind != "video":
            raise VideoProcessingError(
                f"Timeline clip '{name}' (type '{kind}') is not supported in FFmpeg MP4 export yet. Only video clips on track V1 are supported (text overlays, images, and standalone audio tracks are not burned into MP4).",
                status_code=400,
            )
        if track_id != "track_v1":
            raise VideoProcessingError(
                f"Clip '{name}' is on track '{track_id}'. FFmpeg MP4 export currently supports primary video track V1 ('track_v1') only.",
                status_code=400,
            )

        speed = float(clip.get("speed", 1.0))
        if abs(speed - 1.0) > 0.01:
            raise VideoProcessingError(
                f"Clip '{name}' uses {speed}x speed. Variable playback speed is not supported in FFmpeg MP4 export yet; set speed to 1.0x.",
                status_code=400,
            )

        volume = float(clip.get("volume", 1.0))
        if abs(volume - 1.0) > 0.05:
            raise VideoProcessingError(
                f"Clip '{name}' uses {int(round(volume * 100))}% volume. Per-clip volume mixing is not supported in FFmpeg MP4 export yet; set volume to 100%.",
                status_code=400,
            )

        opacity = float(clip.get("opacity", 1.0))
        if abs(opacity - 1.0) > 0.01:
            raise VideoProcessingError(
                f"Clip '{name}' uses {int(round(opacity * 100))}% opacity. Opacity adjustments are not supported in FFmpeg MP4 export yet; set opacity to 100%.",
                status_code=400,
            )

    sorted_clips = sorted(
        clips,
        key=lambda c: (float(c.get("timelineStartSec", 0.0)), str(c.get("id", ""))),
    )

    first_start = float(sorted_clips[0].get("timelineStartSec", 0.0))
    if first_start > 0.15:
        raise VideoProcessingError(
            "Timeline starts with an empty gap before the first clip. Move the first clip to 00:00 before exporting.",
            status_code=400,
        )

    for idx in range(len(sorted_clips) - 1):
        cur = sorted_clips[idx]
        nxt = sorted_clips[idx + 1]
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

    file_indices: list[int] = []
    for clip in sorted_clips:
        raw_idx = clip.get("fileIndex")
        if raw_idx is None:
            if len(uploaded_files) == 1:
                file_idx = 0
            else:
                raise VideoProcessingError(
                    "Each clip in timelineSpec must specify 'fileIndex' when uploading multiple video files.",
                    status_code=400,
                )
        else:
            try:
                file_idx = int(raw_idx)
            except (TypeError, ValueError) as exc:
                raise VideoProcessingError("Invalid fileIndex in timelineSpec clip.", status_code=400) from exc
        if file_idx < 0 or file_idx >= len(uploaded_files):
            raise VideoProcessingError(
                f"Clip references missing uploaded video file index {file_idx}.",
                status_code=400,
            )
        file_indices.append(file_idx)

    source_metas: dict[int, dict] = {}
    for file_idx in set(file_indices):
        source_metas[file_idx] = _assert_short_video_limit(
            uploaded_files[file_idx],
            ffprobe_bin=ffprobe_bin,
            max_duration_sec=max_duration_sec,
        )

    total_export_duration = sum(
        max(0.0, float(c.get("sourceOutSec", 0.0)) - float(c.get("sourceInSec", 0.0)))
        if "sourceOutSec" in c
        else float(c.get("durationSec", 0.0))
        for c in sorted_clips
    )
    if total_export_duration > max_duration_sec:
        raise VideoProcessingError(
            f"Combined timeline duration ({total_export_duration:.1f}s) exceeds synchronous short-video limit ({max_duration_sec:.0f}s).",
            status_code=400,
        )

    work_dir = output_path.parent / "_timeline_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    segments: list[Path] = []

    for idx, clip in enumerate(sorted_clips):
        file_idx = file_indices[idx]
        src_path = uploaded_files[file_idx]
        src_meta = source_metas[file_idx]
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
        if effective_out - src_in < 0.1:
            raise VideoProcessingError("Clip duration must be at least 0.1 seconds.", status_code=400)

        needs_trim = src_in > 0.05 or (src_duration > 0 and effective_out < src_duration - 0.05)
        if needs_trim:
            trimmed_path = work_dir / f"seg_{idx}_trim.mp4"
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
            segments.append(trimmed_path)
        else:
            segments.append(src_path)

    if len(segments) == 1:
        raw_export_path = (
            work_dir / "pre_subtitles.mp4" if bool(timeline_spec.get("burnSubtitles")) else output_path
        )
        rendered_meta = export_mp4(
            segments[0],
            raw_export_path,
            resolution=eff_resolution,
            fps=eff_fps,
            aspect_ratio=eff_aspect,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
            max_duration_sec=max_duration_sec,
        )
    else:
        target_w, target_h = _resolve_export_dimensions(eff_resolution, eff_aspect)
        target_ratio = target_w / target_h
        prepared_segments: list[Path] = []
        for idx, seg_path in enumerate(segments):
            if eff_aspect is not None:
                seg_meta = extract_video_metadata(seg_path, ffprobe_bin=ffprobe_bin)
                seg_w = int(seg_meta["video"]["width"])
                seg_h = int(seg_meta["video"]["height"])
                seg_ratio = seg_w / seg_h if seg_h > 0 else target_ratio
                if abs(seg_ratio - target_ratio) > 0.03:
                    cropped_path = work_dir / f"seg_{idx}_aspect.mp4"
                    resize_crop_aspect_ratio(
                        seg_path,
                        cropped_path,
                        target_width=target_w,
                        target_height=target_h,
                        fit_mode="crop",
                        ffmpeg_bin=ffmpeg_bin,
                        ffprobe_bin=ffprobe_bin,
                        timeout_sec=timeout_sec,
                        max_duration_sec=max_duration_sec,
                    )
                    prepared_segments.append(cropped_path)
                    continue
            prepared_segments.append(seg_path)

        raw_export_path = (
            work_dir / "pre_subtitles.mp4" if bool(timeline_spec.get("burnSubtitles")) else output_path
        )
        rendered_meta = merge_video_clips(
            prepared_segments,
            raw_export_path,
            target_width=target_w,
            target_height=target_h,
            fps=eff_fps,
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            timeout_sec=timeout_sec,
            max_total_duration_sec=max_duration_sec,
        )

    if bool(timeline_spec.get("burnSubtitles")):
        subtitles = timeline_spec.get("subtitles")
        if not isinstance(subtitles, list) or len(subtitles) == 0:
            raise VideoProcessingError(
                "Subtitle burn-in is enabled, but there are no subtitle cues to burn.",
                status_code=400,
            )
        style = (
            timeline_spec.get("subtitleStyle")
            if isinstance(timeline_spec.get("subtitleStyle"), dict)
            else {}
        )
        out_w = int(rendered_meta["video"]["width"])
        out_h = int(rendered_meta["video"]["height"])
        ass_path = work_dir / "subtitles.ass"
        _write_ass_subtitles(subtitles, style, ass_path, width=out_w, height=out_h)
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


def _write_ass_subtitles(
    subtitles: Sequence[dict],
    style: dict,
    ass_path: Path,
    *,
    width: int,
    height: int,
) -> None:
    font_size_ui = float(style.get("fontSize", 28))
    font_size_ui = max(12.0, min(72.0, font_size_ui))
    ass_font_size = max(18, int(round(font_size_ui * (height / 540.0))))

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
        f"Style: Default,Arial,{ass_font_size},{text_color},&H000000FF,{outline_colour},{back_colour},1,0,0,0,100,100,0,0,{border_style},{outline_width},{shadow_depth},{alignment},{margin_h},{margin_h},{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

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
        lines.append(f"Dialogue: 0,{start_ts},{end_ts},Default,,0,0,0,,{escaped_text}")
        valid_cues += 1

    if valid_cues == 0:
        raise VideoProcessingError(
            "Subtitle burn-in is enabled, but all subtitle cues have empty text.",
            status_code=400,
        )

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

