import { Router } from "express";
import { getEnvConfig } from "../config/env.ts";
import {
  ttsCancelJobController,
  ttsGenerateController,
  ttsJobStatusController,
  ttsStatusController,
  ttsVoicesController,
} from "../controllers/tts.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateBody } from "../middleware/validate.middleware.ts";
import { TtsGenerateRequestSchema } from "../validators/tts.validators.ts";

export const ttsRouter = Router();

const ttsRateLimiter = createRateLimiter({
  name: "tts-generate",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitTtsMax,
  message: "Too many voiceover synthesis requests in a short window. Wait briefly before retrying.",
});

ttsRouter.use(requireAuth);

ttsRouter.get("/status", ttsStatusController);
ttsRouter.get("/voices", ttsVoicesController);
ttsRouter.post(
  "/generate",
  ttsRateLimiter,
  validateBody(TtsGenerateRequestSchema),
  ttsGenerateController
);
ttsRouter.get("/jobs/:id", ttsJobStatusController);
ttsRouter.post("/jobs/:id/cancel", ttsCancelJobController);
