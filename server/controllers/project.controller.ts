import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  createUserProject,
  deleteUserProject,
  getUserProjectById,
  listUserProjects,
  saveUserProjectTimeline,
  updateUserProject,
} from "../services/project.service.ts";

function getParamId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function listProjectsController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const projects = await listUserProjects(req.userId!);
    res.json({ status: "ok", projects });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to list projects.",
    });
  }
}

export async function getProjectController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const project = await getUserProjectById(req.userId!, getParamId(req));
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ status: "ok", project });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch project.",
    });
  }
}

export async function createProjectController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const project = await createUserProject(req.userId!, req.body);
    res.status(201).json({ status: "ok", project });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to create project.",
    });
  }
}

export async function updateProjectController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const project = await updateUserProject(req.userId!, getParamId(req), req.body);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ status: "ok", project });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update project.",
    });
  }
}

export async function saveTimelineController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const project = await saveUserProjectTimeline(req.userId!, getParamId(req), req.body);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ status: "ok", project });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to save timeline.",
    });
  }
}

export async function deleteProjectController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const deleted = await deleteUserProject(req.userId!, getParamId(req));
    if (!deleted) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ status: "ok", deleted: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to delete project.",
    });
  }
}
