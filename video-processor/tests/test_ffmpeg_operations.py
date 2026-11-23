from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Sequence
from unittest import mock

from app.config import get_settings
from app.services.ffmpeg_service import (
    EXPORT_PROFILES,
    VideoProcessingCancelledError,
    VideoProcessingError,
    _assert_short_audio_limit,
    _resolve_ass_font_name,
    _run_ffmpeg_with_progress,
    _trim_audio_segment,
    _write_ass_subtitles,
    clear_hardware_encoder_cache,
    detect_hardware_h264_encoders,
    export_mp4,
    export_timeline_mp4,
    generate_thumbnail,
    merge_video_clips,
    normalize_encoding_mode,
    resize_crop_aspect_ratio,
    resolve_export_profile_spec,
    trim_video,
    validate_timeline_export_spec,
)
from app.services.ffprobe_service import check_binary, extract_video_metadata
from app.services.job_store import job_store
from app.services.whisper_service import (
    SubtitleGenerationError,
    extract_mono_wav_for_whisper,
    format_srt,
    format_vtt,
    is_faster_whisper_available,
    resolve_multilingual_model_size,
    transcribe_video_subtitles,
    validate_subtitle_language,
)


class TestFfmpegAndWhisperServices(unittest.TestCase):
    def setUp(self) -> None:
        self.test_root = Path(tempfile.mkdtemp(prefix="ai_studio_ffmpeg_test_"))
        self.ffmpeg = check_binary("ffmpeg")
        if not self.ffmpeg:
            self.skipTest("ffmpeg is not installed")

    def tearDown(self) -> None:
        shutil.rmtree(self.test_root, ignore_errors=True)

    def _make_clip(self, name: str, duration: float = 2.0, size: str = "640x360", with_audio: bool = True) -> Path:
        out = self.test_root / name
        cmd = [
            self.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=duration={duration}:size={size}:rate=24",
        ]
        if with_audio:
            cmd.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"])
        cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
        if with_audio:
            cmd.extend(["-c:a", "aac", "-shortest"])
        cmd.append(str(out))

        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def test_generate_thumbnail(self) -> None:
        src = self._make_clip("thumb_src.mp4")
        thumb = self.test_root / "thumb.jpg"
        info = generate_thumbnail(src, thumb, timestamp_sec=0.5, width=320)
        self.assertTrue(thumb.exists())
        self.assertGreater(info["size_bytes"], 500)
        self.assertEqual(info["width"], 320)

    def test_trim_video_and_validation(self) -> None:
        src = self._make_clip("trim_src.mp4", duration=3.0)
        out = self.test_root / "trimmed.mp4"
        meta = trim_video(src, out, start_sec=0.5, end_sec=2.0)
        self.assertTrue(out.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 1.5, delta=0.35)

        with self.assertRaises(VideoProcessingError):
            trim_video(src, self.test_root / "bad_trim.mp4", start_sec=2.0, end_sec=1.0)

    def test_aspect_ratio_conversions(self) -> None:
        src = self._make_clip("ar_src.mp4", duration=1.5, size="640x360")

        out_9_16 = self.test_root / "vertical.mp4"
        meta_9_16 = resize_crop_aspect_ratio(src, out_9_16, aspect_ratio="9:16", fit_mode="crop")
        self.assertEqual(meta_9_16["video"]["width"], 720)
        self.assertEqual(meta_9_16["video"]["height"], 1280)
        self.assertEqual(meta_9_16["aspect_ratio_label"], "9:16")

        out_1_1 = self.test_root / "square.mp4"
        meta_1_1 = resize_crop_aspect_ratio(src, out_1_1, aspect_ratio="1:1", fit_mode="pad")
        self.assertEqual(meta_1_1["video"]["width"], 720)
        self.assertEqual(meta_1_1["video"]["height"], 720)
        self.assertEqual(meta_1_1["aspect_ratio_label"], "1:1")

    def test_merge_clips_and_export_mp4(self) -> None:
        clip1 = self._make_clip("c1.mp4", duration=1.2)
        clip2 = self._make_clip("c2.mp4", duration=1.2)
        merged = self.test_root / "merged.mp4"
        merged_meta = merge_video_clips([clip1, clip2], merged, target_width=640, target_height=360, fps=24)
        self.assertTrue(merged.exists())
        self.assertGreaterEqual(merged_meta["duration_seconds"], 2.0)
        self.assertEqual(merged_meta["video"]["width"], 640)

        exported = self.test_root / "exported.mp4"
        export_meta = export_mp4(merged, exported, resolution="720p", fps=30, aspect_ratio="16:9")
        self.assertTrue(exported.exists())
        self.assertEqual(export_meta["video"]["width"], 1280)
        self.assertEqual(export_meta["video"]["height"], 720)
        self.assertAlmostEqual(export_meta["video"]["fps"], 30.0, delta=0.5)

    def test_whisper_audio_extraction_and_subtitle_formatting(self) -> None:
        src = self._make_clip("audio_src.mp4", duration=1.2, with_audio=True)
        wav = self.test_root / "out.wav"
        extract_mono_wav_for_whisper(src, wav)
        self.assertTrue(wav.exists())
        self.assertGreater(wav.stat().st_size, 1000)

        silent = self._make_clip("silent.mp4", duration=1.0, with_audio=False)
        with self.assertRaises(SubtitleGenerationError):
            extract_mono_wav_for_whisper(silent, self.test_root / "silent.wav")

        segs = [{"id": 1, "start": 0.0, "end": 1.25, "text": "Hello AI Studio"}]
        self.assertIn("00:00:00,000 --> 00:00:01,250", format_srt(segs))
        self.assertIn("WEBVTT", format_vtt(segs))

        if not is_faster_whisper_available():
            with self.assertRaises(SubtitleGenerationError) as ctx:
                transcribe_video_subtitles(src, self.test_root)
            self.assertEqual(ctx.exception.status_code, 503)

    def test_export_timeline_mp4_trim_merge_and_aspect_ratio(self) -> None:
        clip_a = self._make_clip("tl_a.mp4", duration=3.0, size="640x360")
        clip_b = self._make_clip("tl_b.mp4", duration=3.0, size="640x360")
        out = self.test_root / "timeline_export.mp4"

        timeline_spec = {
            "schemaVersion": "1.0",
            "format": "mp4",
            "project": {
                "name": "Timeline Cut",
                "aspectRatio": "9:16",
                "resolution": "720p",
                "fps": 30,
            },
            "tracks": [
                {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False}
            ],
            "clips": [
                {
                    "id": "c_first",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "tl_b.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 1.5,
                    "durationSec": 1.5,
                    "sourceInSec": 0.5,
                    "sourceOutSec": 2.0,
                    "speed": 1.0,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 1,
                },
                {
                    "id": "c_second",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "tl_a.mp4",
                    "timelineStartSec": 1.5,
                    "timelineEndSec": 3.0,
                    "durationSec": 1.5,
                    "sourceInSec": 1.0,
                    "sourceOutSec": 2.5,
                    "speed": 1.0,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                },
            ],
        }

        meta = export_timeline_mp4(
            [clip_a, clip_b],
            out,
            timeline_spec=timeline_spec,
            resolution="720p",
            fps=30,
            aspect_ratio="9:16",
        )
        self.assertTrue(out.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 3.0, delta=0.4)
        self.assertEqual(meta["video"]["width"], 720)
        self.assertEqual(meta["video"]["height"], 1280)
        self.assertEqual(meta["aspect_ratio_label"], "9:16")
        self.assertAlmostEqual(meta["video"]["fps"], 30.0, delta=0.5)

    def test_export_timeline_mp4_rejects_unsupported_operations(self) -> None:
        clip = self._make_clip("tl_unsupported.mp4", duration=2.0)
        out = self.test_root / "should_fail.mp4"

        base_clip = {
            "id": "v1",
            "trackId": "track_v1",
            "kind": "video",
            "sourceName": "tl_unsupported.mp4",
            "timelineStartSec": 0.0,
            "timelineEndSec": 2.0,
            "durationSec": 2.0,
            "sourceInSec": 0.0,
            "sourceOutSec": 2.0,
            "speed": 1.0,
            "volume": 1.0,
            "opacity": 1.0,
            "fileIndex": 0,
        }

        # Invalid track/kind combination unsupported (audio on track_v1)
        with self.assertRaises(VideoProcessingError) as ctx_bad_track:
            export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
                    "tracks": [],
                    "clips": [
                        base_clip,
                        {
                            **base_clip,
                            "id": "bad_a_on_v1",
                            "trackId": "track_v1",
                            "kind": "audio",
                            "sourceName": "Invalid",
                        },
                    ],
                },
            )
        self.assertEqual(ctx_bad_track.exception.status_code, 400)

        # Out-of-range playback speed (< 0.5 or > 2.0) unsupported
        for bad_speed in (0.25, 3.0):
            with self.assertRaises(VideoProcessingError):
                export_timeline_mp4(
                    [clip],
                    out,
                    timeline_spec={
                        "format": "mp4",
                        "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
                        "tracks": [],
                        "clips": [{**base_clip, "speed": bad_speed}],
                    },
                )

        # Gap on V1 unsupported
        with self.assertRaises(VideoProcessingError):
            export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
                    "tracks": [],
                    "clips": [{**base_clip, "timelineStartSec": 1.0, "timelineEndSec": 3.0}],
                },
            )

        # WebM unsupported
        with self.assertRaises(VideoProcessingError):
            export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "webm",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
                    "tracks": [],
                    "clips": [base_clip],
                },
            )

        # 4K unsupported
        with self.assertRaises(VideoProcessingError):
            export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "4K", "width": 3840, "height": 2160, "fps": 30},
                    "tracks": [],
                    "clips": [base_clip],
                },
            )

    def test_export_timeline_mp4_burn_subtitles_and_validation(self) -> None:
        clip = self._make_clip("sub_burn_src.mp4", duration=2.0, size="640x360")
        out_plain = self.test_root / "plain.mp4"
        out_burned = self.test_root / "burned.mp4"

        base_spec = {
            "schemaVersion": "1.0",
            "format": "mp4",
            "project": {
                "name": "Subtitle Burn Test",
                "aspectRatio": "16:9",
                "resolution": "720p",
                "fps": 30,
            },
            "tracks": [
                {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False}
            ],
            "clips": [
                {
                    "id": "c1",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "sub_burn_src.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 1.6,
                    "durationSec": 1.6,
                    "sourceInSec": 0.2,
                    "sourceOutSec": 1.8,
                    "speed": 1.0,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }

        export_timeline_mp4([clip], out_plain, timeline_spec={**base_spec, "burnSubtitles": False})
        burned_meta = export_timeline_mp4(
            [clip],
            out_burned,
            timeline_spec={
                **base_spec,
                "burnSubtitles": True,
                "subtitleStyle": {
                    "enabled": True,
                    "fontSize": 32,
                    "color": "#FFFFFF",
                    "position": "bottom",
                    "backgroundColor": "#09090B",
                    "backgroundOpacity": 0.85,
                },
                "subtitles": [
                    {"id": "s1", "start": 0.1, "end": 1.4, "text": "Hello AI Studio"}
                ],
            },
        )
        self.assertTrue(out_burned.exists())
        self.assertEqual(burned_meta["video"]["width"], 1280)
        self.assertEqual(burned_meta["video"]["height"], 720)
        self.assertAlmostEqual(burned_meta["duration_seconds"], 1.6, delta=0.35)

        # Verify pixel output differs at t=0.6s when subtitle box/text is burned in
        frame_plain = self.test_root / "frame_plain.rgb"
        frame_burned = self.test_root / "frame_burned.rgb"
        for src_mp4, raw_out in [(out_plain, frame_plain), (out_burned, frame_burned)]:
            proc = subprocess.run(
                [
                    self.ffmpeg,
                    "-y",
                    "-ss",
                    "0.6",
                    "-i",
                    str(src_mp4),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    str(raw_out),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotEqual(frame_plain.read_bytes(), frame_burned.read_bytes())

        # Empty subtitles with burnSubtitles=True must fail cleanly
        with self.assertRaises(VideoProcessingError) as ctx_empty:
            export_timeline_mp4(
                [clip],
                self.test_root / "empty_sub.mp4",
                timeline_spec={**base_spec, "burnSubtitles": True, "subtitles": []},
            )
        self.assertEqual(ctx_empty.exception.status_code, 400)

    def test_bengali_language_validation_multilingual_model_and_utf8_exports(self) -> None:
        self.assertEqual(validate_subtitle_language("bn"), "bn")
        self.assertEqual(validate_subtitle_language("BN"), "bn")
        self.assertEqual(validate_subtitle_language("en"), "en")
        self.assertEqual(validate_subtitle_language("hi"), "hi")
        self.assertEqual(validate_subtitle_language("es"), "es")
        self.assertEqual(validate_subtitle_language("fr"), "fr")
        self.assertEqual(validate_subtitle_language("de"), "de")
        self.assertEqual(validate_subtitle_language("ja"), "ja")
        self.assertIsNone(validate_subtitle_language(""))
        self.assertIsNone(validate_subtitle_language("auto"))
        self.assertIsNone(validate_subtitle_language(None))

        with self.assertRaises(SubtitleGenerationError) as ctx_bad_lang:
            validate_subtitle_language("bengali-invalid")
        self.assertEqual(ctx_bad_lang.exception.status_code, 400)

        self.assertEqual(get_settings().whisper_model_size, "small")
        self.assertEqual(resolve_multilingual_model_size("small", "bn"), "small")
        self.assertEqual(resolve_multilingual_model_size("base.en", "bn"), "base")
        self.assertEqual(resolve_multilingual_model_size("small.en", "bn"), "small")
        self.assertEqual(resolve_multilingual_model_size("distil-small.en", "bn"), "small")
        self.assertFalse(resolve_multilingual_model_size("medium.en", "bn").endswith(".en"))

        bn_text = "নমস্কার, এআই স্টুডিওতে স্বাগতম।"
        segs = [{"id": 1, "start": 0.0, "end": 1.5, "text": bn_text}]
        srt_text = format_srt(segs)
        vtt_text = format_vtt(segs)
        self.assertIn(bn_text, srt_text)
        self.assertIn(bn_text, vtt_text)
        self.assertIn("WEBVTT", vtt_text)

    def test_export_timeline_mp4_burn_bengali_subtitles(self) -> None:
        bn_cues = [{"id": "bn_1", "start": 0.1, "end": 1.4, "text": "আমি বাংলায় কথা বলছি"}]
        en_cues = [{"id": "en_1", "start": 0.1, "end": 1.4, "text": "Hello AI Studio"}]

        bn_font = _resolve_ass_font_name(bn_cues, {})
        self.assertNotEqual(bn_font, "Arial")
        self.assertEqual(_resolve_ass_font_name(en_cues, {}), "Arial")

        ass_file = self.test_root / "bn_check.ass"
        _write_ass_subtitles(bn_cues, {}, ass_file, width=1280, height=720)
        ass_content = ass_file.read_text(encoding="utf-8")
        self.assertIn(f"Style: Default,{bn_font},", ass_content)
        self.assertIn("আমি বাংলায় কথা বলছি", ass_content)

        clip = self._make_clip("bn_burn_src.mp4", duration=2.0, size="640x360")
        out_plain = self.test_root / "bn_plain.mp4"
        out_burned = self.test_root / "bn_burned.mp4"

        base_spec = {
            "schemaVersion": "1.0",
            "format": "mp4",
            "project": {
                "name": "বাংলা সাবটাইটেল",
                "aspectRatio": "16:9",
                "resolution": "720p",
                "fps": 30,
            },
            "tracks": [
                {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False}
            ],
            "clips": [
                {
                    "id": "c1",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "bn_burn_src.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 1.6,
                    "durationSec": 1.6,
                    "sourceInSec": 0.2,
                    "sourceOutSec": 1.8,
                    "speed": 1.0,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }

        export_timeline_mp4([clip], out_plain, timeline_spec={**base_spec, "burnSubtitles": False})
        burned_meta = export_timeline_mp4(
            [clip],
            out_burned,
            timeline_spec={
                **base_spec,
                "burnSubtitles": True,
                "subtitleStyle": {
                    "enabled": True,
                    "fontSize": 32,
                    "color": "#FFFFFF",
                    "position": "bottom",
                    "backgroundColor": "#09090B",
                    "backgroundOpacity": 0.85,
                },
                "subtitles": bn_cues,
            },
        )
        self.assertTrue(out_burned.exists())
        self.assertEqual(burned_meta["video"]["width"], 1280)
        self.assertEqual(burned_meta["video"]["height"], 720)

        frame_plain = self.test_root / "bn_plain.rgb"
        frame_burned = self.test_root / "bn_burned.rgb"
        for src_mp4, raw_out in [(out_plain, frame_plain), (out_burned, frame_burned)]:
            proc = subprocess.run(
                [
                    self.ffmpeg,
                    "-y",
                    "-ss",
                    "0.6",
                    "-i",
                    str(src_mp4),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    str(raw_out),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotEqual(frame_plain.read_bytes(), frame_burned.read_bytes())

    def _make_tone_audio(
        self,
        name: str,
        *,
        duration: float = 2.0,
        freq: int = 880,
        amplitude: float = 0.25,
    ) -> Path:
        out = self.test_root / name
        ext = out.suffix.lower()
        cmd = [
            self.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc={amplitude}*sin(2*PI*{freq}*t):s=44100:d={duration}",
        ]
        if ext == ".mp3":
            cmd.extend(["-c:a", "libmp3lame", "-b:a", "128k"])
        elif ext == ".m4a":
            cmd.extend(["-c:a", "aac", "-b:a", "128k"])
        else:
            cmd.extend(["-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2"])
        cmd.append(str(out))
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return out

    def _measure_pcm_rms(self, media_path: Path, start_sec: float, duration_sec: float) -> float:
        import math
        import struct
        import wave

        wav_out = self.test_root / f"rms_{media_path.stem}_{start_sec:.2f}_{duration_sec:.2f}.wav"
        proc = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-ss",
                f"{start_sec:.3f}",
                "-t",
                f"{duration_sec:.3f}",
                "-i",
                str(media_path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_out),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with wave.open(str(wav_out), "rb") as wf:
            frames = wf.readframes(wf.getnframes())
        if not frames:
            return 0.0
        sample_count = len(frames) // 2
        samples = struct.unpack(f"<{sample_count}h", frames)
        mean_sq = sum(s * s for s in samples) / max(1, sample_count)
        return math.sqrt(mean_sq) / 32768.0

    def test_phase2_audio_probe_and_mix_mp3_wav_m4a_with_mute_volume_fades(self) -> None:
        from app.services.ffprobe_service import extract_audio_metadata

        video_clip = self._make_clip("v_base.mp4", duration=3.0, with_audio=True)
        mp3_file = self._make_tone_audio("bg.mp3", duration=2.5, freq=660, amplitude=0.25)
        wav_file = self._make_tone_audio("bg.wav", duration=2.5, freq=520, amplitude=0.25)
        m4a_file = self._make_tone_audio("bg.m4a", duration=2.5, freq=780, amplitude=0.25)

        for audio_file in (mp3_file, wav_file, m4a_file):
            ameta = extract_audio_metadata(audio_file, ffprobe_bin=check_binary("ffprobe") or "ffprobe")
            self.assertTrue(ameta["has_audio"])
            self.assertGreater(ameta["duration_seconds"], 2.0)

        # 1. Verify M4A A1 clip + V1 muted at 50% vs 200% boost + delayed MP3
        out_50 = self.test_root / "mix_50.mp4"
        out_200 = self.test_root / "mix_200.mp4"
        base_v1_muted = {
            "id": "v1",
            "trackId": "track_v1",
            "kind": "video",
            "sourceName": "v_base.mp4",
            "timelineStartSec": 0.0,
            "timelineEndSec": 3.0,
            "durationSec": 3.0,
            "sourceInSec": 0.0,
            "sourceOutSec": 3.0,
            "speed": 1.0,
            "volume": 1.0,
            "muted": True,
            "opacity": 1.0,
            "fileIndex": 0,
        }

        export_timeline_mp4(
            [video_clip, m4a_file],
            out_50,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    base_v1_muted,
                    {
                        "id": "a1_m4a",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "bg.m4a",
                        "timelineStartSec": 0.5,
                        "timelineEndSec": 2.5,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 0.5,
                        "muted": False,
                        "fadeInSec": 0.0,
                        "fadeOutSec": 0.0,
                        "fileIndex": 1,
                    },
                ],
            },
        )

        export_timeline_mp4(
            [video_clip, wav_file],
            out_200,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": True, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {**base_v1_muted, "muted": False},
                    {
                        "id": "a1_wav",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "bg.wav",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 3.0,
                        "durationSec": 3.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.5,
                        "speed": 1.0,
                        "volume": 2.0,
                        "muted": False,
                        "fadeInSec": 0.7,
                        "fadeOutSec": 0.7,
                        "fileIndex": 1,
                    },
                ],
            },
        )

        # In out_50: 0.0-0.3s must be silent (V1 muted + A1 delayed to 0.5s); 0.7-1.7s must be audible
        rms_before_delay = self._measure_pcm_rms(out_50, 0.05, 0.3)
        rms_mid_50 = self._measure_pcm_rms(out_50, 0.8, 0.8)
        self.assertLess(rms_before_delay, 0.01)
        self.assertGreater(rms_mid_50, 0.04)

        # In out_200: 200% mid RMS > 50% mid RMS, and fade-in / fade-out edges quieter than middle
        rms_start_fade = self._measure_pcm_rms(out_200, 0.02, 0.25)
        rms_mid_200 = self._measure_pcm_rms(out_200, 1.0, 0.5)
        rms_end_fade = self._measure_pcm_rms(out_200, 2.2, 0.25)
        self.assertGreater(rms_mid_200, rms_mid_50 * 2.0)
        self.assertLess(rms_start_fade, rms_mid_200 * 0.65)
        self.assertLess(rms_end_fade, rms_mid_200 * 0.65)

        # 2. Verify MP3 + Bengali burned subtitles export cleanly together
        out_mp3_bn = self.test_root / "mp3_bn.mp4"
        bn_meta = export_timeline_mp4(
            [video_clip, mp3_file],
            out_mp3_bn,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {**base_v1_muted, "muted": False, "volume": 0.8},
                    {
                        "id": "a1_mp3",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "bg.mp3",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.5,
                        "durationSec": 2.5,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.5,
                        "speed": 1.0,
                        "volume": 0.6,
                        "muted": False,
                        "fileIndex": 1,
                    },
                ],
                "burnSubtitles": True,
                "subtitles": [{"id": "s1", "start": 0.2, "end": 1.4, "text": "নমস্কার বাংলা"}],
            },
        )
        self.assertTrue(out_mp3_bn.exists())
        self.assertTrue(bn_meta["has_audio"])

    def test_phase2_speech_aware_ducking_subtitles_and_sidechain(self) -> None:
        silent_video = self._make_clip("v_silent.mp4", duration=3.0, with_audio=False)
        music_wav = self._make_tone_audio("music.wav", duration=3.0, freq=500, amplitude=0.35)
        out_ducked = self.test_root / "ducked_subs.mp4"

        export_timeline_mp4(
            [silent_video, music_wav],
            out_ducked,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v_silent.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 3.0,
                        "durationSec": 3.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 3.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "a1",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "music.wav",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 3.0,
                        "durationSec": 3.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 3.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "muted": False,
                        "duckingEnabled": True,
                        "duckingAmount": 0.75,
                        "fileIndex": 1,
                    },
                ],
                "speechIntervals": [{"start": 1.0, "end": 2.0}],
            },
        )

        rms_before = self._measure_pcm_rms(out_ducked, 0.1, 0.7)
        rms_during = self._measure_pcm_rms(out_ducked, 1.15, 0.7)
        rms_after = self._measure_pcm_rms(out_ducked, 2.15, 0.7)

        self.assertGreater(rms_before, 0.15)
        self.assertGreater(rms_after, 0.15)
        self.assertLess(rms_during, rms_before * 0.4)
        self.assertLess(rms_during, rms_after * 0.4)

        # Also test V1 speech sidechaincompress fallback when no speechIntervals/subtitles are provided
        speech_video = self._make_clip("v_speech.mp4", duration=2.5, with_audio=True)
        out_sidechain = self.test_root / "ducked_sidechain.mp4"
        sc_meta = export_timeline_mp4(
            [speech_video, music_wav],
            out_sidechain,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v_speech.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.5,
                        "durationSec": 2.5,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.5,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "a1",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "music.wav",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.5,
                        "durationSec": 2.5,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.5,
                        "speed": 1.0,
                        "volume": 1.0,
                        "muted": False,
                        "duckingEnabled": True,
                        "duckingAmount": 0.65,
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(out_sidechain.exists())
        self.assertTrue(sc_meta["has_audio"])

    def _extract_rgb24_frame(self, mp4_path: Path, timestamp_sec: float = 0.5) -> bytes:
        raw_out = self.test_root / f"frame_{mp4_path.stem}_{timestamp_sec:.2f}.rgb"
        proc = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-ss",
                f"{timestamp_sec:.3f}",
                "-i",
                str(mp4_path),
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                str(raw_out),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return raw_out.read_bytes()

    def test_phase3_effects_bw_brightness_blur_and_opacity(self) -> None:
        src = self._make_clip("fx_src.mp4", duration=1.6, size="640x360", with_audio=False)
        out_plain = self.test_root / "fx_plain.mp4"
        out_bw_blur = self.test_root / "fx_bw_blur.mp4"
        out_dim = self.test_root / "fx_dim.mp4"

        def build_spec(effects: dict | None = None, opacity: float = 1.0) -> dict:
            return {
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False}
                ],
                "clips": [
                    {
                        "id": "v1",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "fx_src.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 1.6,
                        "durationSec": 1.6,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 1.6,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": opacity,
                        **({"effects": effects} if effects else {}),
                        "fileIndex": 0,
                    }
                ],
            }

        export_timeline_mp4([src], out_plain, timeline_spec=build_spec())
        export_timeline_mp4(
            [src],
            out_bw_blur,
            timeline_spec=build_spec(
                effects={
                    "preset": "bw",
                    "brightness": 0.15,
                    "contrast": 1.2,
                    "saturation": 1.0,
                    "blur": 3.0,
                },
                opacity=1.0,
            ),
        )
        export_timeline_mp4(
            [src],
            out_dim,
            timeline_spec=build_spec(opacity=0.4),
        )

        rgb_plain = self._extract_rgb24_frame(out_plain, 0.6)
        rgb_bw = self._extract_rgb24_frame(out_bw_blur, 0.6)
        rgb_dim = self._extract_rgb24_frame(out_dim, 0.6)

        self.assertNotEqual(rgb_plain, rgb_bw)
        self.assertNotEqual(rgb_plain, rgb_dim)

        # In B&W output, every sampled pixel must have R ~= G ~= B
        max_chroma_diff = 0
        for offset in range(0, min(len(rgb_bw), 1280 * 720 * 3), 97 * 3):
            r, g, b = rgb_bw[offset], rgb_bw[offset + 1], rgb_bw[offset + 2]
            max_chroma_diff = max(max_chroma_diff, max(r, g, b) - min(r, g, b))
        self.assertLessEqual(max_chroma_diff, 4)

        # 40% opacity over black must have strictly lower average luma than 100% opacity
        avg_plain = sum(rgb_plain[::31]) / max(1, len(rgb_plain[::31]))
        avg_dim = sum(rgb_dim[::31]) / max(1, len(rgb_dim[::31]))
        self.assertLess(avg_dim, avg_plain * 0.65)

    def test_phase3_xfade_transitions_and_audio_sync(self) -> None:
        clip1 = self._make_clip("tr1.mp4", duration=2.0, with_audio=True)
        clip2 = self._make_clip("tr2.mp4", duration=2.0, with_audio=True)
        out_xfade = self.test_root / "xfade_out.mp4"

        meta = export_timeline_mp4(
            [clip1, clip2],
            out_xfade,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False}
                ],
                "clips": [
                    {
                        "id": "v1_a",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "tr1.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "transitionOut": {"type": "dissolve", "durationSec": 0.6},
                        "fileIndex": 0,
                    },
                    {
                        "id": "v1_b",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "tr2.mp4",
                        "timelineStartSec": 2.0,
                        "timelineEndSec": 4.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "transitionIn": {"type": "wipeleft", "durationSec": 0.6},
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(out_xfade.exists())
        self.assertTrue(meta["has_audio"])
        # Seam xfade overlaps two 2.0s clips by 0.6s -> ~3.4s total
        self.assertAlmostEqual(meta["duration_seconds"], 3.4, delta=0.35)
        seam_rms = self._measure_pcm_rms(out_xfade, 1.4, 0.8)
        self.assertGreater(seam_rms, 0.05)

    def test_phase3_v2_image_overlay_and_t1_text_with_bengali(self) -> None:
        bg_clip = self.test_root / "blue_bg.mp4"
        proc_bg = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=640x360:d=2.2:r=24",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(bg_clip),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_bg.returncode, 0, proc_bg.stderr)

        red_png = self.test_root / "red_overlay.png"
        proc_png = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x180",
                "-frames:v",
                "1",
                str(red_png),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_png.returncode, 0, proc_png.stderr)

        out_comp = self.test_root / "composited.mp4"
        meta = export_timeline_mp4(
            [bg_clip, red_png],
            out_comp,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_v2", "name": "V2 Overlay", "type": "overlay", "muted": False, "locked": False},
                    {"id": "track_t1", "name": "T1 Text", "type": "text", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_bg",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "blue_bg.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.2,
                        "durationSec": 2.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.2,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "v2_img",
                        "trackId": "track_v2",
                        "kind": "image",
                        "sourceName": "red_overlay.png",
                        "timelineStartSec": 0.6,
                        "timelineEndSec": 1.8,
                        "durationSec": 1.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 1.2,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 0.8,
                        "transitionIn": {"type": "fade", "durationSec": 0.25},
                        "transitionOut": {"type": "fade", "durationSec": 0.25},
                        "fileIndex": 1,
                    },
                    {
                        "id": "t1_bn",
                        "trackId": "track_t1",
                        "kind": "text",
                        "sourceName": "বাংলা টাইটেল",
                        "timelineStartSec": 0.5,
                        "timelineEndSec": 1.9,
                        "durationSec": 1.4,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 1.4,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 0.95,
                        "transitionIn": {"type": "fade", "durationSec": 0.25},
                        "textStyle": {
                            "text": "বাংলা টাইটেল",
                            "fontSize": 36,
                            "color": "#FFFFFF",
                            "backgroundOpacity": 0.75,
                            "x": 50,
                            "y": 25,
                            "align": "center",
                        },
                    },
                ],
                "burnSubtitles": True,
                "subtitles": [{"id": "s1", "start": 0.4, "end": 1.9, "text": "সাবটাইটেল পরীক্ষা"}],
            },
        )
        self.assertTrue(out_comp.exists())
        self.assertEqual(meta["video"]["width"], 1280)
        self.assertEqual(meta["video"]["height"], 720)

        # At t=0.1s neither V2 overlay nor T1/subtitle is active (blue frame)
        # At t=1.1s V2 red overlay + T1 Bengali text + subtitle are all active
        rgb_before = self._extract_rgb24_frame(out_comp, 0.1)
        rgb_during = self._extract_rgb24_frame(out_comp, 1.1)
        self.assertNotEqual(rgb_before, rgb_during)

        # Verify red channel increased significantly at t=1.1s vs blue background at t=0.1s
        avg_red_before = sum(rgb_before[0::3][::41]) / max(1, len(rgb_before[0::3][::41]))
        avg_red_during = sum(rgb_during[0::3][::41]) / max(1, len(rgb_during[0::3][::41]))
        self.assertGreater(avg_red_during, avg_red_before + 40)

    def test_phase35_v2_overlay_transform_corner_pip_and_video_audio(self) -> None:
        bg_clip = self.test_root / "bg_blue_pip.mp4"
        proc_bg = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=640x360:d=2.0:r=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=220:duration=2.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(bg_clip),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_bg.returncode, 0, proc_bg.stderr)

        logo_png = self.test_root / "logo_red.png"
        proc_png = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=200x200",
                "-frames:v",
                "1",
                str(logo_png),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_png.returncode, 0, proc_png.stderr)

        pip_video = self.test_root / "pip_green.mp4"
        proc_pip = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=320x180:d=2.0:r=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=660:duration=2.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(pip_video),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_pip.returncode, 0, proc_pip.stderr)

        # 1) Top-right corner logo watermark (60% opacity) + V1 muted + V2 PiP green video (unlocked stretch)
        out_tr = self.test_root / "top_right_logo.mp4"
        export_timeline_mp4(
            [bg_clip, logo_png],
            out_tr,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_v2", "name": "V2 Overlay", "type": "overlay", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_bg",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "bg_blue_pip.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "v2_logo",
                        "trackId": "track_v2",
                        "kind": "image",
                        "sourceName": "logo_red.png",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 0.6,
                        "overlayTransform": {
                            "x": 84,
                            "y": 16,
                            "widthPct": 26,
                            "heightPct": 26,
                            "scale": 1.0,
                            "lockAspectRatio": True,
                        },
                        "fileIndex": 1,
                    },
                ],
            },
        )
        rgb_tr = self._extract_rgb24_frame(out_tr, 0.8)
        w, h = 1280, 720
        # Pixel near top-right anchor (x=84% -> 1075, y=16% -> 115) should have strong red blend
        tr_idx = (115 * w + 1075) * 3
        bl_idx = (600 * w + 150) * 3
        self.assertGreater(rgb_tr[tr_idx], 100)
        self.assertGreater(rgb_tr[bl_idx + 2], 180)
        self.assertLess(rgb_tr[bl_idx], 40)

        # 2) Picture-in-Picture V2 video in bottom-right with V1 muted -> V2 audio must still be mixed
        out_pip = self.test_root / "pip_video_out.mp4"
        pip_meta = export_timeline_mp4(
            [bg_clip, pip_video],
            out_pip,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_v2", "name": "V2 Overlay", "type": "overlay", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_bg",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "bg_blue_pip.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "muted": True,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "v2_pip",
                        "trackId": "track_v2",
                        "kind": "video",
                        "sourceName": "pip_green.mp4",
                        "timelineStartSec": 0.2,
                        "timelineEndSec": 1.8,
                        "durationSec": 1.6,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 1.6,
                        "speed": 1.0,
                        "volume": 1.0,
                        "muted": False,
                        "opacity": 1.0,
                        "overlayTransform": {
                            "x": 82,
                            "y": 80,
                            "widthPct": 28,
                            "heightPct": 28,
                            "scale": 1.0,
                            "lockAspectRatio": False,
                        },
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(pip_meta["has_audio"])
        rgb_pip = self._extract_rgb24_frame(out_pip, 0.9)
        br_idx = (576 * w + 1050) * 3
        tl_idx = (100 * w + 120) * 3
        # Bottom-right PiP is green; top-left background stays blue
        self.assertGreater(rgb_pip[br_idx + 1], 100)
        self.assertGreater(rgb_pip[tl_idx + 2], 180)
        self.assertGreater(self._measure_pcm_rms(out_pip, 0.4, 0.8), 0.05)

    def test_phase4_playback_speed_video_audio_and_subtitles(self) -> None:
        clip = self._make_clip("speed_src.mp4", duration=2.0, size="640x360", with_audio=True)
        bgm = self.test_root / "speed_bgm.wav"
        proc_bgm = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=3.0",
                "-ar",
                "44100",
                "-ac",
                "2",
                str(bgm),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_bgm.returncode, 0, proc_bgm.stderr)

        for speed, expected_duration in ((0.5, 4.0), (1.5, 1.33), (2.0, 1.0)):
            out = self.test_root / f"speed_{str(speed).replace('.', '_')}.mp4"
            meta = export_timeline_mp4(
                [clip, bgm],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                        {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_speed",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "speed_src.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": expected_duration,
                            "durationSec": expected_duration,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 2.0,
                            "speed": speed,
                            "volume": 0.8,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        },
                        {
                            "id": "a1_speed",
                            "trackId": "track_a1",
                            "kind": "audio",
                            "sourceName": "speed_bgm.wav",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": expected_duration,
                            "durationSec": expected_duration,
                            "sourceInSec": 0.0,
                            "sourceOutSec": min(3.0, round(expected_duration * speed, 3)),
                            "speed": speed,
                            "volume": 0.6,
                            "opacity": 1.0,
                            "fileIndex": 1,
                        },
                    ],
                    "burnSubtitles": True,
                    "subtitles": [
                        {
                            "id": "sub_speed",
                            "start": 0.1,
                            "end": min(expected_duration - 0.05, 0.8),
                            "text": f"Speed {speed}x বাংলা",
                        }
                    ],
                },
            )
            self.assertTrue(out.exists())
            self.assertTrue(meta["has_audio"])
            self.assertAlmostEqual(meta["duration_seconds"], expected_duration, delta=0.35)
            self.assertGreater(self._measure_pcm_rms(out, 0.1, min(0.7, expected_duration - 0.1)), 0.03)

    def test_phase4_ffmpeg_progress_reporting(self) -> None:
        clip = self._make_clip("prog_src.mp4", duration=2.5, size="640x360", with_audio=True)
        out = self.test_root / "prog_out.mp4"
        updates: list[tuple[str, str, int, bool]] = []

        def on_progress(stage: str, stage_label: str, pct: int, measurable: bool) -> None:
            updates.append((stage, stage_label, pct, measurable))

        meta = export_timeline_mp4(
            [clip],
            out,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_prog",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "prog_src.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 1.67,
                        "durationSec": 1.67,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.5,
                        "speed": 1.5,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    }
                ],
            },
            progress_cb=on_progress,
        )
        self.assertTrue(out.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 1.67, delta=0.35)
        stages = [u[0] for u in updates]
        self.assertIn("probing", stages)
        self.assertIn("rendering_v1", stages)
        self.assertIn("finalizing", stages)
        measurable_pcts = [u[2] for u in updates if u[3] and u[0] == "rendering_v1"]
        self.assertTrue(len(measurable_pcts) >= 1, f"Expected measurable FFmpeg progress updates, got {updates}")
        self.assertEqual(measurable_pcts, sorted(measurable_pcts))
        self.assertGreaterEqual(updates[-1][2], 95)

    def test_phase4_export_cancellation_and_temp_cleanup(self) -> None:
        clip = self._make_clip("cancel_src.mp4", duration=4.0, size="640x360", with_audio=True)
        job_dir = self.test_root / "job_cancel_test"
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "temp_marker.txt").write_text("cleanup-me", encoding="utf-8")
        out = job_dir / "cancel_out.mp4"

        job_id = "cancel-regression-job-1"
        job_store.create(job_id, "export-mp4", stage="probing", stage_label="Inspecting sources", measurable=False)
        job_store.register_job_dir(job_id, job_dir)
        cancel_event = job_store.get_cancel_event(job_id)
        self.assertIsNotNone(cancel_event)

        proc_attached = threading.Event()
        errors: list[Exception] = []

        def attach_proc(proc: subprocess.Popen[str] | None) -> None:
            job_store.attach_process(job_id, proc)
            if proc is not None:
                proc_attached.set()

        def worker() -> None:
            try:
                export_timeline_mp4(
                    [clip],
                    out,
                    timeline_spec={
                        "format": "mp4",
                        "project": {"aspectRatio": "16:9", "resolution": "1080p", "fps": 30},
                        "tracks": [
                            {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                        ],
                        "clips": [
                            {
                                "id": "v1_cancel",
                                "trackId": "track_v1",
                                "kind": "video",
                                "sourceName": "cancel_src.mp4",
                                "timelineStartSec": 0.0,
                                "timelineEndSec": 8.0,
                                "durationSec": 8.0,
                                "sourceInSec": 0.0,
                                "sourceOutSec": 4.0,
                                "speed": 0.5,
                                "volume": 1.0,
                                "opacity": 1.0,
                                "fileIndex": 0,
                            }
                        ],
                    },
                    cancel_event=cancel_event,
                    process_cb=attach_proc,
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        proc_attached.wait(timeout=5.0)
        time.sleep(0.05)
        cancelled_record = job_store.request_cancel(job_id)
        thread.join(timeout=8.0)

        self.assertFalse(thread.is_alive())
        self.assertIsNotNone(cancelled_record)
        assert cancelled_record is not None
        self.assertEqual(cancelled_record["status"], "cancelled")
        self.assertTrue(cancelled_record["cancelled"])
        self.assertGreaterEqual(cancelled_record["elapsed_ms"], 0)
        self.assertFalse(job_dir.exists(), "request_cancel must remove temporary job directory")
        self.assertTrue(any(isinstance(err, VideoProcessingCancelledError) for err in errors), errors)

    def test_phase4_fastapi_cancel_and_speed_endpoints(self) -> None:
        try:
            from fastapi.testclient import TestClient
            from app.main import app
        except Exception as exc:  # noqa: BLE001
            self.skipTest(f"FastAPI TestClient unavailable: {exc}")
            return

        client = TestClient(app)
        # Unknown job returns 404
        res_missing = client.post("/api/v1/jobs/non-existent-job-xyz/cancel")
        self.assertEqual(res_missing.status_code, 404)

        # Register queued job + dir and cancel via FastAPI endpoint
        temp_job_dir = self.test_root / "http_cancel_dir"
        temp_job_dir.mkdir(parents=True, exist_ok=True)
        (temp_job_dir / "payload.bin").write_bytes(b"abc")
        job_id = "http-cancel-job-1"
        job_store.create(job_id, "export-mp4")
        job_store.register_job_dir(job_id, temp_job_dir)
        res_cancel = client.post(f"/api/v1/jobs/{job_id}/cancel")
        self.assertEqual(res_cancel.status_code, 200)
        body = res_cancel.json()
        self.assertEqual(body["status"], "cancelled")
        self.assertTrue(body["cancelled"])
        self.assertFalse(temp_job_dir.exists())

        # /api/v1/export-mp4 accepts 1.5x speed and rejects 3.0x speed
        clip = self._make_clip("http_speed.mp4", duration=1.5, with_audio=True)
        spec_ok = {
            "schemaVersion": "1.0",
            "format": "mp4",
            "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
            "tracks": [{"id": "track_v1", "name": "V1", "type": "video", "muted": False, "locked": False}],
            "clips": [
                {
                    "id": "v1_http",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "http_speed.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 1.0,
                    "durationSec": 1.0,
                    "sourceInSec": 0.0,
                    "sourceOutSec": 1.5,
                    "speed": 1.5,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }
        import json

        with clip.open("rb") as f:
            res_ok = client.post(
                "/api/v1/export-mp4",
                data={"timelineSpec": json.dumps(spec_ok), "client_job_id": "http-speed-ok-1"},
                files=[("files", ("http_speed.mp4", f, "video/mp4"))],
            )
        self.assertEqual(res_ok.status_code, 200, res_ok.text)
        res_job = client.get("/api/v1/jobs/http-speed-ok-1")
        self.assertEqual(res_job.status_code, 200)
        job_data = res_job.json()
        self.assertEqual(job_data["status"], "completed")
        self.assertEqual(job_data["progress"], 100)
        # Confirm 1.5s clip exported at 1.5x actually produced ~1.0s timeline output (not unparsed 1.5s fallback)
        self.assertAlmostEqual(float(job_data["result"]["duration_seconds"]), 1.0, delta=0.3)

        spec_bad = {
            **spec_ok,
            "clips": [{**spec_ok["clips"][0], "speed": 3.0}],
        }
        with clip.open("rb") as f:
            res_bad = client.post(
                "/api/v1/export-mp4",
                data={"timelineSpec": json.dumps(spec_bad), "client_job_id": "rejected-speed-job-3x"},
                files=[("files", ("http_speed.mp4", f, "video/mp4"))],
            )
        self.assertEqual(res_bad.status_code, 400)
        self.assertIsNone(job_store.get("rejected-speed-job-3x"))

        spec_bad_slow = {
            **spec_ok,
            "clips": [{**spec_ok["clips"][0], "speed": 0.25}],
        }
        with clip.open("rb") as f:
            res_bad_slow = client.post(
                "/api/v1/export-mp4",
                data={"timeline_spec": json.dumps(spec_bad_slow), "client_job_id": "rejected-speed-job-025x"},
                files=[("files", ("http_speed.mp4", f, "video/mp4"))],
            )
        self.assertEqual(res_bad_slow.status_code, 400)
        self.assertIsNone(job_store.get("rejected-speed-job-025x"))

    def test_phase4_no_removed_filter_complex_script_and_stderr_diagnostics(self) -> None:
        clip = self._make_clip("diag_v1.mp4", duration=1.5, size="640x360", with_audio=True)
        out = self.test_root / "diag_out.mp4"
        seen_cmds: list[list[str]] = []
        seen_shells: list[bool] = []
        real_popen = subprocess.Popen

        def spy_popen(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            seen_cmds.append([str(x) for x in cmd])
            seen_shells.append(bool(kwargs.get("shell", False)))
            return real_popen(cmd, *args, **kwargs)

        with mock.patch("app.services.ffmpeg_service.subprocess.Popen", side_effect=spy_popen):
            meta = export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1", "type": "video", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_diag",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "diag_v1.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 1.0,
                            "durationSec": 1.0,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 1.5,
                            "speed": 1.5,
                            "volume": 1.0,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        }
                    ],
                },
            )
        self.assertTrue(out.exists())
        self.assertTrue(meta["has_audio"])
        self.assertGreaterEqual(len(seen_cmds), 2)
        for cmd in seen_cmds:
            self.assertNotIn("-filter_complex_script", cmd)
            self.assertNotIn("-filter_script", cmd)
            self.assertNotIn("-vsync", cmd)
        self.assertTrue(all(shell_val is False for shell_val in seen_shells))
        self.assertTrue(any("-filter_complex" in cmd for cmd in seen_cmds))

        # Verify diagnostic stderr reporting surfaces unrecognized option details and logs command
        with self.assertLogs("video_processor.ffmpeg", level="ERROR") as log_ctx:
            with self.assertRaises(VideoProcessingError) as err_ctx:
                _run_ffmpeg_with_progress(
                    [self.ffmpeg, "-y", "-bogus_nonexistent_option_xyz", "1", str(out)],
                    timeout_sec=10,
                )
        msg = str(err_ctx.exception)
        self.assertIn("Unrecognized option", msg)
        joined_logs = "\n".join(log_ctx.output)
        self.assertIn("-bogus_nonexistent_option_xyz", joined_logs)
        self.assertIn("Stderr:", joined_logs)

    def test_phase4_validate_timeline_export_spec_speed_and_precheck(self) -> None:
        valid_spec = {
            "format": "mp4",
            "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
            "tracks": [{"id": "track_v1", "name": "V1", "type": "video", "muted": False, "locked": False}],
            "clips": [
                {
                    "id": "v1_ok",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "clip.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 1.0,
                    "durationSec": 1.0,
                    "sourceInSec": 0.0,
                    "sourceOutSec": 1.5,
                    "speed": 1.5,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }
        res = validate_timeline_export_spec(valid_spec, num_files=1)
        self.assertEqual(res[0], "720p")
        self.assertEqual(res[1], 30)

        for bad_speed in (0.25, 0.49, 2.01, 3.0, "fast", float("nan"), float("inf")):
            bad_spec = {
                **valid_spec,
                "clips": [{**valid_spec["clips"][0], "speed": bad_speed}],
            }
            with self.assertRaises(VideoProcessingError) as exc_ctx:
                validate_timeline_export_spec(bad_spec, num_files=1)
            self.assertEqual(exc_ctx.exception.status_code, 400)

    def test_phase4_long_audio_source_short_trimmed_segment_export_and_limit_enforcement(self) -> None:
        from app.services.ffprobe_service import extract_audio_metadata

        # Create a real >300s (385.1s) MP3 audio source matching the reported scenario
        long_mp3 = self.test_root / "long_bgm_385s.mp3"
        proc_mp3 = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=520:sample_rate=8000:duration=385.1",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "32k",
                str(long_mp3),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_mp3.returncode, 0, proc_mp3.stderr)
        mp3_meta = extract_audio_metadata(long_mp3)
        self.assertGreater(mp3_meta["duration_seconds"], 380.0)

        # Standalone short-media audio guard must still enforce 300s limit
        with self.assertRaises(VideoProcessingError) as ctx_short_guard:
            _assert_short_audio_limit(long_mp3, ffprobe_bin="ffprobe", max_duration_sec=300.0)
        self.assertEqual(ctx_short_guard.exception.status_code, 400)
        self.assertIn("300s", str(ctx_short_guard.exception))

        # 1) Exact scenario params: 385.1s MP3 with sourceInSec=0, sourceOutSec=50.4, speed=1 (under 300s workload)
        v1_silent = self._make_clip("v1_long_audio_test.mp4", duration=3.0, size="640x360", with_audio=False)
        out_50s_seg = self.test_root / "export_from_385s_head.mp4"
        seen_cmds: list[list[str]] = []
        real_popen = subprocess.Popen

        def spy_popen(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            seen_cmds.append([str(x) for x in cmd])
            return real_popen(cmd, *args, **kwargs)

        with mock.patch("app.services.ffmpeg_service.subprocess.Popen", side_effect=spy_popen):
            head_meta = export_timeline_mp4(
                [v1_silent, long_mp3],
                out_50s_seg,
                max_duration_sec=300.0,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                        {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_base",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "v1_long_audio_test.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 3.0,
                            "durationSec": 3.0,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 3.0,
                            "speed": 1.0,
                            "volume": 1.0,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        },
                        {
                            "id": "a1_head_trim",
                            "trackId": "track_a1",
                            "kind": "audio",
                            "sourceName": "long_bgm_385s.mp3",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 50.4,
                            "durationSec": 50.4,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 50.4,
                            "speed": 1.0,
                            "volume": 1.2,
                            "muted": False,
                            "fadeInSec": 0.4,
                            "fadeOutSec": 0.4,
                            "fileIndex": 1,
                        },
                    ],
                },
            )
        self.assertTrue(out_50s_seg.exists())
        self.assertTrue(head_meta["has_audio"])
        self.assertAlmostEqual(head_meta["duration_seconds"], 3.0, delta=0.35)
        self.assertGreater(self._measure_pcm_rms(out_50s_seg, 0.6, 1.4), 0.03)
        # Confirm pre-trim command targeted 50.400s instead of passing raw 385.1s MP3 directly into mix filtergraph
        self.assertTrue(
            any("-t" in cmd and "50.400" in cmd and str(long_mp3) in cmd for cmd in seen_cmds),
            seen_cmds,
        )

        # 2) Trimmed slice past the 300s mark inside the 385.1s MP3 (320.0s .. 323.0s) with fades & speed=1.5
        out_tail_seg = self.test_root / "export_from_385s_tail.mp4"
        tail_meta = export_timeline_mp4(
            [v1_silent, long_mp3],
            out_tail_seg,
            max_duration_sec=300.0,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_base",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v1_long_audio_test.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 3.0,
                        "durationSec": 3.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 3.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "a1_tail_trim",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "long_bgm_385s.mp3",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 320.0,
                        "sourceOutSec": 323.0,
                        "speed": 1.5,
                        "volume": 1.0,
                        "muted": False,
                        "fadeInSec": 0.5,
                        "fadeOutSec": 0.5,
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(out_tail_seg.exists())
        self.assertTrue(tail_meta["has_audio"])
        self.assertGreater(self._measure_pcm_rms(out_tail_seg, 0.5, 0.8), 0.03)
        self.assertLess(self._measure_pcm_rms(out_tail_seg, 2.2, 0.6), 0.01)

        # 3) Processed audio segment actually exceeding 300s (0..320s) MUST still be rejected with 400
        with self.assertRaises(VideoProcessingError) as ctx_oversized_a1:
            export_timeline_mp4(
                [v1_silent, long_mp3],
                self.test_root / "should_reject_320s_a1.mp4",
                max_duration_sec=300.0,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                        {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_base",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "v1_long_audio_test.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 3.0,
                            "durationSec": 3.0,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 3.0,
                            "speed": 1.0,
                            "volume": 1.0,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        },
                        {
                            "id": "a1_too_long",
                            "trackId": "track_a1",
                            "kind": "audio",
                            "sourceName": "long_bgm_385s.mp3",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 320.0,
                            "durationSec": 320.0,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 320.0,
                            "speed": 1.0,
                            "volume": 1.0,
                            "muted": False,
                            "fileIndex": 1,
                        },
                    ],
                },
            )
        self.assertEqual(ctx_oversized_a1.exception.status_code, 400)
        self.assertIn("300s", str(ctx_oversized_a1.exception))

        # 4) Standalone short-video trim_video limit preserved vs timeline export short segment from >max_duration_sec video
        vid_8s = self._make_clip("vid_8s.mp4", duration=8.0, size="320x180", with_audio=True)
        with self.assertRaises(VideoProcessingError) as ctx_standalone_trim:
            trim_video(vid_8s, self.test_root / "standalone_trim_reject.mp4", start_sec=0.0, end_sec=2.0, max_duration_sec=5.0)
        self.assertEqual(ctx_standalone_trim.exception.status_code, 400)

        out_short_from_long_vid = self.test_root / "short_from_long_vid.mp4"
        vid_meta = export_timeline_mp4(
            [vid_8s],
            out_short_from_long_vid,
            max_duration_sec=5.0,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_late_slice",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "vid_8s.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 5.5,
                        "sourceOutSec": 7.5,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    }
                ],
            },
        )
        self.assertTrue(out_short_from_long_vid.exists())
        self.assertAlmostEqual(vid_meta["duration_seconds"], 2.0, delta=0.35)

        # Combined V1 timeline exceeding max_duration_sec must still fail with 400
        with self.assertRaises(VideoProcessingError) as ctx_oversized_tl:
            export_timeline_mp4(
                [vid_8s],
                self.test_root / "oversized_timeline.mp4",
                max_duration_sec=5.0,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_too_long",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "vid_8s.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 6.0,
                            "durationSec": 6.0,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 6.0,
                            "speed": 1.0,
                            "volume": 1.0,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        }
                    ],
                },
            )
        self.assertEqual(ctx_oversized_tl.exception.status_code, 400)

    def test_phase45_export_profiles_validation_and_aspect_ratios(self) -> None:
        with self.assertRaises(VideoProcessingError) as bad_prof:
            resolve_export_profile_spec("ultra_slow", "720p")
        self.assertEqual(bad_prof.exception.status_code, 400)

        with self.assertRaises(VideoProcessingError) as bad_enc:
            normalize_encoding_mode("tpu")
        self.assertEqual(bad_enc.exception.status_code, 400)

        p_fast, res_fast, spec_fast = resolve_export_profile_spec("fast_preview", "1080p")
        self.assertEqual(p_fast, "fast_preview")
        self.assertEqual(res_fast, "720p")
        self.assertEqual(spec_fast["x264_preset"], "ultrafast")
        self.assertEqual(spec_fast["crf"], 26)

        p_bal, res_bal, spec_bal = resolve_export_profile_spec("balanced", "720p")
        self.assertEqual(p_bal, "balanced")
        self.assertEqual(res_bal, "1080p")
        self.assertEqual(spec_bal["x264_preset"], "veryfast")
        self.assertEqual(spec_bal["crf"], 22)

        p_hq, res_hq, spec_hq = resolve_export_profile_spec("high_quality", "720p")
        self.assertEqual(p_hq, "high_quality")
        self.assertEqual(res_hq, "1080p")
        self.assertEqual(spec_hq["x264_preset"], "medium")
        self.assertEqual(spec_hq["crf"], 19)

        clip_src = self._make_clip("profile_src.mp4", duration=1.5, size="640x360", with_audio=True)
        expected_dims = [
            ("fast_preview", "16:9", 1280, 720),
            ("fast_preview", "9:16", 720, 1280),
            ("fast_preview", "1:1", 720, 720),
            ("balanced", "9:16", 1080, 1920),
            ("high_quality", "1:1", 1080, 1080),
        ]
        for idx, (profile_id, ar, exp_w, exp_h) in enumerate(expected_dims):
            out_path = self.test_root / f"prof_{idx}_{profile_id}.mp4"
            meta = export_timeline_mp4(
                [clip_src],
                out_path,
                export_profile=profile_id,  # type: ignore[arg-type]
                encoding_mode="cpu",
                fps=24,
                aspect_ratio=ar,  # type: ignore[arg-type]
                timeline_spec={
                    "format": "mp4",
                    "exportProfile": profile_id,
                    "encodingMode": "cpu",
                    "project": {"aspectRatio": ar, "resolution": "1080p", "fps": 24},
                    "tracks": [
                        {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    ],
                    "clips": [
                        {
                            "id": "v1_1",
                            "trackId": "track_v1",
                            "kind": "video",
                            "sourceName": "profile_src.mp4",
                            "timelineStartSec": 0.0,
                            "timelineEndSec": 1.5,
                            "durationSec": 1.5,
                            "sourceInSec": 0.0,
                            "sourceOutSec": 1.5,
                            "speed": 1.0,
                            "volume": 1.0,
                            "opacity": 1.0,
                            "fileIndex": 0,
                        }
                    ],
                },
            )
            self.assertTrue(out_path.exists())
            self.assertEqual(meta["video"]["width"], exp_w)
            self.assertEqual(meta["video"]["height"], exp_h)
            self.assertEqual(meta["export_profile"], profile_id)
            self.assertEqual(meta["encoder_used"], "libx264")
            self.assertFalse(meta["hardware_fallback_used"])
            self.assertAlmostEqual(meta["duration_seconds"], 1.5, delta=0.3)

    def test_phase45_hardware_encoder_detection_and_fallback(self) -> None:
        clear_hardware_encoder_cache()
        try:
            # 1) False-positive hardware encoders (compiled in ffmpeg -encoders, fail 1-frame init) must be excluded
            with mock.patch("app.services.ffmpeg_service.subprocess.run") as mock_run:
                mock_run.return_value = subprocess.CompletedProcess(
                    args=["ffmpeg"],
                    returncode=1,
                    stdout="",
                    stderr="Cannot load libcuda.so.1 / Unknown encoder",
                )
                caps_none = detect_hardware_h264_encoders(self.ffmpeg, force_refresh=True)
                self.assertEqual(caps_none["available_hardware_encoders"], [])
                self.assertEqual(caps_none["recommended_encoder"], "libx264")
                self.assertEqual(mock_run.call_count, 3)

            # 2) Valid QSV 1-frame smoke test succeeds and enforces nv12 pixel format
            seen_cmds: list[list[str]] = []

            def fake_hw_probe(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
                seen_cmds.append([str(x) for x in cmd])
                if "h264_qsv" in cmd:
                    return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")
                return subprocess.CompletedProcess(args=cmd, returncode=1, stdout="", stderr="Device unavailable")

            with mock.patch("app.services.ffmpeg_service.subprocess.run", side_effect=fake_hw_probe):
                caps_qsv = detect_hardware_h264_encoders(self.ffmpeg, force_refresh=True)
                self.assertEqual(caps_qsv["available_hardware_encoders"], ["h264_qsv"])
                self.assertEqual(caps_qsv["recommended_encoder"], "h264_qsv")
                self.assertTrue(caps_qsv["encoders"]["h264_qsv"]["available"])  # type: ignore[index]
                self.assertFalse(caps_qsv["encoders"]["h264_nvenc"]["available"])  # type: ignore[index]
                qsv_cmd = next(c for c in seen_cmds if "h264_qsv" in c)
                self.assertIn("nv12", qsv_cmd)

            # 3) Runtime hardware failure falls back gracefully to libx264 when encoding_mode='gpu'/'auto'
            clip_src = self._make_clip("hw_fallback_src.mp4", duration=1.5, size="640x360", with_audio=False)
            out_fallback = self.test_root / "hw_fallback_out.mp4"
            from app.services.ffmpeg_service import _run_ffmpeg as real_run_ffmpeg

            attempted_encoders: list[str] = []

            def flaky_gpu_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
                if "h264_nvenc" in cmd:
                    attempted_encoders.append("h264_nvenc")
                    raise VideoProcessingError("Simulated NVENC runtime session error", status_code=422)
                if "libx264" in cmd:
                    attempted_encoders.append("libx264")
                return real_run_ffmpeg(cmd, *args, **kwargs)

            mock_hw_caps = {
                "software_encoder": "libx264",
                "available_hardware_encoders": ["h264_nvenc"],
                "recommended_encoder": "h264_nvenc",
                "encoders": {"h264_nvenc": {"available": True, "label": "NVIDIA NVENC", "detail": "Ready"}},
            }
            with (
                mock.patch("app.services.ffmpeg_service.detect_hardware_h264_encoders", return_value=mock_hw_caps),
                mock.patch("app.services.ffmpeg_service._run_ffmpeg", side_effect=flaky_gpu_run),
            ):
                fb_meta = export_timeline_mp4(
                    [clip_src],
                    out_fallback,
                    export_profile="fast_preview",
                    encoding_mode="gpu",
                    fps=24,
                    timeline_spec={
                        "format": "mp4",
                        "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                        "tracks": [
                            {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                        ],
                        "clips": [
                            {
                                "id": "v1_1",
                                "trackId": "track_v1",
                                "kind": "video",
                                "sourceName": "hw_fallback_src.mp4",
                                "timelineStartSec": 0.0,
                                "timelineEndSec": 1.5,
                                "durationSec": 1.5,
                                "sourceInSec": 0.0,
                                "sourceOutSec": 1.5,
                                "speed": 1.0,
                                "volume": 1.0,
                                "opacity": 1.0,
                                "fileIndex": 0,
                            }
                        ],
                    },
                )
            self.assertEqual(attempted_encoders, ["h264_nvenc", "libx264"])
            self.assertEqual(fb_meta["encoder_used"], "libx264")
            self.assertTrue(fb_meta["hardware_fallback_used"])
            self.assertTrue(out_fallback.exists())
        finally:
            clear_hardware_encoder_cache()

    def test_phase45_single_pass_profiling_overlays_subtitles_and_audio_sync(self) -> None:
        clip_a = self._make_clip("v1_sp_a.mp4", duration=2.5, size="640x360", with_audio=True)
        clip_b = self._make_clip("v1_sp_b.mp4", duration=2.5, size="640x360", with_audio=True)
        overlay_img = self.test_root / "ov_logo.png"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=cyan:s=240x180:d=1",
                "-frames:v",
                "1",
                str(overlay_img),
            ],
            capture_output=True,
            check=True,
        )
        bgm_mp3 = self.test_root / "bgm_track.mp3"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=6.0",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(bgm_mp3),
            ],
            capture_output=True,
            check=True,
        )

        out_dir = self.test_root / "isolated_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_mp4 = out_dir / "phase45_full_single_pass.mp4"

        seen_cmds: list[list[str]] = []
        real_popen = subprocess.Popen

        def spy_popen(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            seen_cmds.append([str(x) for x in cmd])
            return real_popen(cmd, *args, **kwargs)

        log_records: list[str] = []

        class _ListHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                log_records.append(self.format(record))

        ffmpeg_logger = logging.getLogger("video_processor.ffmpeg")
        handler = _ListHandler()
        prev_level = ffmpeg_logger.level
        ffmpeg_logger.setLevel(logging.INFO)
        ffmpeg_logger.addHandler(handler)
        try:
            with mock.patch("app.services.ffmpeg_service.subprocess.Popen", side_effect=spy_popen):
                meta = export_timeline_mp4(
                    [clip_a, clip_b, overlay_img, bgm_mp3],
                    out_mp4,
                    export_profile="fast_preview",
                    encoding_mode="cpu",
                    fps=24,
                    aspect_ratio="16:9",
                    timeline_spec={
                        "format": "mp4",
                        "exportProfile": "fast_preview",
                        "encodingMode": "cpu",
                        "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                        "tracks": [
                            {"id": "track_t1", "name": "T1 Text", "type": "text", "muted": False, "locked": False},
                            {"id": "track_v2", "name": "V2 Overlay", "type": "overlay", "muted": False, "locked": False},
                            {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                            {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                        ],
                        "clips": [
                            {
                                "id": "v1_1",
                                "trackId": "track_v1",
                                "kind": "video",
                                "sourceName": "v1_sp_a.mp4",
                                "timelineStartSec": 0.0,
                                "timelineEndSec": 2.0,
                                "durationSec": 2.0,
                                "sourceInSec": 0.5,
                                "sourceOutSec": 2.5,
                                "speed": 1.0,
                                "volume": 0.8,
                                "opacity": 1.0,
                                "transitionOut": {"type": "fade", "durationSec": 0.4},
                                "effects": {"preset": "cinematic"},
                                "fileIndex": 0,
                            },
                            {
                                "id": "v1_2",
                                "trackId": "track_v1",
                                "kind": "video",
                                "sourceName": "v1_sp_b.mp4",
                                "timelineStartSec": 2.0,
                                "timelineEndSec": 3.5,
                                "durationSec": 1.5,
                                "sourceInSec": 0.0,
                                "sourceOutSec": 2.25,
                                "speed": 1.5,
                                "volume": 0.8,
                                "opacity": 1.0,
                                "fileIndex": 1,
                            },
                            {
                                "id": "v2_1",
                                "trackId": "track_v2",
                                "kind": "image",
                                "sourceName": "ov_logo.png",
                                "timelineStartSec": 0.2,
                                "timelineEndSec": 2.6,
                                "durationSec": 2.4,
                                "sourceInSec": 0.0,
                                "sourceOutSec": 2.4,
                                "speed": 1.0,
                                "volume": 1.0,
                                "opacity": 0.85,
                                "overlayTransform": {"x": 85.0, "y": 15.0, "widthPct": 22.0, "heightPct": 22.0, "scale": 1.0, "lockAspectRatio": True},
                                "fileIndex": 2,
                            },
                            {
                                "id": "t1_1",
                                "trackId": "track_t1",
                                "kind": "text",
                                "sourceName": "Title",
                                "timelineStartSec": 0.2,
                                "timelineEndSec": 2.5,
                                "durationSec": 2.3,
                                "opacity": 1.0,
                                "textStyle": {"text": "বাংলা ওভারলে", "fontSize": 34, "color": "#FFFFFF", "x": 50, "y": 20, "align": "center"},
                            },
                            {
                                "id": "a1_1",
                                "trackId": "track_a1",
                                "kind": "audio",
                                "sourceName": "bgm_track.mp3",
                                "timelineStartSec": 0.0,
                                "timelineEndSec": 3.0,
                                "durationSec": 3.0,
                                "sourceInSec": 1.0,
                                "sourceOutSec": 4.0,
                                "speed": 1.0,
                                "volume": 0.9,
                                "fadeInSec": 0.3,
                                "fadeOutSec": 0.3,
                                "duckingEnabled": True,
                                "duckingAmount": 0.5,
                                "fileIndex": 3,
                            },
                        ],
                        "burnSubtitles": True,
                        "subtitles": [{"id": "s1", "start": 0.3, "end": 2.2, "text": "সাবটাইটেল পরীক্ষা"}],
                        "speechIntervals": [{"start": 0.3, "end": 2.2}],
                    },
                )
        finally:
            ffmpeg_logger.removeHandler(handler)
            ffmpeg_logger.setLevel(prev_level)

        self.assertTrue(out_mp4.exists())
        # Verify single visual pass + single audio mix/copy pass (= exactly 2 FFmpeg calls total; subprocess.run also uses Popen)
        ffmpeg_cmds = [c for c in seen_cmds if "ffmpeg" in Path(c[0]).name]
        self.assertEqual(len(ffmpeg_cmds), 2, f"Expected 2 FFmpeg passes, saw {len(ffmpeg_cmds)}: {ffmpeg_cmds}")
        self.assertIn("libx264", ffmpeg_cmds[0])
        self.assertIn("-c:v", ffmpeg_cmds[1])
        self.assertIn("copy", ffmpeg_cmds[1])

        # Expected V1 total with 0.4s seam overlap: 2.0 + 1.5 - 0.4 = 3.1s
        self.assertAlmostEqual(meta["duration_seconds"], 3.1, delta=0.35)
        self.assertEqual(meta["video"]["width"], 1280)
        self.assertEqual(meta["video"]["height"], 720)
        self.assertTrue(meta["has_audio"])
        self.assertGreater(self._measure_pcm_rms(out_mp4, 0.5, 1.5), 0.03)

        # Verify temp _timeline_work directory was completely cleaned up
        self.assertEqual([p.name for p in out_dir.iterdir()], ["phase45_full_single_pass.mp4"])

        # Verify performance telemetry structure and sanitized log output (no temp file paths)
        perf = meta["performance"]
        self.assertGreater(perf["total_export_sec"], 0.0)
        self.assertGreater(perf["ffmpeg_execution_sec"], 0.0)
        self.assertGreaterEqual(perf["total_export_sec"], perf["ffmpeg_execution_sec"])
        for stage_key in (
            "metadata_probing",
            "v1_clip_preparation_and_trimming",
            "playback_speed_processing",
            "effects_and_transitions",
            "v2_overlay_compositing",
            "t1_text_rendering",
            "visual_single_pass_encode",
            "audio_segment_pretrimming",
            "audio_mixing_and_ducking",
            "final_encoding_and_muxing",
        ):
            self.assertIn(stage_key, perf["stages"])

        self.assertTrue(any("MP4 export profile=fast_preview encoder=libx264" in line for line in log_records))
        for line in log_records:
            self.assertNotIn(str(self.test_root), line)
            self.assertNotIn("api_key", line.lower())

    def test_phase45_fastapi_health_and_export_profile_endpoints(self) -> None:
        try:
            from fastapi.testclient import TestClient  # type: ignore[import-not-found]
            from app.main import app
        except Exception as exc:
            self.skipTest(f"FastAPI TestClient unavailable: {exc}")

        with TestClient(app) as client:
            health_res = client.get("/health")
            self.assertEqual(health_res.status_code, 200)
            body = health_res.json()
            self.assertIn("hardware_encoders", body)
            self.assertIn("recommended_encoder", body)
            self.assertIn("export_profiles", body)
            self.assertIn("fast_preview", body["export_profiles"])

    def _measure_region_rgb_mean(
        self,
        video_path: Path,
        timestamp_sec: float,
        *,
        w: int,
        h: int,
        rx: int,
        ry: int,
        rw: int,
        rh: int,
    ) -> tuple[float, float, float]:
        proc = subprocess.run(
            [
                self.ffmpeg,
                "-v",
                "error",
                "-ss",
                f"{timestamp_sec:.3f}",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-s",
                f"{w}x{h}",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
        )
        raw = proc.stdout
        self.assertGreaterEqual(len(raw), w * h * 3)
        r_sum = g_sum = b_sum = count = 0
        for yy in range(max(0, ry), min(h, ry + rh)):
            for xx in range(max(0, rx), min(w, rx + rw)):
                idx = (yy * w + xx) * 3
                r_sum += raw[idx]
                g_sum += raw[idx + 1]
                b_sum += raw[idx + 2]
                count += 1
        self.assertGreater(count, 0)
        return (r_sum / count, g_sum / count, b_sum / count)

    def test_phase52_keyframe_validation_and_bounds(self) -> None:
        base_spec = {
            "format": "mp4",
            "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
            "tracks": [{"id": "track_v1", "name": "V1", "type": "video", "muted": False, "locked": False}],
            "clips": [
                {
                    "id": "v1_ok",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "clip.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 3.0,
                    "durationSec": 3.0,
                    "sourceInSec": 0.0,
                    "sourceOutSec": 3.0,
                    "speed": 1.0,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "rotation": -15.0,
                    "keyframes": [
                        {"id": "k1", "property": "scale", "timeSec": 0.0, "value": 1.0, "easing": "ease-in-out"},
                        {"id": "k2", "property": "scale", "timeSec": 3.0, "value": 1.4, "easing": "linear"},
                    ],
                    "fileIndex": 0,
                }
            ],
        }
        res = validate_timeline_export_spec(base_spec, num_files=1)
        self.assertEqual(res[0], "720p")

        invalid_clips = [
            {**base_spec["clips"][0], "rotation": 400.0},
            {**base_spec["clips"][0], "keyframes": [{"property": "skew", "timeSec": 0, "value": 1, "easing": "linear"}]},
            {**base_spec["clips"][0], "keyframes": [{"property": "opacity", "timeSec": -0.5, "value": 0.5, "easing": "linear"}]},
            {**base_spec["clips"][0], "keyframes": [{"property": "opacity", "timeSec": 0.0, "value": 1.5, "easing": "linear"}]},
            {**base_spec["clips"][0], "keyframes": [{"property": "scale", "timeSec": 0.0, "value": 1.0, "easing": "bounce"}]},
            {**base_spec["clips"][0], "keyframes": [{"property": "x", "timeSec": 0.0, "value": float("nan"), "easing": "linear"}]},
        ]
        for bad_clip in invalid_clips:
            with self.assertRaises(VideoProcessingError) as ctx:
                validate_timeline_export_spec({**base_spec, "clips": [bad_clip]}, num_files=1)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_phase52_v2_overlay_keyframes_and_rotation_export(self) -> None:
        v1_black = self.test_root / "v1_dark.mp4"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=640x360:r=24:d=2.2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(v1_black),
            ],
            capture_output=True,
            check=True,
        )
        red_box = self.test_root / "red_overlay.png"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=#FF1010:s=200x200:d=1",
                "-frames:v",
                "1",
                str(red_box),
            ],
            capture_output=True,
            check=True,
        )
        out_mp4 = self.test_root / "phase52_v2_keyframes.mp4"
        meta = export_timeline_mp4(
            [v1_black, red_box],
            out_mp4,
            export_profile="fast_preview",
            encoding_mode="cpu",
            fps=24,
            aspect_ratio="16:9",
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v2", "name": "V2 Overlay", "type": "overlay", "muted": False, "locked": False},
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_1",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v1_dark.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.2,
                        "durationSec": 2.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.2,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "v2_anim",
                        "trackId": "track_v2",
                        "kind": "image",
                        "sourceName": "red_overlay.png",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.2,
                        "durationSec": 2.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.2,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 0.0,
                        "rotation": 0.0,
                        "overlayTransform": {
                            "x": 20.0,
                            "y": 25.0,
                            "widthPct": 22.0,
                            "heightPct": 22.0,
                            "scale": 1.0,
                            "lockAspectRatio": True,
                        },
                        "keyframes": [
                            {"id": "x0", "property": "x", "timeSec": 0.0, "value": 18.0, "easing": "linear"},
                            {"id": "x1", "property": "x", "timeSec": 2.0, "value": 82.0, "easing": "linear"},
                            {"id": "y0", "property": "y", "timeSec": 0.0, "value": 24.0, "easing": "linear"},
                            {"id": "y1", "property": "y", "timeSec": 2.0, "value": 76.0, "easing": "linear"},
                            {"id": "s0", "property": "scale", "timeSec": 0.0, "value": 0.9, "easing": "ease-out"},
                            {"id": "s1", "property": "scale", "timeSec": 2.0, "value": 1.4, "easing": "linear"},
                            {"id": "r0", "property": "rotation", "timeSec": 0.0, "value": 0.0, "easing": "linear"},
                            {"id": "r1", "property": "rotation", "timeSec": 2.0, "value": 45.0, "easing": "linear"},
                            {"id": "o0", "property": "opacity", "timeSec": 0.0, "value": 0.35, "easing": "linear"},
                            {"id": "o1", "property": "opacity", "timeSec": 2.0, "value": 1.0, "easing": "linear"},
                        ],
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(out_mp4.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 2.2, delta=0.35)
        # Early frame (~0.15s): red box sits around (x~23%, y~28%) in top-left quadrant while bottom-right is black
        tl_early = self._measure_region_rgb_mean(out_mp4, 0.15, w=320, h=180, rx=62, ry=40, rw=20, rh=20)
        br_early = self._measure_region_rgb_mean(out_mp4, 0.15, w=320, h=180, rx=245, ry=120, rw=30, rh=30)
        self.assertGreater(tl_early[0], 70.0)
        self.assertLess(br_early[0], 15.0)
        # Late frame (~1.95s): red box moved to bottom-right quadrant with full opacity (much brighter than early top-left)
        tl_late = self._measure_region_rgb_mean(out_mp4, 1.95, w=320, h=180, rx=62, ry=40, rw=20, rh=20)
        br_late = self._measure_region_rgb_mean(out_mp4, 1.95, w=320, h=180, rx=245, ry=120, rw=30, rh=30)
        self.assertLess(tl_late[0], 15.0)
        self.assertGreater(br_late[0], 170.0)
        self.assertGreater(br_late[0], tl_early[0] * 1.5)

    def test_phase52_v1_and_t1_bengali_keyframe_export(self) -> None:
        v1_blue = self.test_root / "v1_blue.mp4"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=#2266EE:s=640x360:r=24:d=2.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(v1_blue),
            ],
            capture_output=True,
            check=True,
        )
        out_mp4 = self.test_root / "phase52_v1_t1_keyframes.mp4"
        meta = export_timeline_mp4(
            [v1_blue],
            out_mp4,
            export_profile="fast_preview",
            encoding_mode="cpu",
            fps=24,
            aspect_ratio="16:9",
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_t1", "name": "T1 Text", "type": "text", "muted": False, "locked": False},
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_anim",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v1_blue.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.0,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "rotation": 0.0,
                        "keyframes": [
                            {"id": "v1_op0", "property": "opacity", "timeSec": 0.0, "value": 0.2, "easing": "linear"},
                            {"id": "v1_op1", "property": "opacity", "timeSec": 1.8, "value": 1.0, "easing": "linear"},
                            {"id": "v1_sc0", "property": "scale", "timeSec": 0.0, "value": 0.7, "easing": "ease-in-out"},
                            {"id": "v1_sc1", "property": "scale", "timeSec": 1.8, "value": 1.0, "easing": "linear"},
                        ],
                        "fileIndex": 0,
                    },
                    {
                        "id": "t1_bn_anim",
                        "trackId": "track_t1",
                        "kind": "text",
                        "sourceName": "বাংলা অ্যানিমেশন",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.0,
                        "durationSec": 2.0,
                        "opacity": 1.0,
                        "rotation": 8.0,
                        "textStyle": {
                            "text": "বাংলা অ্যানিমেশন",
                            "fontSize": 36,
                            "color": "#FFFFFF",
                            "backgroundColor": "#09090B",
                            "backgroundOpacity": 0.7,
                            "x": 50,
                            "y": 25,
                            "align": "center",
                        },
                        "keyframes": [
                            {"id": "t1_y0", "property": "y", "timeSec": 0.0, "value": 25.0, "easing": "ease-in-out"},
                            {"id": "t1_y1", "property": "y", "timeSec": 1.8, "value": 75.0, "easing": "linear"},
                            {"id": "t1_r0", "property": "rotation", "timeSec": 0.0, "value": -10.0, "easing": "linear"},
                            {"id": "t1_r1", "property": "rotation", "timeSec": 1.8, "value": 10.0, "easing": "linear"},
                            {"id": "t1_o0", "property": "opacity", "timeSec": 0.0, "value": 0.3, "easing": "linear"},
                            {"id": "t1_o1", "property": "opacity", "timeSec": 1.5, "value": 1.0, "easing": "linear"},
                        ],
                    },
                ],
            },
        )
        self.assertTrue(out_mp4.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 2.0, delta=0.35)
        # Early frame (~0.1s) should have much lower center blue intensity than late frame (~1.8s)
        c_early = self._measure_region_rgb_mean(out_mp4, 0.1, w=320, h=180, rx=130, ry=75, rw=40, rh=30)
        c_late = self._measure_region_rgb_mean(out_mp4, 1.8, w=320, h=180, rx=130, ry=75, rw=40, rh=30)
        self.assertGreater(c_late[2], c_early[2] * 2.0)

    def test_phase52_audio_volume_keyframe_rms_export(self) -> None:
        v1_silent = self._make_clip("v1_aud_kf.mp4", duration=2.2, size="640x360", with_audio=False)
        tone_wav = self.test_root / "tone_440.wav"
        subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=2.5",
                str(tone_wav),
            ],
            capture_output=True,
            check=True,
        )
        out_mp4 = self.test_root / "phase52_audio_volume_keyframes.mp4"
        meta = export_timeline_mp4(
            [v1_silent, tone_wav],
            out_mp4,
            export_profile="fast_preview",
            encoding_mode="cpu",
            fps=24,
            timeline_spec={
                "format": "mp4",
                "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 24},
                "tracks": [
                    {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
                    {"id": "track_a1", "name": "A1 Audio", "type": "audio", "muted": False, "locked": False},
                ],
                "clips": [
                    {
                        "id": "v1_1",
                        "trackId": "track_v1",
                        "kind": "video",
                        "sourceName": "v1_aud_kf.mp4",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.2,
                        "durationSec": 2.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.2,
                        "speed": 1.0,
                        "volume": 1.0,
                        "opacity": 1.0,
                        "fileIndex": 0,
                    },
                    {
                        "id": "a1_kf_ramp",
                        "trackId": "track_a1",
                        "kind": "audio",
                        "sourceName": "tone_440.wav",
                        "timelineStartSec": 0.0,
                        "timelineEndSec": 2.2,
                        "durationSec": 2.2,
                        "sourceInSec": 0.0,
                        "sourceOutSec": 2.2,
                        "speed": 1.0,
                        # Base volume=0 tests that keyframed volume > 0 still passes inclusion checks
                        "volume": 0.0,
                        "muted": False,
                        "keyframes": [
                            {"id": "av0", "property": "volume", "timeSec": 0.0, "value": 0.05, "easing": "linear"},
                            {"id": "av1", "property": "volume", "timeSec": 1.8, "value": 1.4, "easing": "linear"},
                        ],
                        "fileIndex": 1,
                    },
                ],
            },
        )
        self.assertTrue(out_mp4.exists())
        self.assertTrue(meta["has_audio"])
        early_rms = self._measure_pcm_rms(out_mp4, 0.05, 0.30)
        late_rms = self._measure_pcm_rms(out_mp4, 1.45, 0.50)
        self.assertGreater(late_rms, 0.06)
        self.assertGreater(late_rms, early_rms * 4.0)

    def test_phase4_cancellation_tombstones_immutability_and_probing_abort(self) -> None:
        # 1) Missing job without allow_precreate still returns None (-> HTTP 404)
        self.assertIsNone(job_store.request_cancel("missing-job-default-404"))

        # 2) Pre-cancel tombstone with allow_precreate=True aborts job created afterward
        tomb_id = "pre-cancelled-upload-job-1"
        pre_snap = job_store.request_cancel(tomb_id, allow_precreate=True)
        self.assertIsNotNone(pre_snap)
        assert pre_snap is not None
        self.assertEqual(pre_snap["status"], "cancelled")
        self.assertTrue(pre_snap["cancelled"])
        self.assertTrue(job_store.is_cancelled(tomb_id))

        created = job_store.create(tomb_id, "export_mp4", if_missing=True)
        self.assertEqual(created["status"], "cancelled")
        self.assertTrue(created["cancelled"])
        ev = job_store.get_cancel_event(tomb_id)
        self.assertIsNotNone(ev)
        assert ev is not None
        self.assertTrue(ev.is_set())

        # 3) Strict terminal state immutability: cancelled cannot revert to completed/processing
        after_complete_attempt = job_store.update(
            tomb_id,
            status="completed",
            progress=100,
            stage="completed",
            stage_label="Export complete",
        )
        self.assertIsNotNone(after_complete_attempt)
        assert after_complete_attempt is not None
        self.assertEqual(after_complete_attempt["status"], "cancelled")
        self.assertTrue(after_complete_attempt["cancelled"])

        # Completed cannot revert to cancelled
        done_id = "completed-immutable-job-1"
        job_store.create(done_id, "export_mp4")
        job_store.update(done_id, status="completed", progress=100, stage="completed")
        after_cancel_attempt = job_store.request_cancel(done_id)
        self.assertIsNotNone(after_cancel_attempt)
        assert after_cancel_attempt is not None
        self.assertEqual(after_cancel_attempt["status"], "completed")

        # 4) Cancelling before FFmpeg starts (during probing) aborts immediately
        clip = self._make_clip("probe_cancel.mp4", duration=1.5, size="640x360", with_audio=False)
        out_probe_cancel = self.test_root / "probe_cancel_out.mp4"
        cancel_ev = threading.Event()
        cancel_ev.set()
        with self.assertRaises(VideoProcessingCancelledError):
            export_timeline_mp4(
                [clip],
                out_probe_cancel,
                export_profile="fast_preview",
                encoding_mode="cpu",
                cancel_event=cancel_ev,
            )
        self.assertFalse(out_probe_cancel.exists())

    def test_phase4_cancellation_across_profiles_and_gpu_fallback_guard(self) -> None:
        clip = self._make_clip("prof_cancel_src.mp4", duration=3.0, size="640x360", with_audio=True)
        spec = {
            "format": "mp4",
            "project": {"aspectRatio": "16:9", "resolution": "1080p", "fps": 24},
            "tracks": [
                {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
            ],
            "clips": [
                {
                    "id": "v1_prof",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "prof_cancel_src.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 6.0,
                    "durationSec": 6.0,
                    "sourceInSec": 0.0,
                    "sourceOutSec": 3.0,
                    "speed": 0.5,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }

        # Cancel across all 3 export profiles (CPU)
        for profile in ("fast_preview", "balanced", "high_quality"):
            job_dir = self.test_root / f"job_prof_{profile}"
            job_dir.mkdir(parents=True, exist_ok=True)
            out_path = job_dir / f"{profile}_cancel.mp4"
            job_id = f"cancel-profile-{profile}"
            job_store.create(job_id, "export_mp4")
            job_store.register_job_dir(job_id, job_dir)
            cancel_ev = job_store.get_cancel_event(job_id)
            assert cancel_ev is not None
            proc_attached = threading.Event()
            spawned_procs: list[subprocess.Popen[str]] = []
            errors: list[Exception] = []

            def on_proc(proc: subprocess.Popen[str] | None, *, _ev=proc_attached, _list=spawned_procs, _jid=job_id) -> None:
                job_store.attach_process(_jid, proc)
                if proc is not None:
                    _list.append(proc)
                    _ev.set()

            def run_job(*, _out=out_path, _jid=job_id, _prof=profile, _cev=cancel_ev, _on_proc=on_proc, _errs=errors) -> None:
                job_store.mark_worker_started(_jid)
                try:
                    export_timeline_mp4(
                        [clip],
                        _out,
                        timeline_spec=spec,
                        export_profile=_prof,
                        encoding_mode="cpu",
                        cancel_event=_cev,
                        process_cb=_on_proc,
                    )
                except Exception as exc:  # noqa: BLE001
                    _errs.append(exc)
                finally:
                    job_store.mark_worker_finished(_jid)

            t = threading.Thread(target=run_job, daemon=True)
            t.start()
            self.assertTrue(proc_attached.wait(timeout=8.0), f"FFmpeg did not start for {profile}")
            # Fire repeated concurrent cancel calls to verify idempotency and coordinated cleanup
            for _ in range(3):
                snap = job_store.request_cancel(job_id)
                self.assertIsNotNone(snap)
                self.assertEqual(snap["status"], "cancelled")
            t.join(timeout=10.0)
            self.assertFalse(t.is_alive())
            self.assertTrue(any(isinstance(e, VideoProcessingCancelledError) for e in errors), errors)
            self.assertFalse(job_dir.exists(), f"{profile} job_dir must be deleted after worker finishes")
            for p in spawned_procs:
                self.assertIsNotNone(p.poll(), f"FFmpeg PID {p.pid} leaked after cancel for {profile}")

        # Mocked GPU encoding cancelled: must NOT fall back to CPU libx264
        gpu_cancel_out = self.test_root / "gpu_cancel_no_fallback.mp4"
        gpu_cancel_ev = threading.Event()
        call_encoders: list[str] = []

        def fake_select_encoder(_mode: str, _bin: str) -> tuple[str, bool]:
            return ("h264_nvenc", False)

        def fake_run_with_progress(cmd: Sequence[str], *_args: object, **_kwargs: object) -> None:
            cmd_str = " ".join(str(x) for x in cmd)
            if "h264_nvenc" in cmd_str:
                call_encoders.append("h264_nvenc")
                gpu_cancel_ev.set()
                raise VideoProcessingError("Simulated NVENC interrupted on cancel", status_code=500)
            call_encoders.append("libx264")
            raise AssertionError("CPU fallback must NOT execute when cancel_event is already set")

        with (
            mock.patch("app.services.ffmpeg_service._select_video_encoder", side_effect=fake_select_encoder),
            mock.patch("app.services.ffmpeg_service._run_ffmpeg_with_progress", side_effect=fake_run_with_progress),
        ):
            with self.assertRaises(VideoProcessingCancelledError):
                export_timeline_mp4(
                    [clip],
                    gpu_cancel_out,
                    timeline_spec=spec,
                    export_profile="fast_preview",
                    encoding_mode="gpu",
                    cancel_event=gpu_cancel_ev,
                )
        self.assertEqual(call_encoders, ["h264_nvenc"])

    def test_phase4_immediate_reexport_succeeds_after_cancellation(self) -> None:
        clip = self._make_clip("reexport_src.mp4", duration=2.5, size="640x360", with_audio=True)
        job_dir_1 = self.test_root / "job_cancel_first"
        job_dir_1.mkdir(parents=True, exist_ok=True)
        out_1 = job_dir_1 / "cancelled.mp4"
        job_id_1 = "cancel-then-reexport-1"
        job_store.create(job_id_1, "export_mp4")
        job_store.register_job_dir(job_id_1, job_dir_1)
        cancel_ev_1 = job_store.get_cancel_event(job_id_1)
        assert cancel_ev_1 is not None

        proc_started = threading.Event()
        errors: list[Exception] = []

        def on_proc_1(proc: subprocess.Popen[str] | None) -> None:
            job_store.attach_process(job_id_1, proc)
            if proc is not None:
                proc_started.set()

        spec_1 = {
            "format": "mp4",
            "project": {"aspectRatio": "16:9", "resolution": "1080p", "fps": 24},
            "tracks": [
                {"id": "track_v1", "name": "V1 Primary", "type": "video", "muted": False, "locked": False},
            ],
            "clips": [
                {
                    "id": "v1_c1",
                    "trackId": "track_v1",
                    "kind": "video",
                    "sourceName": "reexport_src.mp4",
                    "timelineStartSec": 0.0,
                    "timelineEndSec": 5.0,
                    "durationSec": 5.0,
                    "sourceInSec": 0.0,
                    "sourceOutSec": 2.5,
                    "speed": 0.5,
                    "volume": 1.0,
                    "opacity": 1.0,
                    "fileIndex": 0,
                }
            ],
        }

        def worker_1() -> None:
            job_store.mark_worker_started(job_id_1)
            try:
                export_timeline_mp4(
                    [clip],
                    out_1,
                    timeline_spec=spec_1,
                    export_profile="balanced",
                    encoding_mode="cpu",
                    cancel_event=cancel_ev_1,
                    process_cb=on_proc_1,
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                job_store.mark_worker_finished(job_id_1)

        t1 = threading.Thread(target=worker_1, daemon=True)
        t1.start()
        self.assertTrue(proc_started.wait(timeout=8.0))
        job_store.request_cancel(job_id_1)
        t1.join(timeout=10.0)
        self.assertTrue(any(isinstance(e, VideoProcessingCancelledError) for e in errors))
        self.assertFalse(job_dir_1.exists())

        # Immediately launch a brand new export and verify clean completion
        job_dir_2 = self.test_root / "job_reexport_second"
        job_dir_2.mkdir(parents=True, exist_ok=True)
        out_2 = job_dir_2 / "reexport_ok.mp4"
        job_id_2 = "cancel-then-reexport-2"
        job_store.create(job_id_2, "export_mp4")
        job_store.register_job_dir(job_id_2, job_dir_2)
        meta_2 = export_timeline_mp4(
            [clip],
            out_2,
            timeline_spec={
                **spec_1,
                "clips": [{**spec_1["clips"][0], "speed": 1.0, "durationSec": 2.5, "timelineEndSec": 2.5}],
            },
            export_profile="fast_preview",
            encoding_mode="cpu",
            cancel_event=job_store.get_cancel_event(job_id_2),
            process_cb=lambda p: job_store.attach_process(job_id_2, p),
        )
        self.assertTrue(out_2.exists())
        self.assertGreater(out_2.stat().st_size, 1000)
        self.assertAlmostEqual(meta_2["duration_seconds"], 2.5, delta=0.35)


if __name__ == "__main__":
    unittest.main()
