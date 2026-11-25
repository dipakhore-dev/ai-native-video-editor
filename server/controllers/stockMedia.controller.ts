import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import { sanitizeErrorMessage, sanitizeFilenameForDisposition } from "../middleware/security.middleware.ts";
import {
  getStockMediaStatus,
  importStockMediaAsset,
  searchStockMedia,
} from "../services/stockMedia.service.ts";

function sanitizeHeaderValue(raw: string, maxLen = 200): string {
  return raw.replace(/[\r\n]+/g, " ").trim().slice(0, maxLen);
}

export function stockMediaStatusController(_req: AuthenticatedRequest, res: Response): void {
  res.json({
    status: "ok",
    stockMedia: getStockMediaStatus(),
  });
}

export async function searchStockMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const result = await searchStockMedia(req.body);
    res.json({
      status: "ok",
      provider: result.provider,
      items: result.items,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
    res.status(status).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to search stock media."
      ),
      ...(integrationPoint ? { integrationPoint } : {}),
    });
  }
}

export async function importStockMediaController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const imported = await importStockMediaAsset(req.body);
    const safeFilename = sanitizeFilenameForDisposition(
      imported.filename,
      imported.mediaType === "video" ? "stock_clip.mp4" : "stock_image.jpg"
    );

    res.setHeader("Content-Type", imported.mimeType);
    res.setHeader("Content-Length", String(imported.buffer.byteLength));
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Stock-Provider", sanitizeHeaderValue(imported.providerName, 40));
    res.setHeader("X-Stock-Asset-Id", sanitizeHeaderValue(imported.providerAssetId, 80));
    res.setHeader("X-Stock-Media-Type", imported.mediaType);
    res.setHeader("X-Stock-Title", encodeURIComponent(sanitizeHeaderValue(imported.title, 140)));
    res.setHeader(
      "X-Stock-Creator",
      encodeURIComponent(sanitizeHeaderValue(imported.creatorName, 140))
    );
    res.setHeader("X-Stock-Attribution-Url", sanitizeHeaderValue(imported.attributionUrl, 400));
    res.setHeader(
      "X-Stock-License",
      encodeURIComponent(sanitizeHeaderValue(imported.licenseInfo, 160))
    );
    if (imported.width) res.setHeader("X-Stock-Width", String(imported.width));
    if (imported.height) res.setHeader("X-Stock-Height", String(imported.height));
    if (imported.duration !== undefined) {
      res.setHeader("X-Stock-Duration", String(imported.duration));
    }

    res.status(200).send(imported.buffer);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    const integrationPoint = (err as { integrationPoint?: string }).integrationPoint;
    res.status(status).json({
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : "Failed to import stock media."
      ),
      ...(integrationPoint ? { integrationPoint } : {}),
    });
  }
}
