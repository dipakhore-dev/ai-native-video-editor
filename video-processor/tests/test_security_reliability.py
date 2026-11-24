from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.config import ProcessorSettings, get_settings, validate_runtime_settings
from app.services.ffmpeg_service import (
    _resolve_ass_font_name,
    inject_protocol_whitelist,
    trim_video,
)
from app.services.ffprobe_service import check_binary, extract_video_metadata
from app.services.job_store import InMemoryJobStore, sanitize_error_text
from app.utils.file_cleanup import (
    FileValidationError,
    cleanup_stale_job_dirs,
    detect_media_magic_kind,
    get_directory_size_bytes,
    resolve_within_base,
    validate_uploaded_file_magic,
)

_HAS_FASTAPI = importlib.util.find_spec("fastapi") is not None


def _make_settings(**overrides) -> ProcessorSettings:
    base = dict(
        app_env="development",
        host="127.0.0.1",
        port=8001,
        api_key="",
        ffmpeg_bin="ffmpeg",
        ffprobe_bin="ffprobe",
        temp_dir=Path(tempfile.gettempdir()) / "ai-studio-test-temp",
        max_upload_bytes=100 * 1024 * 1024,
        ffprobe_timeout_sec=30,
        ffmpeg_timeout_sec=120,
        max_short_video_sec=300.0,
        max_concurrent_exports=2,
        export_queue_wait_sec=0.1,
        max_temp_storage_mb=2048,
        temp_cleanup_max_age_sec=3600,
        whisper_model_size="small",
        whisper_device="cpu",
        whisper_compute_type="int8",
    )
    base.update(overrides)
    return ProcessorSettings(**base)


class SecurityReliabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = Path(tempfile.mkdtemp(prefix="vp_sec_test_"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_production_config_validation_fails_closed_without_strong_key(self) -> None:
        missing_key = _make_settings(app_env="production", api_key="")
        errs_missing = validate_runtime_settings(missing_key)
        self.assertTrue(any("VIDEO_PROCESSOR_API_KEY" in e for e in errs_missing))

        short_key = _make_settings(app_env="production", api_key="too-short")
        errs_short = validate_runtime_settings(short_key)
        self.assertTrue(any("VIDEO_PROCESSOR_API_KEY" in e for e in errs_short))

        placeholder_key = _make_settings(
            app_env="production", api_key="REPLACE_WITH_LONG_SECRET"
        )
        errs_placeholder = validate_runtime_settings(placeholder_key)
        self.assertTrue(any("VIDEO_PROCESSOR_API_KEY" in e for e in errs_placeholder))

        valid_prod = _make_settings(
            app_env="production", api_key="prod-secret-key-with-32-chars-minimum"
        )
        self.assertEqual(validate_runtime_settings(valid_prod), [])

        bad_port = _make_settings(port=70000)
        self.assertTrue(any("PORT" in e for e in validate_runtime_settings(bad_port)))

    def test_get_settings_bounds_concurrency_and_storage(self) -> None:
        prev = {
            k: os.environ.get(k)
            for k in ("MAX_CONCURRENT_EXPORTS", "MAX_TEMP_STORAGE_MB", "EXPORT_QUEUE_WAIT_SEC")
        }
        try:
            os.environ["MAX_CONCURRENT_EXPORTS"] = "999"
            os.environ["MAX_TEMP_STORAGE_MB"] = "4"
            os.environ["EXPORT_QUEUE_WAIT_SEC"] = "-5"
            s = get_settings()
            self.assertEqual(s.max_concurrent_exports, 16)
            self.assertEqual(s.max_temp_storage_mb, 64)
            self.assertEqual(s.export_queue_wait_sec, 0.0)
        finally:
            for k, v in prev.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_resolve_within_base_blocks_path_traversal(self) -> None:
        valid = resolve_within_base(self.tmp_dir, self.tmp_dir / "job_123" / "clip.mp4")
        self.assertTrue(str(valid).startswith(str(self.tmp_dir.resolve())))

        with self.assertRaises(FileValidationError) as ctx_rel:
            resolve_within_base(self.tmp_dir, self.tmp_dir / ".." / "etc" / "passwd")
        self.assertEqual(ctx_rel.exception.status_code, 400)

        with self.assertRaises(FileValidationError) as ctx_abs:
            resolve_within_base(self.tmp_dir, Path("/etc/passwd"))
        self.assertEqual(ctx_abs.exception.status_code, 400)

    def test_magic_byte_validation_accepts_media_and_rejects_spoofed_files(self) -> None:
        mp4_path = self.tmp_dir / "valid.mp4"
        mp4_path.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2avc1mp41")
        self.assertEqual(validate_uploaded_file_magic(mp4_path, original_filename="valid.mp4"), "video")

        png_path = self.tmp_dir / "logo.png"
        png_path.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
        self.assertEqual(
            validate_uploaded_file_magic(png_path, original_filename="logo.png", allow_images=True),
            "image",
        )
        with self.assertRaises(FileValidationError):
            validate_uploaded_file_magic(png_path, original_filename="logo.png", allow_images=False)

        wav_path = self.tmp_dir / "voice.wav"
        wav_path.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt ")
        self.assertEqual(
            validate_uploaded_file_magic(wav_path, original_filename="voice.wav", allow_audio=True),
            "audio",
        )
        with self.assertRaises(FileValidationError):
            validate_uploaded_file_magic(wav_path, original_filename="voice.mp4", allow_audio=False)

        spoof_exe = self.tmp_dir / "malware.mp4"
        spoof_exe.write_bytes(b"MZ\x90\x00#!/bin/sh\nrm -rf /\n")
        with self.assertRaises(FileValidationError) as ctx_spoof:
            validate_uploaded_file_magic(spoof_exe, original_filename="malware.mp4")
        self.assertEqual(ctx_spoof.exception.status_code, 400)

        self.assertIsNone(detect_media_magic_kind(b"\x7fELF\x02\x01\x01\x00", "evil.mp4"))

    def test_ass_font_family_injection_sanitized(self) -> None:
        font = _resolve_ass_font_name(
            [{"text": "Hello"}],
            {"fontFamily": "Arial,20,&H00FFFFFF\nDialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,pwn"},
        )
        self.assertNotIn("\n", font)
        self.assertNotIn(",", font)
        self.assertNotIn(":", font)
        self.assertLessEqual(len(font), 64)
        self.assertRegex(font, r"^[A-Za-z0-9 _-]+$")

    def test_protocol_whitelist_injection_and_real_ffmpeg_trim(self) -> None:
        cmd = ["ffmpeg", "-y", "-i", "input.mp4", "-t", "1", "output.mp4"]
        safe = inject_protocol_whitelist(cmd)
        idx = safe.index("-i")
        self.assertEqual(safe[idx - 2 : idx], ["-protocol_whitelist", "file,pipe"])
        # Calling a second time must not duplicate flags
        self.assertEqual(inject_protocol_whitelist(safe).count("-protocol_whitelist"), 1)

        ffmpeg_bin = check_binary("ffmpeg")
        ffprobe_bin = check_binary("ffprobe")
        if not ffmpeg_bin or not ffprobe_bin:
            self.skipTest("ffmpeg/ffprobe not installed")

        sample_in = self.tmp_dir / "sample_in.mp4"
        sample_out = self.tmp_dir / "sample_out.mp4"
        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:d=2:r=24",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=stereo:d=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(sample_in),
            ],
            check=True,
            capture_output=True,
        )

        meta = extract_video_metadata(sample_in, ffprobe_bin=ffprobe_bin)
        self.assertTrue(meta["has_video"])
        trim_video(
            sample_in,
            sample_out,
            start_sec=0.2,
            end_sec=1.2,
            ffmpeg_bin=ffmpeg_bin,
        )
        self.assertTrue(sample_out.exists() and sample_out.stat().st_size > 0)

    def test_sanitize_error_text_redacts_urls_and_paths(self) -> None:
        raw = "FFmpeg failed at http://127.0.0.1:8001/export reading /tmp/ai-studio/job_abc/in.mp4 and C:\\Users\\dev\\clip.mp4"
        cleaned = sanitize_error_text(raw)
        self.assertNotIn("127.0.0.1", cleaned)
        self.assertNotIn("/tmp/ai-studio", cleaned)
        self.assertNotIn("C:\\Users\\dev", cleaned)
        self.assertIn("[service-endpoint]", cleaned)
        self.assertIn("[server-path]", cleaned)

    def test_stale_job_dir_cleanup_skips_active_jobs_and_tracks_bytes(self) -> None:
        active_dir = self.tmp_dir / "job_active_1"
        stale_dir = self.tmp_dir / "job_stale_1"
        active_dir.mkdir(parents=True)
        stale_dir.mkdir(parents=True)
        (active_dir / "clip.bin").write_bytes(b"a" * 2048)
        (stale_dir / "old.bin").write_bytes(b"b" * 4096)

        old_ts = time.time() - 7200
        os.utime(active_dir, (old_ts, old_ts))
        os.utime(stale_dir, (old_ts, old_ts))

        self.assertEqual(get_directory_size_bytes(self.tmp_dir), 6144)
        removed = cleanup_stale_job_dirs(
            self.tmp_dir,
            max_age_sec=3600,
            active_job_ids={"active_1"},
        )
        self.assertEqual(removed, 1)
        self.assertTrue(active_dir.exists())
        self.assertFalse(stale_dir.exists())
        self.assertEqual(get_directory_size_bytes(self.tmp_dir), 2048)

    def test_job_store_terminate_all_active_kills_running_subprocess(self) -> None:
        store = InMemoryJobStore()
        store.create("shut_job_1", "export_mp4", stage="encoding", stage_label="Encoding")
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=(os.name != "nt"),
        )
        try:
            store.attach_process("shut_job_1", proc)
            self.assertIn("shut_job_1", store.list_active_job_ids())
            count = store.terminate_all_active("Shutting down cleanly.")
            self.assertEqual(count, 1)
            self.assertEqual(store.list_active_job_ids(), set())
            snap = store.get("shut_job_1")
            self.assertIsNotNone(snap)
            self.assertEqual(snap["status"], "cancelled")
            self.assertIsNotNone(proc.poll())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)

    @unittest.skipUnless(_HAS_FASTAPI, "fastapi not installed in sandbox Python")
    def test_fastapi_auth_key_concurrency_and_quota_guards(self) -> None:
        from app.main import (
            acquire_export_slot,
            assert_processor_key_matches,
            check_temp_storage_quota,
        )
        from app.services.ffmpeg_service import VideoProcessingError

        prod = _make_settings(app_env="production", api_key="super-secret-processor-key-123")
        self.assertTrue(assert_processor_key_matches("super-secret-processor-key-123", prod))
        self.assertFalse(assert_processor_key_matches("wrong-key", prod))
        self.assertFalse(assert_processor_key_matches(None, prod))

        busy_settings = _make_settings(max_concurrent_exports=1, export_queue_wait_sec=0.05)
        sem = acquire_export_slot(busy_settings)
        try:
            with self.assertRaises(VideoProcessingError) as ctx_busy:
                acquire_export_slot(busy_settings)
            self.assertEqual(ctx_busy.exception.status_code, 429)
        finally:
            sem.release()

        # Slot released cleanly so a new acquisition succeeds
        sem2 = acquire_export_slot(busy_settings)
        sem2.release()

        full_dir = self.tmp_dir / "quota_dir"
        full_dir.mkdir(parents=True)
        (full_dir / "big.bin").write_bytes(b"0" * (2 * 1024 * 1024))
        quota_settings = _make_settings(temp_dir=full_dir, max_temp_storage_mb=1)
        with self.assertRaises(VideoProcessingError) as ctx_quota:
            check_temp_storage_quota(quota_settings)
        self.assertEqual(ctx_quota.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
