import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import type { ZodType } from "zod";

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      res.status(400).json({
        error: firstIssue?.message || "Invalid request payload.",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateObjectId(paramName = "id") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawValue = req.params[paramName];
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (!value || !mongoose.Types.ObjectId.isValid(value)) {
      res.status(400).json({
        error: `Invalid resource identifier "${paramName}".`,
      });
      return;
    }
    next();
  };
}
