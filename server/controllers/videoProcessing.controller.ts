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

interface ParsedTimelineExportSpec {
  format?: string;
  project?: {
    name?: string;
    aspectRatio?: string;
    resolution?: string;
    width?: number;
    height?: number;
    fps?: number;
  };
  tracks?: Array<{ id?: string; muted?: boolean }>;
  clips?: Array<{
    id?: string;
    trackId?: string;
    kind?: string;
    sourceName?: string;
    timelineStartSec?: number;
    timelineEndSec?: number;
    durationSec?: number;
    sourceInSec?: number;
    sourceOutSec?: number;
    speed?: number;
    volume?: number;
    opacity?: number;
    fileIndex?: number;
  }>;
}

function validateTimelineExportSpec(
  spec: ParsedTimelineExportSpec,
  uploadedFileCount: number,
  requestedResolution: string,
  requestedFps: number
): string | null {
  const fmt = (spec.format || "mp4").toLowerCase();
  if (fmt !== "mp4") {
    return `Format '${fmt}' is not supported. Synchronous FFmpeg export supports MP4 (H.264) only.`;
  }

  const projRes = spec.project?.resolution || requestedResolution;
  if (
    projRes.toUpperCase() === "4K" ||
    (typeof spec.project?.width === "number" && spec.project.width > 1920) ||
    (typeof spec.project?.height === "number" && spec.project.height > 1920)
  ) {
    return "4K export is not supported in synchronous local MP4 export. Select 720p or 1080p.";
  }

  const effFps = Number(spec.project?.fps ?? requestedFps);
  if (![24, 30, 60].includes(effFps)) {
    return `Frame rate ${effFps} fps is not supported. Use 24, 30, or 60 fps.`;
  }

  const ar = spec.project?.aspectRatio;
  if (ar && !["16:9", "9:16", "1:1"].includes(ar)) {
    return `Aspect ratio '${ar}' is not supported. Use 16:9, 9:16, or 1:1.`;
  }

  const clips = spec.clips;
  if (!Array.isArray(clips) || clips.length === 0) {
    return "Timeline contains no clips to export.";
  }
  if (clips.length > 8) {
    return "Synchronous local MP4 export supports up to 8 timeline clips.";
  }

  const mutedTrackIds = new Set(
    (spec.tracks ?? [])
      .filter((t) => Boolean(t?.muted) && t?.id)
      .map((t) => String(t.id))
  );

  for (const clip of clips) {
    const name = clip.sourceName || clip.id || "clip";
    const trackId = String(clip.trackId || "");
    const kind = String(clip.kind || "");

    if (mutedTrackIds.has(trackId)) {
      return `Track '${trackId}' is muted but contains '${name}'. Unmute the track or remove its clips before exporting.`;
    }
    if (kind !== "video") {
      return `Timeline clip '${name}' (type '${kind}') is not supported in FFmpeg MP4 export yet. Only video clips on track V1 are supported (text overlays, images, and standalone audio tracks cannot be exported yet).`;
    }
    if (trackId !== "track_v1") {
      return `Clip '${name}' is on track '${trackId}'. FFmpeg MP4 export currently supports primary video track V1 ('track_v1') only.`;
    }

    const speed = Number(clip.speed ?? 1);
    if (Math.abs(speed - 1) > 0.01) {
      return `Clip '${name}' uses ${speed}x speed. Variable playback speed is not supported in FFmpeg MP4 export yet; set speed to 1.0x.`;
    }
    const volume = Number(clip.volume ?? 1);
    if (Math.abs(volume - 1) > 0.05) {
      return `Clip '${name}' uses ${Math.round(volume * 100)}% volume. Per-clip volume mixing is not supported in FFmpeg MP4 export yet; set volume to 100%.`;
    }
    const opacity = Number(clip.opacity ?? 1);
    if (Math.abs(opacity - 1) > 0.01) {
      return `Clip '${name}' uses ${Math.round(opacity * 100)}% opacity. Opacity adjustments are not supported in FFmpeg MP4 export yet; set opacity to 100%.`;
    }

    if (clip.fileIndex === undefined) {
      if (uploadedFileCount > 1) {
        return `Clip '${name}' must specify fileIndex when multiple source files are uploaded.`;
      }
    } else if (
      !Number.isInteger(clip.fileIndex) ||
      clip.fileIndex < 0 ||
      clip.fileIndex >= uploadedFileCount
    ) {
      return `Clip '${name}' references missing uploaded file index ${clip.fileIndex}.`;
    }
  }

  const sorted = [...clips].sort(
    (a, b) => Number(a.timelineStartSec ?? 0) - Number(b.timelineStartSec ?? 0)
  );
  if (Number(sorted[0].timelineStartSec ?? 0) > 0.15) {
    return "Timeline starts with an empty gap before the first clip. Move the first clip to 00:00 before exporting.";
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const curStart = Number(sorted[i].timelineStartSec ?? 0);
    const curEnd = Number(
      sorted[i].timelineEndSec ?? curStart + Number(sorted[i].durationSec ?? 0)
    );
    const nextStart = Number(sorted[i + 1].timelineStartSec ?? 0);
    const gap = nextStart - curEnd;
    if (gap < -0.05) {
      return "Overlapping clips on track V1 are not supported in FFmpeg MP4 export. Arrange clips sequentially without overlap.";
    }
    if (gap > 0.15) {
      return "Empty timeline gaps between clips on track V1 are not supported in FFmpeg MP4 export. Close gaps before exporting.";
    }
  }

  return null;
}

export async function exportMp4VideoController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const uploadedFields = (req.files as Record<string, Express.Multer.File[]> | undefined) ?? {};
  const files: Express.Multer.File[] = [
    ...(req.file ? [req.file] : []),
    ...(uploadedFields.video ?? []),
    ...(uploadedFields.videos ?? []),
  ];

  if (files.length === 0) {
    res
      .status(400)
      .json({ error: 'Upload at least one video file using form field "videos" or "video".' });
    return;
  }

  try {
    const rawFormat = typeof req.body?.format === "string" ? req.body.format.trim().toLowerCase() : "mp4";
    if (rawFormat !== "mp4") {
      res.status(400).json({
        error: `Format '${rawFormat}' is not supported. Synchronous FFmpeg export supports MP4 (H.264) only.`,
      });
      return;
    }

    const rawRes = typeof req.body?.resolution === "string" ? req.body.resolution.trim() : "720p";
    if (rawRes.toUpperCase() === "4K" || rawRes === "3840x2160") {
      res.status(400).json({
        error: "4K export is not supported in synchronous local MP4 export. Select 720p or 1080p.",
      });
      return;
    }
    const resolution =
      rawRes === "1080p" || rawRes === "1920x1080" || rawRes === "1080x1920" || rawRes === "1080x1080"
        ? "1080p"
        : "720p";

    const fps = Number(req.body?.fps ?? 30);
    if (!Number.isFinite(fps) || ![24, 30, 60].includes(fps)) {
      res.status(400).json({ error: "Frame rate must be 24, 30, or 60 fps." });
      return;
    }

    const aspectRatio =
      typeof req.body?.aspectRatio === "string" && req.body.aspectRatio.trim()
        ? req.body.aspectRatio.trim()
        : undefined;
    if (aspectRatio && !["16:9", "9:16", "1:1"].includes(aspectRatio)) {
      res.status(400).json({ error: "Aspect ratio must be '16:9', '9:16', or '1:1'." });
      return;
    }

    const rawSpec =
      typeof req.body?.timelineSpec === "string"
        ? req.body.timelineSpec
        : typeof req.body?.timeline_spec === "string"
          ? req.body.timeline_spec
          : "";

    let normalizedSpecString: string | undefined;
    if (rawSpec.trim()) {
      let parsedSpec: ParsedTimelineExportSpec;
      try {
        parsedSpec = JSON.parse(rawSpec) as ParsedTimelineExportSpec;
      } catch {
        res.status(400).json({ error: "Invalid timelineSpec JSON payload." });
        return;
      }
      if (!parsedSpec || typeof parsedSpec !== "object" || Array.isArray(parsedSpec)) {
        res.status(400).json({ error: "timelineSpec must be a JSON object." });
        return;
      }

      const validationError = validateTimelineExportSpec(
        parsedSpec,
        files.length,
        resolution,
        fps
      );
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      normalizedSpecString = JSON.stringify(parsedSpec);
    }

    const result = await runSyncBinaryVideoOperation({
      userId: req.userId!,
      operation: "export_mp4",
      endpointPath: "/api/v1/export-mp4",
      files: files.map((f) => ({
        fieldName: "files",
        filePath: f.path,
        originalName: f.originalname || "video.mp4",
        mimeType: f.mimetype || "application/octet-stream",
        sizeBytes: f.size,
      })),
      fields: {
        resolution,
        fps,
        aspect_ratio: aspectRatio,
        ...(normalizedSpecString ? { timeline_spec: normalizedSpecString } : {}),
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
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
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
