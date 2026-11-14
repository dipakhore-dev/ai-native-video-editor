import fs from "fs/promises";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { getVideoQueueStatus } from "../queues/videoQueue.ts";
import {
  checkVideoProcessorHealth,
  getUserVideoJobWithQueueState,
  listUserVideoJobs,
  processVideoMetadataRequest,
  runSyncBinaryVideoOperation,
  runSyncSubtitlesGeneration,
} from "../services/videoProcessor.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

function getOptionalProjectId(req: AuthenticatedRequest): string | null {
  return typeof req.body?.projectId === "string" && req.body.projectId.trim()
    ? req.body.projectId.trim()
    : null;
}

function sendProcessorError(res: Response, err: unknown, fallbackMessage: string): void {
  const status = (err as { statusCode?: number }).statusCode || 500;
  const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
  res.status(status).json({
    status: status === 503 ? "integration_required" : "error",
    ...(integrationPoint ? { integrationPoint } : {}),
    error: err instanceof Error ? err.message : fallbackMessage,
  });
}

export async function videoProcessorStatusController(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const [processor, queue] = await Promise.all([
    checkVideoProcessorHealth(),
    Promise.resolve(getVideoQueueStatus()),
  ]);

  const processorReady = processor.reachable && processor.ffprobeAvailable && processor.ffmpegAvailable;
  const statusMessage = !processor.configured
    ? "Python FastAPI service URL (VIDEO_PROCESSOR_URL) is not configured. Start video-processor locally on Windows (see docs/WINDOWS_LOCAL_SETUP.md) and set VIDEO_PROCESSOR_URL in .env."
    : !processor.reachable
      ? `Python FastAPI service at ${processor.url} is unreachable. Start uvicorn locally or verify the service URL.`
      : !processorReady
        ? "Python FastAPI service is reachable, but FFmpeg/FFprobe binaries were not detected on its PATH."
        : "Python FastAPI service is connected and ready for synchronous video processing.";

  res.json({
    status: "ok",
    mode: "sync_local_first",
    redisRequiredForBasicProcessing: false,
    message: statusMessage,
    processor,
    queue,
    capabilities: {
      metadataExtraction: processorReady,
      thumbnailGeneration: processorReady,
      trimVideo: processorReady,
      mergeClips: processorReady,
      resizeAndCrop: processorReady,
      aspectRatioConversion: processorReady,
      exportMp4: processorReady,
      localSubtitles: processor.reachable && processor.fasterWhisperAvailable,
    },
  });
}

export async function extractVideoMetadataController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  const asyncMode = req.query.async === "true" || req.body?.async === "true";
  const projectId = getOptionalProjectId(req);
  const mediaAssetId =
    typeof req.body?.mediaAssetId === "string" && req.body.mediaAssetId.trim()
      ? req.body.mediaAssetId.trim()
      : null;

  let transferredToWorker = false;
  try {
    const outcome = await processVideoMetadataRequest({
      userId: req.userId!,
      filePath: file.path,
      originalName: file.originalname || "video.mp4",
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size,
      projectId,
      mediaAssetId,
      asyncMode,
    });

    if (outcome.mode === "bullmq") {
      transferredToWorker = true;
      res.status(202).json({
        status: "queued",
        mode: "bullmq",
        jobId: outcome.job._id.toString(),
        queueJobId: outcome.job.queueJobId,
      });
      return;
    }

    res.json({
      status: "ok",
      mode: "sync",
      jobId: outcome.job._id.toString(),
      processorJobId: outcome.job.processorJobId,
      metadata: outcome.metadata,
    });
  } catch (err) {
    sendProcessorError(res, err, "Failed to extract video metadata.");
  } finally {
    if (!transferredToWorker) {
      await fs.unlink(file.path).catch(() => undefined);
    }
  }
}

export async function thumbnailVideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  try {
    const timestampSec = Number(req.body?.timestampSec ?? 0.5);
    const width = Number(req.body?.width ?? 640);
    if (!Number.isFinite(timestampSec) || timestampSec < 0) {
      res.status(400).json({ error: "timestampSec must be a non-negative number." });
      return;
    }

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: "thumbnail",
      endpointPath: "/api/v1/thumbnail",
      files: [
        {
          fieldName: "file",
          filePath: file.path,
          originalName: file.originalname || "video.mp4",
          mimeType: file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
        },
      ],
      fields: {
        timestamp_sec: timestampSec,
        width: Number.isFinite(width) ? width : 640,
      },
      defaultOutputFilename: "thumbnail.jpg",
      defaultContentType: "image/jpeg",
      projectId: getOptionalProjectId(req),
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to generate video thumbnail.");
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function trimVideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  try {
    const startSec = Number(req.body?.startSec);
    const endSec = Number(req.body?.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
      res.status(400).json({ error: "Provide valid numeric timestamps where 0 <= startSec < endSec." });
      return;
    }

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: "trim",
      endpointPath: "/api/v1/trim",
      files: [
        {
          fieldName: "file",
          filePath: file.path,
          originalName: file.originalname || "video.mp4",
          mimeType: file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
        },
      ],
      fields: { start_sec: startSec, end_sec: endSec },
      defaultOutputFilename: "trimmed.mp4",
      defaultContentType: "video/mp4",
      projectId: getOptionalProjectId(req),
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to trim video.");
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function aspectRatioVideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  try {
    const aspectRatio =
      typeof req.body?.aspectRatio === "string" ? req.body.aspectRatio.trim() : undefined;
    const fitMode = req.body?.fitMode === "pad" ? "pad" : "crop";
    const targetWidth = req.body?.targetWidth ? Number(req.body.targetWidth) : undefined;
    const targetHeight = req.body?.targetHeight ? Number(req.body.targetHeight) : undefined;

    if (!aspectRatio && (!targetWidth || !targetHeight)) {
      res.status(400).json({
        error: "Provide aspectRatio ('16:9', '9:16', '1:1') or targetWidth and targetHeight.",
      });
      return;
    }

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: aspectRatio ? "aspect_ratio" : "resize_crop",
      endpointPath: "/api/v1/aspect-ratio",
      files: [
        {
          fieldName: "file",
          filePath: file.path,
          originalName: file.originalname || "video.mp4",
          mimeType: file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
        },
      ],
      fields: {
        aspect_ratio: aspectRatio,
        fit_mode: fitMode,
        target_width: targetWidth,
        target_height: targetHeight,
      },
      defaultOutputFilename: "formatted.mp4",
      defaultContentType: "video/mp4",
      projectId: getOptionalProjectId(req),
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to resize or convert aspect ratio.");
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function mergeVideosController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length < 2) {
    for (const f of files) {
      await fs.unlink(f.path).catch(() => undefined);
    }
    res.status(400).json({ error: 'Upload at least 2 video clips using form field "videos".' });
    return;
  }

  try {
    const targetWidth = Number(req.body?.targetWidth ?? 1280);
    const targetHeight = Number(req.body?.targetHeight ?? 720);
    const fps = Number(req.body?.fps ?? 30);

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: "merge",
      endpointPath: "/api/v1/merge",
      files: files.map((f) => ({
        fieldName: "files",
        filePath: f.path,
        originalName: f.originalname || "clip.mp4",
        mimeType: f.mimetype || "application/octet-stream",
        sizeBytes: f.size,
      })),
      fields: {
        target_width: Number.isFinite(targetWidth) ? targetWidth : 1280,
        target_height: Number.isFinite(targetHeight) ? targetHeight : 720,
        fps: Number.isFinite(fps) ? fps : 30,
      },
      defaultOutputFilename: "merged_output.mp4",
      defaultContentType: "video/mp4",
      projectId: getOptionalProjectId(req),
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to merge video clips.");
  } finally {
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
  }
}

export async function exportMp4VideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  try {
    const resolution = req.body?.resolution === "1080p" ? "1080p" : "720p";
    const fps = Number(req.body?.fps ?? 30);
    const aspectRatio =
      typeof req.body?.aspectRatio === "string" && req.body.aspectRatio.trim()
        ? req.body.aspectRatio.trim()
        : undefined;

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: "export_mp4",
      endpointPath: "/api/v1/export-mp4",
      files: [
        {
          fieldName: "file",
          filePath: file.path,
          originalName: file.originalname || "video.mp4",
          mimeType: file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
        },
      ],
      fields: {
        resolution,
        fps: Number.isFinite(fps) ? fps : 30,
        aspect_ratio: aspectRatio,
      },
      defaultOutputFilename: "export.mp4",
      defaultContentType: "video/mp4",
      projectId: getOptionalProjectId(req),
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to export MP4 video.");
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function subtitlesVideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a video file using form field "video".' });
    return;
  }

  try {
    const language =
      typeof req.body?.language === "string" && req.body.language.trim()
        ? req.body.language.trim()
        : undefined;

    const result = await runSyncSubtitlesGeneration({
      userId: req.userId!,
      filePath: file.path,
      originalName: file.originalname || "video.mp4",
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size,
      language,
      projectId: getOptionalProjectId(req),
    });

    res.json({
      ...result.subtitles,
      status: "ok",
      mode: "sync",
      jobId: result.job._id.toString(),
    });
  } catch (err) {
    sendProcessorError(res, err, "Failed to generate subtitles.");
  } finally {
    await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function listVideoJobsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const jobs = await listUserVideoJobs(req.userId!, projectId);
    res.json({ status: "ok", jobs });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list video processing jobs.",
    });
  }
}

export async function getVideoJobController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const data = await getUserVideoJobWithQueueState(req.userId!, getParamId(req));
    if (!data) {
      res.status(404).json({ error: "Video processing job not found." });
      return;
    }
    res.json({ status: "ok", job: data.job, bullmq: data.bullmq });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch video processing job.",
    });
  }
}
