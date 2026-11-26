from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from app.config import ProcessorSettings, get_settings, validate_runtime_settings
from app.services.tts_providers.base import (
    TtsCancelledError,
    TtsError,
    normalize_tts_language,
    validate_tts_params,
    validate_tts_text,
)
from app.services.tts_providers.espeak_ng import (
    EspeakNgProvider,
    parse_espeak_voices_output,
)
from app.services.tts_providers.piper_tts import (
    PiperTtsProvider,
    discover_piper_models,
)
from app.services.tts_service import (
    get_tts_status,
    list_tts_voices,
    normalize_synthesized_audio,
    synthesize_tts_audio,
)

_HAS_FASTAPI = (
    importlib.util.find_spec("fastapi") is not None
    and importlib.util.find_spec("httpx") is not None
)

if _HAS_FASTAPI:
    from fastapi.testclient import TestClient
    from app.main import app


def _make_tts_settings(temp_dir: Path, **overrides) -> ProcessorSettings:
    base = {
        "app_env": "test",
        "host": "127.0.0.1",
        "port": 8001,
        "api_key": "test-processor-key-1234",
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
        "whisper_model_size": "tiny",
        "whisper_device": "cpu",
        "whisper_compute_type": "int8",
        "tts_enabled": True,
        "tts_provider": "auto",
        "tts_default_language": "en",
        "tts_max_text_chars": 1500,
        "tts_max_concurrent_jobs": 1,
        "tts_request_timeout_sec": 30,
        "tts_max_audio_mb": 25,
        "espeak_ng_path": "",
        "piper_executable_path": "",
        "piper_models_dir": "",
        "tts_windows_sapi_enabled": False,
    }
    base.update(overrides)
    return ProcessorSettings(**base)


class TtsUnitAndNormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="tts_test_"))

    def tearDown(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_config_validation_allows_missing_binaries_and_rejects_bad_bounds(self) -> None:
        s_ok = _make_tts_settings(self._tmpdir)
        self.assertEqual(validate_runtime_settings(s_ok), [])

        s_bad_provider = _make_tts_settings(self._tmpdir, tts_provider="paid_cloud")
        errs = validate_runtime_settings(s_bad_provider)
        self.assertTrue(any("TTS_PROVIDER" in e for e in errs))

        s_bad_chars = _make_tts_settings(self._tmpdir, tts_max_text_chars=10)
        errs2 = validate_runtime_settings(s_bad_chars)
        self.assertTrue(any("TTS_MAX_TEXT_CHARS" in e for e in errs2))

    def test_language_normalization_and_unicode_text_validation(self) -> None:
        self.assertEqual(normalize_tts_language("English"), "en")
        self.assertEqual(normalize_tts_language("en-US"), "en")
        self.assertEqual(normalize_tts_language("Hindi"), "hi")
        self.assertEqual(normalize_tts_language("hi-IN"), "hi")
        self.assertEqual(normalize_tts_language("Bengali"), "bn")
        self.assertEqual(normalize_tts_language("bn-BD"), "bn")

        with self.assertRaises(TtsError):
            normalize_tts_language("fr")

        hi_text = "नमस्ते! आज हम गहराई से काम करने की आदत सीखेंगे।"
        bn_text = "নমস্কার! আজ আমরা মনোযোগ বাড়ানোর উপায় শিখব।"
        self.assertEqual(validate_tts_text(hi_text, max_chars=200), hi_text)
        self.assertEqual(validate_tts_text(bn_text, max_chars=200), bn_text)

        with self.assertRaises(TtsError):
            validate_tts_text("   \n\t  ")
        with self.assertRaises(TtsError):
            validate_tts_text("bad\x00null")
        with self.assertRaises(TtsError):
            validate_tts_text("x" * 200, max_chars=150)

        rate, pitch, fmt = validate_tts_params(speaking_rate=1.25, pitch=-5, output_format="wav")
        self.assertEqual((rate, pitch, fmt), (1.25, -5.0, "wav"))
        with self.assertRaises(TtsError):
            validate_tts_params(speaking_rate=2.5)
        with self.assertRaises(TtsError):
            validate_tts_params(pitch=50.0)

    def test_espeak_voice_parsing_and_mocked_utf8_stdin_synthesis(self) -> None:
        sample_voices = """
Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  en-us          --/M      English_(America)  gmw/en-US            (en 2)
 5  hi             --/M      Hindi              inc/hi               (hi 1)
 5  bn             --/F      Bengali            inc/bn               (bn 1)
 5  fr             --/M      French             roa/fr
"""
        parsed = parse_espeak_voices_output(sample_voices)
        self.assertEqual([v.language for v in parsed], ["en", "hi", "bn"])
        self.assertEqual([v.voice_id for v in parsed], ["espeak:en-us", "espeak:hi", "espeak:bn"])

        provider = EspeakNgProvider(configured_path="espeak-ng")
        recorded_calls: list[dict] = []

        class FakeProc:
            def __init__(self, cmd, **kwargs):
                self.cmd = cmd
                self.pid = 4242
                self.returncode = 0
                self.stdin = mock.MagicMock()
                self.stdout = mock.MagicMock()
                self.stderr = mock.MagicMock()
                self.stderr.read.return_value = b""
                out_idx = cmd.index("-w") + 1
                out_path = Path(cmd[out_idx])
                out_path.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt ")
                recorded_calls.append({"cmd": cmd, "kwargs": kwargs, "stdin": self.stdin})

            def poll(self):
                return 0

        hi_only_voices = [v for v in parsed if v.language == "en"]  # purposely omit hi/bn

        with mock.patch(
            "app.services.tts_providers.espeak_ng.resolve_espeak_ng_binary",
            return_value="/usr/bin/espeak-ng",
        ):
            # 1) Language mismatch check: must NOT silently substitute English for Hindi
            with mock.patch.object(provider, "_query_voices", return_value=hi_only_voices):
                with self.assertRaises(TtsError) as ctx:
                    provider.synthesize(
                        text="नमस्ते दुनिया",
                        language="hi",
                        voice_id=None,
                        speaking_rate=1.0,
                        pitch=0.0,
                        output_wav_path=self._tmpdir / "hi_fail.wav",
                        timeout_sec=10,
                    )
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(ctx.exception.code, "unsupported_language")

            # 2) Valid Hindi UTF-8 synthesis with stdin & shell=False
            with mock.patch.object(provider, "_query_voices", return_value=parsed):
                with mock.patch(
                    "app.services.tts_providers.espeak_ng.subprocess.Popen",
                    side_effect=FakeProc,
                ):
                    voice = provider.synthesize(
                        text="नमस्ते भारत $(whoami)",
                        language="hi",
                        voice_id="espeak:hi",
                        speaking_rate=1.2,
                        pitch=5.0,
                        output_wav_path=self._tmpdir / "hi_ok.wav",
                        timeout_sec=10,
                    )
                    self.assertEqual(voice.language, "hi")
                    self.assertEqual(voice.voice_id, "espeak:hi")
                    self.assertEqual(len(recorded_calls), 1)
                    call_info = recorded_calls[0]
                    self.assertEqual(call_info["kwargs"].get("shell"), False)
                    self.assertIn("--stdin", call_info["cmd"])
                    written_bytes = call_info["stdin"].write.call_args[0][0]
                    self.assertEqual(written_bytes.decode("utf-8"), "नमस्ते भारत $(whoami)")

    def test_piper_model_discovery_and_path_traversal_protection(self) -> None:
        models_dir = self._tmpdir / "piper_models"
        models_dir.mkdir(parents=True, exist_ok=True)
        en_onnx = models_dir / "en_US-lessac-medium.onnx"
        en_onnx.write_bytes(b"fake-onnx")
        (models_dir / "en_US-lessac-medium.onnx.json").write_text(
            json.dumps(
                {
                    "language": {"code": "en_US"},
                    "audio": {"sample_rate": 22050, "quality": "medium"},
                    "dataset": "lessac",
                }
            ),
            encoding="utf-8",
        )
        hi_onnx = models_dir / "hi_IN-rohan-medium.onnx"
        hi_onnx.write_bytes(b"fake-onnx")
        (models_dir / "hi_IN-rohan-medium.onnx.json").write_text(
            json.dumps({"language": {"code": "hi_IN"}, "audio": {"sample_rate": 22050}}),
            encoding="utf-8",
        )
        # Unsupported French model should not appear in en/hi/bn list
        fr_onnx = models_dir / "fr_FR-siwis-medium.onnx"
        fr_onnx.write_bytes(b"fake-onnx")
        (models_dir / "fr_FR-siwis-medium.onnx.json").write_text(
            json.dumps({"language": {"code": "fr_FR"}, "audio": {"sample_rate": 22050}}),
            encoding="utf-8",
        )

        voices, path_map = discover_piper_models(str(models_dir))
        self.assertEqual(len(voices), 2)
        self.assertEqual({v.language for v in voices}, {"en", "hi"})
        self.assertNotIn("fr_FR-siwis-medium", " ".join(path_map.keys()))

        # Ensure TtsVoiceInfo never exposes raw filesystem path strings
        for v in voices:
            dumped = json.dumps(v.to_dict())
            self.assertNotIn(str(models_dir), dumped)

        provider = PiperTtsProvider(executable_path="piper", models_dir=str(models_dir))
        with mock.patch(
            "app.services.tts_providers.piper_tts.resolve_piper_binary",
            return_value="/usr/local/bin/piper",
        ):
            with self.assertRaises(TtsError) as ctx:
                provider.synthesize(
                    text="Hello world",
                    language="en",
                    voice_id="piper:../../etc/passwd",
                    speaking_rate=1.0,
                    pitch=0.0,
                    output_wav_path=self._tmpdir / "out.wav",
                    timeout_sec=10,
                )
            self.assertEqual(ctx.exception.code, "voice_not_found")

    def test_status_degrades_gracefully_without_binaries(self) -> None:
        settings = _make_tts_settings(self._tmpdir)
        with mock.patch("app.services.tts_providers.espeak_ng.resolve_espeak_ng_binary", return_value=None), mock.patch(
            "app.services.tts_providers.piper_tts.resolve_piper_binary", return_value=None
        ):
            status = get_tts_status(settings)
            self.assertEqual(status["enabled"], True)
            self.assertEqual(status["available"], False)
            self.assertEqual(status["supported_languages"], [])

        disabled_settings = _make_tts_settings(self._tmpdir, tts_enabled=False)
        disabled = get_tts_status(disabled_settings)
        self.assertEqual(disabled["enabled"], False)
        self.assertEqual(disabled["available"], False)

    @unittest.skipUnless(
        bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
        "ffmpeg/ffprobe required for real audio normalization verification",
    )
    def test_real_ffmpeg_normalization_and_corrupt_file_rejection(self) -> None:
        raw_wav = self._tmpdir / "sine_input.wav"
        norm_wav = self._tmpdir / "norm_output.wav"

        # Generate real 1.4s 440Hz stereo 44100Hz WAV via FFmpeg
        gen = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1.4:sample_rate=44100",
                "-ac",
                "2",
                str(raw_wav),
            ],
            capture_output=True,
            check=False,
        )
        self.assertEqual(gen.returncode, 0, gen.stderr.decode(errors="replace"))

        meta = normalize_synthesized_audio(
            raw_wav,
            norm_wav,
            output_format="wav",
            sample_rate_hz=22050,
            channels=1,
        )
        self.assertTrue(norm_wav.exists())
        self.assertAlmostEqual(meta["duration_seconds"], 1.4, delta=0.15)
        self.assertEqual(meta["sample_rate_hz"], 22050)
        self.assertEqual(meta["channels"], 1)
        self.assertEqual(meta["format"], "wav")
        self.assertGreater(meta["size_bytes"], 1000)

        # Reject corrupt garbage bytes
        corrupt = self._tmpdir / "corrupt.wav"
        corrupt.write_bytes(b"NOT_A_REAL_WAV_FILE_PAYLOAD")
        with self.assertRaises(TtsError):
            normalize_synthesized_audio(corrupt, self._tmpdir / "corrupt_out.wav")

        # Reject empty file
        empty_f = self._tmpdir / "empty.wav"
        empty_f.write_bytes(b"")
        with self.assertRaises(TtsError):
            normalize_synthesized_audio(empty_f, self._tmpdir / "empty_out.wav")

        # Reject oversized output
        with self.assertRaises(TtsError) as size_ctx:
            normalize_synthesized_audio(
                raw_wav,
                self._tmpdir / "too_big.wav",
                max_audio_bytes=128,
            )
        self.assertEqual(size_ctx.exception.status_code, 413)

    def test_cancellation_aborts_synthesis_cleanly(self) -> None:
        settings = _make_tts_settings(self._tmpdir)
        cancel_ev = threading.Event()
        cancel_ev.set()
        with self.assertRaises(TtsCancelledError):
            synthesize_tts_audio(
                settings,
                self._tmpdir,
                text="Should cancel immediately.",
                language="en",
                cancel_event=cancel_ev,
            )


@unittest.skipUnless(_HAS_FASTAPI, "fastapi not installed in sandbox Python")
class TtsFastApiRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="tts_api_"))

    def tearDown(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_tts_endpoints_auth_status_and_generate(self) -> None:
        test_settings = _make_tts_settings(self._tmpdir)
        app.dependency_overrides[get_settings] = lambda: test_settings
        try:
            client = TestClient(app)
            unauth = client.get("/api/v1/tts/status")
            self.assertEqual(unauth.status_code, 401)

            status_res = client.get(
                "/api/v1/tts/status",
                headers={"x-processor-key": "test-processor-key-1234"},
            )
            self.assertEqual(status_res.status_code, 200)
            payload = status_res.json()
            self.assertIn("enabled", payload)
            self.assertIn("providers", payload)

            voices_res = client.get(
                "/api/v1/tts/voices",
                headers={"x-processor-key": "test-processor-key-1234"},
            )
            self.assertEqual(voices_res.status_code, 200)
            self.assertIn("voices", voices_res.json())
        finally:
            app.dependency_overrides.clear()


if __name__ == "__main__":
    unittest.main()
