import type { NextFunction, Request, Response } from "express";
import { isDatabaseConnected } from "../config/database.ts";

export function requireDatabase(_req: Request, res: Response, next: NextFunction): void {
  if (!isDatabaseConnected()) {
    res.status(503).json({
      status: "database_not_connected",
      error:
        "MongoDB is not connected in this runtime. Set MONGODB_URI and JWT_SECRET in your environment to enable persistent MERN endpoints.",
    });
    return;
  }
  next();
}
