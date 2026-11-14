import type { CookieOptions, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getAuthCookieMaxAgeMs, getEnvConfig, isJwtConfigured } from "../config/env.ts";
import { isDatabaseConnected } from "../config/database.ts";
import { UserModel, type IUser } from "../models/User.ts";

export interface AuthenticatedRequest extends Request {
  user?: IUser;
  userId?: string;
}

interface JwtPayload {
  sub: string;
  email: string;
}

function getBaseCookieOptions(req?: Request): CookieOptions {
  const { isProd } = getEnvConfig();
  const forwardedProto = req?.headers["x-forwarded-proto"];
  const protoValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const isHttps = Boolean(
    isProd || req?.secure || protoValue?.split(",")[0]?.trim().toLowerCase() === "https"
  );

  return {
    httpOnly: true,
    sameSite: isHttps ? "none" : "lax",
    secure: isHttps,
    path: "/",
  };
}

export function setAuthCookie(res: Response, token: string, req?: Request): void {
  const { authCookieName } = getEnvConfig();
  res.cookie(authCookieName, token, {
    ...getBaseCookieOptions(req),
    maxAge: getAuthCookieMaxAgeMs(),
  });
}

export function clearAuthCookie(res: Response, req?: Request): void {
  const { authCookieName } = getEnvConfig();
  res.clearCookie(authCookieName, getBaseCookieOptions(req));
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!isDatabaseConnected()) {
    res.status(503).json({
      status: "database_not_connected",
      error: "MongoDB is not connected in this runtime. Set MONGODB_URI to enable authenticated MERN routes.",
    });
    return;
  }

  if (!isJwtConfigured()) {
    res.status(500).json({
      error: "JWT_SECRET is not configured on the server.",
    });
    return;
  }

  const { authCookieName, jwtSecret } = getEnvConfig();
  const token = req.cookies?.[authCookieName];
  if (!token || typeof token !== "string") {
    res.status(401).json({ error: "Authentication required. Please sign in." });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as JwtPayload;
    const user = await UserModel.findById(decoded.sub);
    if (!user) {
      clearAuthCookie(res, req);
      res.status(401).json({ error: "Session user no longer exists." });
      return;
    }

    req.user = user;
    req.userId = user._id.toString();
    next();
  } catch {
    clearAuthCookie(res, req);
    res.status(401).json({ error: "Invalid or expired authentication cookie." });
  }
}

export async function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (!isDatabaseConnected() || !isJwtConfigured()) {
    next();
    return;
  }

  const { authCookieName, jwtSecret } = getEnvConfig();
  const token = req.cookies?.[authCookieName];
  if (!token || typeof token !== "string") {
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as JwtPayload;
    const user = await UserModel.findById(decoded.sub);
    if (user) {
      req.user = user;
      req.userId = user._id.toString();
    }
  } catch {
    // Ignore invalid optional cookie
  }
  next();
}
