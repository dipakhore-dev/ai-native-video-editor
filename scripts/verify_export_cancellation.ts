import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import React from "react";
import { renderToString } from "react-dom/server";
import type { AuthenticatedRequest } from "../server/middleware/auth.middleware.ts";
import {
  cancelExportController,
  exportMp4VideoController,
  getExportProgressController,
} from "../server/controllers/videoProcessing.controller.ts";
import {
  handleExportUploadMiddleware,
  preRegisterExportUploadMiddleware,
} from "../server/routes/videoProcessing.routes.ts";
import { VideoJobModel } from "../server/models/VideoJob.ts";
import {
  cancelActiveExport,
  getExportProgressSnapshot,
  isExportCancelled,
  registerActiveExport,
} from "../server/services/videoProcessor.service.ts";
import { cancelExportMp4, exportTimelineMp4 } from "../src/services/api.ts";
import { ExportModal } from "../src/components/editor/ExportModal.tsx";
import { StudioProvider } from "../src/context/StudioContext.tsx";
import { createDefaultTracks } from "../src/utils/timeline.ts";
import type { Project } from "../src/types/studio.ts";

const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), "ai-studio-express-uploads");

function listExpressUploadFiles(): string[] {
  if (!fs.existsSync(UPLOAD_TEMP_DIR)) return [];
  return fs.readdirSync(UPLOAD_TEMP_DIR);
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 25
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return Boolean(await predicate());
}

async function testServiceLevelTombstonesOwnershipAndIdempotency() {
  const missing = await cancelActiveExport("user_a", "missing_job_id_12345");
  assert.equal(missing, null, "Unknown job without allowPrecreate must return null");

  const preSnap = await cancelActiveExport("user_a", "precancel_job_1234", {
    allowPrecreate: true,
  });
  assert.ok(preSnap);
  assert.equal(preSnap.status, "cancelled");
  assert.equal(preSnap.cancelled, true);

  const tmpFile = path.join(os.tmpdir(), `cancel_unit_${Date.now()}.tmp`);
  await fsp.writeFile(tmpFile, Buffer.from("temp-bytes"));

  const preAc = registerActiveExport({
    jobId: "precancel_job_1234",
    userId: "user_a",
    tempFilePaths: [tmpFile],
  });
  assert.equal(preAc.signal.aborted, true, "Pre-cancelled job must start with aborted AbortController");
  assert.equal(isExportCancelled("precancel_job_1234"), true);

  // Repeated idempotent cancel cleans attached temp file too
  const [c1, c2] = await Promise.all([
    cancelActiveExport("user_a", "precancel_job_1234"),
    cancelActiveExport("user_a", "precancel_job_1234"),
  ]);
  assert.equal(c1?.status, "cancelled");
  assert.equal(c2?.status, "cancelled");
  assert.equal(fs.existsSync(tmpFile), false, "Temp file must be unlinked on cancel");

  // Ownership check: different user cannot query or cancel active job
  const activeAc = registerActiveExport({
    jobId: "owned_job_12345678",
    userId: "owner_user",
    tempFilePaths: [],
  });
  assert.equal(activeAc.signal.aborted, false);
  assert.equal(await getExportProgressSnapshot("other_user", "owned_job_12345678"), null);
  assert.equal(await cancelActiveExport("other_user", "owned_job_12345678"), null);

  const ownerCancel = await cancelActiveExport("owner_user", "owned_job_12345678");
  assert.equal(ownerCancel?.status, "cancelled");
  assert.equal(activeAc.signal.aborted, true);
}

interface MockJobDoc {
  _id: string;
  status: string;
  progress: number;
  processorJobId?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  completedAt?: Date;
  saveCount: number;
  save: () => Promise<MockJobDoc>;
}

async function testExpressHttpEndToEndCancellationFlows() {
  const beforeFiles = new Set(listExpressUploadFiles());

  const fastApiRequests: Array<{
    path: string;
    xExportJobId?: string;
    abortedByClient: boolean;
  }> = [];
  const cancelCallsToFastApi: string[] = [];

  type FastApiMode = "hang_stream" | "slow_near_complete" | "slow_download" | "ok";
  let fastApiMode: FastApiMode = "hang_stream";
  let fastApiReceivedRequest = false;
  let fastApiReleaseHook: (() => void) | null = null;
  let activeExpressJobIdForNearComplete: string | null = null;

  const mockFastApi = http.createServer((req, res) => {
    const urlPath = req.url || "/";
    if (req.method === "POST" && urlPath.startsWith("/api/v1/jobs/") && urlPath.endsWith("/cancel") || (req.method === "POST" && urlPath.includes("/cancel?"))) {
      cancelCallsToFastApi.push(urlPath);
      if (fastApiReleaseHook) {
        fastApiReleaseHook();
        fastApiReleaseHook = null;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          job_id: "mock",
          operation: "export_mp4",
          status: "cancelled",
          progress: 0,
          stage: "cancelled",
          stage_label: "Export cancelled",
          measurable: false,
          elapsed_ms: 10,
          cancelled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          error: "Export cancelled by user.",
        })
      );
      return;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/v1/jobs/")) {
      const id = decodeURIComponent(urlPath.replace("/api/v1/jobs/", ""));
      const wasCancelled = cancelCallsToFastApi.some((c) => c.includes(id));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          job_id: id,
          status: wasCancelled ? "cancelled" : "processing",
          stage: wasCancelled ? "cancelled" : "rendering_v1",
          stage_label: wasCancelled ? "Export cancelled" : "Rendering video",
          progress: wasCancelled ? 0 : 45,
          measurable: !wasCancelled,
          elapsed_ms: 120,
          cancelled: wasCancelled,
          error: wasCancelled ? "Export cancelled by user." : null,
        })
      );
      return;
    }

    if (req.method === "POST" && urlPath === "/api/v1/export-mp4") {
      fastApiReceivedRequest = true;
      const entry = {
        path: urlPath,
        xExportJobId:
          typeof req.headers["x-export-job-id"] === "string"
            ? req.headers["x-export-job-id"]
            : undefined,
        abortedByClient: false,
      };
      fastApiRequests.push(entry);

      req.on("aborted", () => {
        entry.abortedByClient = true;
      });
      req.on("close", () => {
        if (!req.complete) {
          entry.abortedByClient = true;
        }
      });

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (fastApiMode === "hang_stream") {
          // Hold response open until cancelled / timed out
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(499, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ cancelled: true, error: "Export cancelled by user." }));
            }
          }, 8000);
          fastApiReleaseHook = () => {
            clearTimeout(timer);
            if (!res.writableEnded) {
              res.writeHead(499, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ cancelled: true, error: "Export cancelled by user." }));
            }
          };
          return;
        }

        if (fastApiMode === "slow_download") {
          // Stream headers + initial chunk, pause so client/Express can abort mid-response
          const bodyChunk = Buffer.alloc(64 * 1024, 0x41);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Disposition": 'attachment; filename="test_slow.mp4"',
            "Content-Length": String(bodyChunk.length * 4),
            "X-Processor-Job-Id": entry.xExportJobId || "proc_slow",
          });
          res.write(bodyChunk);
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.end(Buffer.alloc(bodyChunk.length * 3, 0x42));
            }
          }, 5000);
          fastApiReleaseHook = () => {
            clearTimeout(timer);
            if (!res.destroyed) res.destroy();
          };
          return;
        }

        const mp4Bytes = Buffer.from("ftypmp42_mock_valid_output_bytes");
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Disposition": 'attachment; filename="valid_output.mp4"',
          "Content-Length": String(mp4Bytes.length),
          "X-Processor-Job-Id": entry.xExportJobId || "proc_ok",
          "X-Export-Profile": "fast_preview",
          "X-Export-Encoder": "libx264",
          "X-Export-Fallback": "0",
        });
        res.end(mp4Bytes);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => mockFastApi.listen(0, "127.0.0.1", resolve));
  const fastApiPort = (mockFastApi.address() as { port: number }).port;

  const prevProcessorUrl = process.env.VIDEO_PROCESSOR_URL;
  process.env.VIDEO_PROCESSOR_URL = `http://127.0.0.1:${fastApiPort}`;

  const createdJobDocs = new Map<string, MockJobDoc>();
  let seqId = 1;
  const origCreate = VideoJobModel.create;
  const origFindOneAndUpdate = VideoJobModel.findOneAndUpdate;
  let delaySaveOnCompletion = false;

  (VideoJobModel as unknown as Record<string, unknown>).create = async (doc: Record<string, unknown>) => {
    const id = `65f0000000000000000000${String(seqId++).padStart(2, "0")}`;
    const jobDoc: MockJobDoc = {
      _id: id,
      status: String(doc.status || "processing"),
      progress: Number(doc.progress ?? 15),
      saveCount: 0,
      save: async () => {
        jobDoc.saveCount += 1;
        if (delaySaveOnCompletion && jobDoc.status === "completed") {
          // Simulate slow Mongo save while user clicks cancel at ~100%
          if (activeExpressJobIdForNearComplete) {
            await cancelActiveExport("test_user_1", activeExpressJobIdForNearComplete);
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        return jobDoc;
      },
    };
    createdJobDocs.set(id, jobDoc);
    return jobDoc;
  };
  (VideoJobModel as unknown as Record<string, unknown>).findOneAndUpdate = async (
    filter: { _id?: string; status?: { $nin?: string[] } },
    update: { $set?: Record<string, unknown> }
  ) => {
    const existing = filter?._id ? createdJobDocs.get(String(filter._id)) : undefined;
    if (existing && update?.$set) {
      Object.assign(existing, update.$set);
    }
    return existing ?? null;
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).userId = "test_user_1";
    next();
  });
  app.post(
    "/api/video/export-mp4",
    preRegisterExportUploadMiddleware,
    handleExportUploadMiddleware(),
    exportMp4VideoController
  );
  app.get("/api/video/export-progress/:jobId", getExportProgressController);
  app.post("/api/video/export-cancel/:jobId", cancelExportController);

  const expressServer = http.createServer(app);
  await new Promise<void>((resolve) => expressServer.listen(0, "127.0.0.1", resolve));
  const expressPort = (expressServer.address() as { port: number }).port;

  try {
    // SCENARIO 1: Cancel mid-upload during Multer buffering before FormData completes
    {
      const jobId = "upload_cancel_job_01";
      const boundary = "----TestUploadCancelBoundary123";
      const partHeader =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="videos"; filename="big_source.mp4"\r\n` +
        `Content-Type: video/mp4\r\n\r\n`;

      const uploadResult = await new Promise<{
        abortedOrError: boolean;
        statusCode?: number;
        body?: string;
      }>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: expressPort,
            path: "/api/video/export-mp4",
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "X-Export-Job-Id": jobId,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({
                abortedOrError: false,
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          }
        );
        req.on("error", () => {
          resolve({ abortedOrError: true });
        });

        // Write partial MP4 bytes (~128KB), keep upload open while calling cancel!
        req.write(partHeader);
        req.write(Buffer.alloc(128 * 1024, 0x55));

        setTimeout(async () => {
          const cancelRes = await fetch(
            `http://127.0.0.1:${expressPort}/api/video/export-cancel/${jobId}?allowPrecreate=1`,
            { method: "POST" }
          );
          assert.equal(cancelRes.status, 200, "Cancel during Multer upload must return 200, never 404");
          const cancelJson = (await cancelRes.json()) as { progress: { status: string; cancelled: boolean } };
          assert.equal(cancelJson.progress.status, "cancelled");
          assert.equal(cancelJson.progress.cancelled, true);
          req.destroy();
        }, 80);
      });

      assert.equal(
        uploadResult.abortedOrError || uploadResult.statusCode === 499,
        true,
        `Expected upload request abort or 499, got ${JSON.stringify(uploadResult)}`
      );
      assert.equal(fastApiReceivedRequest, false, "Cancelled upload must never reach FastAPI");
      const leakedAfterUploadCancel = await waitForCondition(
        () => listExpressUploadFiles().filter((f) => !beforeFiles.has(f)).length === 0,
        3000
      );
      assert.equal(leakedAfterUploadCancel, true, "No Multer temp files may leak after upload cancel");
    }

    // SCENARIO 2: Cancel while streaming/rendering on FastAPI
    {
      fastApiMode = "hang_stream";
      fastApiReceivedRequest = false;
      const jobId = "ffmpeg_render_cancel_02";
      const boundary = "----TestStreamCancelBoundary456";
      const bodyBuf = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="format"\r\n\r\nmp4\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="clientJobId"\r\n\r\n${jobId}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="videos"; filename="clip.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n`
        ),
        Buffer.from("mock-mp4-data"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const exportPromise = fetch(`http://127.0.0.1:${expressPort}/api/video/export-mp4`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Export-Job-Id": jobId,
        },
        body: bodyBuf,
      });

      const reachedFastApi = await waitForCondition(() => fastApiReceivedRequest, 4000);
      if (!reachedFastApi) {
        const earlyRes = await Promise.race([
          exportPromise.then(async (r) => `${r.status}: ${await r.text()}`).catch((e) => String(e)),
          new Promise<string>((r) => setTimeout(() => r("still pending"), 300)),
        ]);
        assert.fail(`Export must reach mock FastAPI (Express returned: ${earlyRes})`);
      }
      assert.equal(fastApiRequests[fastApiRequests.length - 1]?.xExportJobId, jobId);

      // Fire repeated concurrent cancel requests -> must be idempotent
      const [cRes1, cRes2] = await Promise.all([
        fetch(`http://127.0.0.1:${expressPort}/api/video/export-cancel/${jobId}?allowPrecreate=1`, {
          method: "POST",
        }),
        fetch(`http://127.0.0.1:${expressPort}/api/video/export-cancel/${jobId}?allowPrecreate=1`, {
          method: "POST",
        }),
      ]);
      assert.equal(cRes1.status, 200);
      assert.equal(cRes2.status, 200);

      const expRes = await exportPromise;
      assert.equal(expRes.status, 499, "Cancelled FastAPI render must return HTTP 499 to browser");
      const expBody = (await expRes.json()) as { cancelled?: boolean; status?: string };
      assert.equal(expBody.cancelled, true);
      assert.equal(expBody.status, "cancelled");

      assert.ok(
        cancelCallsToFastApi.some((c) => c.includes(jobId) && c.includes("allow_precreate=true")),
        "Express must forward cancel with allow_precreate=true to FastAPI"
      );

      const snap = await getExportProgressSnapshot("test_user_1", jobId);
      assert.equal(snap?.status, "cancelled");
      assert.equal(snap?.cancelled, true);

      const cleanAfterRenderCancel = await waitForCondition(
        () => listExpressUploadFiles().filter((f) => !beforeFiles.has(f)).length === 0,
        3000
      );
      assert.equal(cleanAfterRenderCancel, true, "No Multer temp files may leak after render cancel");
    }

    // SCENARIO 3: Cancel right at near-100% completion during VideoJobModel.save()
    {
      fastApiMode = "ok";
      delaySaveOnCompletion = true;
      const jobId = "near_complete_cancel_03";
      activeExpressJobIdForNearComplete = jobId;
      const boundary = "----TestNearCompleteBoundary789";
      const bodyBuf = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="format"\r\n\r\nmp4\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="clientJobId"\r\n\r\n${jobId}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="videos"; filename="clip_near.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n`
        ),
        Buffer.from("mock-mp4-data"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const expRes = await fetch(`http://127.0.0.1:${expressPort}/api/video/export-mp4`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Export-Job-Id": jobId,
        },
        body: bodyBuf,
      });
      delaySaveOnCompletion = false;
      activeExpressJobIdForNearComplete = null;

      assert.equal(expRes.status, 499, "Cancel during final DB save must still return HTTP 499, never 200");
      const snap = await getExportProgressSnapshot("test_user_1", jobId);
      assert.equal(snap?.status, "cancelled", "Completed save must never overwrite cancelled status");
      assert.equal(snap?.cancelled, true);
    }

    // SCENARIO 4: Client aborts while FastAPI is streaming final MP4 delivery
    {
      fastApiMode = "slow_download";
      fastApiReceivedRequest = false;
      const jobId = "delivery_abort_job_04";
      const boundary = "----TestDeliveryAbortBoundary000";
      const bodyBuf = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="format"\r\n\r\nmp4\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="clientJobId"\r\n\r\n${jobId}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="videos"; filename="clip_deliv.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n`
        ),
        Buffer.from("mock-mp4-data"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const controller = new AbortController();
      const exportPromise = fetch(`http://127.0.0.1:${expressPort}/api/video/export-mp4`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Export-Job-Id": jobId,
        },
        body: bodyBuf,
        signal: controller.signal,
      }).catch((err) => err);

      await waitForCondition(() => fastApiReceivedRequest, 3000);
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await exportPromise;

      const becameCancelled = await waitForCondition(async () => {
        const snap = await getExportProgressSnapshot("test_user_1", jobId);
        return snap?.status === "cancelled";
      }, 3000);
      assert.equal(becameCancelled, true, "Aborting mid-MP4 delivery must mark job cancelled");
    }

    // SCENARIO 5: Immediate re-export right after cancellation succeeds cleanly
    {
      fastApiMode = "ok";
      const jobId = "immediate_reexport_05";
      const boundary = "----TestReexportBoundary111";
      const bodyBuf = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="format"\r\n\r\nmp4\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="exportProfile"\r\n\r\nfast_preview\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="encodingMode"\r\n\r\ncpu\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="clientJobId"\r\n\r\n${jobId}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="videos"; filename="clip_reexport.mp4"\r\n` +
            `Content-Type: video/mp4\r\n\r\n`
        ),
        Buffer.from("mock-mp4-data"),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const res = await fetch(`http://127.0.0.1:${expressPort}/api/video/export-mp4`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Export-Job-Id": jobId,
        },
        body: bodyBuf,
      });
      assert.equal(res.status, 200, "Immediate re-export after cancel must succeed with HTTP 200");
      const outBuf = Buffer.from(await res.arrayBuffer());
      assert.equal(outBuf.toString("utf8"), "ftypmp42_mock_valid_output_bytes");
      const snap = await getExportProgressSnapshot("test_user_1", jobId);
      assert.equal(snap?.status, "completed");

      const noLeakAfterReexport = await waitForCondition(
        () => listExpressUploadFiles().filter((f) => !beforeFiles.has(f)).length === 0,
        3000
      );
      assert.equal(noLeakAfterReexport, true);
    }
  } finally {
    const release = fastApiReleaseHook as (() => void) | null;
    if (release) {
      release();
    }
    (VideoJobModel as unknown as Record<string, unknown>).create = origCreate;
    (VideoJobModel as unknown as Record<string, unknown>).findOneAndUpdate = origFindOneAndUpdate;
    if (prevProcessorUrl === undefined) {
      delete process.env.VIDEO_PROCESSOR_URL;
    } else {
      process.env.VIDEO_PROCESSOR_URL = prevProcessorUrl;
    }
    expressServer.close();
    mockFastApi.close();
  }
}

async function testClientApiAndUiCancellationContracts() {
  const g = globalThis as Record<string, unknown>;
  const origXhr = g.XMLHttpRequest;
  const origFetch = g.fetch;
  const origWindow = g.window;
  const origLocalStorage = g.localStorage;

  const sentHeaders: Record<string, string> = {};
  const recordedFetches: Array<{ url: string; init?: RequestInit }> = [];

  class MockXMLHttpRequest {
    public withCredentials = false;
    public responseType = "";
    public status = 0;
    public response: unknown = null;
    public upload: {
      onprogress: ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    public onabort: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onload: (() => void) | null = null;

    open(_method: string, _url: string) {}
    setRequestHeader(name: string, val: string) {
      sentHeaders[name] = val;
    }
    getResponseHeader(name: string): string | null {
      if (name.toLowerCase() === "content-disposition") return 'attachment; filename="out.mp4"';
      return null;
    }
    abort() {
      // Intentionally simulate race where onload still fires with 200 right as signal aborts
    }
    send(_body: unknown) {
      setTimeout(() => {
        this.status = 200;
        this.response = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" });
        void this.onload?.();
      }, 10);
    }
  }

  g.XMLHttpRequest = MockXMLHttpRequest;
  g.fetch = async (url: string, init?: RequestInit) => {
    recordedFetches.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        status: "ok",
        progress: {
          jobId: "ui_cancel_job_01",
          status: "cancelled",
          stage: "cancelled",
          stageLabel: "Export cancelled",
          progress: 0,
          measurable: false,
          elapsedMs: 12,
          cancelled: true,
          error: "Export cancelled by user.",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  g.window = { location: { origin: "http://localhost:3000" } };
  g.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  try {
    // 1) Even if XHR fires onload(200) after signal is aborted, exportTimelineMp4 MUST return cancelled: true
    const ac = new AbortController();
    const promise = exportTimelineMp4(new FormData(), {
      clientJobId: "ui_cancel_job_01",
      signal: ac.signal,
    });
    assert.equal(sentHeaders["X-Export-Job-Id"], "ui_cancel_job_01");
    ac.abort();
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    assert.equal(res.status, 499);
    assert.equal(res.data, undefined);

    // 2) cancelExportMp4 passes ?allowPrecreate=1 and keepalive when requested
    const cancelRes = await cancelExportMp4("ui_cancel_job_01", {
      keepalive: true,
      allowPrecreate: true,
    });
    assert.equal(cancelRes.ok, true);
    assert.equal(
      recordedFetches[0]?.url,
      "/api/video/export-cancel/ui_cancel_job_01?allowPrecreate=1"
    );
    assert.equal(recordedFetches[0]?.init?.keepalive, true);

    // 3) ExportModal SSR render stays clean with no regressions
    const project: Project = {
      id: "proj_cancel_ui",
      name: "Cancel UI Regression",
      description: "Test",
      aspectRatio: "16:9",
      resolution: "1080p",
      fps: 24,
      tracks: createDefaultTracks(),
      clips: [],
      subtitles: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const html = renderToString(
      React.createElement(
        StudioProvider,
        null,
        React.createElement(ExportModal, {
          project,
          totalDuration: 5,
          onClose: () => undefined,
        })
      )
    );
    assert.ok(html.includes("Export MP4"));
    assert.ok(html.includes("Fast Preview (720p)"));
  } finally {
    g.XMLHttpRequest = origXhr;
    g.fetch = origFetch;
    g.window = origWindow;
    g.localStorage = origLocalStorage;
  }
}

await testServiceLevelTombstonesOwnershipAndIdempotency();
await testExpressHttpEndToEndCancellationFlows();
await testClientApiAndUiCancellationContracts();

console.log("ALL_EXPORT_CANCELLATION_VERIFICATIONS_PASSED");
