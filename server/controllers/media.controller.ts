import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  createUserMediaMetadata,
  deleteUserMediaAsset,
  getUserMediaAssetById,
  listUserMediaAssets,
  updateUserMediaMetadata,
} from "../services/media.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function listMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const assets = await listUserMediaAssets(req.userId!, projectId);
    res.json({ status: "ok", assets });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list media metadata.",
    });
  }
}

export async function getMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const asset = await getUserMediaAssetById(req.userId!, getParamId(req));
    if (!asset) {
      res.status(404).json({ error: "Media asset not found." });
      return;
    }
    res.json({ status: "ok", asset });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch media asset.",
    });
  }
}

export async function createMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const asset = await createUserMediaMetadata(req.userId!, req.body);
    res.status(201).json({ status: "ok", asset });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to save media metadata.",
    });
  }
}

export async function updateMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const asset = await updateUserMediaMetadata(req.userId!, getParamId(req), req.body);
    if (!asset) {
      res.status(404).json({ error: "Media asset not found." });
      return;
    }
    res.json({ status: "ok", asset });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to update media metadata.",
    });
  }
}

export async function deleteMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const deleted = await deleteUserMediaAsset(req.userId!, getParamId(req));
    if (!deleted) {
      res.status(404).json({ error: "Media asset not found." });
      return;
    }
    res.json({ status: "ok", deleted: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to delete media metadata.",
    });
  }
}
