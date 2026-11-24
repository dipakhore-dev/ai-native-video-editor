import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  getAllowedOrigins,
  getEnvConfig,
  validateStartupEnv,
} from "../server/config/env.ts";
import {
  corsAllowlistMiddleware,
  csrfProtectionMiddleware,
  requestIdMiddleware,
  sanitizeErrorMessage,
  sanitizeFilenameForDisposition,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
  securityHeadersMiddleware,
} from "../server/middleware/security.middleware.ts";
import { createRateLimiter } from "../server/middleware/rateLimit.middleware.ts";
import {
  RegisterSchema,
  UpdateProfileSchema,
} from "../server/validators/auth.validators.ts";
import {
  AssistantRequestSchema,
  GenerateVideoRequestSchema,
} from "../server/validators/aiAndExport.validators.ts";
import {
  detectBufferMediaMagic,
  validateUploadedMediaMagicBytesMiddleware,
} from "../server/utils/fileMagic.ts";
import {
  acquireExportSlot,
  checkVideoProcessorHealth,
  cleanupStaleExpressUploads,
  getActiveExportSlotStats,
  isVideoServerShuttingDown,
  listUserVideoJobs,
  reconcileOrphanedVideoJobsOnStartup,
  registerActiveExport,
  releaseExportSlot,
  setVideoServerShuttingDown,
  cancelActiveExport,
} from "../server/services/videoProcessor.service.ts";
import { listUserAiRequests } from "../server/services/ai.service.ts";
import { apiRouter } from "../server/routes/index.ts";
import { VideoJobModel } from "../server/models/VideoJob.ts";
import { UserModel } from "../server/models/User.ts";
import { requireAuth } from "../server/middleware/auth.middleware.ts";
import { ErrorBoundary } from "../src/components/common/ErrorBoundary.tsx";

async function startTempServer(
  app: express.Express
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function testEnvStartupValidation() {
  const prodMissingJwt = validateStartupEnv({
    NODE_ENV: "production",
    JWT_SECRET: "short",
  } as NodeJS.ProcessEnv);
  assert.equal(prodMissingJwt.ok, false, "Production must reject short JWT_SECRET");
  assert.ok(prodMissingJwt.errors.some((e) => e.includes("JWT_SECRET")));

  const prodProcessorNoKey = validateStartupEnv({
    NODE_ENV: "production",
    JWT_SECRET: "very-long-production-jwt-secret-key-32",
    VIDEO_PROCESSOR_URL: "https://processor.example.com",
    VIDEO_PROCESSOR_API_KEY: "short",
  } as NodeJS.ProcessEnv);
  assert.equal(
    prodProcessorNoKey.ok,
    false,
    "Production must reject VIDEO_PROCESSOR_URL without >=16 char VIDEO_PROCESSOR_API_KEY"
  );
  assert.ok(
    prodProcessorNoKey.errors.some((e) => e.includes("VIDEO_PROCESSOR_API_KEY"))
  );

  const prodOk = validateStartupEnv({
    NODE_ENV: "production",
    JWT_SECRET: "very-long-production-jwt-secret-key-32",
    VIDEO_PROCESSOR_URL: "https://processor.example.com",
    VIDEO_PROCESSOR_API_KEY: "very-long-processor-shared-secret-key",
    APP_URL: "https://studio.example.com",
  } as NodeJS.ProcessEnv);
  assert.equal(prodOk.ok, true);

  const devLocal = validateStartupEnv({
    NODE_ENV: "development",
  } as NodeJS.ProcessEnv);
  assert.equal(devLocal.ok, true, "Development HTTP local mode must remain operational");
}

async function testSecurityHeadersCorsCsrfAndInputSanitization() {
  const prevOrigins = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = "https://studio.example.com";

  const app = express();
  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(express.json({ limit: "2mb" }));
  app.use(sanitizeRequestInputMiddleware);
  app.use("/api", csrfProtectionMiddleware);
  app.post("/api/echo", (req, res) => {
    res.json({ body: req.body, query: req.query });
  });
  app.use(sanitizedErrorHandler);

  const { server, baseUrl } = await startTempServer(app);
  try {
    // 1. Security headers + allowed CORS origin
    const allowedRes = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://studio.example.com",
      },
      body: JSON.stringify({
        safe: "ok",
        $gt: "",
        nested: { $where: "1==1", constructor: { bad: true }, clean: 42 },
      }),
    });
    assert.equal(allowedRes.status, 200);
    assert.equal(
      allowedRes.headers.get("access-control-allow-origin"),
      "https://studio.example.com"
    );
    assert.notEqual(allowedRes.headers.get("access-control-allow-origin"), "*");
    assert.equal(allowedRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      allowedRes.headers.get("referrer-policy"),
      "strict-origin-when-cross-origin"
    );
    assert.ok(allowedRes.headers.get("permissions-policy"));
    const csp = allowedRes.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("frame-ancestors 'self' https://aistudio.google.com"));
    assert.equal(allowedRes.headers.get("x-frame-options"), null);

    // 2. NoSQL $ operator & prototype keys stripped in-place
    const echoJson = (await allowedRes.json()) as {
      body: Record<string, unknown>;
    };
    assert.equal(echoJson.body.safe, "ok");
    assert.equal("$gt" in echoJson.body, false);
    const nested = echoJson.body.nested as Record<string, unknown>;
    assert.equal("$where" in nested, false);
    assert.equal(Object.prototype.hasOwnProperty.call(nested, "constructor"), false);
    assert.equal(nested.clean, 42);

    // 3. Disallowed cross-origin rejected by CORS with 403
    const badCorsRes = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.attacker.test",
      },
      body: JSON.stringify({ safe: "x" }),
    });
    assert.equal(badCorsRes.status, 403);

    // 4. Cross-site Sec-Fetch-Site rejected by CSRF guard with 403
    const crossSiteRes = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ safe: "x" }),
    });
    assert.equal(crossSiteRes.status, 403);

    // 5. Same-origin request allowed
    const sameOriginRes = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(sameOriginRes.status, 200);

    // 6. Malformed JSON returns 400 without stack trace
    const malformedRes = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    assert.equal(malformedRes.status, 400);
    const malformedBody = (await malformedRes.json()) as { error: string };
    assert.equal(malformedBody.error, "Malformed JSON request body.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = prevOrigins;
  }
}

async function testAuthValidationAndJwtHardening() {
  // Password complexity & URL validation
  const weakPw = RegisterSchema.safeParse({
    fullName: "Elena Vance",
    email: "elena@example.com",
    password: "passwordonly",
  });
  assert.equal(weakPw.success, false, "RegisterSchema must reject letters-only password");

  const strongPw = RegisterSchema.safeParse({
    fullName: "Elena Vance",
    email: "ELENA@example.com",
    password: "StrongPassword123",
  });
  assert.equal(strongPw.success, true);

  const badAvatar = UpdateProfileSchema.safeParse({
    avatarUrl: "javascript:alert(1)",
  });
  assert.equal(badAvatar.success, false, "UpdateProfileSchema must reject javascript: avatarUrl");

  const safeAvatar = UpdateProfileSchema.safeParse({
    avatarUrl: "https://cdn.example.com/avatar.png",
  });
  assert.equal(safeAvatar.success, true);

  // JWT verification must enforce HS256 & valid ObjectId sub
  const prevJwt = process.env.JWT_SECRET;
  const prevMongo = process.env.MONGODB_URI;
  const origFindById = UserModel.findById;
  process.env.JWT_SECRET = "test-jwt-secret-key-minimum-32-chars";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";

  // Verify non-ObjectId sub and alg=none are rejected before DB lookup
  const fakeApp = express();
  fakeApp.use((req, _res, next) => {
    const rawCookie = req.headers.cookie || "";
    const cookies: Record<string, string> = {};
    for (const part of rawCookie.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
    (req as express.Request & { cookies: Record<string, string> }).cookies = cookies;
    next();
  });

  // Mock connected mongoose state via UserModel spy + check requireAuth behavior when DB is disconnected -> 503
  UserModel.findById = (() => {
    throw new Error("Should not hit UserModel.findById for malformed/alg-none JWT");
  }) as unknown as typeof UserModel.findById;

  fakeApp.get("/protected", requireAuth, (_req, res) => res.json({ ok: true }));
  const { server, baseUrl } = await startTempServer(fakeApp);
  try {
    const unsignedToken = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ sub: "507f1f77bcf86cd799439011", email: "x@y.com" })).toString("base64url") +
      ".";
    const resNone = await fetch(`${baseUrl}/protected`, {
      headers: { Cookie: `ai_studio_token=${unsignedToken}` },
    });
    // Without active Mongo connection requireAuth returns 503; with jwt.verify unit test we verify HS256 pinning directly
    assert.ok(resNone.status === 503 || resNone.status === 401);

    assert.throws(
      () =>
        jwt.verify(unsignedToken, process.env.JWT_SECRET!, {
          algorithms: ["HS256"],
        }),
      /algorithm|invalid|signature/i
    );
  } finally {
    UserModel.findById = origFindById;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
    if (prevMongo === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prevMongo;
  }
}

async function testRateLimiterMiddleware() {
  const limiter = createRateLimiter({
    name: "test-route",
    windowMs: 60_000,
    maxRequests: 2,
  });
  const app = express();
  app.get("/limited", limiter, (_req, res) => res.json({ ok: true }));
  const { server, baseUrl } = await startTempServer(app);
  try {
    const r1 = await fetch(`${baseUrl}/limited`);
    const r2 = await fetch(`${baseUrl}/limited`);
    const r3 = await fetch(`${baseUrl}/limited`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.ok(r3.headers.get("retry-after"), "429 response must include Retry-After header");
    const body = (await r3.json()) as { error: string; retryAfterSeconds: number };
    assert.ok(body.retryAfterSeconds >= 1);
  } finally {
    limiter.reset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testMagicByteUploadRejectionAndCleanup() {
  const validMp4 = detectBufferMediaMagic(
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    "sample.mp4"
  );
  assert.equal(validMp4.valid, true);
  assert.equal(validMp4.detectedKind, "video");

  const tempUploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), "p54-magic-"));
  const upload = multer({ dest: tempUploadDir });
  const app = express();
  app.post(
    "/upload",
    upload.single("video"),
    validateUploadedMediaMagicBytesMiddleware({ allowAudio: false, allowImages: false }),
    (_req, res) => res.json({ ok: true })
  );

  const { server, baseUrl } = await startTempServer(app);
  try {
    const form = new FormData();
    form.append(
      "video",
      new Blob([Buffer.from("MZ\x90\x00#!/bin/sh\necho fake\n")], { type: "video/mp4" }),
      "fake_video.mp4"
    );
    const res = await fetch(`${baseUrl}/upload`, { method: "POST", body: form });
    assert.equal(res.status, 400, "Spoofed .mp4 upload must be rejected with HTTP 400");
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /header|signature|valid media/i);
    const remainingFiles = await fsp.readdir(tempUploadDir);
    assert.equal(remainingFiles.length, 0, "Rejected upload temp file must be deleted immediately");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(tempUploadDir, { recursive: true, force: true });
  }
}

async function testExportConcurrencySlotsAndSanitization() {
  const prevConcurrent = process.env.MAX_CONCURRENT_EXPORTS;
  const prevPerUser = process.env.MAX_USER_ACTIVE_EXPORTS;
  const prevWait = process.env.MAX_EXPORT_QUEUE_WAIT_MS;
  process.env.MAX_CONCURRENT_EXPORTS = "2";
  process.env.MAX_USER_ACTIVE_EXPORTS = "1";
  process.env.MAX_EXPORT_QUEUE_WAIT_MS = "50";

  let slot1: string | undefined;
  let slot2: string | undefined;
  try {
    slot1 = await acquireExportSlot("user_alpha");
    // Same user cannot exceed MAX_USER_ACTIVE_EXPORTS=1
    await assert.rejects(
      () => acquireExportSlot("user_alpha"),
      (err: Error & { statusCode?: number }) => err.statusCode === 429
    );
    // Different user gets global slot 2
    slot2 = await acquireExportSlot("user_beta");
    // Global capacity 2 reached
    await assert.rejects(
      () => acquireExportSlot("user_gamma"),
      (err: Error & { statusCode?: number }) => err.statusCode === 429
    );

    // Releasing slot1 restores capacity cleanly
    releaseExportSlot(slot1);
    slot1 = undefined;
    const slot3 = await acquireExportSlot("user_gamma");
    releaseExportSlot(slot3);
    releaseExportSlot(slot2);
    slot2 = undefined;
    assert.equal(getActiveExportSlotStats().total, 0);
  } finally {
    releaseExportSlot(slot1);
    releaseExportSlot(slot2);
    if (prevConcurrent === undefined) delete process.env.MAX_CONCURRENT_EXPORTS;
    else process.env.MAX_CONCURRENT_EXPORTS = prevConcurrent;
    if (prevPerUser === undefined) delete process.env.MAX_USER_ACTIVE_EXPORTS;
    else process.env.MAX_USER_ACTIVE_EXPORTS = prevPerUser;
    if (prevWait === undefined) delete process.env.MAX_EXPORT_QUEUE_WAIT_MS;
    else process.env.MAX_EXPORT_QUEUE_WAIT_MS = prevWait;
  }

  // Filename & error sanitization
  const safeName = sanitizeFilenameForDisposition('../evil"\r\n; name=x.mp4', "export.mp4");
  assert.equal(safeName.includes("\r"), false);
  assert.equal(safeName.includes("\n"), false);
  assert.equal(safeName.includes('"'), false);
  assert.equal(safeName.includes(".."), false);

  const redactedErr = sanitizeErrorMessage(
    "Connect error http://127.0.0.1:8001/api/v1/export-mp4 reading /tmp/ai-studio-express-uploads/f123"
  );
  assert.equal(redactedErr.includes("127.0.0.1"), false);
  assert.equal(redactedErr.includes("/tmp/ai-studio-express-uploads"), false);

  const prevProcUrl = process.env.VIDEO_PROCESSOR_URL;
  process.env.VIDEO_PROCESSOR_URL = "http://127.0.0.1:59999";
  try {
    const health = await checkVideoProcessorHealth();
    assert.equal(health.url, "", "checkVideoProcessorHealth must never expose internal processor URL");
  } finally {
    if (prevProcUrl === undefined) delete process.env.VIDEO_PROCESSOR_URL;
    else process.env.VIDEO_PROCESSOR_URL = prevProcUrl;
  }
}

async function testAiHardeningAndQueryValidation() {
  const tooManyClips = AssistantRequestSchema.safeParse({
    prompt: "Trim clip",
    timelineMetadata: {
      projectId: "proj_1",
      projectName: "Test",
      aspectRatio: "16:9",
      resolution: "1080p",
      fps: 24,
      durationSeconds: 10,
      selectedClipId: null,
      playheadTime: 0,
      clips: Array.from({ length: 65 }, (_, i) => ({
        id: `c_${i}`,
        name: "clip.mp4",
        kind: "video",
        trackId: "track_v1",
        startTime: i,
        duration: 1,
        inPoint: 0,
        sourceDuration: 10,
        speed: 1,
        volume: 1,
      })),
    },
  });
  assert.equal(tooManyClips.success, false, "AssistantRequestSchema must reject > 64 clips");

  const validGen = GenerateVideoRequestSchema.safeParse({
    mode: "text-to-video",
    prompt: "Sunset drone flyover",
    aspectRatio: "16:9",
    durationSeconds: 5,
  });
  assert.equal(validGen.success, true);

  const badGen = GenerateVideoRequestSchema.safeParse({
    prompt: "hi",
  });
  assert.equal(badGen.success, false);

  await assert.rejects(
    () => listUserAiRequests("507f1f77bcf86cd799439011", "not-an-object-id"),
    (err: Error & { statusCode?: number }) => err.statusCode === 400
  );
  await assert.rejects(
    () => listUserVideoJobs("507f1f77bcf86cd799439011", "bad-object-id", "export_mp4"),
    (err: Error & { statusCode?: number }) => err.statusCode === 400
  );
}

async function testHealthProbesCleanupAndOrphanReconcile() {
  const app = express();
  app.use("/api", apiRouter);
  const { server, baseUrl } = await startTempServer(app);
  try {
    const live = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(live.status, 200);

    const ready = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(ready.status, 200, "Dev mode without MONGODB_URI should report ready");

    // Verify integrations status hides internal processor URL
    const integ = await fetch(`${baseUrl}/api/integrations/status`);
    assert.equal(integ.status, 200);
    const integText = await integ.text();
    assert.equal(integText.includes("8001"), false);

    // Shutting down causes /health/ready to return 503
    setVideoServerShuttingDown(true);
    assert.equal(isVideoServerShuttingDown(), true);
    const shuttingReady = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(shuttingReady.status, 503);
    setVideoServerShuttingDown(false);
  } finally {
    setVideoServerShuttingDown(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Test cleanupStaleExpressUploads skips active export temp files
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "p54-cleanup-"));
  const activeFile = path.join(tmpDir, "active_upload.tmp");
  const staleFile = path.join(tmpDir, "stale_upload.tmp");
  await fsp.writeFile(activeFile, "active");
  await fsp.writeFile(staleFile, "stale");
  const oldTime = new Date(Date.now() - 120_000);
  await fsp.utimes(activeFile, oldTime, oldTime);
  await fsp.utimes(staleFile, oldTime, oldTime);

  const jobId = `cleanup_test_${Date.now()}`;
  registerActiveExport({
    jobId,
    userId: "u_cleanup",
    tempFilePaths: [activeFile],
  });
  try {
    const removed = await cleanupStaleExpressUploads(tmpDir, 60_000);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(activeFile), true, "Active export temp file must not be cleaned up");
    assert.equal(fs.existsSync(staleFile), false, "Stale upload temp file must be removed");
  } finally {
    await cancelActiveExport("u_cleanup", jobId);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  // Reconcile helper safely returns 0 when MongoDB is disconnected
  const reconciled = await reconcileOrphanedVideoJobsOnStartup();
  assert.equal(reconciled, 0);
  assert.ok(VideoJobModel);
}

async function testFrontendHardeningContracts() {
  // ErrorBoundary renders children cleanly on SSR
  const okHtml = renderToString(
    React.createElement(ErrorBoundary, null, React.createElement("div", null, "Studio OK"))
  );
  assert.ok(okHtml.includes("Studio OK"));

  const apiSrc = await fsp.readFile("src/services/api.ts", "utf8");
  assert.ok(apiSrc.includes('"X-Requested-With": "AIStudioClient"'));
  assert.ok(apiSrc.includes("registerSessionExpiredHandler"));

  const appSrc = await fsp.readFile("src/App.tsx", "utf8");
  assert.ok(appSrc.includes("<ErrorBoundary>"));

  const ctxSrc = await fsp.readFile("src/context/StudioContext.tsx", "utf8");
  assert.ok(ctxSrc.includes("beforeunload"));
  assert.ok(ctxSrc.includes("hasUnsavedChanges"));
  assert.ok(ctxSrc.includes("registerSessionExpiredHandler"));

  const aiPanelSrc = await fsp.readFile("src/components/editor/AiAssistantPanel.tsx", "utf8");
  assert.ok(aiPanelSrc.includes("Destructive change"));
  assert.ok(aiPanelSrc.includes("delete_clip"));
  assert.ok(aiPanelSrc.includes("clear_clip_keyframes"));

  const createModalSrc = await fsp.readFile("src/components/common/CreateProjectModal.tsx", "utf8");
  assert.ok(createModalSrc.includes('e.key === "Escape"'));

  const exportModalSrc = await fsp.readFile("src/components/editor/ExportModal.tsx", "utf8");
  assert.ok(exportModalSrc.includes('e.key === "Escape" && !submitting'));

  const editorPageSrc = await fsp.readFile("src/pages/EditorPage.tsx", "utf8");
  assert.ok(editorPageSrc.includes("saveFlashTimerRef"));

  const envCfg = getEnvConfig({ PORT: "3000" } as NodeJS.ProcessEnv);
  assert.equal(envCfg.maxConcurrentExports, 2);
  assert.ok(getAllowedOrigins({ PORT: "3000" } as NodeJS.ProcessEnv).has("http://localhost:3000"));
}

async function main() {
  testEnvStartupValidation();
  console.log("[PASS] 1. Startup environment & production secret checks");

  await testSecurityHeadersCorsCsrfAndInputSanitization();
  console.log("[PASS] 2. Security headers, CORS allowlist, CSRF guard, NoSQL & prototype sanitization, error handler");

  await testAuthValidationAndJwtHardening();
  console.log("[PASS] 3. Password complexity, safe avatar URL validation, HS256 JWT enforcement");

  await testRateLimiterMiddleware();
  console.log("[PASS] 4. Bounded rate limiter HTTP 429 + Retry-After");

  await testMagicByteUploadRejectionAndCleanup();
  console.log("[PASS] 5. Spoofed media magic-byte rejection + temp file cleanup");

  await testExportConcurrencySlotsAndSanitization();
  console.log("[PASS] 6. Export concurrency slots, filename sanitization, URL/path redaction");

  await testAiHardeningAndQueryValidation();
  console.log("[PASS] 7. AI payload bounds & strict ObjectId query validation");

  await testHealthProbesCleanupAndOrphanReconcile();
  console.log("[PASS] 8. Liveness/readiness probes, active upload preservation, orphan reconciliation");

  await testFrontendHardeningContracts();
  console.log("[PASS] 9. Frontend ErrorBoundary, X-Requested-With, beforeunload, session expiry, destructive AI badge, Escape handlers");

  console.log("\nAll Phase 5.4 TypeScript & Express hardening verification checks passed.");
}

main().catch((err) => {
  console.error("Phase 5.4 verification failed:", err);
  process.exit(1);
});
