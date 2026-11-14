from __future__ import annotations

import os
import re
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator


ALLOWED_VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
    ".avi",
    ".m4v",
    ".mpeg",
    ".mpg",
    ".ogv",
}

ALLOWED_VIDEO_MIME_PREFIXES = ("video/",)
ALLOWED_EXACT_MIMES = {"application/octet-stream", "application/mp4"}


class FileValidationError(ValueError):
    """Raised when an uploaded file fails extension, MIME, or size validation."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def sanitize_filename(filename: str | None) -> str:
    raw = os.path.basename((filename or "upload.mp4").strip())
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", raw)
    return cleaned[:180] or "upload.mp4"


def validate_upload_headers(filename: str | None, content_type: str | None) -> str:
    safe_name = sanitize_filename(filename)
    ext = Path(safe_name).suffix.lower()
    if ext and ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise FileValidationError(
            f"Unsupported video file extension '{ext}'. Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}.",
            status_code=400,
        )

    if content_type:
        mime = content_type.split(";")[0].strip().lower()
        is_allowed = mime in ALLOWED_EXACT_MIMES or any(
            mime.startswith(prefix) for prefix in ALLOWED_VIDEO_MIME_PREFIXES
        )
        if not is_allowed:
            raise FileValidationError(
                f"Unsupported MIME type '{mime}'. Expected a video/* upload.",
                status_code=400,
            )

    return safe_name


def write_stream_with_limit(
    source: BinaryIO,
    dest_path: Path,
    max_bytes: int,
    chunk_size: int = 1024 * 1024,
) -> int:
    total = 0
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_path, "wb") as out:
        while True:
            chunk = source.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise FileValidationError(
                    f"Uploaded video exceeds maximum allowed size ({max_bytes // (1024 * 1024)} MB).",
                    status_code=413,
                )
            out.write(chunk)

    if total == 0:
        raise FileValidationError("Uploaded video file is empty.", status_code=400)

    return total


def cleanup_path(target: Path) -> None:
    try:
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink(missing_ok=True)
    except OSError:
        pass


@contextmanager
def managed_job_temp_dir(base_dir: Path, job_id: str) -> Iterator[Path]:
    job_dir = base_dir / f"job_{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        yield job_dir
    finally:
        cleanup_path(job_dir)
