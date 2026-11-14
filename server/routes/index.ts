import { Router } from "express";
import { getDatabaseStatus } from "../config/database.ts";
import { isGeminiConfigured, isJwtConfigured } from "../config/env.ts";
import { getVideoQueueStatus } from "../queues/videoQueue.ts";
import { checkVideoProcessorHealth } from "../services/videoProcessor.service.ts";
import { authRouter } from "./auth.routes.ts";
import { projectRouter } from "./project.routes.ts";
import { mediaRouter } from "./media.routes.ts";
import { aiRouter } from "./ai.routes.ts";
import { exportRouter } from "./export.routes.ts";
import { videoProcessingRouter } from "./videoProcessing.routes.ts";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  const db = getDatabaseStatus();
  const queue = getVideoQueueStatus();
  res.json({
    status: "ok",
    runtime: `Node ${process.version}`,
    uptimeSeconds: Math.round(process.uptime()),
    database: db,
    redisQueue: queue,
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/integrations/status", async (_req, res) => {
  const db = getDatabaseStatus();
  const geminiReady = isGeminiConfigured();
  const jwtReady = isJwtConfigured();
  const queueStatus = getVideoQueueStatus();
  const processorHealth = await checkVideoProcessorHealth();

  res.json({
    integrations: {
      database: {
        id: "database",
        label: "MongoDB & Mongoose",
        connected: db.connected,
        provider: db.connected ? "MongoDB (Connected via Mongoose)" : "MongoDB (Set MONGODB_URI)",
        endpoint: "/api/projects",
        summary: db.connected
          ? "Connected to MongoDB for persistent projects, timelines, media metadata, and job tracking."
          : "MONGODB_URI is not connected in this runtime. Projects and timelines remain in browser session/localStorage.",
      },
      objectStorage: {
        id: "objectStorage",
        label: "Media Object Storage",
        connected: false,
        provider: "S3 / Cloud Storage (Unconnected)",
        endpoint: "/api/media",
        summary:
          "Media metadata schemas are ready in MongoDB; binary video files remain local via browser Object URLs until S3/GCS is attached.",
      },
      aiAssistant: {
        id: "aiAssistant",
        label: "Editorial AI Assistant",
        connected: geminiReady,
        provider: geminiReady ? "Gemini 4 Hydrogen (@google/genai)" : "Server LLM Endpoint (Unconnected)",
        endpoint: "POST /api/ai/assistant",
        summary: geminiReady
          ? "Connected to Gemini API on the Node.js server with Zod-validated timeline editing operations."
          : "Requires GEMINI_API_KEY in server environment to translate natural-language editing instructions.",
      },
      videoGeneration: {
        id: "videoGeneration",
        label: "AI Video Generation Worker",
        connected: false,
        provider: "Text-to-Video / Image-to-Video Queue (Unconnected)",
        endpoint: "POST /api/ai/generate-video",
        summary:
          "Request validation is active. Connect an external video synthesis worker to dispatch and stream generated clips.",
      },
      renderWorker: {
        id: "renderWorker",
        label: "Python FFmpeg/FFprobe Processor",
        connected: processorHealth.reachable && processorHealth.ffprobeAvailable,
        provider: !processorHealth.configured
          ? "FastAPI Microservice (Set VIDEO_PROCESSOR_URL)"
          : processorHealth.reachable && processorHealth.ffprobeAvailable
            ? "FastAPI + FFmpeg/FFprobe (Active)"
            : "FastAPI Microservice (Unreachable)",
        endpoint: "POST /api/video/metadata",
        summary: !processorHealth.configured
          ? "Deploy video-processor/ externally (e.g. Cloud Run) and set VIDEO_PROCESSOR_URL to enable FFprobe/FFmpeg endpoints."
          : processorHealth.reachable && processorHealth.ffprobeAvailable
            ? "Python FastAPI microservice is reachable with FFprobe metadata extraction active."
            : "VIDEO_PROCESSOR_URL is configured, but the FastAPI service /health endpoint could not be reached.",
      },
      jobQueue: {
        id: "jobQueue",
        label: "Redis & BullMQ Queue",
        connected: queueStatus.connected,
        provider: queueStatus.connected
          ? "Redis + BullMQ Worker (Active)"
          : "Redis + BullMQ (Set REDIS_URL)",
        endpoint: "GET /api/video/jobs",
        summary: queueStatus.connected
          ? "Connected to Redis for background video processing jobs."
          : "BullMQ queue & worker are wired; set REDIS_URL to enable asynchronous background processing.",
      },
      authProvider: {
        id: "authProvider",
        label: "JWT HTTP-Only Cookie Auth",
        connected: db.connected && jwtReady,
        provider:
          db.connected && jwtReady
            ? "Mongoose Users + JWT Cookies (Active)"
            : "JWT + Mongoose Auth (Requires MONGODB_URI & JWT_SECRET)",
        endpoint: "POST /api/auth/login",
        summary:
          db.connected && jwtReady
            ? "User registration, bcrypt password hashing, and HTTP-only JWT cookie authentication are active."
            : "Auth routes, bcrypt hashing, and HTTP-only cookie middleware are ready once MONGODB_URI and JWT_SECRET are set.",
      },
    },
    checkedAt: new Date().toISOString(),
  });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/projects", projectRouter);
apiRouter.use("/media", mediaRouter);
apiRouter.use("/ai", aiRouter);
apiRouter.use("/exports", exportRouter);
apiRouter.use("/video", videoProcessingRouter);
