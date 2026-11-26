import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { getAllowedOrigins, getEnvConfig, normalizeOrigin } from "../config/env.ts";

export interface RequestWithContext extends Request {
  requestId?: string;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function sanitizeErrorMessage(raw: string, fallback = "An unexpected error occurred."): string {
  const cleaned = (raw || "")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[a-zA-Z0-9.-]+)(?::\d+)?(?:\/[^\s"']*)?/gi, "[service-endpoint]")
    .replace(/[A-Za-z]:\\(?:[^\s"'<>|:*?]+\\)*[^\s"'<>|:*?]*/g, "[server-path]")
    .replace(/(?:^|[\s(])(\/(?:tmp|var|app|home|Users|etc|opt)\/[^\s"')]+)/g, " [server-path]")
    .trim();
  return cleaned || fallback;
}

export function sanitizeFilenameForDisposition(raw: string, fallback = "download.mp4"): string {
  const base = raw.split(/[\\/]/).pop() || fallback;
  const sanitized = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return sanitized || fallback;
}

export function sanitizeObjectInPlace(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = sanitizeObjectInPlace(value[i], depth + 1);
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith("$") || FORBIDDEN_KEYS.has(key)) {
      delete record[key];
      continue;
    }
    const nested = record[key];
    if (nested && typeof nested === "object") {
      sanitizeObjectInPlace(nested, depth + 1);
    }
  }
  return record;
}

export function requestIdMiddleware(req: RequestWithContext, res: Response, next: NextFunction): void {
  const incomingId =
    typeof req.headers["x-request-id"] === "string" &&
    /^[A-Za-z0-9_-]{8,64}$/.test(req.headers["x-request-id"].trim())
      ? req.headers["x-request-id"].trim()
      : crypto.randomUUID();
  req.requestId = incomingId;
  res.setHeader("X-Request-Id", incomingId);

  const startedAt = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api")) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (res.statusCode >= 500 || elapsedMs > 15_000) {
      console.warn(
        JSON.stringify({
          level: res.statusCode >= 500 ? "error" : "warn",
          requestId: incomingId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: elapsedMs,
        })
      );
    }
  });

  next();
}

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { isProd } = getEnvConfig();
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protoValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const isHttps = Boolean(
    req.secure || protoValue?.split(",")[0]?.trim().toLowerCase() === "https"
  );

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");

  if (isHttps && isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Keep CSP compatible with AI Studio preview iframe, Tailwind runtime styles, and local blob/IndexedDB media playback.
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    isProd
      ? "script-src 'self'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws: wss: https:",
    "worker-src 'self' blob:",
    "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com",
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  next();
}

export function isOriginAllowedForRequest(
  originHeader: string | undefined,
  req: Pick<Request, "headers" | "protocol" | "secure">,
  allowedOrigins: Set<string> = getAllowedOrigins()
): boolean {
  if (!originHeader) {
    return true;
  }
  const normalized = normalizeOrigin(originHeader);
  if (!normalized) {
    return false;
  }
  if (allowedOrigins.has(normalized)) {
    return true;
  }

  const forwardedHost = req.headers["x-forwarded-host"];
  const rawHost =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
    req.headers.host;
  if (typeof rawHost === "string" && rawHost.trim()) {
    const cleanHost = rawHost.split(",")[0].trim().toLowerCase();
    try {
      const originUrl = new URL(normalized);
      if (originUrl.host.toLowerCase() === cleanHost) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

export function corsAllowlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  const originHeader = req.headers.origin;
  if (typeof originHeader === "string" && originHeader.trim()) {
    const allowed = isOriginAllowedForRequest(originHeader, req);
    if (!allowed) {
      if (req.path.startsWith("/api")) {
        res.status(403).json({
          error: "Cross-origin request rejected by CORS policy.",
        });
        return;
      }
      next();
      return;
    }

    const normalized = normalizeOrigin(originHeader)!;
    res.setHeader("Access-Control-Allow-Origin", normalized);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, X-Export-Job-Id, X-TTS-Job-Id, X-Request-Id"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Request-Id, X-Video-Job-Id, X-Export-Client-Job-Id, X-Export-Profile, X-Export-Encoder, X-Export-Fallback, Content-Disposition, X-Stock-Provider, X-Stock-Asset-Id, X-Stock-Media-Type, X-Stock-Title, X-Stock-Creator, X-Stock-Attribution-Url, X-Stock-License, X-Stock-Width, X-Stock-Height, X-Stock-Duration, X-TTS-Job-Id, X-TTS-Provider, X-TTS-Voice-Id, X-TTS-Voice-Label, X-TTS-Language, X-TTS-Duration, X-TTS-Sample-Rate, X-TTS-Channels, X-TTS-Format"
    );
  }

  if (req.method === "OPTIONS" && req.path.startsWith("/api")) {
    res.status(204).end();
    return;
  }

  next();
}

export function isCsrfRequestAllowed(req: Request): boolean {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    return true;
  }

  const secFetchSite =
    typeof req.headers["sec-fetch-site"] === "string"
      ? req.headers["sec-fetch-site"].trim().toLowerCase()
      : "";
  if (secFetchSite === "cross-site") {
    return false;
  }

  const originHeader =
    typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (originHeader) {
    return isOriginAllowedForRequest(originHeader, req);
  }

  const refererHeader =
    typeof req.headers.referer === "string" ? req.headers.referer.trim() : "";
  if (refererHeader) {
    return isOriginAllowedForRequest(refererHeader, req);
  }

  return true;
}

export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isCsrfRequestAllowed(req)) {
    res.status(403).json({
      error: "Cross-site state-changing request rejected.",
    });
    return;
  }
  next();
}

export function sanitizeRequestInputMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object") {
    sanitizeObjectInPlace(req.body);
  }
  if (req.query && typeof req.query === "object") {
    sanitizeObjectInPlace(req.query);
  }
  next();
}

export function sanitizedErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent || res.writableEnded) {
    next(err);
    return;
  }

  const errObj = err as { statusCode?: number; status?: number; type?: string; message?: string };
  if (errObj?.type === "entity.too.large") {
    res.status(413).json({ error: "Request JSON payload exceeds the maximum allowed size." });
    return;
  }
  if (err instanceof SyntaxError && errObj?.status === 400) {
    res.status(400).json({ error: "Malformed JSON request body." });
    return;
  }

  const statusCode =
    typeof errObj?.statusCode === "number" && errObj.statusCode >= 400 && errObj.statusCode < 600
      ? errObj.statusCode
      : 500;
  const message =
    statusCode >= 500
      ? "Internal server error."
      : sanitizeErrorMessage(errObj?.message || "Request failed.");

  res.status(statusCode).json({ error: message });
}
