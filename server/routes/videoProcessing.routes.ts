import fs from "fs";
import os from "os";
import path from "path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { getEnvConfig } from "../config/env.ts";
import {
  extractVideoMetadataController,
  getVideoJobController,
  listVideoJobsController,
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

function createVideoUploadMiddleware() {
  const { videoUploadMaxMb } = getEnvConfig();
  const upload = multer({
    dest: uploadTempDir,
    limits: {
      fileSize: videoUploadMaxMb * 1024 * 1024,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const mimeOk =
        file.mimetype.startsWith("video/") ||
        file.mimetype === "application/octet-stream" ||
        file.mimetype === "application/mp4";
      const extOk = !ext || ALLOWED_VIDEO_EXTENSIONS.has(ext);
      if (!mimeOk || !extOk) {
        cb(new Error("Unsupported file type. Upload a valid video file (mp4, mov, webm, mkv)."));
        return;
      }
      cb(null, true);
    },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single("video")(req, res, (err: unknown) => {
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

export const videoProcessingRouter = Router();

videoProcessingRouter.use(requireAuth);

videoProcessingRouter.get("/status", videoProcessorStatusController);
videoProcessingRouter.post(
  "/metadata",
  createVideoUploadMiddleware(),
  extractVideoMetadataController
);
videoProcessingRouter.get("/jobs", listVideoJobsController);
videoProcessingRouter.get("/jobs/:id", validateObjectId("id"), getVideoJobController);
