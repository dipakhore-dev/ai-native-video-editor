import crypto from "crypto";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { PassThrough, Readable } from "stream";
import { getEnvConfig } from "../config/env.ts";
import {
  CLIENT_CAPTIONS_JOB_ID_RE,
  type CaptionLanguageCode,
} from "../validators/captions.validators.ts";

export interface CaptionsStatusResult {
  enabled: boolean;
  defaultMode: "script" | "audio";
  scriptModeAvailable: boolean;
  audioTranscriptionAvailable: boolean;
  fasterWhisperInstalled: boolean;
  localModelReady: boolean;
  localFilesOnly: boolean;
  model: string | null;
  device: string;
  computeType: string;
  maxAudioMb: number;
  maxDurationSec: number;
  maxConcurrentJobs: number;
  maxSegmentsPerScene: number;
  maxBatchScenes: number;
  supportedLanguages: CaptionLanguageCode[];
  message: string;
}

export interface CaptionWordTimestampDto {
  word: string;
  start: number;
  end: number;
}

export interface AudioCaptionSegmentDto {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: CaptionWordTimestampDto[];
}

export interface AudioCaptionsGenerateResult {
  jobId: string;
  model: string;
  language: string;
  languageProbability: number;
  durationSeconds: number;
  wordTimestampsIncluded: boolean;
  segments: AudioCaptionSegmentDto[];
  srt: string;
  vtt: string;
}

export interface ActiveCaptionsJobSnapshot {
  jobId: string;
  userId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  stage: string;
  stageLabel: string;
  cancelled: boolean;
  startedAtMs: number;
  finishedAtMs?: number;
  error?: string | null;
}

interface ActiveCaptionsJobEntry extends ActiveCaptionsJobSnapshot {
  abortController: AbortController;
}

const activeCaptionsJobs = new Map<string, ActiveCaptionsJobEntry>();
const preCancelledCaptionsJobIds = new Map<string, { userId: string; expiresAtMs: number }>();

let activeCaptionsCount = 0;
const captionsWaitQueue: Array<() => void> = [];

function getProcessorHeaders(): Record<string, string> {
  const { videoProcessorApiKey } = getEnvConfig();
  return videoProcessorApiKey ? { "X-Processor-Key": videoProcessorApiKey } : {};
}

export function sanitizeCaptionsErrorMessage(
  raw: string | undefined | null,
  fallback = "Audio caption transcription failed."
): string {
  const text = (raw || "").trim();
  if (!text) return fallback;
  const cleaned = text
    .replace(/https?:\/\/[^\s"']+/gi, "[service-endpoint]")
    .replace(/[A-Za-z]:\\(?:[^\s"'<>|:*?]+\\)*[^\s"'<>|:*?]*/g, "[server-path]")
    .replace(/(?:^|(?<=[\s(]))\/(?:tmp|var|app|home|Users|etc|opt|usr)\/[^\s"')]+/g, "[server-path]")
    .trim();
  return cleaned || fallback;
}

export async function unlinkTempFileWithRetry(filePath: string, retries = 4): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return;
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
        continue;
      }
      return;
    }
  }
}

function pruneCaptionsRegistries(): void {
  const now = Date.now();
  for (const [jobId, entry] of activeCaptionsJobs.entries()) {
    if (entry.finishedAtMs && now - entry.finishedAtMs > 10 * 60 * 1000) {
      activeCaptionsJobs.delete(jobId);
    }
  }
  for (const [jobId, item] of preCancelledCaptionsJobIds.entries()) {
    if (now > item.expiresAtMs) {
      preCancelledCaptionsJobIds.delete(jobId);
    }
  }
}

async function acquireCaptionsConcurrencySlot(signal?: AbortSignal): Promise<boolean> {
  const { captionsMaxConcurrentJobs } = getEnvConfig();
  const limit = Math.max(1, captionsMaxConcurrentJobs);
  if (signal?.aborted) {
    throw Object.assign(new Error("Audio caption transcription cancelled."), {
      statusCode: 499,
      cancelled: true,
    });
  }
  if (activeCaptionsCount < limit) {
    activeCaptionsCount += 1;
    return true;
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = captionsWaitQueue.indexOf(grant);
      if (idx >= 0) captionsWaitQueue.splice(idx, 1);
      reject(
        Object.assign(new Error("Audio caption transcription cancelled."), {
          statusCode: 499,
          cancelled: true,
        })
      );
    };

    const grant = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      activeCaptionsCount += 1;
      resolve(true);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const idx = captionsWaitQueue.indexOf(grant);
      if (idx >= 0) captionsWaitQueue.splice(idx, 1);
      reject(
        Object.assign(
          new Error(
            "Local Whisper caption queue is busy. Wait for the active scene transcription to complete."
          ),
          { statusCode: 429 }
        )
      );
    }, 5000);

    signal?.addEventListener("abort", onAbort, { once: true });
    captionsWaitQueue.push(grant);
  });
}

function releaseCaptionsConcurrencySlot(acquired: boolean): void {
  if (!acquired) return;
  activeCaptionsCount = Math.max(0, activeCaptionsCount - 1);
  const next = captionsWaitQueue.shift();
  if (next) {
    next();
  }
}

async function forwardCaptionsCancelToPython(jobId: string): Promise<void> {
  const { videoProcessorUrl } = getEnvConfig();
  if (!videoProcessorUrl) return;
  try {
    await fetch(
      `${videoProcessorUrl}/api/v1/captions/jobs/${encodeURIComponent(jobId)}/cancel?allow_precreate=true`,
      {
        method: "POST",
        headers: getProcessorHeaders(),
        signal: AbortSignal.timeout(2500),
      }
    );
  } catch {
    // Best-effort cancellation forward
  }
}

export function getCaptionsJobSnapshot(
  userId: string,
  jobId: string
): ActiveCaptionsJobSnapshot | null {
  pruneCaptionsRegistries();
  const entry = activeCaptionsJobs.get(jobId);
  if (!entry || entry.userId !== userId) {
    return null;
  }
  return {
    jobId: entry.jobId,
    userId: entry.userId,
    status: entry.status,
    stage: entry.stage,
    stageLabel: entry.stageLabel,
    cancelled: entry.cancelled,
    startedAtMs: entry.startedAtMs,
    finishedAtMs: entry.finishedAtMs,
    error: entry.error,
  };
}

export async function cancelCaptionsJob(
  userId: string,
  jobId: string
): Promise<ActiveCaptionsJobSnapshot | null> {
  pruneCaptionsRegistries();
  const entry = activeCaptionsJobs.get(jobId);
  if (!entry) {
    if (!CLIENT_CAPTIONS_JOB_ID_RE.test(jobId)) {
      return null;
    }
    const existingPre = preCancelledCaptionsJobIds.get(jobId);
    if (existingPre && existingPre.userId !== userId) {
      return null;
    }
    preCancelledCaptionsJobIds.set(jobId, {
      userId,
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    });
    await forwardCaptionsCancelToPython(jobId);
    return {
      jobId,
      userId,
      status: "cancelled",
      stage: "cancelled",
      stageLabel: "Caption transcription cancelled",
      cancelled: true,
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      error: "Audio caption transcription cancelled.",
    };
  }

  if (entry.userId !== userId) {
    return null;
  }

  if (entry.status !== "completed" && entry.status !== "failed") {
    entry.cancelled = true;
    entry.status = "cancelled";
    entry.stage = "cancelled";
    entry.stageLabel = "Caption transcription cancelled";
    entry.error = "Audio caption transcription cancelled.";
    entry.finishedAtMs = entry.finishedAtMs ?? Date.now();
    try {
      entry.abortController.abort(new Error("Audio caption transcription cancelled."));
    } catch {
      // Ignore abort errors
    }
    await forwardCaptionsCancelToPython(jobId);
  }

  return getCaptionsJobSnapshot(userId, jobId);
}

export async function shutdownActiveCaptionsJobs(): Promise<void> {
  const entries = Array.from(activeCaptionsJobs.values());
  for (const entry of entries) {
    if (entry.status === "queued" || entry.status === "processing") {
      entry.cancelled = true;
      entry.status = "cancelled";
      entry.stage = "cancelled";
      entry.stageLabel = "Server shutting down";
      entry.finishedAtMs = Date.now();
      try {
        entry.abortController.abort(new Error("Server shutting down."));
      } catch {
        // Ignore
      }
      await forwardCaptionsCancelToPython(entry.jobId);
    }
  }
}

export async function fetchProcessorCaptionsStatus(): Promise<CaptionsStatusResult> {
  const cfg = getEnvConfig();
  const fallback: CaptionsStatusResult = {
    enabled: cfg.captionsEnabled,
    defaultMode: cfg.captionsDefaultMode,
    scriptModeAvailable: cfg.captionsEnabled,
    audioTranscriptionAvailable: false,
    fasterWhisperInstalled: false,
    localModelReady: false,
    localFilesOnly: true,
    model: null,
    device: "cpu",
    computeType: "int8",
    maxAudioMb: cfg.captionsMaxAudioMb,
    maxDurationSec: 90,
    maxConcurrentJobs: cfg.captionsMaxConcurrentJobs,
    maxSegmentsPerScene: cfg.captionsMaxSegmentsPerScene,
    maxBatchScenes: cfg.captionsMaxBatchScenes,
    supportedLanguages: ["en", "hi", "bn"],
    message: !cfg.captionsEnabled
      ? "Storyboard captions are disabled by server configuration."
      : !cfg.videoProcessorUrl
        ? "Script-based caption generation is ready locally. Start the Python video-processor to enable faster-whisper audio transcription."
        : "Script-based caption generation is ready locally. Python video-processor is currently unreachable for audio transcription.",
  };

  if (!cfg.captionsEnabled || !cfg.videoProcessorUrl) {
    return fallback;
  }

  try {
    const res = await fetch(`${cfg.videoProcessorUrl}/api/v1/captions/status`, {
      method: "GET",
      headers: getProcessorHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return {
        ...fallback,
        message: `Script-based captions are ready. Audio transcription probe returned HTTP ${res.status}.`,
      };
    }

    const raw = (await res.json()) as {
      enabled?: boolean;
      script_mode_available?: boolean;
      audio_transcription_available?: boolean;
      faster_whisper_installed?: boolean;
      local_model_ready?: boolean;
      local_files_only?: boolean;
      model?: string;
      device?: string;
      compute_type?: string;
      max_audio_mb?: number;
      max_duration_sec?: number;
      max_concurrent_jobs?: number;
      supported_languages?: CaptionLanguageCode[];
      message?: string;
    };

    const effectiveMaxMb = Math.min(
      cfg.captionsMaxAudioMb,
      typeof raw.max_audio_mb === "number" && raw.max_audio_mb > 0
        ? raw.max_audio_mb
        : cfg.captionsMaxAudioMb
    );

    return {
      enabled: cfg.captionsEnabled && (raw.enabled ?? true),
      defaultMode: cfg.captionsDefaultMode,
      scriptModeAvailable: cfg.captionsEnabled && Boolean(raw.script_mode_available ?? true),
      audioTranscriptionAvailable:
        cfg.captionsEnabled && Boolean(raw.audio_transcription_available),
      fasterWhisperInstalled: Boolean(raw.faster_whisper_installed),
      localModelReady: Boolean(raw.local_model_ready),
      localFilesOnly: Boolean(raw.local_files_only ?? true),
      model: raw.model || null,
      device: raw.device || "cpu",
      computeType: raw.compute_type || "int8",
      maxAudioMb: effectiveMaxMb,
      maxDurationSec:
        typeof raw.max_duration_sec === "number" && raw.max_duration_sec > 0
          ? raw.max_duration_sec
          : 90,
      maxConcurrentJobs: Math.min(
        cfg.captionsMaxConcurrentJobs,
        typeof raw.max_concurrent_jobs === "number" && raw.max_concurrent_jobs > 0
          ? raw.max_concurrent_jobs
          : cfg.captionsMaxConcurrentJobs
      ),
      maxSegmentsPerScene: cfg.captionsMaxSegmentsPerScene,
      maxBatchScenes: cfg.captionsMaxBatchScenes,
      supportedLanguages:
        Array.isArray(raw.supported_languages) && raw.supported_languages.length > 0
          ? raw.supported_languages
          : ["en", "hi", "bn"],
      message: sanitizeCaptionsErrorMessage(raw.message, fallback.message),
    };
  } catch {
    return fallback;
  }
}

function sanitizeHeaderToken(raw: string): string {
  return raw.replace(/[\r\n"]/g, "_");
}

async function createAudioMultipartStream(params: {
  filePath: string;
  originalName: string;
  mimeType: string;
  fields: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}): Promise<{
  contentType: string;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
  waitForClose: () => Promise<void>;
}> {
  const boundary = `----AIStudioCaptions${crypto.randomBytes(16).toString("hex")}`;
  const fieldBuffers: Buffer[] = [];

  for (const [key, val] of Object.entries(params.fields)) {
    if (val === undefined || val === null || String(val).trim() === "") continue;
    const safeKey = sanitizeHeaderToken(key);
    fieldBuffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeKey}"\r\n\r\n${String(val)}\r\n`,
        "utf8"
      )
    );
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(params.filePath, "r");
  } catch (err) {
    throw Object.assign(
      new Error("Temporary voiceover audio file could not be read for transcription."),
      { statusCode: 400, cause: err }
    );
  }

  let sizeBytes = 0;
  try {
    const stat = await handle.stat();
    sizeBytes = stat.size;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }

  const safeFilename = sanitizeHeaderToken(params.originalName || "voiceover.wav");
  const safeMime = (params.mimeType || "audio/wav").replace(/[\r\n]/g, "");
  const headerBuf = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${safeMime}\r\n\r\n`,
    "utf8"
  );
  const crlfBuf = Buffer.from("\r\n", "utf8");
  const endBuf = Buffer.from(`--${boundary}--\r\n`, "utf8");

  let contentLength =
    headerBuf.length + sizeBytes + crlfBuf.length + endBuf.length;
  for (const fb of fieldBuffers) contentLength += fb.length;

  const passThrough = new PassThrough();
  passThrough.on("error", () => undefined);

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
        const cleanup = () => {
          passThrough.off("drain", onWake);
          passThrough.off("close", onWake);
          passThrough.off("error", onWake);
        };
        const onWake = () => {
          cleanup();
          resolve();
        };
        passThrough.once("drain", onWake);
        passThrough.once("close", onWake);
        passThrough.once("error", onWake);
      });
    }
  };

  void (async () => {
    try {
      for (const fb of fieldBuffers) {
        if (aborted || passThrough.destroyed) break;
        await writeChunk(fb);
      }
      if (!aborted && !passThrough.destroyed) {
        await writeChunk(headerBuf);
      }
      if (sizeBytes > 0 && !aborted && !passThrough.destroyed) {
        await new Promise<void>((resolve, reject) => {
          const rs = handle.createReadStream({ autoClose: false });
          currentReadStream = rs;
          const cleanupStream = () => {
            rs.off("data", onData);
            rs.off("end", onEnd);
            rs.off("error", onErr);
            rs.off("close", onClose);
            if (currentReadStream === rs) currentReadStream = null;
          };
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
          rs.on("data", onData);
          rs.once("end", onEnd);
          rs.once("error", onErr);
          rs.once("close", onClose);
        });
      }
      if (!aborted && !passThrough.destroyed) {
        await writeChunk(crlfBuf);
        await writeChunk(endBuf);
        passThrough.end();
      }
    } catch (err) {
      if (!passThrough.destroyed) {
        passThrough.destroy(err instanceof Error ? err : new Error("Multipart stream failed."));
      }
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      await handle.close().catch(() => undefined);
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

export async function transcribeProcessorAudioCaptions(params: {
  userId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  language: CaptionLanguageCode | "auto";
  wordTimestamps: boolean;
  clientJobId?: string;
  headerJobId?: string;
  requestAbortSignal?: AbortSignal;
}): Promise<AudioCaptionsGenerateResult> {
  pruneCaptionsRegistries();
  const cfg = getEnvConfig();

  if (!cfg.captionsEnabled) {
    throw Object.assign(
      new Error("Storyboard caption generation is disabled by server configuration."),
      { statusCode: 503, integrationPoint: "Local Audio Captions" }
    );
  }

  if (!cfg.videoProcessorUrl) {
    throw Object.assign(
      new Error(
        "Python FastAPI service is not configured (set VIDEO_PROCESSOR_URL) for faster-whisper audio transcription. Script-based captions remain available."
      ),
      { statusCode: 503, integrationPoint: "Python FastAPI Video Processor" }
    );
  }

  const maxBytes = cfg.captionsMaxAudioMb * 1024 * 1024;
  if (params.sizeBytes <= 0 || params.sizeBytes > maxBytes) {
    throw Object.assign(
      new Error(
        params.sizeBytes <= 0
          ? "Uploaded audio file is empty."
          : `Audio file exceeds maximum caption transcription limit (${cfg.captionsMaxAudioMb} MB).`
      ),
      { statusCode: params.sizeBytes <= 0 ? 400 : 413 }
    );
  }

  const rawCid = (params.clientJobId || params.headerJobId || "").trim();
  const jobId = CLIENT_CAPTIONS_JOB_ID_RE.test(rawCid)
    ? rawCid
    : `cap_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const preCancelled = preCancelledCaptionsJobIds.get(jobId);
  if (preCancelled && preCancelled.userId === params.userId) {
    preCancelledCaptionsJobIds.delete(jobId);
    throw Object.assign(new Error("Audio caption transcription cancelled."), {
      statusCode: 499,
      cancelled: true,
    });
  }

  const abortController = new AbortController();
  const entry: ActiveCaptionsJobEntry = {
    jobId,
    userId: params.userId,
    status: "queued",
    stage: "queued",
    stageLabel: "Queued for local faster-whisper transcription",
    cancelled: false,
    startedAtMs: Date.now(),
    abortController,
  };
  activeCaptionsJobs.set(jobId, entry);

  const onExternalAbort = () => {
    if (!entry.cancelled && entry.status !== "completed" && entry.status !== "failed") {
      entry.cancelled = true;
      entry.status = "cancelled";
      entry.stage = "cancelled";
      entry.stageLabel = "Caption transcription cancelled";
      entry.finishedAtMs = Date.now();
      try {
        abortController.abort(new Error("Caption transcription aborted by client."));
      } catch {
        // Ignore
      }
      void forwardCaptionsCancelToPython(jobId);
    }
  };
  params.requestAbortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let acquiredSlot = false;
  try {
    acquiredSlot = await acquireCaptionsConcurrencySlot(abortController.signal);
    if (entry.cancelled || abortController.signal.aborted) {
      throw Object.assign(new Error("Audio caption transcription cancelled."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    entry.status = "processing";
    entry.stage = "transcribing";
    entry.stageLabel = "Transcribing audio with faster-whisper";

    const timeoutSignal = AbortSignal.timeout(cfg.captionsRequestTimeoutMs);
    const combinedSignal = AbortSignal.any([abortController.signal, timeoutSignal]);

    const upload = await createAudioMultipartStream({
      filePath: params.filePath,
      originalName: params.originalName,
      mimeType: params.mimeType,
      fields: {
        language: params.language === "auto" ? "" : params.language,
        word_timestamps: params.wordTimestamps ? "true" : "false",
        client_job_id: jobId,
      },
      signal: combinedSignal,
    });

    let res: Response;
    try {
      res = await fetch(`${cfg.videoProcessorUrl}/api/v1/captions/generate`, {
        method: "POST",
        headers: {
          ...getProcessorHeaders(),
          "X-Captions-Job-Id": jobId,
          "Content-Type": upload.contentType,
          "Content-Length": String(upload.contentLength),
        },
        body: upload.body,
        duplex: "half",
        signal: combinedSignal,
      } as RequestInit & { duplex: "half" });
    } catch (err) {
      if (entry.cancelled || abortController.signal.aborted) {
        throw Object.assign(new Error("Audio caption transcription cancelled."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      if (err instanceof Error && (err.name === "TimeoutError" || timeoutSignal.aborted)) {
        await forwardCaptionsCancelToPython(jobId);
        throw Object.assign(
          new Error("Local Whisper audio transcription timed out. Try a shorter clip or faster model."),
          { statusCode: 504 }
        );
      }
      throw Object.assign(
        new Error(
          "Python FastAPI Whisper service is unreachable. Start local uvicorn service or use Script-based captions."
        ),
        { statusCode: 503, integrationPoint: "Local faster-whisper" }
      );
    } finally {
      await upload.waitForClose();
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      cancelled?: boolean;
      job_id?: string;
      model?: string;
      language?: string;
      language_probability?: number;
      duration_seconds?: number;
      word_timestamps_included?: boolean;
      segments?: AudioCaptionSegmentDto[];
      srt?: string;
      vtt?: string;
    };

    if (!res.ok || !Array.isArray(body.segments)) {
      const isCancelled = res.status === 499 || Boolean(body.cancelled) || entry.cancelled;
      if (isCancelled) {
        throw Object.assign(new Error("Audio caption transcription cancelled."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      const message = sanitizeCaptionsErrorMessage(
        body.error || body.detail,
        `Audio caption transcription failed (${res.status}).`
      );
      throw Object.assign(new Error(message), {
        statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
      });
    }

    entry.status = "completed";
    entry.stage = "completed";
    entry.stageLabel = "Audio captions ready";
    entry.finishedAtMs = Date.now();

    return {
      jobId: body.job_id || jobId,
      model: body.model || "faster-whisper",
      language: body.language || (params.language === "auto" ? "unknown" : params.language),
      languageProbability: Number(body.language_probability || 0),
      durationSeconds: Number(body.duration_seconds || 0),
      wordTimestampsIncluded: Boolean(body.word_timestamps_included),
      segments: body.segments.slice(0, cfg.captionsMaxSegmentsPerScene),
      srt: body.srt || "",
      vtt: body.vtt || "",
    };
  } catch (err) {
    const isCancelled = Boolean((err as { cancelled?: boolean }).cancelled) || entry.cancelled;
    entry.status = isCancelled ? "cancelled" : "failed";
    entry.cancelled = isCancelled;
    entry.stage = isCancelled ? "cancelled" : "failed";
    entry.stageLabel = isCancelled ? "Caption transcription cancelled" : "Caption transcription failed";
    entry.error = sanitizeCaptionsErrorMessage(
      err instanceof Error ? err.message : undefined,
      "Audio caption transcription failed."
    );
    entry.finishedAtMs = entry.finishedAtMs ?? Date.now();
    throw err;
  } finally {
    params.requestAbortSignal?.removeEventListener("abort", onExternalAbort);
    releaseCaptionsConcurrencySlot(acquiredSlot);
  }
}
