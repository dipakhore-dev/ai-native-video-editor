import fs from "fs/promises";
import { Queue, Worker, type Job, type JobProgress } from "bullmq";
import IORedis from "ioredis";
import { getEnvConfig, isRedisConfigured } from "../config/env.ts";
import { VideoJobModel, type VideoOperationType } from "../models/VideoJob.ts";
import { forwardMetadataFileToPython } from "../services/videoProcessor.service.ts";

export const VIDEO_QUEUE_NAME = "ai-studio-video-processing";

export interface VideoQueueJobPayload {
  videoJobId: string;
  userId: string;
  operation: VideoOperationType;
  tempFilePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  mediaAssetId?: string | null;
}

let redisConnection: IORedis | null = null;
let videoQueue: Queue<VideoQueueJobPayload> | null = null;
let videoWorker: Worker<VideoQueueJobPayload> | null = null;
let redisConnected = false;
let lastRedisError: string | null = null;

function createRedisClient(redisUrl: string): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
}

export async function initializeVideoQueue(): Promise<boolean> {
  if (!isRedisConfigured()) {
    lastRedisError = "REDIS_URL is not set; BullMQ background queue disabled.";
    redisConnected = false;
    return false;
  }

  if (redisConnected && videoQueue && videoWorker) {
    return true;
  }

  const { redisUrl } = getEnvConfig();
  const client = createRedisClient(redisUrl);
  client.on("error", (err) => {
    lastRedisError = err.message;
    redisConnected = false;
  });

  try {
    await client.connect();
    await client.ping();
    redisConnection = client;
    redisConnected = true;
    lastRedisError = null;

    videoQueue = new Queue<VideoQueueJobPayload>(VIDEO_QUEUE_NAME, {
      connection: client,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    const workerConnection = createRedisClient(redisUrl);
    await workerConnection.connect();

    videoWorker = new Worker<VideoQueueJobPayload>(
      VIDEO_QUEUE_NAME,
      async (job: Job<VideoQueueJobPayload>) => {
        const {
          videoJobId,
          userId,
          operation,
          tempFilePath,
          originalName,
          mimeType,
          mediaAssetId,
        } = job.data;

        await VideoJobModel.findByIdAndUpdate(videoJobId, {
          $set: { status: "processing", progress: 20, startedAt: new Date() },
        });
        await job.updateProgress(20);

        try {
          if (operation !== "metadata") {
            throw new Error(`Operation "${operation}" is not enabled yet.`);
          }

          const pyResult = await forwardMetadataFileToPython({
            filePath: tempFilePath,
            originalName,
            mimeType,
          });

          await job.updateProgress(90);
          await VideoJobModel.findByIdAndUpdate(videoJobId, {
            $set: {
              status: "completed",
              progress: 100,
              processorJobId: pyResult.job_id,
              result: pyResult.metadata,
              completedAt: new Date(),
            },
          });

          if (mediaAssetId) {
            const { MediaAssetModel } = await import("../models/MediaAsset.ts");
            await MediaAssetModel.findOneAndUpdate(
              { _id: mediaAssetId, userId },
              {
                $set: {
                  duration: pyResult.metadata.duration_seconds,
                  width: pyResult.metadata.video?.width,
                  height: pyResult.metadata.video?.height,
                },
              }
            );
          }

          await job.updateProgress(100);
          return pyResult;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Background video job failed.";
          await VideoJobModel.findByIdAndUpdate(videoJobId, {
            $set: {
              status: "failed",
              progress: 100,
              errorMessage: message,
              completedAt: new Date(),
            },
          });
          throw err;
        } finally {
          await fs.unlink(tempFilePath).catch(() => undefined);
        }
      },
      {
        connection: workerConnection,
        concurrency: 2,
      }
    );

    console.log("Redis + BullMQ video processing queue initialized.");
    return true;
  } catch (err) {
    lastRedisError = err instanceof Error ? err.message : "Failed to connect to Redis.";
    redisConnected = false;
    await client.quit().catch(() => undefined);
    console.warn("Redis/BullMQ unavailable:", lastRedisError);
    return false;
  }
}

export function getVideoQueueStatus(): {
  configured: boolean;
  connected: boolean;
  queueName: string;
  lastError: string | null;
} {
  return {
    configured: isRedisConfigured(),
    connected: redisConnected && Boolean(videoQueue),
    queueName: VIDEO_QUEUE_NAME,
    lastError: lastRedisError,
  };
}

export async function enqueueVideoProcessingJob(
  payload: VideoQueueJobPayload
): Promise<{ queueJobId: string }> {
  if (!videoQueue || !redisConnected) {
    throw Object.assign(
      new Error("Redis/BullMQ job queue is not connected. Set REDIS_URL to enqueue background video jobs."),
      { statusCode: 503, integrationPoint: "BullMQ / Redis" }
    );
  }

  const job = await videoQueue.add(payload.operation, payload, {
    jobId: payload.videoJobId,
  });
  return { queueJobId: String(job.id ?? payload.videoJobId) };
}

export async function getBullMqJobSnapshot(queueJobId: string): Promise<{
  state: string;
  progress: JobProgress;
} | null> {
  if (!videoQueue || !redisConnected || !queueJobId) {
    return null;
  }
  const job = await videoQueue.getJob(queueJobId);
  if (!job) return null;
  const state = await job.getState();
  return { state, progress: job.progress };
}

export async function closeVideoQueue(): Promise<void> {
  await videoWorker?.close().catch(() => undefined);
  await videoQueue?.close().catch(() => undefined);
  await redisConnection?.quit().catch(() => undefined);
  videoWorker = null;
  videoQueue = null;
  redisConnection = null;
  redisConnected = false;
}
