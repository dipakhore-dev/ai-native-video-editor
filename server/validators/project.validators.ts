import { z } from "zod";

export const TextOverlayStyleSchema = z.object({
  text: z.string().min(1).max(200),
  fontSize: z.number().min(12).max(120),
  color: z.string().min(3).max(32),
  backgroundColor: z.string().min(3).max(32).default("#09090B"),
  backgroundOpacity: z.number().min(0).max(1).default(0.6),
  x: z.number().min(0).max(100).default(50),
  y: z.number().min(0).max(100).default(80),
  align: z.enum(["left", "center", "right"]).default("center"),
});

export const TimelineTrackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["video", "overlay", "text", "audio"]),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
});

export const ClipTransitionSchema = z.object({
  type: z
    .enum(["none", "fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "zoomin"])
    .default("none"),
  durationSec: z.number().min(0.2).max(2).default(0.6),
});

export const ClipVisualEffectsSchema = z.object({
  preset: z.enum(["none", "cinematic", "bw", "vintage", "warm", "cool", "vivid"]).default("none"),
  brightness: z.number().min(-0.5).max(0.5).default(0),
  contrast: z.number().min(0.5).max(1.8).default(1),
  saturation: z.number().min(0).max(2).default(1),
  blur: z.number().min(0).max(10).default(0),
});

export const OverlayTransformSchema = z.object({
  x: z.number().min(0).max(100).default(50),
  y: z.number().min(0).max(100).default(50),
  widthPct: z.number().min(5).max(100).default(100),
  heightPct: z.number().min(5).max(100).default(100),
  scale: z.number().min(0.1).max(2).default(1),
  lockAspectRatio: z.boolean().default(true),
});

export const TimelineClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  trackId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["video", "image", "audio", "text"]),
  startTime: z.number().min(0),
  duration: z.number().min(0.1),
  inPoint: z.number().min(0).default(0),
  sourceDuration: z.number().min(0),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().optional().default(false),
  fadeInSec: z.number().min(0).max(30).optional().default(0),
  fadeOutSec: z.number().min(0).max(30).optional().default(0),
  duckingEnabled: z.boolean().optional().default(false),
  duckingAmount: z.number().min(0).max(0.95).optional().default(0.6),
  speed: z.number().min(0.25).max(4).default(1),
  opacity: z.number().min(0).max(1).default(1),
  transitionIn: ClipTransitionSchema.optional(),
  transitionOut: ClipTransitionSchema.optional(),
  effects: ClipVisualEffectsSchema.optional(),
  overlayTransform: OverlayTransformSchema.optional(),
  sourceWidth: z.number().int().positive().optional(),
  sourceHeight: z.number().int().positive().optional(),
  sourceName: z.string().optional(),
  sourceSizeBytes: z.number().min(0).optional(),
  sourceMimeType: z.string().optional(),
  textStyle: TextOverlayStyleSchema.optional(),
});

export const SubtitleSegmentSchema = z
  .object({
    id: z.string().min(1),
    start: z.number().min(0),
    end: z.number().min(0),
    text: z.string().trim().min(1).max(500),
    clipId: z.string().optional(),
  })
  .refine((seg) => seg.end > seg.start, {
    message: "Subtitle end time must be greater than start time.",
  });

export const SubtitleStyleSchema = z.object({
  enabled: z.boolean().default(true),
  fontSize: z.number().min(12).max(72).default(28),
  color: z.string().min(3).max(32).default("#FFFFFF"),
  position: z.enum(["bottom", "middle", "top"]).default("bottom"),
  backgroundColor: z.string().min(3).max(32).default("#09090B"),
  backgroundOpacity: z.number().min(0).max(1).default(0.75),
});

export const SubtitleMetaSchema = z.object({
  language: z.string().max(32).optional(),
  model: z.string().max(64).optional(),
  generatedAt: z.string().max(64).optional(),
});

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required.").max(140),
  description: z.string().trim().max(500).optional().default(""),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  resolution: z.enum(["720p", "1080p", "4K"]).default("1080p"),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(24),
  tracks: z.array(TimelineTrackSchema).optional(),
  clips: z.array(TimelineClipSchema).optional(),
  subtitles: z.array(SubtitleSegmentSchema).optional(),
  subtitleStyle: SubtitleStyleSchema.optional(),
  subtitleMeta: SubtitleMetaSchema.optional(),
});

export const UpdateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(140).optional(),
    description: z.string().trim().max(500).optional(),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
    resolution: z.enum(["720p", "1080p", "4K"]).optional(),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Provide at least one project field to update.",
  });

export const UpdateTimelineSchema = z.object({
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  tracks: z.array(TimelineTrackSchema).min(1),
  clips: z.array(TimelineClipSchema),
  subtitles: z.array(SubtitleSegmentSchema).optional(),
  subtitleStyle: SubtitleStyleSchema.optional(),
  subtitleMeta: SubtitleMetaSchema.optional(),
});

export const UpdateSubtitlesSchema = z.object({
  subtitles: z.array(SubtitleSegmentSchema),
  subtitleStyle: SubtitleStyleSchema.optional(),
  subtitleMeta: SubtitleMetaSchema.optional(),
});
