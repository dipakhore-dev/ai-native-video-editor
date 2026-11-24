import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { PassThrough, Readable } from "stream";
import mongoose from "mongoose";
import { getEnvConfig } from "../config/env.ts";
import { isDatabaseConnected } from "../config/database.ts";
import { sanitizeErrorMessage, sanitizeFilenameForDisposition } from "../middleware/security.middleware.ts";
import { MediaAssetModel } from "../models/MediaAsset.ts";
import { ProjectModel } from "../models/Project.ts";
import { VideoJobModel, type IVideoJob, type VideoOperationType } from "../models/VideoJob.ts";
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

export interface PythonSubtitleResult {
  status: "completed";
  job_id: string;
  model: string;
  language: string;
  language_probability: number;
  duration_seconds: number;
  segments: Array<{ id: number; start: number; end: number; text: string }>;
  srt: string;
  vtt: string;
}

export interface ProcessorHealthStatus {
  configured: boolean;
  reachable: boolean;
  url: string;
  status: "ok" | "degraded" | "unreachable";
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  fasterWhisperAvailable: boolean;
  hardwareEncoders: string[];
  recommendedEncoder: string;
  encoderCapabilities: Record<string, { available: boolean; label: string; detail: string }>;
  exportProfiles: Record<string, { id: string; label: string; resolution: string; description?: string }>;
  error: string | null;
}

export interface ExportProgressSnapshot {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  stage: string;
  stageLabel: string;
  progress: number;
  measurable: boolean;
  elapsedMs: number;
  cancelled: boolean;
  error: string | null;
}

interface ActiveExportEntry extends ExportProgressSnapshot {
  userId: string;
  abortController: AbortController;
  startedAtMs: number;
  finishedAtMs?: number;
  tempFilePaths: string[];
  activeUploadPromise: Promise<void> | null;
  cancelPromise: Promise<ExportProgressSnapshot | null> | null;
  abortUploadFn: (() => void) | null;
  deliveryCompleted: boolean;
  videoJobId: string | null;
}

const activeExportRegistry = new Map<string, ActiveExportEntry>();
const preCancelledExports = new Map<string, { userId: string; expiresAtMs: number }>();

const activeExportSlots = new Map<string, string>(); // slotToken -> userId
const exportSlotWaiters: Array<() => void> = [];
let shuttingDown = false;

export function isVideoServerShuttingDown(): boolean {
  return shuttingDown;
}

export function setVideoServerShuttingDown(value: boolean): void {
  shuttingDown = value;
  if (value) {
    notifyExportSlotWaiters();
  }
}

function notifyExportSlotWaiters(): void {
  while (exportSlotWaiters.length > 0) {
    const wake = exportSlotWaiters.shift();
    if (wake) wake();
  }
}

function countUserActiveExportSlots(userId: string): number {
  let count = 0;
  for (const owner of activeExportSlots.values()) {
    if (owner === userId) count += 1;
  }
  return count;
}

export function getActiveExportSlotStats(): { total: number } {
  return { total: activeExportSlots.size };
}

export async function acquireExportSlot(
  userId: string,
  signal?: AbortSignal
): Promise<string> {
  if (shuttingDown) {
    throw Object.assign(
      new Error("Server is shutting down. New exports are temporarily unavailable."),
      { statusCode: 503 }
    );
  }

  const { maxConcurrentExports, maxUserActiveExports, maxExportQueueWaitMs } = getEnvConfig();
  const deadlineMs = Date.now() + maxExportQueueWaitMs;

  while (true) {
    if (shuttingDown) {
      throw Object.assign(
        new Error("Server is shutting down. Export aborted."),
        { statusCode: 503 }
      );
    }
    if (signal?.aborted) {
      throw Object.assign(new Error("Export cancelled by user."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    const userCount = countUserActiveExportSlots(userId);
    if (userCount < maxUserActiveExports && activeExportSlots.size < maxConcurrentExports) {
      const slotToken = crypto.randomUUID();
      activeExportSlots.set(slotToken, userId);
      return slotToken;
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw Object.assign(
        new Error(
          userCount >= maxUserActiveExports
            ? "You already have an active MP4 export running. Wait for it to finish or cancel it first."
            : "Export workers are currently at full capacity. Please retry in a few seconds."
        ),
        { statusCode: 429 }
      );
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const idx = exportSlotWaiters.indexOf(done);
        if (idx >= 0) exportSlotWaiters.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(done, Math.min(remainingMs, 500));
      exportSlotWaiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function releaseExportSlot(slotToken: string | null | undefined): void {
  if (!slotToken) return;
  if (activeExportSlots.delete(slotToken)) {
    notifyExportSlotWaiters();
  }
}

export async function shutdownVideoExports(): Promise<void> {
  setVideoServerShuttingDown(true);
  const activeEntries = Array.from(activeExportRegistry.values()).filter(
    (entry) => entry.status === "processing" || entry.status === "queued"
  );
  await Promise.allSettled(
    activeEntries.map((entry) => cancelActiveExport(entry.userId, entry.jobId))
  );
}

export async function cleanupStaleExpressUploads(
  uploadDir: string,
  maxAgeMs = getEnvConfig().uploadTempMaxAgeMs
): Promise<number> {
  const activePaths = new Set<string>();
  for (const entry of activeExportRegistry.values()) {
    const isActive = !entry.cancelled && entry.status !== "completed" && entry.status !== "failed";
    if (!isActive) continue;
    for (const p of entry.tempFilePaths) {
      if (p) activePaths.add(path.resolve(p));
    }
  }

  let removedCount = 0;
  try {
    const entries = await fs.readdir(uploadDir, { withFileTypes: true });
    const now = Date.now();
    for (const item of entries) {
      if (!item.isFile()) continue;
      const fullPath = path.resolve(uploadDir, item.name);
      if (activePaths.has(fullPath)) continue;
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs >= maxAgeMs) {
          await unlinkFileWithRetry(fullPath, 2);
          removedCount += 1;
        }
      } catch {
        // Ignore individual stat/unlink races
      }
    }
  } catch {
    // Upload dir may not exist yet
  }
  return removedCount;
}

export async function reconcileOrphanedVideoJobsOnStartup(maxAgeMinutes = 30): Promise<number> {
  if (!isDatabaseConnected()) {
    return 0;
  }
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const result = await VideoJobModel.updateMany(
    {
      executionMode: "sync",
      status: { $in: ["queued", "processing"] },
      updatedAt: { $lt: cutoff },
    },
    {
      $set: {
        status: "failed",
        errorMessage: "Processing interrupted by server restart or worker timeout.",
        completedAt: new Date(),
      },
    }
  );
  return result.modifiedCount ?? 0;
}

function pruneActiveExports(): void {
  const now = Date.now();
  const cutoff = now - 5 * 60 * 1000;
  for (const [id, entry] of activeExportRegistry.entries()) {
    if (entry.finishedAtMs && entry.finishedAtMs < cutoff) {
      activeExportRegistry.delete(id);
    }
  }
  for (const [id, item] of preCancelledExports.entries()) {
    if (item.expiresAtMs < now) {
      preCancelledExports.delete(id);
    }
  }
}

async function unlinkFileWithRetry(filePath: string, retries = 4): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return;
      }
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
        continue;
      }
      return;
    }
  }
}

export function registerActiveExport(params: {
  jobId: string;
  userId: string;
  tempFilePaths: string[];
}): AbortController {
  pruneActiveExports();

  const existing = activeExportRegistry.get(params.jobId);
  if (existing && existing.userId === params.userId) {
    for (const filePath of params.tempFilePaths) {
      if (filePath && !existing.tempFilePaths.includes(filePath)) {
        existing.tempFilePaths.push(filePath);
      }
    }
    return existing.abortController;
  }

  const preCancelled = preCancelledExports.get(params.jobId);
  const wasPreCancelled = Boolean(preCancelled && preCancelled.userId === params.userId);
  if (wasPreCancelled) {
    preCancelledExports.delete(params.jobId);
  }

  const abortController = new AbortController();
  const now = Date.now();
  if (wasPreCancelled) {
    abortController.abort(
      Object.assign(new Error("Export cancelled by user."), {
        name: "AbortError",
        statusCode: 499,
        cancelled: true,
      })
    );
  }

  activeExportRegistry.set(params.jobId, {
    jobId: params.jobId,
    userId: params.userId,
    abortController,
    status: wasPreCancelled ? "cancelled" : "processing",
    stage: wasPreCancelled ? "cancelled" : "uploading",
    stageLabel: wasPreCancelled ? "Export cancelled" : "Preparing export media",
    progress: 0,
    measurable: false,
    elapsedMs: 0,
    cancelled: wasPreCancelled,
    error: wasPreCancelled ? "Export cancelled by user." : null,
    startedAtMs: now,
    finishedAtMs: wasPreCancelled ? now : undefined,
    tempFilePaths: [...params.tempFilePaths],
    activeUploadPromise: null,
    cancelPromise: null,
    abortUploadFn: null,
    deliveryCompleted: false,
    videoJobId: null,
  });
  return abortController;
}

export function attachExportUploadAbort(
  userId: string,
  jobId: string,
  abortFn: () => void
): void {
  const entry = activeExportRegistry.get(jobId);
  if (!entry || entry.userId !== userId) {
    return;
  }
  if (entry.cancelled || entry.status === "cancelled") {
    try {
      abortFn();
    } catch {
      // Ignore abort errors
    }
    return;
  }
  entry.abortUploadFn = abortFn;
}

export function attachExportTempFiles(
  userId: string,
  jobId: string,
  filePaths: string[]
): void {
  const entry = activeExportRegistry.get(jobId);
  if (!entry || entry.userId !== userId) {
    return;
  }
  for (const filePath of filePaths) {
    if (filePath && !entry.tempFilePaths.includes(filePath)) {
      entry.tempFilePaths.push(filePath);
    }
  }
}

export function isExportCancelled(jobId: string): boolean {
  const entry = activeExportRegistry.get(jobId);
  if (entry) {
    return (
      entry.cancelled ||
      entry.status === "cancelled" ||
      entry.abortController.signal.aborted
    );
  }
  return preCancelledExports.has(jobId);
}

export function markExportDeliveryCompleted(jobId: string): void {
  const entry = activeExportRegistry.get(jobId);
  if (entry) {
    entry.deliveryCompleted = true;
    entry.abortUploadFn = null;
  }
}

function toSnapshot(entry: ActiveExportEntry): ExportProgressSnapshot {
  const endMs = entry.finishedAtMs ?? Date.now();
  return {
    jobId: entry.jobId,
    status: entry.status,
    stage: entry.stage,
    stageLabel: entry.stageLabel,
    progress: entry.progress,
    measurable: entry.measurable,
    elapsedMs: Math.max(0, endMs - entry.startedAtMs),
    cancelled: entry.cancelled,
    error: entry.error,
  };
}

export async function getExportProgressSnapshot(
  userId: string,
  jobId: string
): Promise<ExportProgressSnapshot | null> {
  const entry = activeExportRegistry.get(jobId);
  if (!entry || entry.userId !== userId) {
    return null;
  }

  if (
    entry.cancelled ||
    entry.status === "completed" ||
    entry.status === "failed" ||
    entry.status === "cancelled"
  ) {
    return toSnapshot(entry);
  }

  const { videoProcessorUrl } = getEnvConfig();
  if (videoProcessorUrl) {
    try {
      const res = await fetch(
        `${videoProcessorUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`,
        {
          headers: getProcessorHeaders(),
          signal: AbortSignal.timeout(1500),
        }
      );
      if (res.ok) {
        const body = (await res.json()) as {
          status?: ExportProgressSnapshot["status"];
          stage?: string;
          stage_label?: string;
          progress?: number;
          measurable?: boolean;
          elapsed_ms?: number;
          cancelled?: boolean;
          error?: string | null;
        };
        const currentStatus = entry.status as ExportProgressSnapshot["status"];
        if (!entry.cancelled && currentStatus !== "cancelled" && currentStatus !== "completed") {
          if (body.status) entry.status = body.status;
          if (body.stage) entry.stage = body.stage;
          if (body.stage_label) entry.stageLabel = body.stage_label;
          if (typeof body.progress === "number") entry.progress = body.progress;
          if (typeof body.measurable === "boolean") entry.measurable = body.measurable;
          if (typeof body.cancelled === "boolean") entry.cancelled = body.cancelled;
          if (body.error !== undefined) entry.error = body.error;
          if (
            body.status === "completed" ||
            body.status === "failed" ||
            body.status === "cancelled"
          ) {
            entry.finishedAtMs = entry.finishedAtMs ?? Date.now();
          }
          return {
            ...toSnapshot(entry),
            elapsedMs:
              typeof body.elapsed_ms === "number" && body.elapsed_ms >= 0
                ? Math.max(body.elapsed_ms, Date.now() - entry.startedAtMs)
                : Date.now() - entry.startedAtMs,
          };
        }
      }
    } catch {
      // FastAPI unreachable/busy: fall back to current Express tracking snapshot cleanly
    }
  }

  return toSnapshot(entry);
}

export async function cancelActiveExport(
  userId: string,
  jobId: string,
  options?: { allowPrecreate?: boolean }
): Promise<ExportProgressSnapshot | null> {
  pruneActiveExports();
  const entry = activeExportRegistry.get(jobId);
  if (!entry) {
    if (!options?.allowPrecreate) {
      return null;
    }
    const existingPre = preCancelledExports.get(jobId);
    if (existingPre && existingPre.userId !== userId) {
      return null;
    }
    preCancelledExports.set(jobId, {
      userId,
      expiresAtMs: Date.now() + 5 * 60 * 1000,
    });
    const { videoProcessorUrl } = getEnvConfig();
    if (videoProcessorUrl) {
      try {
        await fetch(
          `${videoProcessorUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/cancel?allow_precreate=true`,
          {
            method: "POST",
            headers: getProcessorHeaders(),
            signal: AbortSignal.timeout(2500),
          }
        );
      } catch {
        // Best-effort cancellation forward to Python FastAPI
      }
    }
    return {
      jobId,
      status: "cancelled",
      stage: "cancelled",
      stageLabel: "Export cancelled",
      progress: 0,
      measurable: false,
      elapsedMs: 0,
      cancelled: true,
      error: "Export cancelled by user.",
    };
  }

  if (entry.userId !== userId) {
    return null;
  }

  if (entry.status === "completed" || entry.status === "failed") {
    return toSnapshot(entry);
  }

  if (entry.cancelPromise) {
    return entry.cancelPromise;
  }

  entry.cancelled = true;
  entry.status = "cancelled";
  entry.stage = "cancelled";
  entry.stageLabel = "Export cancelled";
  entry.measurable = false;
  entry.error = "Export cancelled by user.";
  entry.finishedAtMs = entry.finishedAtMs ?? Date.now();

  if (entry.abortUploadFn) {
    try {
      entry.abortUploadFn();
    } catch {
      // Ignore request destroy errors
    }
    entry.abortUploadFn = null;
  }

  if (!entry.abortController.signal.aborted) {
    entry.abortController.abort(
      Object.assign(new Error("Export cancelled by user."), {
        name: "AbortError",
        statusCode: 499,
        cancelled: true,
      })
    );
  }

  const runCancel = async (): Promise<ExportProgressSnapshot> => {
    // Wait for any in-flight multipart FileHandle streams to finish closing before unlinking temp files
    if (entry.activeUploadPromise) {
      await Promise.race([
        entry.activeUploadPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    await Promise.all(
      entry.tempFilePaths.map((filePath) => unlinkFileWithRetry(filePath))
    );

    if (entry.videoJobId) {
      await VideoJobModel.findOneAndUpdate(
        {
          _id: entry.videoJobId,
          userId,
          status: { $nin: ["completed", "failed"] },
        },
        {
          $set: {
            status: "cancelled",
            errorMessage: "Export cancelled by user.",
            completedAt: new Date(),
          },
        }
      ).catch(() => undefined);
    }

    const { videoProcessorUrl } = getEnvConfig();
    if (videoProcessorUrl) {
      try {
        await fetch(
          `${videoProcessorUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/cancel?allow_precreate=true`,
          {
            method: "POST",
            headers: getProcessorHeaders(),
            signal: AbortSignal.timeout(2500),
          }
        );
      } catch {
        // Best-effort cancellation forward to Python FastAPI
      }
    }

    return toSnapshot(entry);
  };

  entry.cancelPromise = runCancel();
  return entry.cancelPromise;
}

function createCombinedSignal(externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeoutSignal = AbortSignal.timeout(getEnvConfig().exportTimeoutMs);
  if (!externalSignal) {
    return { signal: timeoutSignal, cleanup: () => undefined };
  }
  const combined = new AbortController();
  const forward = (reason?: unknown) => {
    if (!combined.signal.aborted) {
      combined.abort(reason);
    }
  };
  if (externalSignal.aborted) {
    forward(externalSignal.reason);
    return { signal: combined.signal, cleanup: () => undefined };
  }
  const onExt = () => forward(externalSignal.reason);
  const onTimeout = () => forward(timeoutSignal.reason);
  externalSignal.addEventListener("abort", onExt, { once: true });
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  return {
    signal: combined.signal,
    cleanup: () => {
      externalSignal.removeEventListener("abort", onExt);
      timeoutSignal.removeEventListener("abort", onTimeout);
    },
  };
}

function sanitizeHeaderToken(raw: string): string {
  return raw.replace(/[\r\n"]/g, "_");
}

function isLocalBlobOrFileReadError(err: unknown): boolean {
  const check = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    const obj = candidate as { name?: string; code?: string; message?: string };
    const name = String(obj.name || "");
    const code = String(obj.code || "");
    const msg = String(obj.message || "").toLowerCase();
    return (
      name === "NotReadableError" ||
      code === "ENOENT" ||
      code === "EBADF" ||
      msg.includes("blob could not be read")
    );
  };
  return check(err) || (typeof err === "object" && err !== null && check((err as { cause?: unknown }).cause));
}

async function createStreamingMultipartUpload(params: {
  files: Array<{
    fieldName: string;
    filePath: string;
    originalName: string;
    mimeType: string;
  }>;
  fields?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}): Promise<{
  contentType: string;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
  waitForClose: () => Promise<void>;
}> {
  const boundary = `----AIStudioBoundary${crypto.randomBytes(16).toString("hex")}`;
  const fieldBuffers: Buffer[] = [];

  for (const [key, val] of Object.entries(params.fields ?? {})) {
    if (val === undefined || val === null || String(val).trim() === "") continue;
    const safeKey = sanitizeHeaderToken(key);
    fieldBuffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeKey}"\r\n\r\n${String(val)}\r\n`,
        "utf8"
      )
    );
  }

  const openedFiles: Array<{
    handle: FileHandle;
    sizeBytes: number;
    headerBuf: Buffer;
  }> = [];

  try {
    for (const f of params.files) {
      let handle: FileHandle;
      try {
        handle = await fs.open(f.filePath, "r");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Temp upload file is missing or unreadable.";
        throw Object.assign(
          new Error(`Failed to read uploaded file '${f.originalName}': ${msg}`),
          { statusCode: 400, cause: err }
        );
      }

      try {
        const stat = await handle.stat();
        const safeField = sanitizeHeaderToken(f.fieldName);
        const safeFilename = sanitizeHeaderToken(f.originalName || "upload.bin");
        const safeMime = (f.mimeType || "application/octet-stream").replace(/[\r\n]/g, "");
        const headerBuf = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${safeField}"; filename="${safeFilename}"\r\nContent-Type: ${safeMime}\r\n\r\n`,
          "utf8"
        );
        openedFiles.push({
          handle,
          sizeBytes: stat.size,
          headerBuf,
        });
      } catch (err) {
        await handle.close().catch(() => undefined);
        throw err;
      }
    }
  } catch (err) {
    await Promise.all(openedFiles.map((item) => item.handle.close().catch(() => undefined)));
    throw err;
  }

  const crlfBuf = Buffer.from("\r\n", "utf8");
  const endBuf = Buffer.from(`--${boundary}--\r\n`, "utf8");

  let contentLength = endBuf.length;
  for (const fb of fieldBuffers) contentLength += fb.length;
  for (const ofile of openedFiles) {
    contentLength += ofile.headerBuf.length + ofile.sizeBytes + crlfBuf.length;
  }

  const passThrough = new PassThrough();
  passThrough.on("error", () => {
    // Error propagates through webStream/fetch catch without crashing Node
  });

  let currentReadStream: Readable | null = null;
  let aborted = Boolean(params.signal?.aborted);
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const onAbort = () => {
    aborted = true;
    if (currentReadStream && !currentReadStream.destroyed) {
      currentReadStream.destroy(new Error("Upload stream aborted."));
    }
    if (!passThrough.destroyed) {
      passThrough.destroy(new Error("Upload stream aborted."));
    }
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });

  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (aborted || passThrough.destroyed) return;
    if (!passThrough.write(chunk)) {
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          cleanupWait();
          resolve();
        };
        const onClose = () => {
          cleanupWait();
          resolve();
        };
        const cleanupWait = () => {
          passThrough.off("drain", onDrain);
          passThrough.off("close", onClose);
          passThrough.off("error", onClose);
        };
        passThrough.once("drain", onDrain);
        passThrough.once("close", onClose);
        passThrough.once("error", onClose);
      });
    }
  };

  void (async () => {
    try {
      for (const fb of fieldBuffers) {
        if (aborted || passThrough.destroyed) break;
        await writeChunk(fb);
      }

      for (const item of openedFiles) {
        if (aborted || passThrough.destroyed) break;
        await writeChunk(item.headerBuf);
        if (item.sizeBytes > 0 && !aborted && !passThrough.destroyed) {
          await new Promise<void>((resolve, reject) => {
            const rs = item.handle.createReadStream({ autoClose: false });
            currentReadStream = rs;
            const onData = (chunk: Buffer | string) => {
              const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
              if (aborted || passThrough.destroyed) {
                rs.destroy();
                return;
              }
              if (!passThrough.write(buf)) {
                rs.pause();
                passThrough.once("drain", () => {
                  if (!rs.destroyed) rs.resume();
                });
              }
            };
            const onEnd = () => {
              cleanupStream();
              resolve();
            };
            const onErr = (err: Error) => {
              cleanupStream();
              reject(err);
            };
            const onClose = () => {
              cleanupStream();
              resolve();
            };
            const cleanupStream = () => {
              rs.off("data", onData);
              rs.off("end", onEnd);
              rs.off("error", onErr);
              rs.off("close", onClose);
              if (currentReadStream === rs) {
                currentReadStream = null;
              }
            };
            rs.on("data", onData);
            rs.once("end", onEnd);
            rs.once("error", onErr);
            rs.once("close", onClose);
          });
        }
        await item.handle.close().catch(() => undefined);
        if (!aborted && !passThrough.destroyed) {
          await writeChunk(crlfBuf);
        }
      }

      if (!aborted && !passThrough.destroyed) {
        await writeChunk(endBuf);
        passThrough.end();
      }
    } catch (err) {
      if (!passThrough.destroyed) {
        passThrough.destroy(err instanceof Error ? err : new Error("Multipart stream failed."));
      }
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      await Promise.all(openedFiles.map((item) => item.handle.close().catch(() => undefined)));
      resolveClosed();
    }
  })();

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
    body: Readable.toWeb(passThrough) as ReadableStream<Uint8Array>,
    waitForClose: () => closedPromise,
  };
}

function getProcessorHeaders(): Record<string, string> {
  const { videoProcessorApiKey } = getEnvConfig();
  return videoProcessorApiKey ? { "X-Processor-Key": videoProcessorApiKey } : {};
}

function requireConfiguredProcessorUrl(): string {
  const { videoProcessorUrl } = getEnvConfig();
  if (!videoProcessorUrl) {
    throw Object.assign(
      new Error(
        "Python FastAPI service URL is not configured (VIDEO_PROCESSOR_URL is empty). Start video-processor locally on Windows (uvicorn app.main:app --host 127.0.0.1 --port 8001) and set VIDEO_PROCESSOR_URL."
      ),
      { statusCode: 503, integrationPoint: "Python FastAPI Video Processor" }
    );
  }
  return videoProcessorUrl;
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
      fasterWhisperAvailable: false,
      hardwareEncoders: [],
      recommendedEncoder: "libx264",
      encoderCapabilities: {},
      exportProfiles: {},
      error:
        "VIDEO_PROCESSOR_URL is not configured. Start the local Python FastAPI service and set VIDEO_PROCESSOR_URL in .env.",
    };
  }

  try {
    const res = await fetch(`${videoProcessorUrl}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return {
        configured: true,
        reachable: true,
        url: "",
        status: "degraded",
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        fasterWhisperAvailable: false,
        hardwareEncoders: [],
        recommendedEncoder: "libx264",
        encoderCapabilities: {},
        exportProfiles: {},
        error: `Python FastAPI /health returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      status?: string;
      ffmpeg_available?: boolean;
      ffprobe_available?: boolean;
      faster_whisper_available?: boolean;
      hardware_encoders?: string[];
      recommended_encoder?: string;
      encoder_capabilities?: Record<string, { available: boolean; label: string; detail: string }>;
      export_profiles?: Record<string, { id: string; label: string; resolution: string; description?: string }>;
    };
    return {
      configured: true,
      reachable: true,
      url: "",
      status: body.status === "ok" ? "ok" : "degraded",
      ffmpegAvailable: Boolean(body.ffmpeg_available),
      ffprobeAvailable: Boolean(body.ffprobe_available),
      fasterWhisperAvailable: Boolean(body.faster_whisper_available),
      hardwareEncoders: Array.isArray(body.hardware_encoders) ? body.hardware_encoders : [],
      recommendedEncoder: body.recommended_encoder || "libx264",
      encoderCapabilities: body.encoder_capabilities || {},
      exportProfiles: body.export_profiles || {},
      error: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      url: "",
      status: "unreachable",
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      fasterWhisperAvailable: false,
      hardwareEncoders: [],
      recommendedEncoder: "libx264",
      encoderCapabilities: {},
      exportProfiles: {},
      error: sanitizeErrorMessage(
        err instanceof Error
          ? `Python FastAPI service unreachable: ${err.message}`
          : "Unable to reach Python FastAPI video processor.",
        "Unable to reach Python FastAPI video processor."
      ),
    };
  }
}

export async function forwardMetadataFileToPython(params: {
  filePath: string;
  originalName: string;
  mimeType: string;
}): Promise<PythonVideoMetadataResult> {
  const videoProcessorUrl = requireConfiguredProcessorUrl();

  const upload = await createStreamingMultipartUpload({
    files: [
      {
        fieldName: "file",
        filePath: params.filePath,
        originalName: params.originalName,
        mimeType: params.mimeType || "application/octet-stream",
      },
    ],
  });

  let res: Response;
  try {
    res = await fetch(`${videoProcessorUrl}/api/v1/metadata`, {
      method: "POST",
      headers: {
        ...getProcessorHeaders(),
        "Content-Type": upload.contentType,
        "Content-Length": String(upload.contentLength),
      },
      body: upload.body,
      duplex: "half",
      signal: AbortSignal.timeout(60_000),
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    if (isLocalBlobOrFileReadError(err)) {
      throw Object.assign(new Error("Temporary upload file could not be read before processing."), {
        statusCode: 500,
        cause: err,
      });
    }
    throw Object.assign(
      new Error(
        "Python FastAPI video processor is unreachable. Start uvicorn locally (see docs/WINDOWS_LOCAL_SETUP.md)."
      ),
      {
        statusCode: 503,
        integrationPoint: "Python FastAPI Video Processor",
        cause: err,
      }
    );
  } finally {
    await upload.waitForClose();
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    detail?: string;
    job_id?: string;
    metadata?: PythonVideoMetadataResult["metadata"];
  };

  if (!res.ok || !body.metadata) {
    const rawMsg = body.error || body.detail || `Video processor failed (${res.status}).`;
    const message = sanitizeErrorMessage(rawMsg, `Video processor failed (${res.status}).`);
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
          "Redis/BullMQ queue is not connected. Omit async=true to run synchronous local video processing without Redis."
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

export async function runSyncBinaryVideoOperation(params: {
  userId: string;
  operation: VideoOperationType;
  endpointPath: string;
  files: Array<{ fieldName: string; filePath: string; originalName: string; mimeType: string; sizeBytes: number }>;
  fields?: Record<string, string | number | undefined>;
  defaultOutputFilename: string;
  defaultContentType: string;
  projectId?: string | null;
  clientJobId?: string;
  signal?: AbortSignal;
}): Promise<{
  job: IVideoJob;
  buffer: Buffer;
  contentType: string;
  filename: string;
  processorJobId: string;
  exportProfile: string;
  encoderUsed: string;
  hardwareFallbackUsed: boolean;
}> {
  await assertOwnedReferences(params.userId, params.projectId, null);

  const primary = params.files[0];
  const jobDoc = await VideoJobModel.create({
    userId: params.userId,
    projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : null,
    operation: params.operation,
    status: "processing",
    progress: 15,
    executionMode: "sync",
    sourceFilename:
      params.files.length > 1
        ? `${primary.originalName} (+${params.files.length - 1} more)`
        : primary.originalName,
    sourceSizeBytes: params.files.reduce((sum, f) => sum + f.sizeBytes, 0),
    inputParams: {
      ...(params.fields ?? {}),
      ...(params.clientJobId ? { client_job_id: params.clientJobId } : {}),
    },
    startedAt: new Date(),
  });

  const activeEntry = params.clientJobId ? activeExportRegistry.get(params.clientJobId) : undefined;
  if (activeEntry) {
    activeEntry.videoJobId = jobDoc._id.toString();
  }
  const { signal, cleanup } = createCombinedSignal(params.signal);
  const hasCancelled = (): boolean => {
    if (params.signal?.aborted) return true;
    if (!activeEntry) return false;
    const st = activeEntry.status as ExportProgressSnapshot["status"];
    return Boolean(activeEntry.cancelled || st === "cancelled");
  };

  let acquiredExportSlot: string | null = null;
  try {
    if (hasCancelled()) {
      throw Object.assign(new Error("Export cancelled by user."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    if (params.operation === "export_mp4") {
      acquiredExportSlot = await acquireExportSlot(params.userId, signal);
    }

    const videoProcessorUrl = requireConfiguredProcessorUrl();
    const multipartFields: Record<string, string | number | undefined> = {
      ...(params.fields ?? {}),
      ...(params.clientJobId ? { client_job_id: params.clientJobId } : {}),
    };
    const upload = await createStreamingMultipartUpload({
      files: params.files,
      fields: multipartFields,
      signal,
    });
    if (activeEntry) {
      activeEntry.activeUploadPromise = upload.waitForClose();
    }

    let res: Response;
    try {
      res = await fetch(`${videoProcessorUrl}${params.endpointPath}`, {
        method: "POST",
        headers: {
          ...getProcessorHeaders(),
          ...(params.clientJobId ? { "X-Export-Job-Id": params.clientJobId } : {}),
          "Content-Type": upload.contentType,
          "Content-Length": String(upload.contentLength),
        },
        body: upload.body,
        duplex: "half",
        signal,
      } as RequestInit & { duplex: "half" });
    } catch (err) {
      if (hasCancelled()) {
        throw Object.assign(new Error("Export cancelled by user."), {
          statusCode: 499,
          cancelled: true,
          cause: err,
        });
      }
      if (isLocalBlobOrFileReadError(err)) {
        throw Object.assign(
          new Error("Temporary upload media file became unreadable during processing."),
          { statusCode: 500, cause: err }
        );
      }
      throw Object.assign(
        new Error(
          "Python FastAPI video processor is unreachable. Start uvicorn locally (see docs/WINDOWS_LOCAL_SETUP.md)."
        ),
        { statusCode: 503, integrationPoint: "Python FastAPI Video Processor", cause: err }
      );
    } finally {
      await upload.waitForClose();
    }

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        cancelled?: boolean;
      };
      if (res.status === 499 || errBody.cancelled || hasCancelled()) {
        throw Object.assign(new Error(errBody.error || "Export cancelled by user."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      const message = sanitizeErrorMessage(
        errBody.error || errBody.detail || `Video processing failed (${res.status}).`,
        `Video processing failed (${res.status}).`
      );
      throw Object.assign(new Error(message), {
        statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
      });
    }

    const arrayBuf = await res.arrayBuffer();
    if (hasCancelled()) {
      throw Object.assign(new Error("Export cancelled by user."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    const buffer = Buffer.from(arrayBuf);
    const contentType = res.headers.get("content-type") || params.defaultContentType;
    const processorJobId = res.headers.get("x-processor-job-id") || "";
    const exportProfile = res.headers.get("x-export-profile") || "";
    const encoderUsed = res.headers.get("x-export-encoder") || "";
    const hardwareFallbackUsed = res.headers.get("x-export-fallback") === "1";
    const disposition = res.headers.get("content-disposition") || "";
    const nameMatch = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = sanitizeFilenameForDisposition(
      nameMatch?.[1] || params.defaultOutputFilename,
      params.defaultOutputFilename
    );

    if (hasCancelled()) {
      throw Object.assign(new Error("Export cancelled by user."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    const exportDurationMs = Math.max(
      0,
      Date.now() - (jobDoc.startedAt ? new Date(jobDoc.startedAt).getTime() : Date.now())
    );

    jobDoc.status = "completed";
    jobDoc.progress = 100;
    jobDoc.processorJobId = processorJobId;
    jobDoc.result = {
      outputFilename: filename,
      outputSizeBytes: buffer.length,
      contentType,
      exportDurationMs,
      ...(exportProfile ? { exportProfile } : {}),
      ...(encoderUsed ? { encoderUsed, hardwareFallbackUsed } : {}),
    };
    jobDoc.completedAt = new Date();
    await jobDoc.save();

    if (hasCancelled()) {
      await VideoJobModel.findOneAndUpdate(
        { _id: jobDoc._id, userId: params.userId, status: { $ne: "cancelled" } },
        {
          $set: {
            status: "cancelled",
            errorMessage: "Export cancelled by user.",
            completedAt: new Date(),
          },
        }
      ).catch(() => undefined);
      throw Object.assign(new Error("Export cancelled by user."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    if (activeEntry) {
      activeEntry.status = "completed";
      activeEntry.progress = 100;
      activeEntry.stage = "completed";
      activeEntry.stageLabel = "Export complete";
      activeEntry.measurable = true;
      activeEntry.finishedAtMs = Date.now();
    }

    return {
      job: jobDoc,
      buffer,
      contentType,
      filename,
      processorJobId,
      exportProfile,
      encoderUsed,
      hardwareFallbackUsed,
    };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const isCancelled =
      statusCode === 499 ||
      Boolean((err as { cancelled?: boolean }).cancelled) ||
      hasCancelled();
    jobDoc.status = isCancelled
      ? "cancelled"
      : statusCode === 503
        ? "integration_required"
        : "failed";
    jobDoc.progress = isCancelled ? activeEntry?.progress ?? jobDoc.progress : 100;
    jobDoc.errorMessage = err instanceof Error ? err.message : "Video processing failed.";
    jobDoc.completedAt = new Date();
    await jobDoc.save().catch(() => undefined);

    if (activeEntry && (activeEntry.status as ExportProgressSnapshot["status"]) !== "completed") {
      activeEntry.status = isCancelled ? "cancelled" : "failed";
      activeEntry.cancelled = isCancelled;
      activeEntry.stage = isCancelled ? "cancelled" : "failed";
      activeEntry.stageLabel = isCancelled ? "Export cancelled" : "Export failed";
      activeEntry.measurable = false;
      activeEntry.error = jobDoc.errorMessage;
      activeEntry.finishedAtMs = activeEntry.finishedAtMs ?? Date.now();
    }
    if (err && typeof err === "object") {
      (err as { videoJobId?: string }).videoJobId = jobDoc._id.toString();
    }
    throw err;
  } finally {
    releaseExportSlot(acquiredExportSlot);
    cleanup();
  }
}

export async function runSyncSubtitlesGeneration(params: {
  userId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  language?: string;
  projectId?: string | null;
}): Promise<{ job: IVideoJob; subtitles: PythonSubtitleResult }> {
  await assertOwnedReferences(params.userId, params.projectId, null);

  const jobDoc = await VideoJobModel.create({
    userId: params.userId,
    projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : null,
    operation: "subtitles",
    status: "processing",
    progress: 15,
    executionMode: "sync",
    sourceFilename: params.originalName,
    sourceSizeBytes: params.sizeBytes,
    inputParams: { language: params.language || "auto" },
    startedAt: new Date(),
  });

  try {
    const videoProcessorUrl = requireConfiguredProcessorUrl();
    const upload = await createStreamingMultipartUpload({
      files: [
        {
          fieldName: "file",
          filePath: params.filePath,
          originalName: params.originalName,
          mimeType: params.mimeType || "application/octet-stream",
        },
      ],
      fields: params.language ? { language: params.language } : undefined,
    });

    let res: Response;
    try {
      res = await fetch(`${videoProcessorUrl}/api/v1/subtitles`, {
        method: "POST",
        headers: {
          ...getProcessorHeaders(),
          "Content-Type": upload.contentType,
          "Content-Length": String(upload.contentLength),
        },
        body: upload.body,
        duplex: "half",
        signal: AbortSignal.timeout(240_000),
      } as RequestInit & { duplex: "half" });
    } catch (err) {
      if (isLocalBlobOrFileReadError(err)) {
        throw Object.assign(new Error("Temporary upload media file could not be read for subtitle generation."), {
          statusCode: 500,
          cause: err,
        });
      }
      throw Object.assign(
        new Error(
          "Python FastAPI video processor is unreachable. Start uvicorn locally (see docs/WINDOWS_LOCAL_SETUP.md)."
        ),
        { statusCode: 503, integrationPoint: "Python FastAPI Video Processor", cause: err }
      );
    } finally {
      await upload.waitForClose();
    }

    const body = (await res.json().catch(() => ({}))) as Partial<PythonSubtitleResult> & {
      error?: string;
      detail?: string;
    };

    if (!res.ok || !Array.isArray(body.segments)) {
      const message = sanitizeErrorMessage(
        body.error || body.detail || `Subtitle generation failed (${res.status}).`,
        `Subtitle generation failed (${res.status}).`
      );
      throw Object.assign(new Error(message), {
        statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
      });
    }

    const subtitles: PythonSubtitleResult = {
      status: "completed",
      job_id: body.job_id || "",
      model: body.model || "faster-whisper",
      language: body.language || "unknown",
      language_probability: Number(body.language_probability || 0),
      duration_seconds: Number(body.duration_seconds || 0),
      segments: body.segments,
      srt: body.srt || "",
      vtt: body.vtt || "",
    };

    jobDoc.status = "completed";
    jobDoc.progress = 100;
    jobDoc.processorJobId = subtitles.job_id;
    jobDoc.result = {
      model: subtitles.model,
      language: subtitles.language,
      segmentCount: subtitles.segments.length,
    };
    jobDoc.completedAt = new Date();
    await jobDoc.save();

    return { job: jobDoc, subtitles };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    jobDoc.status = statusCode === 503 ? "integration_required" : "failed";
    jobDoc.progress = 100;
    jobDoc.errorMessage = sanitizeErrorMessage(
      err instanceof Error ? err.message : "Subtitle generation failed.",
      "Subtitle generation failed."
    );
    jobDoc.completedAt = new Date();
    await jobDoc.save();
    throw err;
  }
}

export async function listUserVideoJobs(
  userId: string,
  projectId?: string,
  operation?: VideoOperationType,
  limit = 50
): Promise<IVideoJob[]> {
  const filter: Record<string, unknown> = { userId };
  if (projectId !== undefined && projectId.trim() !== "") {
    if (!mongoose.Types.ObjectId.isValid(projectId.trim())) {
      throw Object.assign(new Error("Invalid projectId filter."), { statusCode: 400 });
    }
    filter.projectId = projectId.trim();
  }
  if (operation) {
    filter.operation = operation;
  }
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return VideoJobModel.find(filter).sort({ createdAt: -1 }).limit(safeLimit);
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

export async function deleteUserVideoJob(
  userId: string,
  jobId: string
): Promise<{ deleted: boolean; conflict?: boolean }> {
  const existing = await VideoJobModel.findOne({ _id: jobId, userId });
  if (!existing) {
    return { deleted: false };
  }
  if (existing.status === "queued" || existing.status === "processing") {
    return { deleted: false, conflict: true };
  }
  const removed = await VideoJobModel.findOneAndDelete({
    _id: jobId,
    userId,
    status: { $nin: ["queued", "processing"] },
  });
  return { deleted: Boolean(removed) };
}
