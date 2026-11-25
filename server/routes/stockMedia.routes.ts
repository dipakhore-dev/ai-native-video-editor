import { Router } from "express";
import { getEnvConfig } from "../config/env.ts";
import {
  importStockMediaController,
  searchStockMediaController,
  stockMediaStatusController,
} from "../controllers/stockMedia.controller.ts";
import { requireAuth } from "../middleware/auth.middleware.ts";
import { createRateLimiter } from "../middleware/rateLimit.middleware.ts";
import { validateBody } from "../middleware/validate.middleware.ts";
import {
  StockImportRequestSchema,
  StockSearchRequestSchema,
} from "../services/stockMedia.service.ts";

export const stockMediaRouter = Router();

const stockRateLimiter = createRateLimiter({
  name: "stock-media",
  windowMs: 60_000,
  maxRequests: () => getEnvConfig().rateLimitAiMax,
  message: "Too many stock media requests in a short window. Wait briefly before retrying.",
});

stockMediaRouter.use(requireAuth);

stockMediaRouter.get("/status", stockMediaStatusController);
stockMediaRouter.post(
  "/search",
  stockRateLimiter,
  validateBody(StockSearchRequestSchema),
  searchStockMediaController
);
stockMediaRouter.post(
  "/import",
  stockRateLimiter,
  validateBody(StockImportRequestSchema),
  importStockMediaController
);
