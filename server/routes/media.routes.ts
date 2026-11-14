import { Router } from "express";
import {
  createMediaController,
  deleteMediaController,
  getMediaController,
  listMediaController,
  updateMediaController,
} from "../controllers/media.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { validateBody, validateObjectId } from "../middleware/validate.middleware.ts";
import {
  CreateMediaMetadataSchema,
  UpdateMediaMetadataSchema,
} from "../validators/media.validators.ts";

export const mediaRouter = Router();

mediaRouter.use(requireAuth);

mediaRouter.get("/", listMediaController);
mediaRouter.post("/", validateBody(CreateMediaMetadataSchema), createMediaController);
mediaRouter.get("/:id", validateObjectId("id"), getMediaController);
mediaRouter.patch(
  "/:id",
  validateObjectId("id"),
  validateBody(UpdateMediaMetadataSchema),
  updateMediaController
);
mediaRouter.delete("/:id", validateObjectId("id"), deleteMediaController);
