import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  cancelTtsJob,
  fetchProcessorTtsStatus,
  fetchProcessorTtsVoices,
  getTtsJobSnapshot,
  synthesizeProcessorTtsAudio,
} from "../services/tts.service.ts";
import type { ValidatedTtsGenerateRequest } from "../validators/tts.validators.ts";

export async function ttsStatusController(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const status = await fetchProcessorTtsStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
}

export async function ttsVoicesController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const language = typeof req.query.language === "string" ? req.query.language : undefined;
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    const voices = await fetchProcessorTtsVoices({ language, provider });
    res.json(voices);
  } catch (err) {
    next(err);
  }
}

export async function ttsGenerateController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableFinished && !res.writableEnded) {
      abortController.abort(new Error("Client connection closed."));
    }
  };
  req.on("aborted", onClose);
  res.on("close", onClose);

  try {
    const payload = req.body as ValidatedTtsGenerateRequest;
    const headerJobId =
      typeof req.headers["x-tts-job-id"] === "string" ? req.headers["x-tts-job-id"] : undefined;

    const result = await synthesizeProcessorTtsAudio({
      userId: req.userId!,
      input: payload,
      headerJobId,
      requestAbortSignal: abortController.signal,
    });

    if (res.writableEnded) return;

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${result.filename}"`);
    res.setHeader("Content-Length", String(result.buffer.length));
    res.setHeader("X-TTS-Job-Id", result.jobId);
    res.setHeader("X-TTS-Provider", result.provider);
    res.setHeader("X-TTS-Voice-Id", encodeURIComponent(result.voiceId));
    res.setHeader("X-TTS-Voice-Label", encodeURIComponent(result.voiceLabel));
    res.setHeader("X-TTS-Language", result.language);
    res.setHeader("X-TTS-Duration", result.durationSeconds.toFixed(3));
    res.setHeader("X-TTS-Sample-Rate", String(result.sampleRateHz));
    res.setHeader("X-TTS-Channels", String(result.channels));
    res.setHeader("X-TTS-Format", result.format);
    res.status(200).send(result.buffer);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const cancelled = Boolean((err as { cancelled?: boolean }).cancelled);
    if (statusCode === 499 || cancelled) {
      if (!res.headersSent && !res.writableEnded) {
        res.status(499).json({
          status: "cancelled",
          cancelled: true,
          error: err instanceof Error ? err.message : "Voiceover synthesis cancelled.",
        });
      }
      return;
    }
    next(err);
  } finally {
    req.off("aborted", onClose);
    res.off("close", onClose);
  }
}

export async function ttsJobStatusController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const jobId = String(req.params.id || "").trim();
    const snap = getTtsJobSnapshot(req.userId!, jobId);
    if (!snap) {
      res.status(404).json({ error: "TTS job not found." });
      return;
    }
    res.json({ job: snap });
  } catch (err) {
    next(err);
  }
}

export async function ttsCancelJobController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const jobId = String(req.params.id || "").trim();
    const snap = await cancelTtsJob(req.userId!, jobId);
    if (!snap) {
      res.status(404).json({ error: "TTS job not found or invalid job ID." });
      return;
    }
    res.json({
      status: "cancelled",
      cancelled: true,
      job: snap,
    });
  } catch (err) {
    next(err);
  }
}
