import { openAsBlob } from "fs";
import mongoose from "mongoose";
import { getEnvConfig } from "../config/env.ts";
import { MediaAssetModel } from "../models/MediaAsset.ts";
import { ProjectModel } from "../models/Project.ts";
import { VideoJobModel, type IVideoJob } from "../models/VideoJob.ts";
import {
  enqueueVideoProcessingJob,
  getBullMqJobSnapshot,
  getVideoQueueStatus,
} from "../queues/videoQueue.ts";

export interface PythonVideoMetadataResult {
  status: "completed";
  job_id: string;
  metadata: {
    filename: string;
    format_name: string;
    format_long_name?: string | null;
    duration_seconds: number;
    size_bytes: number;
    bit_rate?: number | null;
    has_video: boolean;
    has_audio: boolean;
    aspect_ratio_label?: string | null;
    video?: {
      index: number;
      codec_name: string;
      codec_long_name?: string | null;
      profile?: string | null;
      width: number;
      height: number;
      fps: number;
      avg_frame_rate?: string | null;
      pixel_format?: string | null;
      bit_rate?: number | null;
      display_aspect_ratio?: string | null;
      rotation: number;
    } | null;
    audio?: {
      index: number;
      codec_name: string;
      codec_long_name?: string | null;
      sample_rate?: number | null;
      channels?: number | null;
      channel_layout?: string | null;
      bit_rate?: number | null;
    } | null;
    stream_count: number;
  };
}

export interface ProcessorHealthStatus {
  configured: boolean;
  reachable: boolean;
  url: string;
  status: "ok" | "degraded" | "unreachable";
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  error: string | null;
}

export async function checkVideoProcessorHealth(): Promise<ProcessorHealthStatus> {
  const { videoProcessorUrl } = getEnvConfig();
  if (!videoProcessorUrl) {
    return {
      configured: false,
      reachable: false,
      url: "",
      status: "unreachable",
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      error: "VIDEO_PROCESSOR_URL is not configured.",
    };
  }

  try {
    const res = await fetch(`${videoProcessorUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return {
        configured: true,
        reachable: true,
        url: videoProcessorUrl,
        status: "degraded",
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        error: `Health endpoint returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      status?: string;
      ffmpeg_available?: boolean;
      ffprobe_available?: boolean;
    };
    return {
      configured: true,
      reachable: true,
      url: videoProcessorUrl,
      status: body.status === "ok" ? "ok" : "degraded",
      ffmpegAvailable: Boolean(body.ffmpeg_available),
      ffprobeAvailable: Boolean(body.ffprobe_available),
      error: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      url: videoProcessorUrl,
      status: "unreachable",
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      error:
        err instanceof Error
          ? err.message
          : "Unable to reach Python FastAPI video processor.",
    };
  }
}

export async function forwardMetadataFileToPython(params: {
  filePath: string;
  originalName: string;
  mimeType: string;
}): Promise<PythonVideoMetadataResult> {
  const { videoProcessorUrl, videoProcessorApiKey } = getEnvConfig();
  if (!videoProcessorUrl) {
    throw Object.assign(
      new Error("VIDEO_PROCESSOR_URL is not configured on the Express server."),
      { statusCode: 503, integrationPoint: "Python FastAPI Video Processor" }
    );
  }

  const fileBlob = await openAsBlob(params.filePath, {
    type: params.mimeType || "application/octet-stream",
  });
  const form = new FormData();
  form.append("file", fileBlob, params.originalName);

  const headers: Record<string, string> = {};
  if (videoProcessorApiKey) {
    headers["X-Processor-Key"] = videoProcessorApiKey;
  }

  let res: Response;
  try {
    res = await fetch(`${videoProcessorUrl}/api/v1/metadata`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw Object.assign(
      new Error(
        `Python FastAPI video processor at ${videoProcessorUrl} is unreachable. Start uvicorn (video-processor/app/main.py) to run FFprobe metadata extraction.`
      ),
      {
        statusCode: 503,
        integrationPoint: "Python FastAPI Video Processor",
        cause: err,
      }
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    detail?: string;
    job_id?: string;
    status?: string;
    metadata?: PythonVideoMetadataResult["metadata"];
  };

  if (!res.ok || !body.metadata) {
    const message = body.error || body.detail || `Video processor failed (${res.status}).`;
    throw Object.assign(new Error(message), {
      statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
    });
  }

  return {
    status: "completed",
    job_id: body.job_id || "",
    metadata: body.metadata,
  };
}

async function assertOwnedReferences(
  userId: string,
  projectId?: string | null,
  mediaAssetId?: string | null
): Promise<void> {
  if (projectId) {
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      throw Object.assign(new Error("Invalid projectId."), { statusCode: 400 });
    }
    const ownsProject = await ProjectModel.exists({ _id: projectId, userId });
    if (!ownsProject) {
      throw Object.assign(new Error("Project not found for authenticated user."), {
        statusCode: 404,
      });
    }
  }

  if (mediaAssetId) {
    if (!mongoose.Types.ObjectId.isValid(mediaAssetId)) {
      throw Object.assign(new Error("Invalid mediaAssetId."), { statusCode: 400 });
    }
    const ownsAsset = await MediaAssetModel.exists({ _id: mediaAssetId, userId });
    if (!ownsAsset) {
      throw Object.assign(new Error("Media asset not found for authenticated user."), {
        statusCode: 404,
      });
    }
  }
}

export async function processVideoMetadataRequest(params: {
  userId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  projectId?: string | null;
  mediaAssetId?: string | null;
  asyncMode?: boolean;
}): Promise<{
  mode: "sync" | "bullmq";
  job: IVideoJob;
  metadata?: PythonVideoMetadataResult["metadata"];
}> {
  await assertOwnedReferences(params.userId, params.projectId, params.mediaAssetId);

  if (params.asyncMode) {
    const queueStatus = getVideoQueueStatus();
    if (!queueStatus.connected) {
      throw Object.assign(
        new Error(
          "Redis/BullMQ background queue is not connected. Set REDIS_URL or omit async=true for synchronous metadata extraction."
        ),
        { statusCode: 503, integrationPoint: "BullMQ / Redis" }
      );
    }

    const jobDoc = await VideoJobModel.create({
      userId: params.userId,
      projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : null,
      mediaAssetId: params.mediaAssetId ? new mongoose.Types.ObjectId(params.mediaAssetId) : null,
      operation: "metadata",
      status: "queued",
      progress: 0,
      executionMode: "bullmq",
      sourceFilename: params.originalName,
      sourceSizeBytes: params.sizeBytes,
      inputParams: { mimeType: params.mimeType },
    });

    const { queueJobId } = await enqueueVideoProcessingJob({
      videoJobId: jobDoc._id.toString(),
      userId: params.userId,
      operation: "metadata",
      tempFilePath: params.filePath,
      originalName: params.originalName,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      mediaAssetId: params.mediaAssetId,
    });

    jobDoc.queueJobId = queueJobId;
    await jobDoc.save();
    return { mode: "bullmq", job: jobDoc };
  }

  const jobDoc = await VideoJobModel.create({
    userId: params.userId,
    projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : null,
    mediaAssetId: params.mediaAssetId ? new mongoose.Types.ObjectId(params.mediaAssetId) : null,
    operation: "metadata",
    status: "processing",
    progress: 15,
    executionMode: "sync",
    sourceFilename: params.originalName,
    sourceSizeBytes: params.sizeBytes,
    inputParams: { mimeType: params.mimeType },
    startedAt: new Date(),
  });

  try {
    const pyResult = await forwardMetadataFileToPython({
      filePath: params.filePath,
      originalName: params.originalName,
      mimeType: params.mimeType,
    });

    jobDoc.status = "completed";
    jobDoc.progress = 100;
    jobDoc.processorJobId = pyResult.job_id;
    jobDoc.result = pyResult.metadata;
    jobDoc.completedAt = new Date();
    await jobDoc.save();

    if (params.mediaAssetId) {
      await MediaAssetModel.findOneAndUpdate(
        { _id: params.mediaAssetId, userId: params.userId },
        {
          $set: {
            duration: pyResult.metadata.duration_seconds,
            width: pyResult.metadata.video?.width,
            height: pyResult.metadata.video?.height,
          },
        }
      );
    }

    return { mode: "sync", job: jobDoc, metadata: pyResult.metadata };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    jobDoc.status = statusCode === 503 ? "integration_required" : "failed";
    jobDoc.progress = 100;
    jobDoc.errorMessage = err instanceof Error ? err.message : "Metadata extraction failed.";
    jobDoc.completedAt = new Date();
    await jobDoc.save();
    throw err;
  }
}

export async function listUserVideoJobs(
  userId: string,
  projectId?: string
): Promise<IVideoJob[]> {
  const filter: Record<string, unknown> = { userId };
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
    filter.projectId = projectId;
  }
  return VideoJobModel.find(filter).sort({ createdAt: -1 }).limit(50);
}

export async function getUserVideoJobWithQueueState(
  userId: string,
  jobId: string
): Promise<{ job: IVideoJob; bullmq: { state: string; progress: unknown } | null } | null> {
  const job = await VideoJobModel.findOne({ _id: jobId, userId });
  if (!job) return null;
  const bullmq =
    job.executionMode === "bullmq" && job.queueJobId
      ? await getBullMqJobSnapshot(job.queueJobId)
      : null;
  return { job, bullmq };
}
