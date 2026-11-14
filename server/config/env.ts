export interface AppEnvConfig {
  port: number;
  nodeEnv: string;
  isProd: boolean;
  mongodbUri: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  authCookieName: string;
  clientOrigin: string;
  geminiApiKey: string;
  videoProcessorUrl: string;
  videoProcessorApiKey: string;
  redisUrl: string;
  videoUploadMaxMb: number;
  videoGenProviderUrl: string;
}

export function getEnvConfig(): AppEnvConfig {
  const nodeEnv = process.env.NODE_ENV || "development";
  return {
    port: Number(process.env.PORT || 3000),
    nodeEnv,
    isProd: nodeEnv === "production",
    mongodbUri: (process.env.MONGODB_URI || "").trim(),
    jwtSecret: (process.env.JWT_SECRET || "").trim(),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    authCookieName: process.env.AUTH_COOKIE_NAME || "ai_studio_token",
    clientOrigin: process.env.CLIENT_ORIGIN || process.env.APP_URL || "http://localhost:3000",
    geminiApiKey: (process.env.GEMINI_API_KEY || "").trim(),
    videoProcessorUrl: (process.env.VIDEO_PROCESSOR_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    videoProcessorApiKey: (process.env.VIDEO_PROCESSOR_API_KEY || "").trim(),
    redisUrl: (process.env.REDIS_URL || "").trim(),
    videoUploadMaxMb: Math.max(1, Number(process.env.VIDEO_UPLOAD_MAX_MB || 500)),
    videoGenProviderUrl: (process.env.VIDEO_GEN_PROVIDER_URL || "").trim(),
  };
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

export function isGeminiConfigured(): boolean {
  const { geminiApiKey } = getEnvConfig();
  return Boolean(geminiApiKey && geminiApiKey !== "MY_GEMINI_API_KEY");
}

export function isJwtConfigured(): boolean {
  const { jwtSecret } = getEnvConfig();
  return Boolean(jwtSecret && jwtSecret.length >= 16 && jwtSecret !== "REPLACE_WITH_SECURE_RANDOM_SECRET");
}

export function isRedisConfigured(): boolean {
  return Boolean(getEnvConfig().redisUrl);
}

export function isVideoProcessorUrlConfigured(): boolean {
  return Boolean(getEnvConfig().videoProcessorUrl);
}

export function isVideoGenProviderConfigured(): boolean {
  return Boolean(getEnvConfig().videoGenProviderUrl);
}
