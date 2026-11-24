from __future__ import annotations

import os
import re
import shutil
import time
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

ALLOWED_AUDIO_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".flac",
}

ALLOWED_IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
}

ALLOWED_VIDEO_MIME_PREFIXES = ("video/",)
ALLOWED_AUDIO_MIME_PREFIXES = ("audio/",)
ALLOWED_IMAGE_MIME_PREFIXES = ("image/",)
ALLOWED_EXACT_MIMES = {"application/octet-stream", "application/mp4"}


class FileValidationError(ValueError):
    """Raised when an uploaded file fails extension, MIME, signature, path, or size validation."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def sanitize_filename(filename: str | None) -> str:
    raw = os.path.basename((filename or "upload.mp4").strip())
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", raw).lstrip(".")
    return cleaned[:180] or "upload.mp4"


def resolve_within_base(base_dir: Path, target_path: Path) -> Path:
    resolved_base = base_dir.resolve()
    resolved_target = target_path.resolve()
    if resolved_target == resolved_base or not resolved_target.is_relative_to(resolved_base):
        raise FileValidationError("Invalid file path outside workspace boundary.", status_code=400)
    return resolved_target


def detect_media_magic_kind(header: bytes, filename: str | None = None) -> str | None:
    if len(header) < 4:
        return None
    ext = Path(filename or "").suffix.lower()

    # Images
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image"
    if header.startswith(b"\xff\xd8\xff"):
        return "image"
    if header.startswith(b"GIF87a") or header.startswith(b"GIF89a"):
        return "image"
    if header.startswith(b"RIFF") and len(header) >= 12:
        subtype = header[8:12]
        if subtype == b"WEBP":
            return "image"
        if subtype == b"WAVE":
            return "audio"
        if subtype == b"AVI ":
            return "video"

    # ISO BMFF (MP4 / MOV / M4V / M4A)
    if len(header) >= 8 and header[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free"):
        major = header[8:12].decode("ascii", errors="ignore").lower() if len(header) >= 12 else ""
        if major.startswith("m4a") or ext == ".m4a":
            return "audio"
        return "video"

    # Matroska / WebM
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "video"

    # MPEG-PS / MPEG-TS
    if header.startswith(b"\x00\x00\x01\xba") or header.startswith(b"\x00\x00\x01\xb3"):
        return "video"
    if header[0] == 0x47 and (len(header) < 189 or header[188] == 0x47):
        return "video"

    # Ogg / Ogv
    if header.startswith(b"OggS"):
        return "video" if ext == ".ogv" else "audio"

    # FLAC
    if header.startswith(b"fLaC"):
        return "audio"

    # MP3 (ID3 or MPEG frame sync)
    if header.startswith(b"ID3") or (
        header[0] == 0xFF and (header[1] & 0xE0) == 0xE0 and (header[1] & 0x06) != 0
    ):
        return "audio"

    return None


def validate_uploaded_file_magic(
    file_path: Path,
    *,
    original_filename: str | None = None,
    allow_audio: bool = False,
    allow_images: bool = False,
) -> str:
    try:
        with open(file_path, "rb") as fh:
            header = fh.read(256)
    except OSError as exc:
        raise FileValidationError("Uploaded media file could not be read.", status_code=400) from exc

    detected = detect_media_magic_kind(header, original_filename or file_path.name)
    if detected is None:
        safe_label = sanitize_filename(original_filename or file_path.name)
        raise FileValidationError(
            f"File header for '{safe_label}' does not match a supported media container.",
            status_code=400,
        )
    if detected == "audio" and not allow_audio:
        raise FileValidationError("Audio-only uploads are not permitted on this endpoint.", status_code=400)
    if detected == "image" and not allow_images:
        raise FileValidationError("Image uploads are not permitted on this endpoint.", status_code=400)
    return detected


def validate_upload_headers(
    filename: str | None,
    content_type: str | None,
    *,
    allow_audio: bool = False,
    allow_images: bool = False,
) -> str:
    safe_name = sanitize_filename(filename)
    ext = Path(safe_name).suffix.lower()
    allowed_exts = set(ALLOWED_VIDEO_EXTENSIONS)
    if allow_audio:
        allowed_exts |= ALLOWED_AUDIO_EXTENSIONS
    if allow_images:
        allowed_exts |= ALLOWED_IMAGE_EXTENSIONS

    if ext and ext not in allowed_exts:
        raise FileValidationError(
            f"Unsupported media file extension '{ext}'. Allowed: {', '.join(sorted(allowed_exts))}.",
            status_code=400,
        )

    if content_type:
        mime = content_type.split(";")[0].strip().lower()
        allowed_prefixes: tuple[str, ...] = ALLOWED_VIDEO_MIME_PREFIXES
        if allow_audio:
            allowed_prefixes = allowed_prefixes + ALLOWED_AUDIO_MIME_PREFIXES
        if allow_images:
            allowed_prefixes = allowed_prefixes + ALLOWED_IMAGE_MIME_PREFIXES

        allowed_exact = (
            ALLOWED_EXACT_MIMES | {"application/x-m4a"}
            if allow_audio
            else ALLOWED_EXACT_MIMES
        )
        is_allowed = mime in allowed_exact or any(
            mime.startswith(prefix) for prefix in allowed_prefixes
        )
        if not is_allowed:
            expected_parts = ["video/*"]
            if allow_audio:
                expected_parts.append("audio/*")
            if allow_images:
                expected_parts.append("image/*")
            expected_label = " or ".join(expected_parts)
            raise FileValidationError(
                f"Unsupported MIME type '{mime}'. Expected a {expected_label} upload.",
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


def get_directory_size_bytes(base_dir: Path) -> int:
    if not base_dir.exists():
        return 0
    total = 0
    for root, _dirs, files in os.walk(base_dir):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


def cleanup_stale_job_dirs(
    base_dir: Path,
    max_age_sec: int,
    active_job_ids: set[str] | None = None,
) -> int:
    if not base_dir.exists():
        return 0
    active_names = {f"job_{jid}" for jid in (active_job_ids or set())}
    now = time.time()
    removed = 0
    try:
        for entry in base_dir.iterdir():
            if not entry.name.startswith("job_"):
                continue
            if entry.name in active_names:
                continue
            try:
                mtime = entry.stat().st_mtime
                if now - mtime >= max_age_sec:
                    cleanup_path(entry)
                    removed += 1
            except OSError:
                pass
    except OSError:
        pass
    return removed


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
    safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", job_id)[:64] or "job"
    job_dir = resolve_within_base(base_dir, base_dir / f"job_{safe_job_id}")
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        yield job_dir
    finally:
        cleanup_path(job_dir)
