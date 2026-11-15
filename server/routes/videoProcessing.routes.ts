import fs from "fs";
import os from "os";
import path from "path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getEnvConfig } from "../config/env.ts";
import {
  aspectRatioVideoController,
  exportMp4VideoController,
  extractVideoMetadataController,
  getVideoJobController,
  listVideoJobsController,
  mergeVideosController,
  subtitlesVideoController,
  thumbnailVideoController,
  trimVideoController,
  videoProcessorStatusController,
} from "../controllers/videoProcessing.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { validateObjectId } from "../middleware/validate.middleware.ts";

const uploadTempDir = path.join(os.tmpdir(), "ai-studio-express-uploads");
fs.mkdirSync(uploadTempDir, { recursive: true });

const ALLOWED_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".ogv",
]);

const ALLOWED_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
]);

function createMulterInstance(maxFiles = 1, allowAudio = false) {
  const { videoUploadMaxMb } = getEnvConfig();
  return multer({
    dest: uploadTempDir,
    limits: {
      fileSize: videoUploadMaxMb * 1024 * 1024,
      files: maxFiles,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const mime = (file.mimetype || "").split(";")[0].trim().toLowerCase();
      const isVideoMime =
        mime.startsWith("video/") ||
        mime === "application/octet-stream" ||
        mime === "application/mp4";
      const isAudioMime =
        allowAudio &&
        (mime.startsWith("audio/") || mime === "application/x-m4a");

      const isVideoExt = !ext || ALLOWED_VIDEO_EXTENSIONS.has(ext);
      const isAudioExt = allowAudio && (!ext || ALLOWED_AUDIO_EXTENSIONS.has(ext));

      if (isVideoMime && isVideoExt) {
        cb(null, true);
        return;
      }
      if (isAudioMime && isAudioExt) {
        cb(null, true);
        return;
      }
      if (allowAudio && mime === "video/mp4" && ext === ".m4a") {
        cb(null, true);
        return;
      }

      cb(
        new Error(
          allowAudio
            ? "Unsupported file type. Upload valid video (mp4, mov, webm, mkv) or audio (mp3, wav, m4a) files."
            : "Unsupported file type. Upload a valid video file (mp4, mov, webm, mkv)."
        )
      );
    },
  });
}

function handleUploadMiddleware(fieldName: string, maxFiles = 1) {
  const upload = createMulterInstance(maxFiles, false);
  const runner = maxFiles === 1 ? upload.single(fieldName) : upload.array(fieldName, maxFiles);

  return (req: Request, res: Response, next: NextFunction): void => {
    runner(req, res, (err: unknown) => {
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
        error: err instanceof Error ? err.message : "Invalid video upload.",
      });
    });
  };
}

function handleExportUploadMiddleware() {
  const upload = createMulterInstance(16, true);
  const runner = upload.fields([
    { name: "video", maxCount: 1 },
    { name: "videos", maxCount: 16 },
  ]);

  return (req: Request, res: Response, next: NextFunction): void => {
    runner(req, res, (err: unknown) => {
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
        error: err instanceof Error ? err.message : "Invalid media upload.",
      });
    });
  };
}

export const videoProcessingRouter = Router();

videoProcessingRouter.use(requireAuth);

videoProcessingRouter.get("/status", videoProcessorStatusController);
videoProcessingRouter.post(
  "/metadata",
  handleUploadMiddleware("video", 1),
  extractVideoMetadataController
);
videoProcessingRouter.post(
  "/thumbnail",
  handleUploadMiddleware("video", 1),
  thumbnailVideoController
);
videoProcessingRouter.post(
  "/trim",
  handleUploadMiddleware("video", 1),
  trimVideoController
);
videoProcessingRouter.post(
  "/aspect-ratio",
  handleUploadMiddleware("video", 1),
  aspectRatioVideoController
);
videoProcessingRouter.post(
  "/merge",
  handleUploadMiddleware("videos", 8),
  mergeVideosController
);
videoProcessingRouter.post(
  "/export-mp4",
  handleExportUploadMiddleware(),
  exportMp4VideoController
);
videoProcessingRouter.post(
  "/subtitles",
  handleUploadMiddleware("video", 1),
  subtitlesVideoController
);
videoProcessingRouter.get("/jobs", listVideoJobsController);
videoProcessingRouter.get("/jobs/:id", validateObjectId("id"), getVideoJobController);
