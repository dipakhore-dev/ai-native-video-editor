import { Router } from "express";
import { getEnvConfig } from "../config/env.ts";
import {
  aiAssistantController,
  generateVideoStubController,
  listAiRequestsController,
  updateAiRequestStatusController,
} from "../controllers/ai.controller.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  AssistantRequestSchema,
  GenerateVideoRequestSchema,
  UpdateAiRequestStatusSchema,
} from "../validators/aiAndExport.validators.ts";

export const aiRouter = Router();

const aiRateLimiter = createRateLimiter({
  name: "ai-assistant",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitAiMax,
  message: "Too many AI editing requests in a short window. Please wait a moment and try again.",
});

// Preserves preview-mode AI editing while persisting AiEditRequest docs when MongoDB + auth are active
aiRouter.post(
  "/assistant",
  aiRateLimiter,
  optionalAuth,
  validateBody(AssistantRequestSchema),
  aiAssistantController
);

aiRouter.get("/requests", requireAuth, listAiRequestsController);
aiRouter.patch(
  "/requests/:id",
  requireAuth,
  validateObjectId("id"),
  validateBody(UpdateAiRequestStatusSchema),
  updateAiRequestStatusController
);

aiRouter.post(
  "/generate-video",
  aiRateLimiter,
  optionalAuth,
  validateBody(GenerateVideoRequestSchema),
  generateVideoStubController
);
