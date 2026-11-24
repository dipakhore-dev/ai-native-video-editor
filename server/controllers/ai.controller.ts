import type { Request, Response } from "express";
import { isVideoGenProviderConfigured } from "../config/env.ts";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  generateAiEditPlan,
  listUserAiRequests,
  updateUserAiRequestStatus,
} from "../services/ai.service.ts";

export async function aiAssistantController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const result = await generateAiEditPlan({
      prompt: req.body.prompt,
      timelineMetadata: req.body.timelineMetadata,
      userId: req.userId,
    });
    res.json({
      status: "ok",
      model: result.model,
      plan: result.plan,
      ...(result.requestId ? { requestId: result.requestId } : {}),
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 502;
    const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
    res.status(status).json({
      status: status === 503 ? "integration_required" : "error",
      ...(integrationPoint ? { integrationPoint } : {}),
      error: err instanceof Error ? err.message : "AI editing request failed.",
    });
  }
}

export async function listAiRequestsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const requests = await listUserAiRequests(
      req.userId!,
      projectId,
      Number.isFinite(rawLimit) ? rawLimit : 50
    );
    res.json({ status: "ok", requests });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to load AI request history.",
    });
  }
}

export async function updateAiRequestStatusController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const updated = await updateUserAiRequestStatus(req.userId!, id, req.body.status);
    if (!updated) {
      res.status(404).json({ error: "AI edit request not found." });
      return;
    }
    res.json({ status: "ok", request: updated });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update AI edit request.",
    });
  }
}

export function generateVideoStubController(req: Request, res: Response): void {
  if (!isVideoGenProviderConfigured()) {
    res.status(503).json({
      status: "disabled",
      integrationPoint: "POST /api/ai/generate-video",
      error:
        "Paid text-to-video and image-to-video generation is disabled until an external provider (VIDEO_GEN_PROVIDER_URL) is configured.",
    });
    return;
  }

  const { mode, prompt, negativePrompt, aspectRatio, durationSeconds, cameraMotion, hasReferenceImage } =
    req.body ?? {};

  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 6) {
    res.status(400).json({
      error: "Provide a descriptive prompt (at least 6 characters) before submitting.",
    });
    return;
  }

  if (mode === "image-to-video" && !hasReferenceImage) {
    res.status(400).json({
      error: "Image-to-Video mode requires a reference image file or studio still.",
    });
    return;
  }

  res.status(501).json({
    status: "integration_required",
    integrationPoint: "POST /api/ai/generate-video",
    message:
      "Video generation provider URL is configured, but the provider adapter is not wired yet.",
    validatedRequest: {
      mode: mode === "image-to-video" ? "image-to-video" : "text-to-video",
      prompt: prompt.trim(),
      negativePrompt: typeof negativePrompt === "string" ? negativePrompt.trim() : "",
      aspectRatio: aspectRatio || "16:9",
      durationSeconds: Number(durationSeconds) || 4,
      cameraMotion: cameraMotion || "static",
      hasReferenceImage: Boolean(hasReferenceImage),
    },
  });
}
