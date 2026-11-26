export interface AppEnvConfig {
  port: number;
  nodeEnv: string;
  isProd: boolean;
  mongodbUri: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  authCookieName: string;
  clientOrigin: string;
  corsAllowedOrigins: string[];
  geminiApiKey: string;
  geminiModel: string;
  geminiFallbackModels: string[];
  videoProcessorUrl: string;
  videoProcessorApiKey: string;
  redisUrl: string;
  videoUploadMaxMb: number;
  videoGenProviderUrl: string;
  maxConcurrentExports: number;
  maxUserActiveExports: number;
  maxExportQueueWaitMs: number;
  exportTimeoutMs: number;
  aiRequestTimeoutMs: number;
  uploadTempMaxAgeMs: number;
  rateLimitAuthMax: number;
  rateLimitAiMax: number;
  rateLimitVideoMax: number;
  rateLimitExportMax: number;
  stockMediaProvider: "none" | "pexels";
  pexelsApiKey: string;
  stockMediaRequestTimeoutMs: number;
  stockMediaMaxResults: number;
  stockMediaMaxImportBytes: number;
  ttsEnabled: boolean;
  ttsProvider: "auto" | "espeak_ng" | "piper" | "windows_sapi" | "none";
  ttsDefaultLanguage: "en" | "hi" | "bn";
  ttsMaxTextChars: number;
  ttsMaxConcurrentJobs: number;
  ttsRequestTimeoutMs: number;
  ttsMaxBatchScenes: number;
  ttsMaxAudioMb: number;
  rateLimitTtsMax: number;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const MAX_GEMINI_MODEL_ATTEMPTS = 3;

const VALID_GEMINI_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,79}$/;

export function parseGeminiModelName(raw?: string): string | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith("models/")) {
    cleaned = cleaned.slice("models/".length).trim();
  }
  if (!cleaned || !VALID_GEMINI_MODEL_RE.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function parseGeminiFallbackModels(
  raw: string | undefined,
  primaryModel: string
): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  const seen = new Set<string>([primaryModel]);
  const fallbacks: string[] = [];
  for (const part of raw.split(",")) {
    const parsed = parseGeminiModelName(part);
    if (!parsed || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    fallbacks.push(parsed);
    if (fallbacks.length >= MAX_GEMINI_MODEL_ATTEMPTS - 1) {
      break;
    }
  }
  return fallbacks;
}

export function resolveGeminiModelCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const cfg = getEnvConfig(env);
  return [cfg.geminiModel, ...cfg.geminiFallbackModels].slice(0, MAX_GEMINI_MODEL_ATTEMPTS);
}

export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "MY_APP_URL") {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function parseAllowedOriginsList(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.CORS_ALLOWED_ORIGINS) {
    candidates.push(...env.CORS_ALLOWED_ORIGINS.split(","));
  }
  if (env.APP_URL) {
    candidates.push(env.APP_URL);
  }
  if (env.CLIENT_ORIGIN) {
    candidates.push(env.CLIENT_ORIGIN);
  }

  const normalized = new Set<string>();
  for (const item of candidates) {
    const origin = normalizeOrigin(item);
    if (origin) {
      normalized.add(origin);
    }
  }
  return Array.from(normalized);
}

export function getEnvConfig(env: NodeJS.ProcessEnv = process.env): AppEnvConfig {
  const nodeEnv = (env.NODE_ENV || "development").trim() || "development";
  const geminiModel = parseGeminiModelName(env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
  const geminiFallbackModels = parseGeminiFallbackModels(
    env.GEMINI_FALLBACK_MODELS,
    geminiModel
  );
  return {
    port: parseBoundedInt(env.PORT, 3000, 1, 65535),
    nodeEnv,
    isProd: nodeEnv === "production",
    mongodbUri: (env.MONGODB_URI || "").trim(),
    jwtSecret: (env.JWT_SECRET || "").trim(),
    jwtExpiresIn: (env.JWT_EXPIRES_IN || "7d").trim() || "7d",
    authCookieName: (env.AUTH_COOKIE_NAME || "ai_studio_token").trim() || "ai_studio_token",
    clientOrigin: env.CLIENT_ORIGIN || env.APP_URL || "http://localhost:3000",
    corsAllowedOrigins: parseAllowedOriginsList(env),
    geminiApiKey: (env.GEMINI_API_KEY || "").trim(),
    geminiModel,
    geminiFallbackModels,
    videoProcessorUrl: (env.VIDEO_PROCESSOR_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    videoProcessorApiKey: (env.VIDEO_PROCESSOR_API_KEY || "").trim(),
    redisUrl: (env.REDIS_URL || "").trim(),
    videoUploadMaxMb: parseBoundedInt(env.VIDEO_UPLOAD_MAX_MB, 500, 1, 4096),
    videoGenProviderUrl: (env.VIDEO_GEN_PROVIDER_URL || "").trim(),
    maxConcurrentExports: parseBoundedInt(env.MAX_CONCURRENT_EXPORTS, 2, 1, 16),
    maxUserActiveExports: parseBoundedInt(env.MAX_USER_ACTIVE_EXPORTS, 1, 1, 8),
    maxExportQueueWaitMs: parseBoundedInt(env.MAX_EXPORT_QUEUE_WAIT_MS, 5000, 0, 60_000),
    exportTimeoutMs: parseBoundedInt(env.VIDEO_EXPORT_TIMEOUT_MS, 360_000, 30_000, 1_800_000),
    aiRequestTimeoutMs: parseBoundedInt(env.AI_REQUEST_TIMEOUT_MS, 25_000, 3_000, 120_000),
    uploadTempMaxAgeMs: parseBoundedInt(env.UPLOAD_TEMP_MAX_AGE_MS, 3_600_000, 60_000, 86_400_000),
    rateLimitAuthMax: parseBoundedInt(env.RATE_LIMIT_AUTH_MAX, 25, 1, 500),
    rateLimitAiMax: parseBoundedInt(env.RATE_LIMIT_AI_MAX, 20, 1, 500),
    rateLimitVideoMax: parseBoundedInt(env.RATE_LIMIT_VIDEO_MAX, 40, 1, 1000),
    rateLimitExportMax: parseBoundedInt(env.RATE_LIMIT_EXPORT_MAX, 10, 1, 200),
    stockMediaProvider:
      (env.STOCK_MEDIA_PROVIDER || "none").trim().toLowerCase() === "pexels"
        ? "pexels"
        : "none",
    pexelsApiKey: (env.PEXELS_API_KEY || "").trim(),
    stockMediaRequestTimeoutMs: parseBoundedInt(
      env.STOCK_MEDIA_REQUEST_TIMEOUT_MS,
      15_000,
      3_000,
      60_000
    ),
    stockMediaMaxResults: parseBoundedInt(env.STOCK_MEDIA_MAX_RESULTS, 15, 1, 30),
    stockMediaMaxImportBytes:
      parseBoundedInt(env.STOCK_MEDIA_MAX_IMPORT_MB, 80, 5, 250) * 1024 * 1024,
    ttsEnabled: !/^(0|false|no|off)$/i.test((env.TTS_ENABLED || "true").trim()),
    ttsProvider: (() => {
      const p = (env.TTS_PROVIDER || "auto").trim().toLowerCase();
      if (p === "espeak_ng" || p === "piper" || p === "windows_sapi" || p === "none") {
        return p;
      }
      return "auto";
    })(),
    ttsDefaultLanguage: (() => {
      const l = (env.TTS_DEFAULT_LANGUAGE || "en").trim().toLowerCase();
      if (l === "hi" || l === "hindi") return "hi";
      if (l === "bn" || l === "bengali") return "bn";
      return "en";
    })(),
    ttsMaxTextChars: parseBoundedInt(env.TTS_MAX_TEXT_CHARS, 1500, 100, 5000),
    ttsMaxConcurrentJobs: parseBoundedInt(env.TTS_MAX_CONCURRENT_JOBS, 1, 1, 4),
    ttsRequestTimeoutMs: parseBoundedInt(env.TTS_REQUEST_TIMEOUT_MS, 45_000, 5_000, 180_000),
    ttsMaxBatchScenes: parseBoundedInt(env.TTS_MAX_BATCH_SCENES, 12, 1, 12),
    ttsMaxAudioMb: parseBoundedInt(env.TTS_MAX_AUDIO_MB, 25, 1, 100),
    rateLimitTtsMax: parseBoundedInt(env.RATE_LIMIT_TTS_MAX, 36, 1, 500),
  };
}

export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const cfg = getEnvConfig(env);
  const origins = new Set<string>(cfg.corsAllowedOrigins);
  if (!cfg.isProd) {
    origins.add(`http://localhost:${cfg.port}`);
    origins.add(`http://127.0.0.1:${cfg.port}`);
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  return origins;
}

export function normalizeJwtExpiresIn(raw?: string): string | number {
  const value = (raw || "7d").trim();
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

export function getAuthCookieMaxAgeMs(): number {
  const raw = (getEnvConfig().jwtExpiresIn || "7d").trim();
  if (/^\d+$/.test(raw)) {
    return Math.max(Number(raw) * 1000, 60_000);
  }
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(raw);
  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return amount * (multipliers[unit] ?? 24 * 60 * 60 * 1000);
}

export function isGeminiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const { geminiApiKey } = getEnvConfig(env);
  return Boolean(geminiApiKey && geminiApiKey !== "MY_GEMINI_API_KEY");
}

export function isJwtConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const { jwtSecret } = getEnvConfig(env);
  return Boolean(
    jwtSecret &&
      jwtSecret.length >= 16 &&
      jwtSecret !== "REPLACE_WITH_SECURE_RANDOM_SECRET"
  );
}

export function isRedisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getEnvConfig(env).redisUrl);
}

export function isVideoProcessorUrlConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getEnvConfig(env).videoProcessorUrl);
}

export function isVideoGenProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getEnvConfig(env).videoGenProviderUrl);
}

export function isStockMediaConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = getEnvConfig(env);
  return cfg.stockMediaProvider === "pexels" && Boolean(cfg.pexelsApiKey);
}

export interface StartupValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateStartupEnv(env: NodeJS.ProcessEnv = process.env): StartupValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cfg = getEnvConfig(env);

  if (env.PORT !== undefined && env.PORT.trim() !== "") {
    const portNum = Number(env.PORT);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      errors.push("PORT must be an integer between 1 and 65535.");
    }
  }

  if (env.VIDEO_UPLOAD_MAX_MB !== undefined && env.VIDEO_UPLOAD_MAX_MB.trim() !== "") {
    const maxMb = Number(env.VIDEO_UPLOAD_MAX_MB);
    if (!Number.isFinite(maxMb) || maxMb < 1 || maxMb > 4096) {
      errors.push("VIDEO_UPLOAD_MAX_MB must be between 1 and 4096.");
    }
  }

  if (cfg.videoProcessorUrl) {
    try {
      const parsed = new URL(cfg.videoProcessorUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("VIDEO_PROCESSOR_URL must use http:// or https://.");
      }
    } catch {
      errors.push("VIDEO_PROCESSOR_URL is not a valid URL.");
    }
  }

  if (cfg.videoGenProviderUrl) {
    try {
      const parsed = new URL(cfg.videoGenProviderUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("VIDEO_GEN_PROVIDER_URL must use http:// or https://.");
      }
    } catch {
      errors.push("VIDEO_GEN_PROVIDER_URL is not a valid URL.");
    }
  }

  if (env.GEMINI_MODEL !== undefined && env.GEMINI_MODEL.trim() !== "") {
    if (!parseGeminiModelName(env.GEMINI_MODEL)) {
      warnings.push(
        `GEMINI_MODEL value is invalid; falling back to default model "${DEFAULT_GEMINI_MODEL}".`
      );
    }
  }

  if (cfg.stockMediaProvider === "pexels" && !cfg.pexelsApiKey) {
    warnings.push(
      "STOCK_MEDIA_PROVIDER=pexels is set without PEXELS_API_KEY; free stock search remains disabled until PEXELS_API_KEY is configured."
    );
  }

  if (env.TTS_PROVIDER !== undefined && env.TTS_PROVIDER.trim() !== "") {
    const rawTtsProv = env.TTS_PROVIDER.trim().toLowerCase();
    if (!["auto", "espeak_ng", "piper", "windows_sapi", "none"].includes(rawTtsProv)) {
      warnings.push(
        `TTS_PROVIDER value "${env.TTS_PROVIDER}" is invalid; falling back to "auto".`
      );
    }
  }

  if (cfg.isProd) {
    if (!isJwtConfigured(env)) {
      errors.push(
        "Production startup blocked: JWT_SECRET must be set to a random secret of at least 16 characters."
      );
    }
    if (cfg.videoProcessorUrl && cfg.videoProcessorApiKey.length < 16) {
      errors.push(
        "Production startup blocked: VIDEO_PROCESSOR_API_KEY (minimum 16 characters) is required when VIDEO_PROCESSOR_URL is configured."
      );
    }
    if (cfg.corsAllowedOrigins.length === 0) {
      warnings.push(
        "No explicit CORS_ALLOWED_ORIGINS/APP_URL origin configured; cross-origin browser API requests will be rejected."
      );
    }
  } else {
    if (cfg.mongodbUri && !isJwtConfigured(env)) {
      warnings.push(
        "MONGODB_URI is set without a strong JWT_SECRET (>= 16 chars); authenticated routes will fail until JWT_SECRET is set."
      );
    }
    if (cfg.videoProcessorUrl && !cfg.videoProcessorApiKey) {
      warnings.push(
        "VIDEO_PROCESSOR_API_KEY is empty in local development mode. Set a shared secret before deploying."
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
