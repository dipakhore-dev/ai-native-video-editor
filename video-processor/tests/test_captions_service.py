from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.config import ProcessorSettings, get_settings, validate_runtime_settings
from app.services.ffprobe_service import VideoMetadataError, check_binary
from app.services.whisper_service import (
    CaptionsCancelledError,
    SubtitleGenerationError,
    _cached_models,
    _get_caption_semaphore,
    _sanitize_cue_text,
    check_whisper_local_model_ready,
    extract_mono_wav_for_whisper,
    format_srt,
    format_vtt,
    get_captions_runtime_status,
    resolve_multilingual_model_size,
    transcribe_audio_captions,
    validate_subtitle_language,
)

_HAS_FASTAPI = (
    importlib.util.find_spec("fastapi") is not None
    and importlib.util.find_spec("httpx") is not None
)

if _HAS_FASTAPI:
    from fastapi.testclient import TestClient
    from app.main import app


def _make_captions_settings(temp_dir: Path, **overrides) -> ProcessorSettings:
    base = {
        "app_env": "test",
        "host": "127.0.0.1",
        "port": 8001,
        "api_key": "test-processor-key-captions-1234",
        "ffmpeg_bin": "ffmpeg",
        "ffprobe_bin": "ffprobe",
        "temp_dir": temp_dir,
        "max_upload_bytes": 25 * 1024 * 1024,
        "ffprobe_timeout_sec": 15,
        "ffmpeg_timeout_sec": 30,
        "max_short_video_sec": 180.0,
        "max_concurrent_exports": 1,
        "export_queue_wait_sec": 1.0,
        "max_temp_storage_mb": 512,
        "temp_cleanup_max_age_sec": 3600,
        "whisper_model_size": "small",
        "whisper_device": "cpu",
        "whisper_compute_type": "int8",
        "whisper_local_files_only": True,
        "captions_max_audio_mb": 20,
        "captions_max_duration_sec": 90.0,
        "captions_max_concurrent_jobs": 1,
        "captions_request_timeout_sec": 120,
        "captions_max_segments_per_scene": 100,
    }
    base.update(overrides)
    return ProcessorSettings(**base)


class CaptionsConfigAndMultilingualTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="cap_cfg_"))

    def tearDown(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_caption_settings_bounds_and_validation(self) -> None:
        valid = _make_captions_settings(self._tmpdir)
        self.assertEqual(validate_runtime_settings(valid), [])
        self.assertEqual(valid.whisper_local_files_only, True)

        bad_conc = _make_captions_settings(self._tmpdir, captions_max_concurrent_jobs=4)
        self.assertTrue(
            any("CAPTIONS_MAX_CONCURRENT_JOBS" in e for e in validate_runtime_settings(bad_conc))
        )

        bad_mb = _make_captions_settings(self._tmpdir, captions_max_audio_mb=500)
        self.assertTrue(
            any("CAPTIONS_MAX_AUDIO_MB" in e for e in validate_runtime_settings(bad_mb))
        )

    def test_multilingual_model_never_uses_english_only_for_hi_or_bn(self) -> None:
        self.assertEqual(resolve_multilingual_model_size("small.en", "hi"), "small")
        self.assertEqual(resolve_multilingual_model_size("base.en", "bn"), "base")
        self.assertEqual(resolve_multilingual_model_size("tiny.en", None), "tiny")
        self.assertEqual(resolve_multilingual_model_size("distil-small.en", "hi"), "small")
        self.assertEqual(resolve_multilingual_model_size("small", "bn"), "small")

    def test_language_validation_supports_en_hi_bn_and_rejects_unknown(self) -> None:
        self.assertEqual(validate_subtitle_language("English"), "en")
        self.assertEqual(validate_subtitle_language("Hindi"), "hi")
        self.assertEqual(validate_subtitle_language("Bengali"), "bn")
        self.assertEqual(validate_subtitle_language("hi"), "hi")
        self.assertEqual(validate_subtitle_language("bn"), "bn")
        self.assertIsNone(validate_subtitle_language("auto"))
        self.assertIsNone(validate_subtitle_language(""))

        with self.assertRaises(SubtitleGenerationError) as ctx:
            validate_subtitle_language("zz_unknown")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_runtime_status_honestly_reflects_offline_cache_state(self) -> None:
        with mock.patch("app.services.whisper_service.is_faster_whisper_available", return_value=False):
            st_missing = get_captions_runtime_status(model_size="small", local_files_only=True)
            self.assertTrue(st_missing["script_mode_available"])
            self.assertFalse(st_missing["faster_whisper_installed"])
            self.assertFalse(st_missing["audio_transcription_available"])
            self.assertEqual(st_missing["supported_languages"], ["en", "hi", "bn"])

        with mock.patch(
            "app.services.whisper_service.check_whisper_local_model_ready",
            return_value={
                "installed": True,
                "model": "small",
                "in_memory": False,
                "local_model_cached": False,
                "ready": False,
                "detail": "Not cached",
            },
        ):
            st_uncached = get_captions_runtime_status(model_size="small", local_files_only=True)
            self.assertTrue(st_uncached["script_mode_available"])
            self.assertTrue(st_uncached["faster_whisper_installed"])
            self.assertFalse(st_uncached["local_model_ready"])
            self.assertFalse(st_uncached["audio_transcription_available"])

        with mock.patch(
            "app.services.whisper_service.check_whisper_local_model_ready",
            return_value={
                "installed": True,
                "model": "small",
                "in_memory": True,
                "local_model_cached": True,
                "ready": True,
                "detail": "Ready",
            },
        ):
            st_ready = get_captions_runtime_status(model_size="small", local_files_only=True)
            self.assertTrue(st_ready["audio_transcription_available"])
            self.assertTrue(st_ready["local_model_ready"])

    def test_local_model_dir_detection_and_srt_vtt_sanitization(self) -> None:
        fake_model_dir = self._tmpdir / "local_whisper_small"
        fake_model_dir.mkdir(parents=True)
        (fake_model_dir / "model.bin").write_bytes(b"ctranslate2-weights")

        with mock.patch("app.services.whisper_service.is_faster_whisper_available", return_value=True):
            probe = check_whisper_local_model_ready(str(fake_model_dir), "cpu", "int8")
            self.assertTrue(probe["installed"])
            self.assertTrue(probe["local_model_cached"])
            self.assertTrue(probe["ready"])

        clean = _sanitize_cue_text("WEBVTT\r\nनमस्ते --> दुनिया\x00!")
        self.assertNotIn("-->", clean)
        self.assertIn("->", clean)
        self.assertIn("नमस्ते", clean)

        segments = [
            {"id": 1, "start": 0.0, "end": 1.25, "text": "নমস্কার বন্ধুরা --> স্বাগতম"},
            {"id": 2, "start": 1.5, "end": 3.0, "text": "नमस्ते दोस्तों।"},
        ]
        srt = format_srt(segments)
        vtt = format_vtt(segments)
        self.assertIn("00:00:00,000 --> 00:00:01,250", srt)
        self.assertIn("নমস্কার বন্ধুরা -> স্বাগতম", srt)
        self.assertTrue(vtt.startswith("WEBVTT\n\n"))
        self.assertIn("00:00:01.500 --> 00:00:03.000", vtt)


class AudioExtractionAndMockWhisperTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="cap_audio_"))
        _cached_models.clear()

    def tearDown(self) -> None:
        _cached_models.clear()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    @unittest.skipUnless(
        bool(check_binary("ffmpeg") and check_binary("ffprobe")),
        "ffmpeg/ffprobe required for audio extraction tests",
    )
    def test_extract_mono_wav_reuses_16k_mono_and_resamples_stereo(self) -> None:
        mono_16k = self._tmpdir / "voice_16k.wav"
        stereo_44k = self._tmpdir / "voice_44k_stereo.wav"
        silent_mp4 = self._tmpdir / "silent_video.mp4"

        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1.2:sample_rate=16000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                str(mono_16k),
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=520:duration=1.2:sample_rate=44100",
                "-ac",
                "2",
                str(stereo_44k),
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x90:d=1",
                "-an",
                str(silent_mp4),
            ],
            check=True,
            capture_output=True,
        )

        # Fast copy reuse path when input is already 16kHz mono PCM WAV
        copied_wav = self._tmpdir / "reused_16k.wav"
        with mock.patch("app.services.whisper_service.subprocess.run", wraps=subprocess.run) as run_spy:
            meta = extract_mono_wav_for_whisper(
                mono_16k,
                copied_wav,
                max_duration_sec=30.0,
                allow_audio_only=True,
            )
            invoked_bins = [Path(c.args[0][0]).name for c in run_spy.call_args_list]
            self.assertFalse(any("ffmpeg" in b for b in invoked_bins))
            self.assertTrue(copied_wav.exists())
            self.assertGreater(meta["duration_seconds"], 1.0)

        # Resample path for 44.1kHz stereo WAV
        resampled_wav = self._tmpdir / "resampled_16k.wav"
        meta_stereo = extract_mono_wav_for_whisper(
            stereo_44k,
            resampled_wav,
            max_duration_sec=30.0,
            allow_audio_only=True,
        )
        self.assertTrue(resampled_wav.exists() and resampled_wav.stat().st_size > 1000)
        self.assertAlmostEqual(meta_stereo["duration_seconds"], 1.2, delta=0.15)

        # Duration limit exceeded rejects with 400
        with self.assertRaises(SubtitleGenerationError) as dur_ctx:
            extract_mono_wav_for_whisper(
                mono_16k,
                self._tmpdir / "too_long.wav",
                max_duration_sec=0.5,
                allow_audio_only=True,
            )
        self.assertEqual(dur_ctx.exception.status_code, 400)

        # File without audio track fails cleanly
        with self.assertRaises((VideoMetadataError, SubtitleGenerationError)):
            extract_mono_wav_for_whisper(
                silent_mp4,
                self._tmpdir / "no_audio.wav",
                max_duration_sec=30.0,
                allow_audio_only=True,
            )

    @unittest.skipUnless(
        bool(check_binary("ffmpeg") and check_binary("ffprobe")),
        "ffmpeg/ffprobe required for transcription tests",
    )
    def test_mocked_whisper_transcription_hindi_bengali_word_timestamps_and_cancel(self) -> None:
        wav_path = self._tmpdir / "scene_audio.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=2.0:sample_rate=16000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                str(wav_path),
            ],
            check=True,
            capture_output=True,
        )

        class FakeWhisperModel:
            def transcribe(self, path, **kwargs):
                lang = kwargs.get("language") or "hi"
                if lang == "bn":
                    segs = [
                        SimpleNamespace(
                            start=0.0,
                            end=1.8,
                            text="নমস্কার বন্ধুরা, স্বাগতম।",
                            words=[
                                SimpleNamespace(word="নমস্কার", start=0.0, end=0.8),
                                SimpleNamespace(word="বন্ধুরা", start=0.8, end=1.8),
                            ],
                        )
                    ]
                else:
                    segs = [
                        SimpleNamespace(
                            start=0.0,
                            end=1.9,
                            text="नमस्ते दोस्तों, आज हम शुरू करते हैं।",
                            words=[
                                SimpleNamespace(word="नमस्ते", start=0.0, end=0.7),
                                SimpleNamespace(word="दोस्तों", start=0.7, end=1.9),
                            ],
                        )
                    ]
                info = SimpleNamespace(language=lang, language_probability=0.96)
                return iter(segs), info

        fake_module = SimpleNamespace(WhisperModel=lambda *a, **k: FakeWhisperModel())

        with mock.patch("app.services.whisper_service.is_faster_whisper_available", return_value=True), mock.patch.dict(
            sys.modules, {"faster_whisper": fake_module}
        ):
            # 1) Hindi transcription using small.en requested -> automatically upgraded to multilingual 'small'
            hi_res = transcribe_audio_captions(
                wav_path,
                self._tmpdir / "work_hi",
                language="hi",
                model_size="small.en",
                local_files_only=True,
                word_timestamps=True,
            )
            self.assertEqual(hi_res["model"], "faster-whisper-small")
            self.assertEqual(hi_res["language"], "hi")
            self.assertTrue(hi_res["word_timestamps_included"])
            self.assertEqual(len(hi_res["segments"]), 1)
            self.assertIn("नमस्ते दोस्तों", hi_res["segments"][0]["text"])
            self.assertEqual(len(hi_res["segments"][0]["words"]), 2)

            # 2) Bengali transcription from cached fake model
            bn_res = transcribe_audio_captions(
                wav_path,
                self._tmpdir / "work_bn",
                language="bn",
                model_size="small",
                local_files_only=True,
                word_timestamps=False,
            )
            self.assertEqual(bn_res["language"], "bn")
            self.assertFalse(bn_res["word_timestamps_included"])
            self.assertIn("নমস্কার বন্ধুরা", bn_res["srt"])

            # 3) Cooperative cancellation raises CaptionsCancelledError (499)
            cancel_ev = threading.Event()
            cancel_ev.set()
            with self.assertRaises(CaptionsCancelledError) as cancel_ctx:
                transcribe_audio_captions(
                    wav_path,
                    self._tmpdir / "work_cancel",
                    language="en",
                    cancel_event=cancel_ev,
                )
            self.assertEqual(cancel_ctx.exception.status_code, 499)

            # 4) Concurrency slot guard returns 429 when busy
            sem = _get_caption_semaphore(1)
            sem.acquire()
            try:
                with self.assertRaises(SubtitleGenerationError) as busy_ctx:
                    transcribe_audio_captions(
                        wav_path,
                        self._tmpdir / "work_busy",
                        language="en",
                        max_concurrent_jobs=1,
                    )
                self.assertEqual(busy_ctx.exception.status_code, 429)
            finally:
                sem.release()


@unittest.skipUnless(_HAS_FASTAPI, "fastapi not installed in sandbox Python")
class CaptionsFastApiRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="cap_api_"))

    def tearDown(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_captions_routes_auth_status_cancel_and_reject_video(self) -> None:
        test_settings = _make_captions_settings(self._tmpdir)
        app.dependency_overrides[get_settings] = lambda: test_settings
        try:
            client = TestClient(app)
            unauth = client.get("/api/v1/captions/status")
            self.assertEqual(unauth.status_code, 401)

            status_res = client.get(
                "/api/v1/captions/status",
                headers={"x-processor-key": "test-processor-key-captions-1234"},
            )
            self.assertEqual(status_res.status_code, 200)
            payload = status_res.json()
            self.assertTrue(payload["script_mode_available"])
            self.assertIn("audio_transcription_available", payload)

            bad_upload = client.post(
                "/api/v1/captions/generate",
                headers={"x-processor-key": "test-processor-key-captions-1234"},
                files={"file": ("clip.mp4", b"\x00\x00\x00\x18ftypisom", "video/mp4")},
            )
            self.assertEqual(bad_upload.status_code, 400)

            cancel_res = client.post(
                "/api/v1/captions/jobs/cap_pre_cancel_123/cancel?allow_precreate=true",
                headers={"x-processor-key": "test-processor-key-captions-1234"},
            )
            self.assertEqual(cancel_res.status_code, 200)
            self.assertEqual(cancel_res.json()["status"], "cancelled")
        finally:
            app.dependency_overrides.clear()


if __name__ == "__main__":
    unittest.main()
