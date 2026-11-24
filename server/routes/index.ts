import { Router } from "express";
import { getDatabaseStatus } from "../config/database.ts";
import {
  isGeminiConfigured,
  isJwtConfigured,
  isVideoGenProviderConfigured,
} from "../config/env.ts";
import { getVideoQueueStatus } from "../queues/videoQueue.ts";
import {
  checkVideoProcessorHealth,
  isVideoServerShuttingDown,
} from "../services/videoProcessor.service.ts";
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
  const shuttingDown = isVideoServerShuttingDown();
  res.json({
    status: shuttingDown ? "shutting_down" : "ok",
    runtime: `Node ${process.version}`,
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      configured: db.configured,
      connected: db.connected,
      readyState: db.readyState,
    },
    redisQueue: queue,
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/health/live", (_req, res) => {
  res.status(200).json({
    status: "ok",
    live: true,
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/health/ready", (_req, res) => {
  const db = getDatabaseStatus();
  const shuttingDown = isVideoServerShuttingDown();
  const dbRequiredButDisconnected = db.configured && !db.connected;
  const ready = !shuttingDown && !dbRequiredButDisconnected;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    ready,
    shuttingDown,
    databaseConnected: db.connected,
    databaseConfigured: db.configured,
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/integrations/status", async (_req, res) => {
  const db = getDatabaseStatus();
  const geminiReady = isGeminiConfigured();
  const jwtReady = isJwtConfigured();
  const videoGenReady = isVideoGenProviderConfigured();
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
        provider: "Local Browser IndexedDB (₹0 Free Mode)",
        endpoint: "/api/media",
        summary:
          "Media Blobs persist locally in your browser's IndexedDB across refreshes/restarts while stable asset IDs and metadata sync to MongoDB (no paid cloud bucket required).",
      },
      aiAssistant: {
        id: "aiAssistant",
        label: "Editorial AI Assistant",
        connected: geminiReady,
        provider: geminiReady ? "Gemini 4 Hydrogen (@google/genai)" : "Server LLM Endpoint (Set GEMINI_API_KEY)",
        endpoint: "POST /api/ai/assistant",
        summary: geminiReady
          ? "Connected to Gemini API on the Node.js server with Zod-validated timeline editing operations."
          : "Requires GEMINI_API_KEY in server environment to translate natural-language editing instructions.",
      },
      videoGeneration: {
        id: "videoGeneration",
        label: "Paid Text-to-Video Generation",
        connected: videoGenReady,
        provider: videoGenReady
          ? "External Provider Configured"
          : "Disabled (No Paid Provider Configured)",
        endpoint: "POST /api/ai/generate-video",
        summary: videoGenReady
          ? "VIDEO_GEN_PROVIDER_URL is configured; wire your provider adapter to dispatch requests."
          : "Disabled in ₹0 local mode until an external video generation provider (VIDEO_GEN_PROVIDER_URL) is configured.",
      },
      renderWorker: {
        id: "renderWorker",
        label: "Local Python FFmpeg/FFprobe Service",
        connected:
          processorHealth.reachable &&
          processorHealth.ffprobeAvailable &&
          processorHealth.ffmpegAvailable,
        provider: !processorHealth.configured
          ? "Unavailable (Set VIDEO_PROCESSOR_URL)"
          : processorHealth.reachable && processorHealth.ffprobeAvailable
            ? "FastAPI + FFmpeg/FFprobe (Active)"
            : "Unavailable (Start Local Uvicorn Service)",
        endpoint: "POST /api/video/export-mp4",
        summary: !processorHealth.configured
          ? "Python FastAPI service is not configured. Start video-processor locally on Windows PowerShell and set VIDEO_PROCESSOR_URL (see docs/WINDOWS_LOCAL_SETUP.md)."
          : processorHealth.reachable && processorHealth.ffprobeAvailable
            ? "Local Python FastAPI service is active for synchronous metadata, thumbnails, trimming, aspect-ratio conversion, clip merging, and MP4 export."
            : "VIDEO_PROCESSOR_URL is set, but the Python FastAPI service is not reachable. Start uvicorn in video-processor/.",
      },
      localSubtitles: {
        id: "localSubtitles",
        label: "Local Subtitles (faster-whisper)",
        connected: processorHealth.reachable && processorHealth.fasterWhisperAvailable,
        provider:
          processorHealth.reachable && processorHealth.fasterWhisperAvailable
            ? "faster-whisper CPU (Active)"
            : "Unavailable (Start Local video-processor)",
        endpoint: "POST /api/video/subtitles",
        summary:
          processorHealth.reachable && processorHealth.fasterWhisperAvailable
            ? "Local faster-whisper speech-to-subtitle transcription is active on CPU at ₹0 cost."
            : "Runs locally via faster-whisper inside the Python FastAPI service (no paid transcription API required).",
      },
      jobQueue: {
        id: "jobQueue",
        label: "Redis & BullMQ Queue (Optional)",
        connected: queueStatus.connected,
        provider: queueStatus.connected
          ? "Redis + BullMQ Worker (Active)"
          : "Optional (Sync Processing Active Without Redis)",
        endpoint: "GET /api/video/jobs",
        summary: queueStatus.connected
          ? "Connected to Redis for asynchronous background video processing."
          : "Redis is optional. Basic synchronous metadata and short-video FFmpeg operations run without Redis.",
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
