import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { connectDatabase } from "./server/config/database.ts";
import { getEnvConfig } from "./server/config/env.ts";
import { initializeVideoQueue } from "./server/queues/videoQueue.ts";
import { apiRouter } from "./server/routes/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  const { port, nodeEnv } = getEnvConfig();

  // Attempt MongoDB connection when MONGODB_URI is provided; preview mode continues gracefully if unset
  await connectDatabase();
  // Initialize Redis/BullMQ queue when REDIS_URL is configured; skipped gracefully otherwise
  await initializeVideoQueue();

  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  // Mount modular MERN API routes
  app.use("/api", apiRouter);

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

  app.listen(port, "0.0.0.0", () => {
    console.log(`AI Studio server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start AI Studio server:", err);
  process.exit(1);
});
