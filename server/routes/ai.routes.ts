import { Router } from "express";
import { getEnvConfig } from "../config/env.ts";
import {
  aiAssistantController,
  createStoryboardDraftController,
  deleteStoryboardDraftController,
  generateStoryboardController,
  generateVideoStubController,
  getStoryboardDraftController,
  listAiRequestsController,
  listStoryboardDraftsController,
  updateAiRequestStatusController,
  updateStoryboardDraftController,
} from "../controllers/ai.controller.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  AssistantRequestSchema,
  GenerateVideoRequestSchema,
  SaveStoryboardDraftSchema,
  StoryboardGenerationInputSchema,
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
  "/storyboard",
  requireAuth,
  aiRateLimiter,
  validateBody(StoryboardGenerationInputSchema),
  generateStoryboardController
);

aiRouter.get("/storyboards", requireAuth, listStoryboardDraftsController);
aiRouter.post(
  "/storyboards",
  requireAuth,
  aiRateLimiter,
  validateBody(SaveStoryboardDraftSchema),
  createStoryboardDraftController
);
aiRouter.get(
  "/storyboards/:id",
  requireAuth,
  validateObjectId("id"),
  getStoryboardDraftController
);
aiRouter.patch(
  "/storyboards/:id",
  requireAuth,
  aiRateLimiter,
  validateObjectId("id"),
  validateBody(SaveStoryboardDraftSchema),
  updateStoryboardDraftController
);
aiRouter.delete(
  "/storyboards/:id",
  requireAuth,
  validateObjectId("id"),
  deleteStoryboardDraftController
);

aiRouter.post(
  "/generate-video",
  aiRateLimiter,
  optionalAuth,
  validateBody(GenerateVideoRequestSchema),
  generateVideoStubController
);
