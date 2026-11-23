import crypto from "crypto";
import fs from "fs/promises";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { getVideoQueueStatus } from "../queues/videoQueue.ts";
import {
  cancelActiveExport,
  checkVideoProcessorHealth,
  getExportProgressSnapshot,
  getUserVideoJobWithQueueState,
  isExportCancelled,
  listUserVideoJobs,
  markExportDeliveryCompleted,
  processVideoMetadataRequest,
  registerActiveExport,
  runSyncBinaryVideoOperation,
  runSyncSubtitlesGeneration,
} from "../services/videoProcessor.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

const SUPPORTED_SUBTITLE_LANGUAGES = new Set([
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs",
  "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi",
  "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy",
  "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb",
  "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
  "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru",
  "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw",
  "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi",
  "yi", "yo", "yue", "zh",
]);

export function parseValidatedSubtitleLanguage(raw: unknown): {
  value?: string;
  error?: string;
} {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  if (typeof raw !== "string") {
    return { error: "Subtitle language must be a string ISO-639-1 code (e.g. 'en', 'hi', 'bn') or empty for auto-detect." };
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return { value: undefined };
  }
  if (!SUPPORTED_SUBTITLE_LANGUAGES.has(normalized)) {
    return {
      error: `Unsupported subtitle language '${raw.trim()}'. Use Auto-Detect or a valid Whisper language code such as 'en', 'hi', 'bn', 'es', 'fr', 'de', or 'ja'.`,
    };
  }
  return { value: normalized };
}

function getOptionalProjectId(req: AuthenticatedRequest): string | null {
  return typeof req.body?.projectId === "string" && req.body.projectId.trim()
    ? req.body.projectId.trim()
    : null;
}

function sendProcessorError(res: Response, err: unknown, fallbackMessage: string): void {
  if (res.writableEnded || res.headersSent) {
    return;
  }
  const status = (err as { statusCode?: number }).statusCode || 500;
  const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
  const isCancelled = status === 499 || Boolean((err as { cancelled?: boolean })?.cancelled);
  res.status(status).json({
    status: isCancelled
      ? "cancelled"
      : status === 503
        ? "integration_required"
        : "error",
    ...(isCancelled ? { cancelled: true } : {}),
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
      hardwareEncoding: processor.reachable && processor.hardwareEncoders.length > 0,
      hardwareEncoders: processor.hardwareEncoders,
      recommendedEncoder: processor.recommendedEncoder,
      encoderCapabilities: processor.encoderCapabilities,
      exportProfiles: processor.exportProfiles,
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
  exportProfile?: string;
  encodingMode?: string;
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
    muted?: boolean;
    fadeInSec?: number;
    fadeOutSec?: number;
    duckingEnabled?: boolean;
    duckingAmount?: number;
    opacity?: number;
    transitionIn?: { type?: string; durationSec?: number };
    transitionOut?: { type?: string; durationSec?: number };
    effects?: {
      preset?: string;
      brightness?: number;
      contrast?: number;
      saturation?: number;
      blur?: number;
    };
    overlayTransform?: {
      x?: number;
      y?: number;
      widthPct?: number;
      heightPct?: number;
      scale?: number;
      lockAspectRatio?: boolean;
    };
    textStyle?: {
      text?: string;
      fontSize?: number;
      color?: string;
      backgroundColor?: string;
      backgroundOpacity?: number;
      x?: number;
      y?: number;
      align?: string;
    };
    fileIndex?: number;
  }>;
  speechIntervals?: Array<{ start?: number; end?: number }>;
  burnSubtitles?: boolean;
  subtitles?: Array<{
    id?: string;
    start?: number;
    end?: number;
    text?: string;
    clipId?: string;
  }>;
  subtitleStyle?: {
    enabled?: boolean;
    fontSize?: number;
    color?: string;
    position?: string;
    backgroundColor?: string;
    backgroundOpacity?: number;
  };
}

const VALID_TRANSITION_TYPES = new Set([
  "none",
  "fade",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "zoomin",
]);

const VALID_EFFECT_PRESETS = new Set([
  "none",
  "cinematic",
  "bw",
  "vintage",
  "warm",
  "cool",
  "vivid",
]);

const VALID_EXPORT_PROFILES = new Set(["fast_preview", "balanced", "high_quality"]);
const VALID_ENCODING_MODES = new Set(["auto", "cpu", "gpu"]);

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

  if (spec.exportProfile !== undefined && !VALID_EXPORT_PROFILES.has(String(spec.exportProfile).trim().toLowerCase())) {
    return `Unsupported exportProfile '${spec.exportProfile}'. Choose 'fast_preview', 'balanced', or 'high_quality'.`;
  }
  if (spec.encodingMode !== undefined && !VALID_ENCODING_MODES.has(String(spec.encodingMode).trim().toLowerCase())) {
    return `Unsupported encodingMode '${spec.encodingMode}'. Choose 'auto', 'cpu', or 'gpu'.`;
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
  if (clips.length > 24) {
    return "Synchronous local MP4 export supports up to 24 timeline clips.";
  }

  const v1Clips: NonNullable<ParsedTimelineExportSpec["clips"]> = [];
  const v2Clips: NonNullable<ParsedTimelineExportSpec["clips"]> = [];
  const textClips: NonNullable<ParsedTimelineExportSpec["clips"]> = [];
  const audioClips: NonNullable<ParsedTimelineExportSpec["clips"]> = [];

  for (const clip of clips) {
    const name = clip.sourceName || clip.id || "clip";
    const trackId = String(clip.trackId || "");
    const kind = String(clip.kind || "");

    if ((kind === "video" || kind === "image") && trackId === "track_v1") {
      v1Clips.push(clip);
    } else if ((kind === "image" || kind === "video") && trackId === "track_v2") {
      v2Clips.push(clip);
    } else if (kind === "text" && trackId === "track_t1") {
      textClips.push(clip);
    } else if (kind === "audio" && trackId === "track_a1") {
      audioClips.push(clip);
    } else {
      return `Timeline clip '${name}' (${kind} on '${trackId}') is not supported on this track.`;
    }

    const speed = Number(clip.speed ?? 1);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
      return `Clip '${name}' uses unsupported ${speed}x speed. Supported playback speed range is 0.5x to 2.0x.`;
    }

    const volume = Number(clip.volume ?? 1);
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) {
      return `Clip '${name}' volume (${Math.round(volume * 100)}%) must be between 0% and 200%.`;
    }

    const fadeIn = Number(clip.fadeInSec ?? 0);
    const fadeOut = Number(clip.fadeOutSec ?? 0);
    if (
      !Number.isFinite(fadeIn) ||
      fadeIn < 0 ||
      fadeIn > 30 ||
      !Number.isFinite(fadeOut) ||
      fadeOut < 0 ||
      fadeOut > 30
    ) {
      return `Clip '${name}' fade durations must be between 0s and 30s.`;
    }

    if (clip.duckingAmount !== undefined) {
      const duckAmt = Number(clip.duckingAmount);
      if (!Number.isFinite(duckAmt) || duckAmt < 0 || duckAmt > 0.95) {
        return `Clip '${name}' ducking amount must be between 0% and 95%.`;
      }
    }

    const opacity = Number(clip.opacity ?? 1);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      return `Clip '${name}' opacity must be between 0% and 100%.`;
    }

    for (const [label, tr] of [
      ["transitionIn", clip.transitionIn],
      ["transitionOut", clip.transitionOut],
    ] as const) {
      if (!tr) continue;
      if (tr.type && !VALID_TRANSITION_TYPES.has(tr.type)) {
        return `Clip '${name}' has unsupported ${label} type '${tr.type}'.`;
      }
      if (
        tr.durationSec !== undefined &&
        (!Number.isFinite(Number(tr.durationSec)) ||
          Number(tr.durationSec) < 0.2 ||
          Number(tr.durationSec) > 2.0)
      ) {
        return `Clip '${name}' ${label} duration must be between 0.2s and 2.0s.`;
      }
    }

    if (clip.effects) {
      const fx = clip.effects;
      if (fx.preset && !VALID_EFFECT_PRESETS.has(fx.preset)) {
        return `Clip '${name}' has unsupported effect preset '${fx.preset}'.`;
      }
      if (
        fx.brightness !== undefined &&
        (!Number.isFinite(Number(fx.brightness)) || Number(fx.brightness) < -0.5 || Number(fx.brightness) > 0.5)
      ) {
        return `Clip '${name}' brightness must be between -0.5 and 0.5.`;
      }
      if (
        fx.contrast !== undefined &&
        (!Number.isFinite(Number(fx.contrast)) || Number(fx.contrast) < 0.5 || Number(fx.contrast) > 1.8)
      ) {
        return `Clip '${name}' contrast must be between 0.5 and 1.8.`;
      }
      if (
        fx.saturation !== undefined &&
        (!Number.isFinite(Number(fx.saturation)) || Number(fx.saturation) < 0 || Number(fx.saturation) > 2)
      ) {
        return `Clip '${name}' saturation must be between 0 and 2.`;
      }
      if (
        fx.blur !== undefined &&
        (!Number.isFinite(Number(fx.blur)) || Number(fx.blur) < 0 || Number(fx.blur) > 10)
      ) {
        return `Clip '${name}' blur must be between 0 and 10.`;
      }
    }

    if (clip.overlayTransform) {
      const ov = clip.overlayTransform;
      if (
        ov.x !== undefined &&
        (!Number.isFinite(Number(ov.x)) || Number(ov.x) < 0 || Number(ov.x) > 100)
      ) {
        return `Clip '${name}' overlay X position must be between 0% and 100%.`;
      }
      if (
        ov.y !== undefined &&
        (!Number.isFinite(Number(ov.y)) || Number(ov.y) < 0 || Number(ov.y) > 100)
      ) {
        return `Clip '${name}' overlay Y position must be between 0% and 100%.`;
      }
      if (
        ov.widthPct !== undefined &&
        (!Number.isFinite(Number(ov.widthPct)) || Number(ov.widthPct) < 5 || Number(ov.widthPct) > 100)
      ) {
        return `Clip '${name}' overlay width must be between 5% and 100%.`;
      }
      if (
        ov.heightPct !== undefined &&
        (!Number.isFinite(Number(ov.heightPct)) || Number(ov.heightPct) < 5 || Number(ov.heightPct) > 100)
      ) {
        return `Clip '${name}' overlay height must be between 5% and 100%.`;
      }
      if (
        ov.scale !== undefined &&
        (!Number.isFinite(Number(ov.scale)) || Number(ov.scale) < 0.1 || Number(ov.scale) > 2)
      ) {
        return `Clip '${name}' overlay scale must be between 0.1 and 2.0.`;
      }
    }

    if (kind !== "text") {
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
  }

  if (v1Clips.length === 0) {
    return "Timeline must include at least one video or image clip on track V1 before exporting MP4.";
  }
  if (v1Clips.length > 8 || v2Clips.length > 8 || textClips.length > 8 || audioClips.length > 8) {
    return "Synchronous local MP4 export supports up to 8 clips per track.";
  }

  const videoClips = v1Clips;

  const sortedV1 = [...videoClips].sort(
    (a, b) => Number(a.timelineStartSec ?? 0) - Number(b.timelineStartSec ?? 0)
  );
  if (Number(sortedV1[0].timelineStartSec ?? 0) > 0.15) {
    return "Timeline starts with an empty gap before the first V1 clip. Move the first clip to 00:00 before exporting.";
  }

  for (let i = 0; i < sortedV1.length - 1; i++) {
    const curStart = Number(sortedV1[i].timelineStartSec ?? 0);
    const curEnd = Number(
      sortedV1[i].timelineEndSec ?? curStart + Number(sortedV1[i].durationSec ?? 0)
    );
    const nextStart = Number(sortedV1[i + 1].timelineStartSec ?? 0);
    const gap = nextStart - curEnd;
    if (gap < -0.05) {
      return "Overlapping clips on track V1 are not supported in FFmpeg MP4 export. Arrange clips sequentially without overlap.";
    }
    if (gap > 0.15) {
      return "Empty timeline gaps between clips on track V1 are not supported in FFmpeg MP4 export. Close gaps before exporting.";
    }
  }

  if (Array.isArray(spec.speechIntervals)) {
    for (let i = 0; i < spec.speechIntervals.length; i++) {
      const iv = spec.speechIntervals[i];
      const s = Number(iv?.start);
      const e = Number(iv?.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
        return `Speech ducking interval #${i + 1} has invalid start/end timestamps.`;
      }
    }
  }

  if (spec.burnSubtitles) {
    if (!Array.isArray(spec.subtitles) || spec.subtitles.length === 0) {
      return "Subtitle burn-in is enabled, but there are no subtitle cues to burn.";
    }
    for (let i = 0; i < spec.subtitles.length; i++) {
      const cue = spec.subtitles[i];
      if (!cue || typeof cue !== "object") {
        return `Subtitle cue #${i + 1} is invalid.`;
      }
      const start = Number(cue.start);
      const end = Number(cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return `Subtitle cue #${i + 1} has invalid start/end timestamps.`;
      }
      if (typeof cue.text !== "string" || cue.text.trim().length === 0) {
        return `Subtitle cue #${i + 1} has empty text.`;
      }
    }
    if (spec.subtitleStyle) {
      const { fontSize, position, backgroundOpacity } = spec.subtitleStyle;
      if (
        fontSize !== undefined &&
        (!Number.isFinite(Number(fontSize)) || Number(fontSize) < 12 || Number(fontSize) > 72)
      ) {
        return "Subtitle fontSize must be between 12 and 72.";
      }
      if (position !== undefined && !["bottom", "middle", "top"].includes(position)) {
        return "Subtitle position must be 'bottom', 'middle', or 'top'.";
      }
      if (
        backgroundOpacity !== undefined &&
        (!Number.isFinite(Number(backgroundOpacity)) ||
          Number(backgroundOpacity) < 0 ||
          Number(backgroundOpacity) > 1)
      ) {
        return "Subtitle backgroundOpacity must be between 0 and 1.";
      }
    }
  }

  return null;
}

const CLIENT_JOB_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

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

  const preRegisteredId = (req as AuthenticatedRequest & { exportJobId?: string }).exportJobId;
  const rawHeaderJobId =
    typeof req.headers["x-export-job-id"] === "string"
      ? req.headers["x-export-job-id"].trim()
      : "";
  const rawClientJobId =
    typeof req.body?.clientJobId === "string"
      ? req.body.clientJobId.trim()
      : typeof req.body?.client_job_id === "string"
        ? req.body.client_job_id.trim()
        : "";
  const clientJobId =
    preRegisteredId && CLIENT_JOB_ID_REGEX.test(preRegisteredId)
      ? preRegisteredId
      : CLIENT_JOB_ID_REGEX.test(rawClientJobId)
        ? rawClientJobId
        : CLIENT_JOB_ID_REGEX.test(rawHeaderJobId)
          ? rawHeaderJobId
          : crypto.randomUUID();

  let detachListeners = () => undefined;

  if (isExportCancelled(clientJobId) || (req.destroyed && !req.complete)) {
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
    if (!res.writableEnded && !res.headersSent) {
      res.status(499).json({
        status: "cancelled",
        cancelled: true,
        error: "Export cancelled by user.",
      });
    }
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

    const rawProfile =
      typeof req.body?.exportProfile === "string"
        ? req.body.exportProfile.trim().toLowerCase()
        : typeof req.body?.export_profile === "string"
          ? req.body.export_profile.trim().toLowerCase()
          : "";
    if (rawProfile && !VALID_EXPORT_PROFILES.has(rawProfile)) {
      res.status(400).json({
        error: `Unsupported exportProfile '${rawProfile}'. Choose 'fast_preview', 'balanced', or 'high_quality'.`,
      });
      return;
    }
    const exportProfile = rawProfile || undefined;

    const rawEncodingMode =
      typeof req.body?.encodingMode === "string"
        ? req.body.encodingMode.trim().toLowerCase()
        : typeof req.body?.encoding_mode === "string"
          ? req.body.encoding_mode.trim().toLowerCase()
          : "";
    if (rawEncodingMode && !VALID_ENCODING_MODES.has(rawEncodingMode)) {
      res.status(400).json({
        error: `Unsupported encodingMode '${rawEncodingMode}'. Choose 'auto', 'cpu', or 'gpu'.`,
      });
      return;
    }
    const encodingMode = rawEncodingMode || "auto";

    const rawRes = typeof req.body?.resolution === "string" ? req.body.resolution.trim() : "720p";
    if (rawRes.toUpperCase() === "4K" || rawRes === "3840x2160") {
      res.status(400).json({
        error: "4K export is not supported in synchronous local MP4 export. Select 720p or 1080p.",
      });
      return;
    }
    const resolution =
      exportProfile === "fast_preview"
        ? "720p"
        : exportProfile === "balanced" || exportProfile === "high_quality"
          ? "1080p"
          : rawRes === "1080p" ||
              rawRes === "1920x1080" ||
              rawRes === "1080x1920" ||
              rawRes === "1080x1080"
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

    const abortController = registerActiveExport({
      jobId: clientJobId,
      userId: req.userId!,
      tempFilePaths: files.map((f) => f.path),
    });

    const onDisconnect = () => {
      if (!res.writableFinished) {
        void cancelActiveExport(req.userId!, clientJobId);
      }
    };
    const onFinish = () => {
      markExportDeliveryCompleted(clientJobId);
    };
    req.on("aborted", onDisconnect);
    res.on("close", onDisconnect);
    res.on("finish", onFinish);
    detachListeners = () => {
      req.off("aborted", onDisconnect);
      res.off("close", onDisconnect);
      res.off("finish", onFinish);
    };

    if (abortController.signal.aborted || isExportCancelled(clientJobId)) {
      sendProcessorError(
        res,
        Object.assign(new Error("Export cancelled by user."), {
          statusCode: 499,
          cancelled: true,
        }),
        "Export cancelled by user."
      );
      return;
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
        ...(exportProfile ? { export_profile: exportProfile } : {}),
        encoding_mode: encodingMode,
        ...(normalizedSpecString ? { timeline_spec: normalizedSpecString } : {}),
      },
      defaultOutputFilename: "export.mp4",
      defaultContentType: "video/mp4",
      projectId: getOptionalProjectId(req),
      clientJobId,
      signal: abortController.signal,
    });

    if (
      res.writableEnded ||
      res.destroyed ||
      abortController.signal.aborted ||
      isExportCancelled(clientJobId)
    ) {
      if (!res.writableEnded && !res.headersSent) {
        res.status(499).json({
          status: "cancelled",
          cancelled: true,
          error: "Export cancelled by user.",
        });
      }
      return;
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("X-Video-Job-Id", result.job._id.toString());
    res.setHeader("X-Export-Client-Job-Id", clientJobId);
    if (result.exportProfile) {
      res.setHeader("X-Export-Profile", result.exportProfile);
    }
    if (result.encoderUsed) {
      res.setHeader("X-Export-Encoder", result.encoderUsed);
    }
    res.setHeader("X-Export-Fallback", result.hardwareFallbackUsed ? "1" : "0");
    res.send(result.buffer);
  } catch (err) {
    sendProcessorError(res, err, "Failed to export MP4 video.");
  } finally {
    detachListeners();
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => undefined)));
  }
}

export async function getExportProgressController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const rawJobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const jobId = typeof rawJobId === "string" ? rawJobId.trim() : "";
  if (!CLIENT_JOB_ID_REGEX.test(jobId)) {
    res.status(400).json({ error: "Invalid export jobId format." });
    return;
  }

  const snapshot = await getExportProgressSnapshot(req.userId!, jobId);
  if (!snapshot) {
    res.status(404).json({ error: "Active export job not found." });
    return;
  }
  res.json({ status: "ok", progress: snapshot });
}

export async function cancelExportController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const rawJobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const jobId = typeof rawJobId === "string" ? rawJobId.trim() : "";
  if (!CLIENT_JOB_ID_REGEX.test(jobId)) {
    res.status(400).json({ error: "Invalid export jobId format." });
    return;
  }

  const allowPrecreate =
    req.query.allowPrecreate === "1" ||
    req.query.allowPrecreate === "true" ||
    req.query.allow_precreate === "1" ||
    req.query.allow_precreate === "true";

  const snapshot = await cancelActiveExport(req.userId!, jobId, { allowPrecreate });
  if (!snapshot) {
    res.status(404).json({ error: "Active export job not found." });
    return;
  }
  res.json({ status: "ok", progress: snapshot });
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
    const parsedLanguage = parseValidatedSubtitleLanguage(req.body?.language);
    if (parsedLanguage.error) {
      res.status(400).json({ error: parsedLanguage.error });
      return;
    }

    const result = await runSyncSubtitlesGeneration({
      userId: req.userId!,
      filePath: file.path,
      originalName: file.originalname || "video.mp4",
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size,
      language: parsedLanguage.value,
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
