from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from app.services.ffprobe_service import VideoMetadataError, check_binary, extract_video_metadata
from app.services.job_store import InMemoryJobStore
from app.utils.file_cleanup import (
    FileValidationError,
    managed_job_temp_dir,
    validate_upload_headers,
    write_stream_with_limit,
)


class TestFfprobeMetadataExtraction(unittest.TestCase):
    def setUp(self) -> None:
        self.test_root = Path(tempfile.mkdtemp(prefix="ai_studio_vp_test_"))

    def tearDown(self) -> None:
        shutil.rmtree(self.test_root, ignore_errors=True)

    def _create_sample_mp4(self, filename: str = "sample_16x9.mp4", size: str = "640x360") -> Path:
        ffmpeg_path = check_binary("ffmpeg")
        if not ffmpeg_path:
            self.skipTest("ffmpeg binary is not installed in this environment")

        out_path = self.test_root / filename
        proc = subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc=duration=1.5:size={size}:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1.5",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(out_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"ffmpeg failed: {proc.stderr}")
        return out_path

    def test_extracts_metadata_from_valid_mp4(self) -> None:
        sample = self._create_sample_mp4()
        meta = extract_video_metadata(sample, original_filename="clip.mp4")

        self.assertEqual(meta["filename"], "clip.mp4")
        self.assertTrue(meta["has_video"])
        self.assertTrue(meta["has_audio"])
        self.assertEqual(meta["aspect_ratio_label"], "16:9")
        self.assertGreaterEqual(meta["duration_seconds"], 1.3)
        self.assertGreater(meta["size_bytes"], 0)
        self.assertEqual(meta["video"]["width"], 640)
        self.assertEqual(meta["video"]["height"], 360)
        self.assertAlmostEqual(meta["video"]["fps"], 24.0, delta=0.5)
        self.assertEqual(meta["video"]["codec_name"], "h264")
        self.assertEqual(meta["audio"]["codec_name"], "aac")
        self.assertEqual(meta["audio"]["channels"], 1)

    def test_rejects_corrupt_or_non_video_file(self) -> None:
        bad_file = self.test_root / "corrupt.mp4"
        bad_file.write_bytes(b"not a real mp4 file payload")

        with self.assertRaises(VideoMetadataError) as ctx:
            extract_video_metadata(bad_file)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_rejects_missing_or_empty_file(self) -> None:
        missing = self.test_root / "does_not_exist.mp4"
        with self.assertRaises(VideoMetadataError) as ctx_missing:
            extract_video_metadata(missing)
        self.assertEqual(ctx_missing.exception.status_code, 400)

        empty = self.test_root / "empty.mp4"
        empty.write_bytes(b"")
        with self.assertRaises(VideoMetadataError) as ctx_empty:
            extract_video_metadata(empty)
        self.assertEqual(ctx_empty.exception.status_code, 400)

    def test_upload_validation_and_temp_cleanup(self) -> None:
        with self.assertRaises(FileValidationError):
            validate_upload_headers("malware.exe", "application/x-msdownload")

        safe_name = validate_upload_headers("my clip (1).mp4", "video/mp4")
        self.assertEqual(safe_name, "my_clip__1_.mp4")

        captured_dir: Path | None = None
        with managed_job_temp_dir(self.test_root, "cleanup_1") as temp_dir:
            captured_dir = temp_dir
            dest = temp_dir / safe_name
            written = write_stream_with_limit(BytesIO(b"123456"), dest, max_bytes=1024)
            self.assertEqual(written, 6)
            self.assertTrue(dest.exists())

        assert captured_dir is not None
        self.assertFalse(captured_dir.exists())

    def test_job_store_lifecycle(self) -> None:
        store = InMemoryJobStore()
        created = store.create("job-1", "metadata_extraction")
        self.assertEqual(created["status"], "queued")
        updated = store.update("job-1", status="completed", progress=100, result={"ok": True})
        assert updated is not None
        self.assertEqual(updated["status"], "completed")
        self.assertEqual(updated["progress"], 100)


if __name__ == "__main__":
    unittest.main()
