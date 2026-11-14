import fs from "fs/promises";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { getVideoQueueStatus } from "../queues/videoQueue.ts";
import {
  checkVideoProcessorHealth,
  getUserVideoJobWithQueueState,
  listUserVideoJobs,
  processVideoMetadataRequest,
} from "../services/videoProcessor.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function videoProcessorStatusController(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const [processor, queue] = await Promise.all([
    checkVideoProcessorHealth(),
    Promise.resolve(getVideoQueueStatus()),
  ]);

  res.json({
    status: "ok",
    processor,
    queue,
    implementedFeatures: ["metadata_extraction"],
    plannedFeatures: [
      "thumbnail_generation",
      "trim_video",
      "merge_clips",
      "resize_and_crop",
      "aspect_ratio_conversion",
      "export_mp4",
    ],
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
  const projectId =
    typeof req.body?.projectId === "string" && req.body.projectId.trim()
      ? req.body.projectId.trim()
      : null;
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
    const status = (err as { statusCode?: number }).statusCode || 500;
    const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
    res.status(status).json({
      status: status === 503 ? "integration_required" : "error",
      ...(integrationPoint ? { integrationPoint } : {}),
      error: err instanceof Error ? err.message : "Failed to extract video metadata.",
    });
  } finally {
    if (!transferredToWorker) {
      await fs.unlink(file.path).catch(() => undefined);
    }
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
