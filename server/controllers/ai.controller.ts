import type { Request, Response } from "express";
import { isVideoGenProviderConfigured } from "../config/env.ts";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { sanitizeErrorMessage } from "../middleware/security.middleware.ts";
import {
  createUserStoryboardDraft,
  deleteUserStoryboardDraft,
  generateAiEditPlan,
  generateVideoStoryboard,
  getUserStoryboardDraft,
  listUserAiRequests,
  listUserStoryboardDrafts,
  updateUserAiRequestStatus,
  updateUserStoryboardDraft,
  type StoryboardGeminiInvoker,
} from "../services/ai.service.ts";
import type { ValidatedStoryboardInput } from "../../src/utils/storyboard.ts";

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

export function createGenerateStoryboardController(options?: {
  geminiInvoker?: StoryboardGeminiInvoker;
  timeoutMs?: number;
}) {
  return async function generateStoryboardController(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    const abortController = new AbortController();
    const handleClientClose = () => {
      if (!res.writableFinished && !res.writableEnded) {
        abortController.abort();
      }
    };
    res.on("close", handleClientClose);

    try {
      const result = await generateVideoStoryboard({
        userId: req.userId!,
        request: req.body as ValidatedStoryboardInput,
        signal: abortController.signal,
        timeoutMs: options?.timeoutMs,
        geminiInvoker: options?.geminiInvoker,
      });

      if (res.writableEnded || abortController.signal.aborted) {
        return;
      }

      res.json({
        status: "ok",
        model: result.model,
        storyboard: result.storyboard,
      });
    } catch (err) {
      if (res.writableEnded) {
        return;
      }
      const status = (err as { statusCode?: number }).statusCode || 502;
      const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
      const cancelled = Boolean((err as { cancelled?: boolean }).cancelled) || status === 499;
      res.status(status).json({
        status:
          status === 503 && integrationPoint
            ? "integration_required"
            : cancelled
              ? "cancelled"
              : "error",
        ...(cancelled ? { cancelled: true } : {}),
        ...(integrationPoint ? { integrationPoint } : {}),
        error: sanitizeErrorMessage(
          err instanceof Error ? err.message : "Storyboard generation failed.",
          "Storyboard generation failed."
        ),
      });
    } finally {
      res.off("close", handleClientClose);
    }
  };
}

export const generateStoryboardController = createGenerateStoryboardController();

export async function listStoryboardDraftsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const drafts = await listUserStoryboardDrafts(
      req.userId!,
      Number.isFinite(rawLimit) ? rawLimit : 20
    );
    res.json({ status: "ok", drafts });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to load storyboard drafts.",
        "Failed to load storyboard drafts."
      ),
    });
  }
}

export async function getStoryboardDraftController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const draft = await getUserStoryboardDraft(req.userId!, id);
    if (!draft) {
      res.status(404).json({ error: "Storyboard draft not found." });
      return;
    }
    res.json({ status: "ok", draft });
  } catch (err) {
    res.status(500).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to load storyboard draft.",
        "Failed to load storyboard draft."
      ),
    });
  }
}

export async function createStoryboardDraftController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const draft = await createUserStoryboardDraft(
      req.userId!,
      req.body.storyboard,
      req.body.status
    );
    res.status(201).json({ status: "ok", draft });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to save storyboard draft.",
        "Failed to save storyboard draft."
      ),
    });
  }
}

export async function updateStoryboardDraftController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const draft = await updateUserStoryboardDraft(
      req.userId!,
      id,
      req.body.storyboard,
      req.body.status
    );
    if (!draft) {
      res.status(404).json({ error: "Storyboard draft not found." });
      return;
    }
    res.json({ status: "ok", draft });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to update storyboard draft.",
        "Failed to update storyboard draft."
      ),
    });
  }
}

export async function deleteStoryboardDraftController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const deleted = await deleteUserStoryboardDraft(req.userId!, id);
    if (!deleted) {
      res.status(404).json({ error: "Storyboard draft not found." });
      return;
    }
    res.json({ status: "ok", deleted: true });
  } catch (err) {
    res.status(500).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to delete storyboard draft.",
        "Failed to delete storyboard draft."
      ),
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
