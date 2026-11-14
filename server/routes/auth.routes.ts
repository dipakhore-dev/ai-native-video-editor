import { Router } from "express";
import {
  getCurrentUserController,
  loginController,
  logoutController,
  registerController,
  updateProfileController,
} from "../controllers/auth.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { requireDatabase } from "../middleware/database.middleware.ts";
import { validateBody } from "../middleware/validate.middleware.ts";
import {
  LoginSchema,
  RegisterSchema,
  UpdateProfileSchema,
} from "../validators/auth.validators.ts";

export const authRouter = Router();

authRouter.post("/register", validateBody(RegisterSchema), requireDatabase, registerController);
authRouter.post("/login", validateBody(LoginSchema), requireDatabase, loginController);
authRouter.post("/logout", logoutController);
authRouter.get("/me", requireAuth, getCurrentUserController);
authRouter.patch(
  "/profile",
  requireAuth,
  validateBody(UpdateProfileSchema),
  updateProfileController
);
