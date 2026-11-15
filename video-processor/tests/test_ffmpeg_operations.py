from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from app.config import get_settings
from app.services.ffmpeg_service import (
    VideoProcessingError,
    _resolve_ass_font_name,
    _write_ass_subtitles,
    export_mp4,
    export_timeline_mp4,
    generate_thumbnail,
    merge_video_clips,
    resize_crop_aspect_ratio,
    trim_video,
)
from app.services.ffprobe_service import check_binary, extract_video_metadata
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

        # Text overlay unsupported
        with self.assertRaises(VideoProcessingError) as ctx_text:
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
                            "id": "t1",
                            "trackId": "track_t1",
                            "kind": "text",
                            "sourceName": "Title",
                        },
                    ],
                },
            )
        self.assertEqual(ctx_text.exception.status_code, 400)

        # Speed != 1.0 unsupported
        with self.assertRaises(VideoProcessingError):
            export_timeline_mp4(
                [clip],
                out,
                timeline_spec={
                    "format": "mp4",
                    "project": {"aspectRatio": "16:9", "resolution": "720p", "fps": 30},
                    "tracks": [],
                    "clips": [{**base_clip, "speed": 1.5}],
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


if __name__ == "__main__":
    unittest.main()
