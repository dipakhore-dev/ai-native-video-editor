import { Router } from "express";
import {
  createExportController,
  getExportController,
  listExportsController,
  updateExportStatusController,
} from "../controllers/export.controller.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  CreateExportJobSchema,
  UpdateExportJobStatusSchema,
} from "../validators/aiAndExport.validators.ts";

export const exportRouter = Router();

exportRouter.get("/", requireAuth, listExportsController);
exportRouter.post("/", optionalAuth, validateBody(CreateExportJobSchema), createExportController);
exportRouter.get("/:id", requireAuth, validateObjectId("id"), getExportController);
exportRouter.patch(
  "/:id",
  requireAuth,
  validateObjectId("id"),
  validateBody(UpdateExportJobStatusSchema),
  updateExportStatusController
);
