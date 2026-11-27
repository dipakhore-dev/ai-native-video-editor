import path from "path";
import fs from "fs/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getEnvConfig } from "../config/env.ts";
import {
  captionsCancelJobController,
  captionsFromAudioController,
  captionsJobStatusController,
  captionsStatusController,
} from "../controllers/captions.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { EXPRESS_UPLOAD_TEMP_DIR } from "./videoProcessing.routes.ts";
import { verifyUploadedFileMagic } from "../utils/fileMagic.ts";

const ALLOWED_AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

function handleAudioCaptionUploadMiddleware() {
  const maxBytes = getEnvConfig().captionsMaxAudioMb * 1024 * 1024;
  const upload = multer({
    dest: EXPRESS_UPLOAD_TEMP_DIR,
    limits: {
      fileSize: maxBytes,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const mime = (file.mimetype || "").split(";")[0].trim().toLowerCase();
      const isAudioMime =
        mime.startsWith("audio/") ||
        mime === "application/x-m4a" ||
        mime === "application/octet-stream" ||
        (mime === "video/mp4" && ext === ".m4a");
      const isAudioExt = !ext || ALLOWED_AUDIO_EXTS.has(ext);
      if (isAudioMime && isAudioExt) {
        cb(null, true);
        return;
      }
      cb(
        new Error(
          "Unsupported audio file for caption transcription. Upload WAV, MP3, M4A, AAC, OGG, or FLAC audio."
        )
      );
    },
  }).single("audio");

  return (req: Request, res: Response, next: NextFunction): void => {
    upload(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err.message });
        return;
      }
      res.status(400).json({
        error: err instanceof Error ? err.message : "Invalid audio file upload.",
      });
    });
  };
}

async function validateAudioOnlyMagicMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const file = req.file;
  if (!file) {
    next();
    return;
  }
  try {
    const check = await verifyUploadedFileMagic(
      file.path,
      file.originalname || "voiceover.wav",
      { allowAudio: true, allowImages: false }
    );
    if (!check.valid || check.detectedKind !== "audio") {
      await fs.unlink(file.path).catch(() => undefined);
      res.status(400).json({
        error:
          check.reason ||
          "Uploaded file signature must match an audio container (WAV, MP3, M4A, OGG, FLAC).",
      });
      return;
    }
    next();
  } catch {
    await fs.unlink(file.path).catch(() => undefined);
    res.status(400).json({ error: "Failed to verify uploaded audio signature." });
  }
}

export const captionsRouter = Router();

const captionsRateLimiter = createRateLimiter({
  name: "captions-from-audio",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitCaptionsMax,
  message: "Too many audio caption transcription requests in a short window. Wait briefly before retrying.",
});

captionsRouter.use(requireAuth);

captionsRouter.get("/status", captionsStatusController);
captionsRouter.post(
  "/from-audio",
  captionsRateLimiter,
  handleAudioCaptionUploadMiddleware(),
  validateAudioOnlyMagicMiddleware,
  captionsFromAudioController
);
captionsRouter.get("/jobs/:id", captionsJobStatusController);
captionsRouter.post("/jobs/:id/cancel", captionsCancelJobController);
