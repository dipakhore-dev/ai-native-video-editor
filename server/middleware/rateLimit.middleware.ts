import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "./auth.middleware.ts";

interface BucketRecord {
  count: number;
  resetAtMs: number;
}

export interface RateLimiterOptions {
  name: string;
  windowMs: number;
  maxRequests: number | (() => number);
  maxEntries?: number;
  message?: string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, BucketRecord>();
  const maxEntries = options.maxEntries ?? 5000;
  let requestCounter = 0;

  const pruneExpired = (now: number) => {
    for (const [key, entry] of buckets.entries()) {
      if (entry.resetAtMs <= now) {
        buckets.delete(key);
      }
    }
    while (buckets.size > maxEntries) {
      const oldestKey = buckets.keys().next().value;
      if (!oldestKey) break;
      buckets.delete(oldestKey);
    }
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    requestCounter += 1;
    if (requestCounter % 200 === 0 || buckets.size >= maxEntries) {
      pruneExpired(now);
    }

    const authReq = req as AuthenticatedRequest;
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0].trim()
        : req.ip) || "unknown";
    const subject = authReq.userId ? `user:${authReq.userId}` : `ip:${ip}`;
    const key = `${options.name}:${subject}`;

    const limit =
      typeof options.maxRequests === "function"
        ? Math.max(1, options.maxRequests())
        : Math.max(1, options.maxRequests);

    const existing = buckets.get(key);
    let record: BucketRecord;
    if (!existing || existing.resetAtMs <= now) {
      record = { count: 1, resetAtMs: now + options.windowMs };
      buckets.set(key, record);
    } else {
      existing.count += 1;
      record = existing;
    }

    const remaining = Math.max(0, limit - record.count);
    const resetSeconds = Math.max(1, Math.ceil((record.resetAtMs - now) / 1000));
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSeconds));

    if (record.count > limit) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({
        error:
          options.message ||
          `Too many requests on ${options.name}. Please wait ${resetSeconds}s and try again.`,
        retryAfterSeconds: resetSeconds,
      });
      return;
    }

    next();
  };

  return Object.assign(middleware, {
    reset: () => buckets.clear(),
    size: () => buckets.size,
  });
}
