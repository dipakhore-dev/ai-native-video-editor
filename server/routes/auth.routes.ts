import { Router } from "express";
import {
  getCurrentUserController,
  loginController,
  logoutController,
  registerController,
  updateProfileController,
} from "../controllers/auth.controller.ts";
import { getEnvConfig } from "../config/env.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { requireDatabase } from "../middleware/database.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateBody } from "../middleware/validate.middleware.ts";
import {
  LoginSchema,
  RegisterSchema,
  UpdateProfileSchema,
} from "../validators/auth.validators.ts";

export const authRouter = Router();

const authRateLimiter = createRateLimiter({
  name: "auth",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitAuthMax,
  message: "Too many authentication attempts. Please wait a minute and try again.",
});

authRouter.post("/register", authRateLimiter, validateBody(RegisterSchema), requireDatabase, registerController);
authRouter.post("/login", authRateLimiter, validateBody(LoginSchema), requireDatabase, loginController);
authRouter.post("/logout", logoutController);
authRouter.get("/me", requireAuth, getCurrentUserController);
authRouter.patch(
  "/profile",
  requireAuth,
  validateBody(UpdateProfileSchema),
  updateProfileController
);
