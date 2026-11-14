import type { Response } from "express";
import { isDatabaseConnected } from "../config/database.ts";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  createUserExportJob,
  getUserExportJobById,
  listUserExportJobs,
  updateUserExportJobStatus,
} from "../services/export.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function listExportsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const jobs = await listUserExportJobs(req.userId!);
    res.json({ status: "ok", exports: jobs });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list export jobs.",
    });
  }
}

export async function getExportController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const job = await getUserExportJobById(req.userId!, getParamId(req));
    if (!job) {
      res.status(404).json({ error: "Export job not found." });
      return;
    }
    res.json({ status: "ok", exportJob: job });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch export job.",
    });
  }
}

export async function createExportController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const { projectId, projectName, resolution, format, fps, clipCount, totalDuration, timelineSpec } =
    req.body;

  // When MongoDB and an authenticated user are active, persist the ExportJob record first
  if (isDatabaseConnected() && req.userId) {
    try {
      const savedJob = await createUserExportJob(req.userId, req.body);
      res.status(501).json({
        status: "integration_required",
        integrationPoint: "POST /api/exports",
        message:
          "Export job specification saved to MongoDB, but no FFmpeg / cloud transcoding worker is connected to render an actual video file.",
        exportJobId: savedJob._id.toString(),
        validatedJob: {
          projectId,
          projectName,
          resolution,
          format,
          fps,
          clipCount,
          totalDuration,
          schemaVersion: (timelineSpec as { schemaVersion?: string } | undefined)?.schemaVersion ?? "1.0",
        },
      });
      return;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode || 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : "Failed to record export job.",
      });
      return;
    }
  }

  // Browser-session fallback (no MongoDB connected)
  res.status(501).json({
    status: "integration_required",
    integrationPoint: "POST /api/exports",
    message:
      "Cloud render worker (FFmpeg / transcoding queue) is not connected. No video file was exported or modified. You can download your structured timeline specification (.json) locally.",
    validatedJob: {
      projectId,
      projectName,
      resolution,
      format,
      fps,
      clipCount,
      totalDuration,
      schemaVersion: (timelineSpec as { schemaVersion?: string } | undefined)?.schemaVersion ?? "1.0",
    },
  });
}

export async function updateExportStatusController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const updated = await updateUserExportJobStatus(req.userId!, getParamId(req), req.body);
    if (!updated) {
      res.status(404).json({ error: "Export job not found." });
      return;
    }
    res.json({ status: "ok", exportJob: updated });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update export job.",
    });
  }
}
