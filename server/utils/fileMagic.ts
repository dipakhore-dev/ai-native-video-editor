import fs from "fs/promises";
import path from "path";
import type { NextFunction, Request, Response } from "express";

export type MediaMagicKind = "video" | "audio" | "image";

export interface MagicByteCheckResult {
  valid: boolean;
  detectedKind?: MediaMagicKind;
  reason?: string;
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpeg", ".mpg", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function hasBytesAt(buf: Buffer, offset: number, pattern: number[]): boolean {
  if (buf.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (buf[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function hasAsciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.subarray(offset, offset + text.length).toString("ascii") === text;
}

export function detectBufferMediaMagic(
  buf: Buffer,
  originalName: string
): MagicByteCheckResult {
  if (buf.length < 4) {
    return { valid: false, reason: "Uploaded file is empty or truncated." };
  }

  const ext = path.extname(originalName || "").toLowerCase();

  // PNG
  if (hasBytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { valid: true, detectedKind: "image" };
  }
  // JPEG
  if (hasBytesAt(buf, 0, [0xff, 0xd8, 0xff])) {
    return { valid: true, detectedKind: "image" };
  }
  // GIF
  if (hasAsciiAt(buf, 0, "GIF87a") || hasAsciiAt(buf, 0, "GIF89a")) {
    return { valid: true, detectedKind: "image" };
  }
  // RIFF (AVI, WAV, WEBP)
  if (hasAsciiAt(buf, 0, "RIFF") && buf.length >= 12) {
    if (hasAsciiAt(buf, 8, "WEBP")) {
      return { valid: true, detectedKind: "image" };
    }
    if (hasAsciiAt(buf, 8, "WAVE")) {
      return { valid: true, detectedKind: "audio" };
    }
    if (hasAsciiAt(buf, 8, "AVI ")) {
      return { valid: true, detectedKind: "video" };
    }
  }
  // ISO BMFF / MP4 / MOV / M4V / M4A
  if (buf.length >= 8) {
    if (hasAsciiAt(buf, 4, "ftyp")) {
      const majorBrand = buf.subarray(8, 12).toString("ascii").toLowerCase();
      if (majorBrand.startsWith("m4a") || ext === ".m4a") {
        return { valid: true, detectedKind: "audio" };
      }
      return { valid: true, detectedKind: "video" };
    }
    if (
      hasAsciiAt(buf, 4, "moov") ||
      hasAsciiAt(buf, 4, "mdat") ||
      hasAsciiAt(buf, 4, "wide") ||
      hasAsciiAt(buf, 4, "free")
    ) {
      return { valid: true, detectedKind: ext === ".m4a" ? "audio" : "video" };
    }
  }
  // Matroska / WebM EBML header
  if (hasBytesAt(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { valid: true, detectedKind: "video" };
  }
  // MPEG-PS / MPEG-TS / MPEG Elementary
  if (
    hasBytesAt(buf, 0, [0x00, 0x00, 0x01, 0xba]) ||
    hasBytesAt(buf, 0, [0x00, 0x00, 0x01, 0xb3]) ||
    (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47))
  ) {
    return { valid: true, detectedKind: "video" };
  }
  // Ogg / Ogv
  if (hasAsciiAt(buf, 0, "OggS")) {
    return { valid: true, detectedKind: ext === ".ogv" ? "video" : "audio" };
  }
  // FLAC
  if (hasAsciiAt(buf, 0, "fLaC")) {
    return { valid: true, detectedKind: "audio" };
  }
  // MP3 (ID3 tag or MPEG audio frame sync)
  if (
    hasAsciiAt(buf, 0, "ID3") ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0x00)
  ) {
    return { valid: true, detectedKind: "audio" };
  }

  // Fallback hint for readable error message
  if (ext && !VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) {
    return { valid: false, reason: `Unsupported file extension '${ext}'.` };
  }
  return {
    valid: false,
    reason: `File header of '${path.basename(originalName || "upload")}' does not match a valid media format.`,
  };
}

export async function verifyUploadedFileMagic(
  filePath: string,
  originalName: string,
  options: { allowAudio: boolean; allowImages: boolean }
): Promise<MagicByteCheckResult> {
  const handle = await fs.open(filePath, "r");
  try {
    const headerBuf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(headerBuf, 0, 64, 0);
    const slice = headerBuf.subarray(0, bytesRead);
    const detected = detectBufferMediaMagic(slice, originalName);
    if (!detected.valid || !detected.detectedKind) {
      return detected;
    }
    if (detected.detectedKind === "audio" && !options.allowAudio) {
      return { valid: false, reason: "Audio-only files are not permitted on this endpoint." };
    }
    if (detected.detectedKind === "image" && !options.allowImages) {
      return { valid: false, reason: "Image files are not permitted on this endpoint." };
    }
    return detected;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function validateUploadedMediaMagicBytesMiddleware(options: {
  allowAudio: boolean;
  allowImages: boolean;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const uploadedFields = (req.files as Record<string, Express.Multer.File[]> | Express.Multer.File[] | undefined);
    const files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(uploadedFields)) {
      files.push(...uploadedFields);
    } else if (uploadedFields && typeof uploadedFields === "object") {
      for (const group of Object.values(uploadedFields)) {
        if (Array.isArray(group)) files.push(...group);
      }
    }

    if (files.length === 0) {
      next();
      return;
    }

    try {
      for (const file of files) {
        const result = await verifyUploadedFileMagic(
          file.path,
          file.originalname || file.filename || "upload",
          options
        );
        if (!result.valid) {
          await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
          res.status(400).json({
            error: result.reason || "Invalid or spoofed media file signature.",
          });
          return;
        }
      }
      next();
    } catch {
      await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
      res.status(400).json({ error: "Failed to verify uploaded media file signature." });
    }
  };
}
