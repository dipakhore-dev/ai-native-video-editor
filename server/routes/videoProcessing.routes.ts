import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getEnvConfig } from "../config/env.ts";
import {
  aspectRatioVideoController,
  cancelExportController,
  deleteVideoJobController,
  exportMp4VideoController,
  extractVideoMetadataController,
  getExportProgressController,
  getVideoJobController,
  listVideoJobsController,
  mergeVideosController,
  subtitlesVideoController,
  thumbnailVideoController,
  trimVideoController,
  videoProcessorStatusController,
} from "../controllers/videoProcessing.controller.ts";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateObjectId } from "../middleware/validate.middleware.ts";
import {
  attachExportTempFiles,
  attachExportUploadAbort,
  cancelActiveExport,
  isExportCancelled,
  registerActiveExport,
} from "../services/videoProcessor.service.ts";
import { validateUploadedMediaMagicBytesMiddleware } from "../utils/fileMagic.ts";

export const EXPRESS_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), "ai-studio-express-uploads");
const uploadTempDir = EXPRESS_UPLOAD_TEMP_DIR;
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

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

function createMulterInstance(maxFiles = 1, allowExtraMedia = false) {
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
        allowExtraMedia &&
        (mime.startsWith("audio/") || mime === "application/x-m4a");
      const isImageMime = allowExtraMedia && mime.startsWith("image/");

      const isVideoExt = !ext || ALLOWED_VIDEO_EXTENSIONS.has(ext);
      const isAudioExt = allowExtraMedia && (!ext || ALLOWED_AUDIO_EXTENSIONS.has(ext));
      const isImageExt = allowExtraMedia && (!ext || ALLOWED_IMAGE_EXTENSIONS.has(ext));

      if (isVideoMime && isVideoExt) {
        cb(null, true);
        return;
      }
      if (isAudioMime && isAudioExt) {
        cb(null, true);
        return;
      }
      if (isImageMime && isImageExt) {
        cb(null, true);
        return;
      }
      if (allowExtraMedia && mime === "video/mp4" && ext === ".m4a") {
        cb(null, true);
        return;
      }

      cb(
        new Error(
          allowExtraMedia
            ? "Unsupported file type. Upload valid video (mp4, mov, webm, mkv), audio (mp3, wav, m4a), or image (png, jpg, webp) files."
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

const CLIENT_JOB_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

function extractMulterUploadFiles(req: Request): Express.Multer.File[] {
  const uploadedFields = (req.files as Record<string, Express.Multer.File[]> | undefined) ?? {};
  return [
    ...(req.file ? [req.file] : []),
    ...(uploadedFields.video ?? []),
    ...(uploadedFields.videos ?? []),
  ];
}

export function preRegisterExportUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authReq = req as AuthenticatedRequest & { exportJobId?: string };
  const userId = authReq.userId;
  if (!userId) {
    next();
    return;
  }

  const rawHeaderId =
    typeof req.headers["x-export-job-id"] === "string"
      ? req.headers["x-export-job-id"].trim()
      : "";
  const exportJobId = CLIENT_JOB_ID_REGEX.test(rawHeaderId)
    ? rawHeaderId
    : crypto.randomUUID();
  authReq.exportJobId = exportJobId;

  // Prevent unhandled stream 'error' events when tearing down an aborted upload
  req.on("error", () => undefined);

  registerActiveExport({
    jobId: exportJobId,
    userId,
    tempFilePaths: [],
  });

  attachExportUploadAbort(userId, exportJobId, () => {
    if (!req.destroyed && !req.complete) {
      req.destroy(new Error("Export cancelled by user."));
    }
  });

  const onEarlyDisconnect = () => {
    if (!res.writableFinished && !res.writableEnded) {
      void cancelActiveExport(userId, exportJobId);
    }
  };
  req.on("aborted", onEarlyDisconnect);
  res.on("close", onEarlyDisconnect);
  res.once("finish", () => {
    req.off("aborted", onEarlyDisconnect);
    res.off("close", onEarlyDisconnect);
  });

  if (isExportCancelled(exportJobId)) {
    if (!res.writableEnded && !res.headersSent) {
      res.status(499).json({
        status: "cancelled",
        cancelled: true,
        error: "Export cancelled by user.",
      });
    }
    return;
  }

  next();
}

export function handleExportUploadMiddleware() {
  const upload = createMulterInstance(24, true);
  const runner = upload.fields([
    { name: "video", maxCount: 1 },
    { name: "videos", maxCount: 24 },
  ]);

  return (req: Request, res: Response, next: NextFunction): void => {
    runner(req, res, (err: unknown) => {
      const authReq = req as AuthenticatedRequest & { exportJobId?: string };
      const exportJobId = authReq.exportJobId;
      const files = extractMulterUploadFiles(req);
      const filePaths = files.map((f) => f.path).filter(Boolean);

      if (exportJobId && authReq.userId && filePaths.length > 0) {
        attachExportTempFiles(authReq.userId, exportJobId, filePaths);
      }

      const cancelled = Boolean(exportJobId && isExportCancelled(exportJobId));
      if (cancelled) {
        void Promise.all(
          filePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => undefined))
        );
        if (!res.writableEnded && !res.headersSent) {
          res.status(499).json({
            status: "cancelled",
            cancelled: true,
            error: "Export cancelled by user.",
          });
        }
        return;
      }

      if (!err) {
        next();
        return;
      }

      void Promise.all(
        filePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => undefined))
      );

      if (err instanceof multer.MulterError) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        if (!res.writableEnded && !res.headersSent) {
          res.status(status).json({ error: err.message });
        }
        return;
      }
      if (!res.writableEnded && !res.headersSent) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Invalid media upload.",
        });
      }
    });
  };
}

export const videoProcessingRouter = Router();

const videoOperationRateLimiter = createRateLimiter({
  name: "video-processing",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitVideoMax,
});

const exportRateLimiter = createRateLimiter({
  name: "video-export",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitExportMax,
  message: "Too many MP4 export attempts in a short window. Please wait a moment and try again.",
});

const validateVideoOnlyUpload = validateUploadedMediaMagicBytesMiddleware({
  allowAudio: false,
  allowImages: false,
});

const validateExportUpload = validateUploadedMediaMagicBytesMiddleware({
  allowAudio: true,
  allowImages: true,
});

const validateSubtitleUpload = validateUploadedMediaMagicBytesMiddleware({
  allowAudio: true,
  allowImages: false,
});

videoProcessingRouter.use(requireAuth);

videoProcessingRouter.get("/status", videoProcessorStatusController);
videoProcessingRouter.post(
  "/metadata",
  videoOperationRateLimiter,
  handleUploadMiddleware("video", 1),
  validateVideoOnlyUpload,
  extractVideoMetadataController
);
videoProcessingRouter.post(
  "/thumbnail",
  videoOperationRateLimiter,
  handleUploadMiddleware("video", 1),
  validateVideoOnlyUpload,
  thumbnailVideoController
);
videoProcessingRouter.post(
  "/trim",
  videoOperationRateLimiter,
  handleUploadMiddleware("video", 1),
  validateVideoOnlyUpload,
  trimVideoController
);
videoProcessingRouter.post(
  "/aspect-ratio",
  videoOperationRateLimiter,
  handleUploadMiddleware("video", 1),
  validateVideoOnlyUpload,
  aspectRatioVideoController
);
videoProcessingRouter.post(
  "/merge",
  videoOperationRateLimiter,
  handleUploadMiddleware("videos", 8),
  validateVideoOnlyUpload,
  mergeVideosController
);
videoProcessingRouter.post(
  "/export-mp4",
  exportRateLimiter,
  preRegisterExportUploadMiddleware,
  handleExportUploadMiddleware(),
  validateExportUpload,
  exportMp4VideoController
);
videoProcessingRouter.get("/export-progress/:jobId", getExportProgressController);
videoProcessingRouter.post("/export-cancel/:jobId", cancelExportController);
videoProcessingRouter.post(
  "/subtitles",
  videoOperationRateLimiter,
  handleUploadMiddleware("video", 1),
  validateSubtitleUpload,
  subtitlesVideoController
);
videoProcessingRouter.get("/jobs", listVideoJobsController);
videoProcessingRouter.get("/jobs/:id", validateObjectId("id"), getVideoJobController);
videoProcessingRouter.delete("/jobs/:id", validateObjectId("id"), deleteVideoJobController);
