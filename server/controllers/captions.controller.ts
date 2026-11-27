import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.ts";
import {
  cancelCaptionsJob,
  fetchProcessorCaptionsStatus,
  getCaptionsJobSnapshot,
  transcribeProcessorAudioCaptions,
  unlinkTempFileWithRetry,
} from "../services/captions.service.ts";
import { AudioCaptionsRequestFieldsSchema } from "../validators/captions.validators.ts";

export async function captionsStatusController(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const status = await fetchProcessorCaptionsStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
}

export async function captionsFromAudioController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({
      error: 'Upload a scene voiceover audio file using form field "audio".',
    });
    return;
  }

  const parsedFields = AudioCaptionsRequestFieldsSchema.safeParse(req.body ?? {});
  if (!parsedFields.success) {
    await unlinkTempFileWithRetry(file.path);
    res.status(400).json({
      error: parsedFields.error.issues[0]?.message || "Invalid caption generation parameters.",
    });
    return;
  }

  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableFinished && !res.writableEnded) {
      abortController.abort(new Error("Client connection closed."));
    }
  };
  req.on("aborted", onClose);
  res.on("close", onClose);

  try {
    const headerJobId =
      typeof req.headers["x-captions-job-id"] === "string"
        ? req.headers["x-captions-job-id"]
        : undefined;

    const result = await transcribeProcessorAudioCaptions({
      userId: req.userId!,
      filePath: file.path,
      originalName: file.originalname || "voiceover.wav",
      mimeType: file.mimetype || "audio/wav",
      sizeBytes: file.size,
      language: parsedFields.data.language,
      wordTimestamps: parsedFields.data.wordTimestamps,
      clientJobId: parsedFields.data.clientJobId,
      headerJobId,
      requestAbortSignal: abortController.signal,
    });

    if (res.writableEnded) return;

    res.setHeader("X-Captions-Job-Id", result.jobId);
    res.json({
      status: "completed",
      mode: "audio_transcription",
      ...result,
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const cancelled = Boolean((err as { cancelled?: boolean }).cancelled);
    if (statusCode === 499 || cancelled) {
      if (!res.headersSent && !res.writableEnded) {
        res.status(499).json({
          status: "cancelled",
          cancelled: true,
          error:
            err instanceof Error
              ? err.message
              : "Audio caption transcription cancelled.",
        });
      }
      return;
    }
    next(err);
  } finally {
    req.off("aborted", onClose);
    res.off("close", onClose);
    await unlinkTempFileWithRetry(file.path);
  }
}

export async function captionsJobStatusController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const jobId = String(req.params.id || "").trim();
    const snap = getCaptionsJobSnapshot(req.userId!, jobId);
    if (!snap) {
      res.status(404).json({ error: "Caption job not found." });
      return;
    }
    res.json({ job: snap });
  } catch (err) {
    next(err);
  }
}

export async function captionsCancelJobController(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const jobId = String(req.params.id || "").trim();
    const snap = await cancelCaptionsJob(req.userId!, jobId);
    if (!snap) {
      res.status(404).json({ error: "Caption job not found or invalid job ID." });
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
