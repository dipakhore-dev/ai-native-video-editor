import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { connectDatabase, disconnectDatabase } from "./server/config/database.ts";
import { getEnvConfig, validateStartupEnv } from "./server/config/env.ts";
import {
  corsAllowlistMiddleware,
  csrfProtectionMiddleware,
  requestIdMiddleware,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
  securityHeadersMiddleware,
} from "./server/middleware/security.middleware.ts";
import { initializeVideoQueue } from "./server/queues/videoQueue.ts";
import { apiRouter } from "./server/routes/index.ts";
import { EXPRESS_UPLOAD_TEMP_DIR } from "./server/routes/videoProcessing.routes.ts";
import {
  cleanupStaleExpressUploads,
  reconcileOrphanedVideoJobsOnStartup,
  shutdownVideoExports,
} from "./server/services/videoProcessor.service.ts";
import { shutdownActiveTtsJobs } from "./server/services/tts.service.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const startupCheck = validateStartupEnv();
  for (const warning of startupCheck.warnings) {
    console.warn(`[startup-warning] ${warning}`);
  }
  if (!startupCheck.ok) {
    for (const err of startupCheck.errors) {
      console.error(`[startup-error] ${err}`);
    }
    throw new Error("Server configuration failed startup validation.");
  }

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  const { port, nodeEnv } = getEnvConfig();

  // Attempt MongoDB connection when MONGODB_URI is provided; preview mode continues gracefully if unset
  await connectDatabase();
  await reconcileOrphanedVideoJobsOnStartup().catch((err) => {
    console.warn("Orphaned VideoJob reconciliation skipped:", err instanceof Error ? err.message : err);
  });
  await cleanupStaleExpressUploads(EXPRESS_UPLOAD_TEMP_DIR).catch(() => undefined);

  // Initialize Redis/BullMQ queue when REDIS_URL is configured; skipped gracefully otherwise
  await initializeVideoQueue();

  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use("/api", sanitizeRequestInputMiddleware);
  app.use("/api", csrfProtectionMiddleware);

  // Mount modular MERN API routes
  app.use("/api", apiRouter);
  app.use(sanitizedErrorHandler);

  if (nodeEnv !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`AI Studio server listening on http://0.0.0.0:${port}`);
  });

  const cleanupTimer = setInterval(() => {
    void cleanupStaleExpressUploads(EXPRESS_UPLOAD_TEMP_DIR);
  }, 15 * 60 * 1000);
  cleanupTimer.unref();

  let shutdownInProgress = false;
  const handleShutdown = async (signal: string) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`Received ${signal}; shutting down AI Studio server cleanly...`);
    clearInterval(cleanupTimer);

    await shutdownVideoExports().catch(() => undefined);
    await shutdownActiveTtsJobs().catch(() => undefined);
    await cleanupStaleExpressUploads(EXPRESS_UPLOAD_TEMP_DIR, 0).catch(() => undefined);

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(resolve, 4000);
      server.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });

    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };

  process.once("SIGINT", () => void handleShutdown("SIGINT"));
  process.once("SIGTERM", () => void handleShutdown("SIGTERM"));
}

startServer().catch((err) => {
  console.error("Failed to start AI Studio server:", err);
  process.exit(1);
});
