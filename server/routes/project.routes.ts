import { Router } from "express";
import {
  createProjectController,
  deleteProjectController,
  getProjectController,
  listProjectsController,
  saveTimelineController,
  updateProjectController,
} from "../controllers/project.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  UpdateTimelineSchema,
} from "../validators/project.validators.ts";

export const projectRouter = Router();

projectRouter.use(requireAuth);

projectRouter.get("/", listProjectsController);
projectRouter.post("/", validateBody(CreateProjectSchema), createProjectController);
projectRouter.get("/:id", validateObjectId("id"), getProjectController);
projectRouter.patch(
  "/:id",
  validateObjectId("id"),
  validateBody(UpdateProjectSchema),
  updateProjectController
);
projectRouter.put(
  "/:id/timeline",
  validateObjectId("id"),
  validateBody(UpdateTimelineSchema),
  saveTimelineController
);
projectRouter.delete("/:id", validateObjectId("id"), deleteProjectController);
