import { z } from "zod";
import type {
  AspectRatioOption,
  EffectPreset,
  StoryboardCameraMotion,
  StoryboardCaptionPreference,
  StoryboardDraftRecord,
  StoryboardLanguage,
  StoryboardMediaType,
  StoryboardScene,
  StoryboardSettings,
  StoryboardSourceMode,
  StoryboardStyle,
  StoryboardTargetDuration,
  StoryboardVoiceoverPreference,
  TransitionType,
  VideoStoryboard,
} from "../types/studio";
import { EFFECT_PRESETS, TRANSITION_OPTIONS } from "./effects";

export const MAX_STORYBOARD_SCENES = 12;
export const MIN_STORYBOARD_SCENE_DURATION_SEC = 0.5;
export const STORYBOARD_TIMING_TOLERANCE_SEC = 0.05;
export const LOCAL_STORYBOARD_DRAFT_STORAGE_KEY = "ai_studio_storyboard_drafts_v1";

export const STORYBOARD_TARGET_DURATIONS = [15, 30, 60] as const;

export const STORYBOARD_ASPECT_RATIOS: ReadonlyArray<AspectRatioOption> = ["16:9", "9:16", "1:1"];

export const STORYBOARD_STYLES: ReadonlyArray<StoryboardStyle> = [
  "Cinematic",
  "Educational",
  "Motivational",
  "Minimal",
  "Social Media",
];

export const STORYBOARD_LANGUAGES: ReadonlyArray<StoryboardLanguage> = [
  "English",
  "Hindi",
  "Bengali",
];

export const VOICEOVER_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: StoryboardVoiceoverPreference;
  label: string;
}> = [
  { value: "natural_narrator", label: "Natural Narrator" },
  { value: "energetic_host", label: "Energetic Host" },
  { value: "calm_explainer", label: "Calm Explainer" },
  { value: "none", label: "No Voiceover" },
];

export const CAPTION_PREFERENCE_OPTIONS: ReadonlyArray<{
  value: StoryboardCaptionPreference;
  label: string;
}> = [
  { value: "clean_subtitles", label: "Clean Subtitles" },
  { value: "bold_social", label: "Bold Social Captions" },
  { value: "minimal_lower", label: "Minimal Lower-Third" },
  { value: "none", label: "No Captions" },
];

export const STORYBOARD_MEDIA_TYPE_OPTIONS: ReadonlyArray<{
  value: StoryboardMediaType;
  label: string;
}> = [
  { value: "video", label: "Video Clip" },
  { value: "image", label: "Still Image" },
  { value: "motion_graphic", label: "Motion Graphic" },
  { value: "text_card", label: "Title / Text Card" },
];

export const CAMERA_MOTION_OPTIONS: ReadonlyArray<{
  value: StoryboardCameraMotion;
  label: string;
}> = [
  { value: "static", label: "Static Frame" },
  { value: "slow-dolly-in", label: "Slow Dolly In" },
  { value: "slow-dolly-out", label: "Slow Dolly Out" },
  { value: "pan-left", label: "Pan Left" },
  { value: "pan-right", label: "Pan Right" },
  { value: "aerial-orbit", label: "Aerial Orbit" },
  { value: "handheld-subtle", label: "Subtle Handheld" },
];

export const SUPPORTED_TRANSITION_VALUES = TRANSITION_OPTIONS.map((t) => t.value) as [
  TransitionType,
  ...TransitionType[],
];

export const SUPPORTED_EFFECT_VALUES = EFFECT_PRESETS.map((e) => e.value) as [
  EffectPreset,
  ...EffectPreset[],
];

const TransitionTypeEnum = z.enum(SUPPORTED_TRANSITION_VALUES);
const EffectPresetEnum = z.enum(SUPPORTED_EFFECT_VALUES);

export const StoryboardMediaTypeEnum = z.enum([
  "video",
  "image",
  "text_card",
  "motion_graphic",
]);

export const StoryboardCameraMotionEnum = z.enum([
  "static",
  "slow-dolly-in",
  "slow-dolly-out",
  "pan-left",
  "pan-right",
  "aerial-orbit",
  "handheld-subtle",
]);

export const StoryboardStyleEnum = z.enum([
  "Cinematic",
  "Educational",
  "Motivational",
  "Minimal",
  "Social Media",
]);

export const StoryboardLanguageEnum = z.enum(["English", "Hindi", "Bengali"]);

export const StoryboardVoiceoverPreferenceEnum = z.enum([
  "none",
  "natural_narrator",
  "energetic_host",
  "calm_explainer",
]);

export const StoryboardCaptionPreferenceEnum = z.enum([
  "none",
  "clean_subtitles",
  "bold_social",
  "minimal_lower",
]);

export const StoryboardDurationSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
]);

export const StoryboardGenerationInputSchema = z
  .object({
    mode: z.enum(["prompt-to-video", "script-to-video", "image-animation"]),
    title: z.string().trim().max(120, "Video title must be 120 characters or fewer.").optional().default(""),
    prompt: z
      .string()
      .trim()
      .max(4000, "Prompt or script must be 4,000 characters or fewer."),
    targetDurationSec: StoryboardDurationSchema,
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
    style: StoryboardStyleEnum,
    language: StoryboardLanguageEnum,
    voiceoverEnabled: z.boolean().default(true),
    voiceoverPreference: StoryboardVoiceoverPreferenceEnum.default("natural_narrator"),
    captionsEnabled: z.boolean().default(true),
    captionStyle: StoryboardCaptionPreferenceEnum.default("clean_subtitles"),
    targetAudience: z
      .string()
      .trim()
      .max(160, "Target audience must be 160 characters or fewer.")
      .optional()
      .default(""),
    additionalInstructions: z
      .string()
      .trim()
      .max(500, "Additional instructions must be 500 characters or fewer.")
      .optional()
      .default(""),
    requestKey: z.string().trim().max(80).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "image-animation") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message:
          "Image Animation is an upcoming feature and is not enabled yet. Select Prompt to Video or Script to Video.",
      });
      return;
    }
    const minLen = data.mode === "script-to-video" ? 20 : 10;
    if (data.prompt.length < minLen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message:
          data.mode === "script-to-video"
            ? "Provide an existing script of at least 20 characters."
            : "Provide a descriptive video prompt of at least 10 characters.",
      });
    }
  });

export type ValidatedStoryboardInput = z.infer<typeof StoryboardGenerationInputSchema> & {
  mode: StoryboardSourceMode;
};

const NonBlobUrlString = z
  .string()
  .trim()
  .max(1000)
  .refine((val) => val === "" || !/^blob:/i.test(val), {
    message: "Temporary blob URLs cannot be saved permanently inside storyboard assignments.",
  });

export const SceneAssignedMediaTypeEnum = z.enum(["image", "video", "generated_slide"]);
export const SceneMediaSourceEnum = z.enum([
  "uploaded",
  "existing_library",
  "stock",
  "generated_slide",
]);
export const SceneMediaAssignmentStatusEnum = z.enum([
  "unassigned",
  "matching",
  "assigned",
  "missing",
  "invalid",
  "failed",
]);
export const AspectRatioHandlingModeEnum = z.enum(["preserve", "fit", "fill"]);

export const StoryboardSceneMediaAssignmentSchema = z.object({
  sceneId: z.string().trim().min(1).max(64),
  mediaAssetId: z.string().trim().min(1).max(160),
  mediaType: SceneAssignedMediaTypeEnum,
  mediaSource: SceneMediaSourceEnum,
  assetTitle: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  width: z.number().int().positive().max(16384).optional(),
  height: z.number().int().positive().max(16384).optional(),
  duration: z.number().finite().min(0).max(86_400).optional(),
  thumbnailRef: NonBlobUrlString.optional(),
  sourceUrl: NonBlobUrlString.optional(),
  providerName: z.string().trim().max(80).optional(),
  providerAssetId: z.string().trim().max(120).optional(),
  creatorName: z.string().trim().max(160).optional(),
  attributionUrl: NonBlobUrlString.optional(),
  licenseInfo: z.string().trim().max(200).optional(),
  matchScore: z.number().finite().min(0).max(100).optional(),
  matchExplanation: z.string().trim().max(320).optional(),
  assignmentStatus: SceneMediaAssignmentStatusEnum,
  sourceStartTime: z.number().finite().min(0).max(86_400).default(0),
  aspectRatioHandling: AspectRatioHandlingModeEnum.default("fit"),
  assignedAt: z.string().trim().min(1).max(64),
});

export const StoryboardMediaSummarySchema = z.object({
  totalScenes: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  assignedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  unassignedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  missingOrInvalidCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  readyCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  progressPercent: z.number().min(0).max(100),
  overallStatus: SceneMediaAssignmentStatusEnum,
  isMediaReady: z.boolean(),
});

export const TtsLanguageCodeEnum = z.enum(["en", "hi", "bn"]);
export const TtsEngineIdEnum = z.enum(["piper", "espeak_ng", "windows_sapi"]);
export const TtsProviderIdEnum = z.enum(["auto", "piper", "espeak_ng", "windows_sapi", "none"]);
export const TtsAudioFormatEnum = z.enum(["wav", "mp3"]);
export const SceneVoiceoverStatusEnum = z.enum([
  "none",
  "generating",
  "ready",
  "stale",
  "missing",
  "failed",
  "skipped_empty",
]);

export const StoryboardSceneVoiceoverSchema = z.object({
  sceneId: z.string().trim().min(1).max(64),
  mediaAssetId: z
    .string()
    .trim()
    .max(160)
    .refine((val) => !/^blob:/i.test(val), {
      message: "Voiceover asset ID cannot be a blob URL.",
    })
    .optional(),
  provider: TtsEngineIdEnum,
  voiceId: z.string().trim().min(1).max(160),
  voiceLabel: z.string().trim().min(1).max(200),
  language: TtsLanguageCodeEnum,
  speakingRate: z.number().finite().min(0.6).max(1.5).default(1.0),
  pitch: z.number().finite().min(-20).max(20).default(0),
  volume: z.number().finite().min(0).max(2).default(1),
  format: TtsAudioFormatEnum.default("wav"),
  mimeType: z.string().trim().min(1).max(80),
  durationSeconds: z.number().finite().min(0).max(3600),
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024),
  sampleRateHz: z.number().int().min(8000).max(96000),
  channels: z.number().int().min(1).max(8),
  narrationFingerprint: z.string().trim().min(1).max(128),
  generatedAt: z.string().trim().min(1).max(64),
  status: SceneVoiceoverStatusEnum,
  errorMessage: z.string().trim().max(400).optional(),
});

export const StoryboardVoiceoverSettingsSchema = z.object({
  provider: TtsProviderIdEnum.default("auto"),
  voiceId: z.string().trim().max(160).optional(),
  speakingRate: z.number().finite().min(0.6).max(1.5).default(1.0),
  pitch: z.number().finite().min(-20).max(20).default(0),
  format: TtsAudioFormatEnum.default("wav"),
  volume: z.number().finite().min(0).max(2).default(1),
});

export const StoryboardVoiceoverSummarySchema = z.object({
  totalScenes: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  spokenScenes: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  readyCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  staleCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  missingCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  failedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  unassignedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  overflowCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  totalAudioDurationSec: z.number().finite().min(0).max(86_400),
  progressPercent: z.number().min(0).max(100),
  isVoiceoverReady: z.boolean(),
});

export const CaptionGenerationModeEnum = z.enum(["script", "audio"]);
export const CaptionTimingSourceEnum = z.enum([
  "estimated",
  "audio_transcription",
  "manual",
]);
export const SceneCaptionStatusEnum = z.enum([
  "none",
  "queued",
  "generating",
  "ready",
  "stale",
  "failed",
  "skipped_empty",
]);
export const CaptionStylePresetIdEnum = z.enum([
  "classic",
  "cinematic",
  "educational",
  "social_media",
  "minimal",
  "yellow_highlight",
]);

const HexColorString = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a 6-digit hex string.");

export const CaptionStyleConfigSchema = z.object({
  presetId: CaptionStylePresetIdEnum.default("classic"),
  enabled: z.boolean().default(true),
  fontFamily: z.string().trim().min(1).max(200),
  fontSize: z.number().int().min(18).max(72).default(40),
  fontWeight: z.union([
    z.literal(400),
    z.literal(500),
    z.literal(600),
    z.literal(700),
    z.literal(800),
  ]).default(600),
  color: HexColorString.default("#FFFFFF"),
  backgroundEnabled: z.boolean().default(true),
  backgroundColor: HexColorString.default("#09090B"),
  backgroundOpacity: z.number().finite().min(0).max(1).default(0.75),
  outlineWidth: z.number().finite().min(0).max(6).default(2),
  outlineColor: HexColorString.default("#000000"),
  position: z.enum(["top", "middle", "bottom"]).default("bottom"),
  alignment: z.enum(["left", "center", "right"]).default("center"),
  safeMarginBottomPct: z.number().finite().min(4).max(30).default(10),
  maxLines: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
});

export const StoryboardCaptionWordTimestampSchema = z.object({
  word: z.string().trim().min(1).max(120),
  start: z.number().finite().min(0).max(3600),
  end: z.number().finite().min(0).max(3600),
});

export const StoryboardCaptionSegmentSchema = z.object({
  id: z.string().trim().min(1).max(96),
  start: z.number().finite().min(0).max(3600),
  end: z.number().finite().min(0).max(3600),
  text: z.string().trim().max(400),
  timingSource: CaptionTimingSourceEnum,
  words: z.array(StoryboardCaptionWordTimestampSchema).max(80).optional(),
  isManuallyEdited: z.boolean().optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
});

export const StoryboardSceneCaptionsSchema = z.object({
  sceneId: z.string().trim().min(1).max(64),
  mode: CaptionGenerationModeEnum,
  timingSource: CaptionTimingSourceEnum,
  language: TtsLanguageCodeEnum,
  status: SceneCaptionStatusEnum,
  segments: z.array(StoryboardCaptionSegmentSchema).max(100),
  fingerprint: z.string().trim().min(1).max(128),
  sourceNarrationSnapshot: z.string().max(1500),
  sourceVoiceoverMediaAssetId: z
    .string()
    .trim()
    .max(160)
    .refine((val) => !/^blob:/i.test(val), {
      message: "Caption source asset ID cannot be a blob URL.",
    })
    .optional(),
  sourceVoiceoverDurationSec: z.number().finite().min(0).max(3600).optional(),
  sourceSceneDurationSec: z.number().finite().min(0).max(3600).optional(),
  model: z.string().trim().max(80).optional(),
  detectedLanguage: z.string().trim().max(32).optional(),
  languageProbability: z.number().finite().min(0).max(1).optional(),
  generatedAt: z.string().trim().min(1).max(64),
  hasManualEdits: z.boolean().optional(),
  overflowsSceneDuration: z.boolean().optional(),
  warnings: z.array(z.string().trim().max(300)).max(12).optional(),
  errorMessage: z.string().trim().max(400).optional(),
});

export const StoryboardCaptionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultMode: CaptionGenerationModeEnum.default("script"),
  language: z.union([z.literal("match_storyboard"), TtsLanguageCodeEnum]).default("match_storyboard"),
  wordTimestamps: z.boolean().default(false),
  style: CaptionStyleConfigSchema,
});

export const StoryboardCaptionSummarySchema = z.object({
  totalScenes: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  captionableScenes: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  readyCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  staleCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  failedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  unassignedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  manualCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  overflowCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  totalCueCount: z.number().int().min(0).max(1200),
  estimatedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  transcribedCount: z.number().int().min(0).max(MAX_STORYBOARD_SCENES),
  progressPercent: z.number().min(0).max(100),
  isCaptionsReady: z.boolean(),
});

export const StoryboardSceneSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "Scene ID cannot be empty.")
    .max(64, "Scene ID must be 64 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Scene ID may only contain letters, numbers, underscores, and hyphens."),
  title: z.string().trim().min(1, "Scene title is required.").max(120, "Scene title max 120 chars."),
  startTime: z.number().finite("Scene startTime must be finite.").min(0, "Scene startTime must be >= 0.").max(60),
  duration: z
    .number()
    .finite("Scene duration must be finite.")
    .min(MIN_STORYBOARD_SCENE_DURATION_SEC, "Scene duration must be at least 0.5 seconds.")
    .max(60, "Single scene duration cannot exceed 60 seconds."),
  narration: z.string().trim().max(1500, "Scene narration max 1500 chars."),
  onScreenText: z.string().trim().max(220, "On-screen text max 220 chars."),
  visualDescription: z
    .string()
    .trim()
    .min(1, "Visual description is required.")
    .max(600, "Visual description max 600 chars."),
  mediaKeywords: z
    .array(z.string().trim().min(1).max(60))
    .min(1, "At least 1 media keyword is required.")
    .max(8, "Maximum 8 media keywords per scene."),
  mediaType: StoryboardMediaTypeEnum,
  transition: TransitionTypeEnum,
  effect: EffectPresetEnum,
  cameraMotion: StoryboardCameraMotionEnum,
  mediaAssignment: StoryboardSceneMediaAssignmentSchema.optional(),
  voiceover: StoryboardSceneVoiceoverSchema.optional(),
  captions: StoryboardSceneCaptionsSchema.optional(),
});

export const AiStoryboardOutputSchema = z.object({
  title: z.string().trim().min(1, "Storyboard title is required.").max(120),
  description: z.string().trim().min(1, "Storyboard description is required.").max(500),
  targetAudience: z.string().trim().min(1, "Target audience is required.").max(160),
  language: StoryboardLanguageEnum,
  totalDuration: StoryboardDurationSchema,
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  style: StoryboardStyleEnum,
  fullNarrationScript: z.string().trim().max(5000),
  backgroundMusicMood: z.string().trim().min(1, "Background music mood is required.").max(120),
  captionText: z.string().trim().max(5000),
  scenes: z
    .array(StoryboardSceneSchema)
    .min(1, "Storyboard must include at least 1 scene.")
    .max(MAX_STORYBOARD_SCENES, `Storyboard cannot exceed ${MAX_STORYBOARD_SCENES} scenes.`),
});

export const StoryboardSettingsSchema = z.object({
  mode: z.enum(["prompt-to-video", "script-to-video"]),
  targetDurationSec: StoryboardDurationSchema,
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  style: StoryboardStyleEnum,
  language: StoryboardLanguageEnum,
  voiceoverEnabled: z.boolean(),
  voiceoverPreference: StoryboardVoiceoverPreferenceEnum,
  captionsEnabled: z.boolean(),
  captionStyle: StoryboardCaptionPreferenceEnum,
  targetAudience: z.string().trim().max(160),
  additionalInstructions: z.string().trim().max(500),
});

export const VideoStoryboardSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  targetAudience: z.string().trim().max(160),
  language: StoryboardLanguageEnum,
  totalDuration: StoryboardDurationSchema,
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  style: StoryboardStyleEnum,
  fullNarrationScript: z.string().trim().max(5000),
  backgroundMusicMood: z.string().trim().min(1).max(120),
  captionText: z.string().trim().max(5000),
  settings: StoryboardSettingsSchema,
  scenes: z.array(StoryboardSceneSchema).min(1).max(MAX_STORYBOARD_SCENES),
  sourceMode: z.enum(["prompt-to-video", "script-to-video"]),
  model: z.string().trim().max(80).optional(),
  compositionReady: z.literal(false),
  mediaReadinessSummary: StoryboardMediaSummarySchema.optional(),
  voiceoverSettings: StoryboardVoiceoverSettingsSchema.optional(),
  voiceoverSummary: StoryboardVoiceoverSummarySchema.optional(),
  captionSettings: StoryboardCaptionSettingsSchema.optional(),
  captionSummary: StoryboardCaptionSummarySchema.optional(),
  createdAt: z.string().trim().max(64),
  updatedAt: z.string().trim().max(64),
});

export function roundTo2(value: number): number {
  return Number(value.toFixed(2));
}

export interface StoryboardValidationReport {
  valid: boolean;
  errors: string[];
  actualDuration: number;
  durationDelta: number;
}

export function validateStoryboardInvariants(
  storyboard: Pick<VideoStoryboard, "totalDuration" | "scenes">
): StoryboardValidationReport {
  const errors: string[] = [];

  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    errors.push("Storyboard must contain at least 1 scene.");
    return {
      valid: false,
      errors,
      actualDuration: 0,
      durationDelta: -storyboard.totalDuration,
    };
  }

  if (storyboard.scenes.length > MAX_STORYBOARD_SCENES) {
    errors.push(`Storyboard cannot contain more than ${MAX_STORYBOARD_SCENES} scenes.`);
  }

  const seenIds = new Set<string>();
  let runningTime = 0;

  for (let i = 0; i < storyboard.scenes.length; i += 1) {
    const scene = storyboard.scenes[i];

    if (!scene.id || !scene.id.trim()) {
      errors.push(`Scene ${i + 1} is missing a unique ID.`);
    } else if (seenIds.has(scene.id)) {
      errors.push(`Duplicate scene ID detected: "${scene.id}".`);
    } else {
      seenIds.add(scene.id);
    }

    if (!Number.isFinite(scene.startTime) || scene.startTime < 0) {
      errors.push(`Scene ${i + 1} ("${scene.title}") has an invalid startTime.`);
    } else if (Math.abs(scene.startTime - runningTime) > STORYBOARD_TIMING_TOLERANCE_SEC) {
      errors.push(
        `Scene ${i + 1} ("${scene.title}") starts at ${roundTo2(scene.startTime)}s, expected ${roundTo2(
          runningTime
        )}s (no gaps or overlaps allowed).`
      );
    }

    if (!Number.isFinite(scene.duration) || scene.duration < MIN_STORYBOARD_SCENE_DURATION_SEC) {
      errors.push(
        `Scene ${i + 1} ("${scene.title}") must have a positive duration of at least ${MIN_STORYBOARD_SCENE_DURATION_SEC}s.`
      );
    } else {
      runningTime = roundTo2(runningTime + scene.duration);
    }

    if (!SUPPORTED_TRANSITION_VALUES.includes(scene.transition)) {
      errors.push(
        `Scene ${i + 1} ("${scene.title}") uses unsupported transition "${scene.transition}".`
      );
    }
    if (!SUPPORTED_EFFECT_VALUES.includes(scene.effect)) {
      errors.push(`Scene ${i + 1} ("${scene.title}") uses unsupported effect "${scene.effect}".`);
    }
  }

  const actualDuration = roundTo2(runningTime);
  const durationDelta = roundTo2(actualDuration - storyboard.totalDuration);

  if (Math.abs(durationDelta) > STORYBOARD_TIMING_TOLERANCE_SEC) {
    errors.push(
      `Total scene duration (${actualDuration}s) does not match target duration (${storyboard.totalDuration}s). Adjust scene durations by ${
        durationDelta > 0 ? `-${durationDelta}` : `+${Math.abs(durationDelta)}`
      }s.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    actualDuration,
    durationDelta,
  };
}

export function buildValidatedStoryboardFromAi(
  rawJson: unknown,
  input: ValidatedStoryboardInput,
  modelName = "gemini-3.5-flash"
): VideoStoryboard {
  const parsed = AiStoryboardOutputSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw Object.assign(new Error(`Storyboard validation failed: ${issueSummary}`), {
      statusCode: 422,
    });
  }

  const data = parsed.data;

  // Enforce requested structural settings over AI echoes where explicit user inputs exist
  if (data.totalDuration !== input.targetDurationSec) {
    throw Object.assign(
      new Error(
        `Storyboard validation failed: AI returned totalDuration=${data.totalDuration}s instead of requested ${input.targetDurationSec}s.`
      ),
      { statusCode: 422 }
    );
  }

  const scenes: StoryboardScene[] = data.scenes.map((scene) => ({
    ...scene,
    startTime: roundTo2(scene.startTime),
    duration: roundTo2(scene.duration),
    mediaKeywords: scene.mediaKeywords.map((kw) => kw.trim()).filter(Boolean).slice(0, 8),
  }));

  const report = validateStoryboardInvariants({
    totalDuration: input.targetDurationSec,
    scenes,
  });

  if (!report.valid) {
    throw Object.assign(new Error(`Storyboard validation failed: ${report.errors[0]}`), {
      statusCode: 422,
      validationErrors: report.errors,
    });
  }

  const now = new Date().toISOString();
  const settings: StoryboardSettings = {
    mode: input.mode,
    targetDurationSec: input.targetDurationSec,
    aspectRatio: input.aspectRatio,
    style: input.style,
    language: input.language,
    voiceoverEnabled: input.voiceoverEnabled,
    voiceoverPreference: input.voiceoverEnabled ? input.voiceoverPreference : "none",
    captionsEnabled: input.captionsEnabled,
    captionStyle: input.captionsEnabled ? input.captionStyle : "none",
    targetAudience: (input.targetAudience || data.targetAudience).slice(0, 160),
    additionalInstructions: (input.additionalInstructions || "").slice(0, 500),
  };

  return {
    id: `sb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: (input.title?.trim() || data.title).slice(0, 120),
    description: data.description.slice(0, 500),
    targetAudience: settings.targetAudience || data.targetAudience.slice(0, 160),
    language: input.language,
    totalDuration: input.targetDurationSec,
    aspectRatio: input.aspectRatio,
    style: input.style,
    fullNarrationScript: data.fullNarrationScript.slice(0, 5000),
    backgroundMusicMood: data.backgroundMusicMood.slice(0, 120),
    captionText: data.captionText.slice(0, 5000),
    settings,
    scenes,
    sourceMode: input.mode,
    model: modelName,
    compositionReady: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function recalculateStoryboardTiming(scenes: StoryboardScene[]): StoryboardScene[] {
  let cursor = 0;
  return scenes.map((scene) => {
    const safeDuration = Number.isFinite(scene.duration)
      ? Math.max(MIN_STORYBOARD_SCENE_DURATION_SEC, Math.min(60, roundTo2(scene.duration)))
      : MIN_STORYBOARD_SCENE_DURATION_SEC;
    const nextScene: StoryboardScene = {
      ...scene,
      startTime: roundTo2(cursor),
      duration: safeDuration,
    };
    cursor = roundTo2(cursor + safeDuration);
    return nextScene;
  });
}

export function reorderStoryboardScenes(
  scenes: StoryboardScene[],
  fromIndex: number,
  toIndex: number
): StoryboardScene[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= scenes.length ||
    toIndex >= scenes.length
  ) {
    return scenes;
  }
  const next = [...scenes];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return recalculateStoryboardTiming(next);
}

export function generateUniqueSceneId(existingScenes: StoryboardScene[]): string {
  const existingIds = new Set(existingScenes.map((s) => s.id));
  let counter = existingScenes.length + 1;
  while (counter < 1000) {
    const candidate = `scene_${counter}_${Math.random().toString(36).slice(2, 5)}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
  return `scene_${Date.now()}`;
}

export function createBlankStoryboardScene(
  existingScenes: StoryboardScene[],
  defaultDuration = 5
): StoryboardScene {
  const totalSoFar = existingScenes.reduce((sum, s) => sum + s.duration, 0);
  return {
    id: generateUniqueSceneId(existingScenes),
    title: `Scene ${existingScenes.length + 1}`,
    startTime: roundTo2(totalSoFar),
    duration: Math.max(MIN_STORYBOARD_SCENE_DURATION_SEC, Math.min(60, roundTo2(defaultDuration))),
    narration: "",
    onScreenText: "",
    visualDescription: "Describe the visual composition, subject, and lighting for this scene.",
    mediaKeywords: ["cinematic", "b-roll"],
    mediaType: "video",
    transition: "dissolve",
    effect: "none",
    cameraMotion: "static",
  };
}

export function fitSceneDurationsToTarget(
  scenes: StoryboardScene[],
  targetDuration: StoryboardTargetDuration
): StoryboardScene[] {
  if (scenes.length === 0) return scenes;
  const currentTotal = scenes.reduce((sum, s) => sum + Math.max(0.5, s.duration), 0);
  if (currentTotal <= 0) return scenes;

  const minSum = scenes.length * MIN_STORYBOARD_SCENE_DURATION_SEC;
  if (minSum > targetDuration) return scenes;

  const scaled = scenes.map((s) =>
    Math.max(
      MIN_STORYBOARD_SCENE_DURATION_SEC,
      roundTo2((Math.max(0.5, s.duration) / currentTotal) * targetDuration)
    )
  );

  // Adjust last scene to eliminate rounding residual cleanly
  const sumExceptLast = scaled.slice(0, -1).reduce((a, b) => a + b, 0);
  const lastAdjusted = roundTo2(targetDuration - sumExceptLast);
  if (lastAdjusted >= MIN_STORYBOARD_SCENE_DURATION_SEC) {
    scaled[scaled.length - 1] = lastAdjusted;
  }

  return recalculateStoryboardTiming(
    scenes.map((scene, idx) => ({
      ...scene,
      duration: scaled[idx],
    }))
  );
}

export function buildNarrationFromScenes(scenes: StoryboardScene[]): string {
  return scenes
    .map((s) => s.narration.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 5000);
}

export function buildCaptionsFromScenes(scenes: StoryboardScene[]): string {
  return scenes
    .map((s) => s.onScreenText.trim() || s.narration.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 5000);
}

function getLocalStorageDraftKey(scopeKey = "local"): string {
  const safeScope = scopeKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "local";
  return `${LOCAL_STORYBOARD_DRAFT_STORAGE_KEY}:${safeScope}`;
}

export function sanitizeStoryboardForPersistence(storyboard: VideoStoryboard): VideoStoryboard {
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => {
      const nextAssignment = scene.mediaAssignment
        ? {
            ...scene.mediaAssignment,
            sceneId: scene.id,
            ...(scene.mediaAssignment.thumbnailRef &&
            !/^blob:/i.test(scene.mediaAssignment.thumbnailRef)
              ? { thumbnailRef: scene.mediaAssignment.thumbnailRef }
              : { thumbnailRef: undefined }),
            ...(scene.mediaAssignment.sourceUrl &&
            !/^blob:/i.test(scene.mediaAssignment.sourceUrl)
              ? { sourceUrl: scene.mediaAssignment.sourceUrl }
              : { sourceUrl: undefined }),
            ...(scene.mediaAssignment.attributionUrl &&
            !/^blob:/i.test(scene.mediaAssignment.attributionUrl)
              ? { attributionUrl: scene.mediaAssignment.attributionUrl }
              : { attributionUrl: undefined }),
          }
        : undefined;

      const cleanedVoiceoverMediaAssetId =
        scene.voiceover?.mediaAssetId && !/^blob:/i.test(scene.voiceover.mediaAssetId)
          ? scene.voiceover.mediaAssetId
          : undefined;
      const cleanedVoiceoverError =
        scene.voiceover?.errorMessage && !/\bblob:/i.test(scene.voiceover.errorMessage)
          ? scene.voiceover.errorMessage
          : undefined;

      const nextVoiceover = scene.voiceover
        ? {
            ...scene.voiceover,
            sceneId: scene.id,
            mediaAssetId: cleanedVoiceoverMediaAssetId,
            errorMessage: cleanedVoiceoverError,
            status:
              scene.voiceover.status === "generating"
                ? cleanedVoiceoverMediaAssetId
                  ? ("ready" as const)
                  : ("failed" as const)
                : scene.voiceover.status === "ready" && !cleanedVoiceoverMediaAssetId
                  ? ("missing" as const)
                  : scene.voiceover.status,
          }
        : undefined;

      const cleanedCaptionAssetId =
        scene.captions?.sourceVoiceoverMediaAssetId &&
        !/^blob:/i.test(scene.captions.sourceVoiceoverMediaAssetId)
          ? scene.captions.sourceVoiceoverMediaAssetId
          : undefined;
      const cleanedCaptionError =
        scene.captions?.errorMessage && !/\bblob:/i.test(scene.captions.errorMessage)
          ? scene.captions.errorMessage
          : undefined;

      const nextCaptions = scene.captions
        ? {
            ...scene.captions,
            sceneId: scene.id,
            sourceVoiceoverMediaAssetId: cleanedCaptionAssetId,
            errorMessage: cleanedCaptionError,
            status:
              scene.captions.status === "generating" || scene.captions.status === "queued"
                ? scene.captions.segments.length > 0
                  ? ("ready" as const)
                  : ("none" as const)
                : scene.captions.status,
          }
        : undefined;

      return {
        ...scene,
        ...(nextAssignment ? { mediaAssignment: nextAssignment } : {}),
        ...(nextVoiceover ? { voiceover: nextVoiceover } : {}),
        ...(nextCaptions ? { captions: nextCaptions } : {}),
      };
    }),
  };
}

export function saveLocalStoryboardDraft(
  draft: StoryboardDraftRecord,
  scopeKey = "local"
): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }
  try {
    const key = getLocalStorageDraftKey(scopeKey);
    const sanitizedDraft: StoryboardDraftRecord = {
      ...draft,
      storyboard: sanitizeStoryboardForPersistence(draft.storyboard),
    };
    window.localStorage.setItem(key, JSON.stringify(sanitizedDraft));
    return true;
  } catch {
    return false;
  }
}

export function loadLocalStoryboardDraft(scopeKey = "local"): StoryboardDraftRecord | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const key = getLocalStorageDraftKey(scopeKey);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoryboardDraftRecord>;
    if (!parsed || typeof parsed !== "object" || !parsed.storyboard) return null;
    const sbCheck = VideoStoryboardSchema.safeParse(parsed.storyboard);
    if (!sbCheck.success) return null;
    return {
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : sbCheck.data.id,
      ...(typeof parsed.serverDraftId === "string" && parsed.serverDraftId
        ? { serverDraftId: parsed.serverDraftId }
        : {}),
      title: typeof parsed.title === "string" && parsed.title ? parsed.title : sbCheck.data.title,
      status: parsed.status === "validated" ? "validated" : "draft",
      storyboard: sbCheck.data,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : sbCheck.data.updatedAt,
    };
  } catch {
    return null;
  }
}

export function clearLocalStoryboardDraft(scopeKey = "local"): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(getLocalStorageDraftKey(scopeKey));
  } catch {
    // Ignore storage removal errors
  }
}

export function loadAllLocalStoryboardDrafts(): StoryboardDraftRecord[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }
  const results: StoryboardDraftRecord[] = [];
  try {
    const prefix = `${LOCAL_STORYBOARD_DRAFT_STORAGE_KEY}:`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const scope = key.slice(prefix.length);
      const draft = loadLocalStoryboardDraft(scope);
      if (draft) {
        results.push(draft);
      }
    }
  } catch {
    return [];
  }
  return results;
}
