import { Router } from "express";
import {
  aiAssistantController,
  generateVideoStubController,
  listAiRequestsController,
  updateAiRequestStatusController,
} from "../controllers/ai.controller.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  AssistantRequestSchema,
  UpdateAiRequestStatusSchema,
} from "../validators/aiAndExport.validators.ts";

export const aiRouter = Router();

// Preserves preview-mode AI editing while persisting AiEditRequest docs when MongoDB + auth are active
aiRouter.post(
  "/assistant",
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

aiRouter.post("/generate-video", generateVideoStubController);
