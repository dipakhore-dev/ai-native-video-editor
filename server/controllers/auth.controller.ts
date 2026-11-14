import type { Request, Response } from "express";
import {
  clearAuthCookie,
  setAuthCookie,
  type AuthenticatedRequest,
} from "../middleware/auth.middleware.ts";
import {
  authenticateUser,
  registerUser,
  toPublicUser,
  updateUserProfile,
} from "../services/auth.service.ts";

export async function registerController(req: Request, res: Response): Promise<void> {
  try {
    const { user, token } = await registerUser(req.body);
    setAuthCookie(res, token, req);
    res.status(201).json({ status: "ok", user });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Failed to register user.",
    });
  }
}

export async function loginController(req: Request, res: Response): Promise<void> {
  try {
    const { user, token } = await authenticateUser(req.body);
    setAuthCookie(res, token, req);
    res.json({ status: "ok", user });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Authentication failed.",
    });
  }
}

export function logoutController(req: Request, res: Response): void {
  clearAuthCookie(res, req);
  res.json({ status: "ok", message: "Signed out." });
}

export function getCurrentUserController(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  res.json({ status: "ok", user: toPublicUser(req.user) });
}

export async function updateProfileController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const updated = await updateUserProfile(req.userId!, req.body);
    if (!updated) {
      res.status(404).json({ error: "User profile not found." });
      return;
    }
    res.json({ status: "ok", user: updated });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update user profile.",
    });
  }
}
