import crypto from "crypto";
import { getEnvConfig } from "../config/env.ts";
import {
  CLIENT_TTS_JOB_ID_RE,
  normalizeTtsLanguageInput,
  type ValidatedTtsGenerateRequest,
} from "../validators/tts.validators.ts";

export interface TtsStatusResult {
  enabled: boolean;
  available: boolean;
  configuredProvider: string;
  activeProvider: string | null;
  defaultLanguage: "en" | "hi" | "bn";
  supportedLanguages: Array<"en" | "hi" | "bn">;
  mp3Supported: boolean;
  maxTextChars: number;
  maxAudioMb: number;
  providers: Array<{
    provider: "piper" | "espeak_ng" | "windows_sapi";
    label: string;
    available: boolean;
    installed: boolean;
    license: string;
    supportedLanguages: Array<"en" | "hi" | "bn">;
    voiceCount: number;
    message: string;
  }>;
  message: string;
}

export interface TtsVoiceItem {
  voiceId: string;
  provider: "piper" | "espeak_ng" | "windows_sapi";
  label: string;
  language: "en" | "hi" | "bn";
  languageTag: string;
  gender?: string | null;
  quality: string;
  sampleRateHz?: number | null;
  description?: string | null;
}

export interface TtsVoicesResult {
  available: boolean;
  provider: string | null;
  language: "en" | "hi" | "bn" | null;
  voices: TtsVoiceItem[];
  supportedLanguages: Array<"en" | "hi" | "bn">;
  message: string;
}

export interface ActiveTtsJobSnapshot {
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

interface ActiveTtsJobEntry extends ActiveTtsJobSnapshot {
  abortController: AbortController;
}

const activeTtsJobs = new Map<string, ActiveTtsJobEntry>();
const preCancelledTtsJobIds = new Map<string, number>();

let activeTtsSynthesisCount = 0;
const ttsWaitQueue: Array<() => void> = [];

function getProcessorHeaders(): Record<string, string> {
  const { videoProcessorApiKey } = getEnvConfig();
  return videoProcessorApiKey ? { "X-Processor-Key": videoProcessorApiKey } : {};
}

export function sanitizeTtsErrorMessage(
  raw: string | undefined | null,
  fallback = "Local text-to-speech synthesis failed."
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

function pruneTtsRegistries(): void {
  const now = Date.now();
  for (const [jobId, entry] of activeTtsJobs.entries()) {
    if (entry.finishedAtMs && now - entry.finishedAtMs > 10 * 60 * 1000) {
      activeTtsJobs.delete(jobId);
    }
  }
  for (const [jobId, ts] of preCancelledTtsJobIds.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      preCancelledTtsJobIds.delete(jobId);
    }
  }
}

async function acquireTtsConcurrencySlot(signal?: AbortSignal): Promise<boolean> {
  const { ttsMaxConcurrentJobs } = getEnvConfig();
  const limit = Math.max(1, ttsMaxConcurrentJobs);
  if (signal?.aborted) {
    throw Object.assign(new Error("Voiceover synthesis cancelled."), {
      statusCode: 499,
      cancelled: true,
    });
  }
  if (activeTtsSynthesisCount < limit) {
    activeTtsSynthesisCount += 1;
    return true;
  }

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const idx = ttsWaitQueue.indexOf(grant);
      if (idx >= 0) ttsWaitQueue.splice(idx, 1);
      reject(
        Object.assign(new Error("Voiceover synthesis cancelled."), {
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
      activeTtsSynthesisCount += 1;
      resolve(true);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      const idx = ttsWaitQueue.indexOf(grant);
      if (idx >= 0) ttsWaitQueue.splice(idx, 1);
      reject(
        Object.assign(
          new Error("Local voiceover queue is busy. Wait for the active synthesis request to complete."),
          { statusCode: 429 }
        )
      );
    }, 5000);

    signal?.addEventListener("abort", onAbort, { once: true });
    ttsWaitQueue.push(grant);
  });
}

function releaseTtsConcurrencySlot(acquired: boolean): void {
  if (!acquired) return;
  activeTtsSynthesisCount = Math.max(0, activeTtsSynthesisCount - 1);
  const next = ttsWaitQueue.shift();
  if (next) {
    next();
  }
}

async function forwardTtsCancelToPython(jobId: string): Promise<void> {
  const { videoProcessorUrl } = getEnvConfig();
  if (!videoProcessorUrl) return;
  try {
    await fetch(
      `${videoProcessorUrl}/api/v1/tts/jobs/${encodeURIComponent(jobId)}/cancel?allow_precreate=true`,
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

export function getTtsJobSnapshot(
  userId: string,
  jobId: string
): ActiveTtsJobSnapshot | null {
  pruneTtsRegistries();
  const entry = activeTtsJobs.get(jobId);
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

export async function cancelTtsJob(
  userId: string,
  jobId: string
): Promise<ActiveTtsJobSnapshot | null> {
  pruneTtsRegistries();
  const entry = activeTtsJobs.get(jobId);
  if (!entry) {
    if (!CLIENT_TTS_JOB_ID_RE.test(jobId)) {
      return null;
    }
    preCancelledTtsJobIds.set(jobId, Date.now());
    await forwardTtsCancelToPython(jobId);
    return {
      jobId,
      userId,
      status: "cancelled",
      stage: "cancelled",
      stageLabel: "Voiceover cancelled",
      cancelled: true,
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      error: "Voiceover synthesis cancelled.",
    };
  }

  if (entry.userId !== userId) {
    return null;
  }

  if (entry.status !== "completed" && entry.status !== "failed") {
    entry.cancelled = true;
    entry.status = "cancelled";
    entry.stage = "cancelled";
    entry.stageLabel = "Voiceover cancelled";
    entry.error = "Voiceover synthesis cancelled.";
    entry.finishedAtMs = entry.finishedAtMs ?? Date.now();
    try {
      entry.abortController.abort(new Error("Voiceover synthesis cancelled."));
    } catch {
      // Ignore abort errors
    }
    await forwardTtsCancelToPython(jobId);
  }

  return getTtsJobSnapshot(userId, jobId);
}

export async function shutdownActiveTtsJobs(): Promise<void> {
  const entries = Array.from(activeTtsJobs.values());
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
      await forwardTtsCancelToPython(entry.jobId);
    }
  }
}

export async function fetchProcessorTtsStatus(): Promise<TtsStatusResult> {
  const cfg = getEnvConfig();
  const disabledFallback: TtsStatusResult = {
    enabled: cfg.ttsEnabled,
    available: false,
    configuredProvider: cfg.ttsProvider,
    activeProvider: null,
    defaultLanguage: cfg.ttsDefaultLanguage,
    supportedLanguages: [],
    mp3Supported: false,
    maxTextChars: cfg.ttsMaxTextChars,
    maxAudioMb: cfg.ttsMaxAudioMb,
    providers: [],
    message: !cfg.ttsEnabled || cfg.ttsProvider === "none"
      ? "Local text-to-speech is disabled by server configuration."
      : !cfg.videoProcessorUrl
        ? "Python FastAPI processor is not configured (set VIDEO_PROCESSOR_URL in .env)."
        : "Local Python video-processor is unreachable. Start uvicorn to probe local TTS voices.",
  };

  if (!cfg.ttsEnabled || cfg.ttsProvider === "none" || !cfg.videoProcessorUrl) {
    return disabledFallback;
  }

  try {
    const res = await fetch(`${cfg.videoProcessorUrl}/api/v1/tts/status`, {
      method: "GET",
      headers: getProcessorHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return {
        ...disabledFallback,
        message: `Local TTS status probe returned HTTP ${res.status}.`,
      };
    }

    const raw = (await res.json()) as {
      enabled?: boolean;
      available?: boolean;
      configured_provider?: string;
      active_provider?: string | null;
      default_language?: "en" | "hi" | "bn";
      supported_languages?: Array<"en" | "hi" | "bn">;
      mp3_supported?: boolean;
      max_text_chars?: number;
      max_audio_mb?: number;
      providers?: Array<{
        provider: "piper" | "espeak_ng" | "windows_sapi";
        label: string;
        available: boolean;
        installed: boolean;
        license: string;
        supported_languages?: Array<"en" | "hi" | "bn">;
        voice_count?: number;
        message?: string;
      }>;
      message?: string;
    };

    const effectiveMaxChars = Math.min(
      cfg.ttsMaxTextChars,
      typeof raw.max_text_chars === "number" && raw.max_text_chars > 0
        ? raw.max_text_chars
        : cfg.ttsMaxTextChars
    );

    return {
      enabled: Boolean(raw.enabled ?? cfg.ttsEnabled),
      available: Boolean(raw.available),
      configuredProvider: raw.configured_provider || cfg.ttsProvider,
      activeProvider: raw.active_provider ?? null,
      defaultLanguage: raw.default_language || cfg.ttsDefaultLanguage,
      supportedLanguages: Array.isArray(raw.supported_languages) ? raw.supported_languages : [],
      mp3Supported: Boolean(raw.mp3_supported),
      maxTextChars: effectiveMaxChars,
      maxAudioMb:
        typeof raw.max_audio_mb === "number" && raw.max_audio_mb > 0
          ? raw.max_audio_mb
          : cfg.ttsMaxAudioMb,
      providers: Array.isArray(raw.providers)
        ? raw.providers.map((p) => ({
            provider: p.provider,
            label: p.label,
            available: Boolean(p.available),
            installed: Boolean(p.installed),
            license: p.license,
            supportedLanguages: Array.isArray(p.supported_languages) ? p.supported_languages : [],
            voiceCount: Number(p.voice_count || 0),
            message: sanitizeTtsErrorMessage(p.message, ""),
          }))
        : [],
      message: sanitizeTtsErrorMessage(raw.message, disabledFallback.message),
    };
  } catch {
    return disabledFallback;
  }
}

export async function fetchProcessorTtsVoices(options?: {
  language?: string;
  provider?: string;
}): Promise<TtsVoicesResult> {
  const cfg = getEnvConfig();
  const normalizedLanguage = options?.language
    ? normalizeTtsLanguageInput(options.language)
    : null;

  if (!cfg.ttsEnabled || cfg.ttsProvider === "none") {
    return {
      available: false,
      provider: null,
      language: normalizedLanguage,
      voices: [],
      supportedLanguages: [],
      message: "Local text-to-speech is disabled by server configuration.",
    };
  }

  if (!cfg.videoProcessorUrl) {
    return {
      available: false,
      provider: null,
      language: normalizedLanguage,
      voices: [],
      supportedLanguages: [],
      message: "Python FastAPI video-processor is not configured.",
    };
  }

  const query = new URLSearchParams();
  if (normalizedLanguage) query.set("language", normalizedLanguage);
  if (options?.provider && options.provider.trim()) {
    query.set("provider", options.provider.trim());
  }
  const qs = query.toString();

  let res: Response;
  try {
    res = await fetch(
      `${cfg.videoProcessorUrl}/api/v1/tts/voices${qs ? `?${qs}` : ""}`,
      {
        method: "GET",
        headers: getProcessorHeaders(),
        signal: AbortSignal.timeout(4000),
      }
    );
  } catch {
    return {
      available: false,
      provider: null,
      language: normalizedLanguage,
      voices: [],
      supportedLanguages: [],
      message: "Local Python video-processor is unreachable. Start uvicorn to list voices.",
    };
  }

  const raw = (await res.json().catch(() => ({}))) as {
    available?: boolean;
    provider?: string | null;
    language?: "en" | "hi" | "bn" | null;
    voices?: Array<{
      voice_id: string;
      provider: "piper" | "espeak_ng" | "windows_sapi";
      label: string;
      language: "en" | "hi" | "bn";
      language_tag: string;
      gender?: string | null;
      quality?: string;
      sample_rate_hz?: number | null;
      description?: string | null;
    }>;
    supported_languages?: Array<"en" | "hi" | "bn">;
    message?: string;
    error?: string;
  };

  if (!res.ok) {
    throw Object.assign(
      new Error(sanitizeTtsErrorMessage(raw.error || raw.message, `Failed to list TTS voices (${res.status}).`)),
      { statusCode: res.status >= 400 && res.status < 600 ? res.status : 502 }
    );
  }

  return {
    available: Boolean(raw.available),
    provider: raw.provider ?? null,
    language: raw.language ?? normalizedLanguage,
    voices: Array.isArray(raw.voices)
      ? raw.voices.map((v) => ({
          voiceId: v.voice_id,
          provider: v.provider,
          label: v.label,
          language: v.language,
          languageTag: v.language_tag,
          gender: v.gender ?? null,
          quality: v.quality || "standard",
          sampleRateHz: v.sample_rate_hz ?? null,
          description: v.description ?? null,
        }))
      : [],
    supportedLanguages: Array.isArray(raw.supported_languages) ? raw.supported_languages : [],
    message: sanitizeTtsErrorMessage(raw.message, "Local voices loaded."),
  };
}

async function readResponseBytesBounded(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader) {
    const expected = Number(contentLengthHeader);
    if (Number.isFinite(expected) && expected > maxBytes) {
      throw Object.assign(
        new Error(`Synthesized audio exceeds maximum size (${Math.round(maxBytes / (1024 * 1024))} MB).`),
        { statusCode: 413 }
      );
    }
  }

  if (!res.body) {
    const arr = Buffer.from(await res.arrayBuffer());
    if (arr.length > maxBytes) {
      throw Object.assign(new Error("Synthesized audio exceeds maximum size limit."), { statusCode: 413 });
    }
    return arr;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error("Voiceover synthesis cancelled."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw Object.assign(new Error("Synthesized audio exceeds maximum allowed size."), {
            statusCode: 413,
          });
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export async function synthesizeProcessorTtsAudio(params: {
  userId: string;
  input: ValidatedTtsGenerateRequest;
  headerJobId?: string;
  requestAbortSignal?: AbortSignal;
}): Promise<{
  jobId: string;
  buffer: Buffer;
  contentType: string;
  filename: string;
  provider: string;
  voiceId: string;
  voiceLabel: string;
  language: "en" | "hi" | "bn";
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
  format: "wav" | "mp3";
}> {
  pruneTtsRegistries();
  const cfg = getEnvConfig();

  if (!cfg.ttsEnabled || cfg.ttsProvider === "none") {
    throw Object.assign(
      new Error("Local text-to-speech is disabled by server configuration."),
      { statusCode: 503, integrationPoint: "Local Text-to-Speech" }
    );
  }

  if (!cfg.videoProcessorUrl) {
    throw Object.assign(
      new Error(
        "Python FastAPI video processor is not configured (set VIDEO_PROCESSOR_URL)."
      ),
      { statusCode: 503, integrationPoint: "Python FastAPI Video Processor" }
    );
  }

  const cleanText = params.input.text.trim();
  if (cleanText.length > cfg.ttsMaxTextChars) {
    throw Object.assign(
      new Error(
        `Scene narration exceeds server maximum of ${cfg.ttsMaxTextChars} characters.`
      ),
      { statusCode: 400 }
    );
  }

  const normLang = normalizeTtsLanguageInput(params.input.language);
  const rawCid = (params.input.clientJobId || params.headerJobId || "").trim();
  const jobId = CLIENT_TTS_JOB_ID_RE.test(rawCid)
    ? rawCid
    : `tts_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  if (preCancelledTtsJobIds.has(jobId)) {
    preCancelledTtsJobIds.delete(jobId);
    throw Object.assign(new Error("Voiceover synthesis cancelled."), {
      statusCode: 499,
      cancelled: true,
    });
  }

  const abortController = new AbortController();
  const entry: ActiveTtsJobEntry = {
    jobId,
    userId: params.userId,
    status: "queued",
    stage: "queued",
    stageLabel: "Queued for local TTS",
    cancelled: false,
    startedAtMs: Date.now(),
    abortController,
  };
  activeTtsJobs.set(jobId, entry);

  const onExternalAbort = () => {
    if (!entry.cancelled && entry.status !== "completed" && entry.status !== "failed") {
      entry.cancelled = true;
      entry.status = "cancelled";
      entry.stage = "cancelled";
      entry.stageLabel = "Voiceover cancelled";
      entry.finishedAtMs = Date.now();
      try {
        abortController.abort(new Error("Voiceover request aborted by client."));
      } catch {
        // Ignore
      }
      void forwardTtsCancelToPython(jobId);
    }
  };
  params.requestAbortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let acquiredSlot = false;
  try {
    acquiredSlot = await acquireTtsConcurrencySlot(abortController.signal);
    if (entry.cancelled || abortController.signal.aborted) {
      throw Object.assign(new Error("Voiceover synthesis cancelled."), {
        statusCode: 499,
        cancelled: true,
      });
    }

    entry.status = "processing";
    entry.stage = "synthesizing";
    entry.stageLabel = "Synthesizing speech locally";

    const pythonPayload = {
      text: cleanText,
      language: normLang,
      ...(params.input.provider ? { provider: params.input.provider } : {}),
      ...(params.input.voiceId ? { voice_id: params.input.voiceId } : {}),
      speaking_rate: params.input.speakingRate,
      pitch: params.input.pitch,
      format: params.input.format,
      client_job_id: jobId,
    };

    const timeoutSignal = AbortSignal.timeout(cfg.ttsRequestTimeoutMs);
    const combinedSignal = AbortSignal.any([abortController.signal, timeoutSignal]);

    let res: Response;
    try {
      res = await fetch(`${cfg.videoProcessorUrl}/api/v1/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TTS-Job-Id": jobId,
          ...getProcessorHeaders(),
        },
        body: JSON.stringify(pythonPayload),
        signal: combinedSignal,
      });
    } catch (err) {
      if (entry.cancelled || abortController.signal.aborted) {
        throw Object.assign(new Error("Voiceover synthesis cancelled."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      if (err instanceof Error && (err.name === "TimeoutError" || timeoutSignal.aborted)) {
        await forwardTtsCancelToPython(jobId);
        throw Object.assign(
          new Error("Local TTS synthesis timed out. Try shorter narration or faster rate."),
          { statusCode: 504 }
        );
      }
      throw Object.assign(
        new Error(
          "Python FastAPI TTS service is unreachable. Start local uvicorn service to generate voiceovers."
        ),
        { statusCode: 503, integrationPoint: "Local Text-to-Speech" }
      );
    }

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        cancelled?: boolean;
      };
      const isCancelled = res.status === 499 || Boolean(errBody.cancelled) || entry.cancelled;
      if (isCancelled) {
        throw Object.assign(new Error("Voiceover synthesis cancelled."), {
          statusCode: 499,
          cancelled: true,
        });
      }
      const message = sanitizeTtsErrorMessage(
        errBody.error || errBody.detail,
        `Local TTS synthesis failed (${res.status}).`
      );
      throw Object.assign(new Error(message), {
        statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
      });
    }

    const maxBytes = cfg.ttsMaxAudioMb * 1024 * 1024;
    const buffer = await readResponseBytesBounded(res, maxBytes, abortController.signal);
    if (buffer.length === 0) {
      throw Object.assign(new Error("Local TTS engine returned an empty audio stream."), {
        statusCode: 502,
      });
    }

    const decodeHeader = (raw: string | null, fallback: string) => {
      if (!raw) return fallback;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };

    const provider = res.headers.get("x-tts-provider") || "espeak_ng";
    const voiceId = decodeHeader(res.headers.get("x-tts-voice-id"), `${provider}:${normLang}`);
    const voiceLabel = decodeHeader(res.headers.get("x-tts-voice-label"), voiceId);
    const respLanguage = (res.headers.get("x-tts-language") || normLang) as "en" | "hi" | "bn";
    const durationRaw = Number(res.headers.get("x-tts-duration"));
    const sampleRateRaw = Number(res.headers.get("x-tts-sample-rate"));
    const channelsRaw = Number(res.headers.get("x-tts-channels"));
    const respFormat = res.headers.get("x-tts-format") === "mp3" ? "mp3" : "wav";
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() ||
      (respFormat === "mp3" ? "audio/mpeg" : "audio/wav");

    const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;
    if (durationSeconds <= 0) {
      throw Object.assign(
        new Error("Generated voiceover audio did not report a valid FFprobe-verified duration."),
        { statusCode: 502 }
      );
    }

    const filename = `voiceover_${respLanguage}_${jobId.slice(0, 8)}.${respFormat}`;
    entry.status = "completed";
    entry.stage = "completed";
    entry.stageLabel = "Voiceover audio ready";
    entry.finishedAtMs = Date.now();

    return {
      jobId,
      buffer,
      contentType,
      filename,
      provider,
      voiceId,
      voiceLabel,
      language: respLanguage,
      durationSeconds,
      sampleRateHz: Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? sampleRateRaw : 22050,
      channels: Number.isFinite(channelsRaw) && channelsRaw > 0 ? channelsRaw : 1,
      format: respFormat,
    };
  } catch (err) {
    const isCancelled = Boolean((err as { cancelled?: boolean }).cancelled) || entry.cancelled;
    entry.status = isCancelled ? "cancelled" : "failed";
    entry.cancelled = isCancelled;
    entry.stage = isCancelled ? "cancelled" : "failed";
    entry.stageLabel = isCancelled ? "Voiceover cancelled" : "Voiceover failed";
    entry.error = sanitizeTtsErrorMessage(
      err instanceof Error ? err.message : undefined,
      "Local TTS synthesis failed."
    );
    entry.finishedAtMs = entry.finishedAtMs ?? Date.now();
    throw err;
  } finally {
    params.requestAbortSignal?.removeEventListener("abort", onExternalAbort);
    releaseTtsConcurrencySlot(acquiredSlot);
  }
}
