import { z } from "zod";

export const AssistantRequestSchema = z.object({
  prompt: z.string().trim().min(1, "Please enter a video editing instruction.").max(1000),
  timelineMetadata: z.object({
    projectId: z.string().max(120),
    projectName: z.string().max(200),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
    resolution: z.string().max(32),
    fps: z.number().min(1).max(120),
    durationSeconds: z.number().min(0).max(86_400),
    selectedClipId: z.string().max(120).nullable(),
    playheadTime: z.number().min(0).max(86_400),
    clips: z
      .array(
        z.object({
          id: z.string().max(120),
          name: z.string().max(200),
          kind: z.string().max(32),
          trackId: z.string().max(64),
          startTime: z.number().min(0).max(86_400),
          duration: z.number().min(0.05).max(86_400),
          inPoint: z.number().min(0).max(86_400),
          sourceDuration: z.number().min(0).max(86_400),
          speed: z.number().min(0.25).max(4),
          volume: z.number().min(0).max(4),
          opacity: z.number().min(0).max(1).optional(),
          rotation: z.number().min(-360).max(360).optional(),
          keyframes: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
          effects: z.record(z.string(), z.unknown()).optional(),
          transitionIn: z.record(z.string(), z.unknown()).optional(),
          transitionOut: z.record(z.string(), z.unknown()).optional(),
          overlayTransform: z.record(z.string(), z.unknown()).optional(),
          text: z.string().max(500).optional(),
        })
      )
      .max(64),
  }),
});

export const GenerateVideoRequestSchema = z.object({
  mode: z.enum(["text-to-video", "image-to-video"]).default("text-to-video"),
  prompt: z.string().trim().min(6, "Provide a descriptive prompt (at least 6 characters).").max(1000),
  negativePrompt: z.string().trim().max(500).optional().default(""),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  durationSeconds: z.number().min(1).max(30).optional().default(4),
  cameraMotion: z.string().trim().max(64).optional().default("static"),
  hasReferenceImage: z.boolean().optional().default(false),
});

export const UpdateAiRequestStatusSchema = z.object({
  status: z.enum(["applied", "discarded"]),
});

export const CreateExportJobSchema = z.object({
  projectId: z.string().min(1, "projectId is required.").max(120),
  projectName: z.string().min(1, "projectName is required.").max(160),
  format: z.enum(["mp4", "webm", "mov"]).default("mp4"),
  resolution: z.string().min(3).max(32).default("1920x1080"),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(24),
  clipCount: z.number().int().min(0).max(500).default(0),
  totalDuration: z.number().min(0).max(86_400).default(0),
  timelineSpec: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateExportJobStatusSchema = z.object({
  status: z.enum(["queued", "processing", "completed", "failed", "integration_required"]),
  outputUrl: z.string().max(500).optional(),
  errorMessage: z.string().max(500).optional(),
});
