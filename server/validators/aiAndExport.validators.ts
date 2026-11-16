import { z } from "zod";

export const AssistantRequestSchema = z.object({
  prompt: z.string().trim().min(1, "Please enter a video editing instruction.").max(1000),
  timelineMetadata: z.object({
    projectId: z.string(),
    projectName: z.string(),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
    resolution: z.string(),
    fps: z.number(),
    durationSeconds: z.number(),
    selectedClipId: z.string().nullable(),
    playheadTime: z.number(),
    clips: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        trackId: z.string(),
        startTime: z.number(),
        duration: z.number(),
        inPoint: z.number(),
        sourceDuration: z.number(),
        speed: z.number(),
        volume: z.number(),
        opacity: z.number().optional(),
        effects: z.record(z.string(), z.unknown()).optional(),
        transitionIn: z.record(z.string(), z.unknown()).optional(),
        transitionOut: z.record(z.string(), z.unknown()).optional(),
        overlayTransform: z.record(z.string(), z.unknown()).optional(),
        text: z.string().optional(),
      })
    ),
  }),
});

export const UpdateAiRequestStatusSchema = z.object({
  status: z.enum(["applied", "discarded"]),
});

export const CreateExportJobSchema = z.object({
  projectId: z.string().min(1, "projectId is required."),
  projectName: z.string().min(1, "projectName is required."),
  format: z.enum(["mp4", "webm", "mov"]).default("mp4"),
  resolution: z.string().min(3).default("1920x1080"),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(24),
  clipCount: z.number().int().min(0).default(0),
  totalDuration: z.number().min(0).default(0),
  timelineSpec: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateExportJobStatusSchema = z.object({
  status: z.enum(["queued", "processing", "completed", "failed", "integration_required"]),
  outputUrl: z.string().optional(),
  errorMessage: z.string().optional(),
});
