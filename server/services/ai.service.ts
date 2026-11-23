import { GoogleGenAI } from "@google/genai";
import mongoose from "mongoose";
import { getEnvConfig, isGeminiConfigured } from "../config/env.ts";
import { isDatabaseConnected } from "../config/database.ts";
import { AiEditRequestModel, type IAiEditRequest } from "../models/AiEditRequest.ts";
import { ProjectModel } from "../models/Project.ts";
import { AiEditPlanSchema, type AiEditPlan } from "../../src/utils/aiOperations.ts";

export interface TimelineMetadataInput {
  projectId: string;
  projectName: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: string;
  fps: number;
  durationSeconds: number;
  selectedClipId: string | null;
  playheadTime: number;
  clips: Array<{
    id: string;
    name: string;
    kind: string;
    trackId: string;
    startTime: number;
    duration: number;
    inPoint: number;
    sourceDuration: number;
    speed: number;
    volume: number;
    opacity?: number;
    rotation?: number;
    keyframes?: Array<Record<string, unknown>>;
    effects?: Record<string, unknown>;
    transitionIn?: Record<string, unknown>;
    transitionOut?: Record<string, unknown>;
    overlayTransform?: Record<string, unknown>;
    text?: string;
  }>;
}

export async function generateAiEditPlan(params: {
  prompt: string;
  timelineMetadata: TimelineMetadataInput;
  userId?: string;
}): Promise<{ model: string; plan: AiEditPlan; requestId?: string }> {
  if (!isGeminiConfigured()) {
    throw Object.assign(
      new Error(
        "Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets to enable AI editing commands."
      ),
      { statusCode: 503, integrationPoint: "POST /api/ai/assistant" }
    );
  }

  const { geminiApiKey } = getEnvConfig();
  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const systemInstruction = `You are a structured video timeline command translator inside AI Studio.
Convert the user's natural-language editing instruction into strictly structured JSON timeline operations.
Never output shell commands, FFmpeg CLI commands, or executable code.
Only use these operation types:
1. "trim_start": remove seconds from the start of a clip ("removeSeconds", optional "clipId", optional "rippleShift" boolean, "reason").
2. "trim_end": remove seconds from the end of a clip ("removeSeconds", optional "clipId", "reason").
3. "set_aspect_ratio": change sequence aspect ratio ("aspectRatio": "16:9" | "9:16" | "1:1", "reason").
4. "add_text_overlay": add a text title/caption overlay ("text", "startTime", "duration", optional "x" 10-90, optional "y" 10-90, optional "fontSize" 16-72, optional "color" hex like "#FFFFFF", "reason").
5. "split_clip": split a clip at a timestamp ("atTime", optional "clipId", "reason").
6. "delete_clip": remove a clip ("clipId", "reason").
7. "set_clip_speed": change playback speed between 0.5 and 2 ("speed", optional "clipId", "reason").
8. "set_clip_volume": change clip volume between 0 and 2 ("volume", optional "clipId", "reason").
9. "reorder_clip": move a clip "earlier" or "later" on its track ("clipId", "direction", "reason").
10. "set_clip_effects": apply color grading presets, black-and-white filter, brightness, contrast, saturation, or blur to one clip or all V1 clips.
   Fields: optional "clipId", optional "targetScope" ("clip" | "all_v1"), optional "preset" ("none" | "cinematic" | "bw" | "vintage" | "warm" | "cool" | "vivid"), optional "brightness" (-0.5..0.5), optional "brightnessDelta" (-0.5..0.5, use e.g. 0.15 for "increase brightness" or -0.15 for "darken"), optional "contrast" (0.5..1.8), optional "saturation" (0..2), optional "blur" (0..10), and "reason".
   - If user says "Make the video black and white" without naming one clip, set "targetScope": "all_v1" and "preset": "bw".
   - If user says "Apply cinematic filter to the first clip", resolve the earliest track_v1 clip ID and MUST include "preset": "cinematic".
   - If user says "Increase brightness of the selected clip", set "clipId": selectedClipId (or omit if null) and MUST include "brightnessDelta": 0.15.
   - CRITICAL: Every "set_clip_effects" operation MUST include at least one of "preset", "brightness", "brightnessDelta", "contrast", "saturation", or "blur". Never omit all effect parameters.
11. "set_clip_transition": add transitions on a clip or between adjacent V1 clips.
   Fields: optional "clipId", optional "targetScope" ("clip" | "between_v1_clips"), optional "edge" ("in" | "out" | "both"), "transitionType" ("none" | "fade" | "dissolve" | "wipeleft" | "wiperight" | "slideleft" | "slideright" | "zoomin"), optional "durationSec" (0.2..2.0, default 0.6), and "reason".
   - For "Add a 1-second cross dissolve between clips", set "targetScope": "between_v1_clips", "edge": "out", "transitionType": "dissolve", and MUST set "durationSec": 1.0 (always honor the user's explicit seconds).
12. "set_clip_opacity": change clip visual opacity between 0 and 1 ("opacity" 0..1, optional "clipId", "reason"). For example, "Set the logo opacity to 60%" sets clipId to the track_v2 logo/overlay clip (if present) and "opacity": 0.6.
13. "set_overlay_transform": position, resize, scale, or apply layout presets to a V2 image/video overlay ("track_v2" clip such as logo, watermark, or PiP).
   Fields: optional "clipId", optional "preset" ("top-left" | "top-center" | "top-right" | "center" | "bottom-left" | "bottom-right" | "pip" | "watermark" | "fullscreen"), optional "x" (0..100), optional "y" (0..100), optional "widthPct" (5..100), optional "heightPct" (5..100), optional "scale" (0.1..2.0), optional "lockAspectRatio" boolean, and "reason".
   - For "Move the logo to the top-right corner", target the track_v2 overlay clip ID and set "preset": "top-right".
   - For "Put overlay in picture-in-picture mode", set "preset": "pip".
14. "set_clip_keyframes": animate a property over time using clip-relative keyframes (0s to clip duration).
   Fields: optional "clipId", "property" ("x" | "y" | "scale" | "rotation" | "opacity" | "volume"), optional "fromValue", optional "toValue", optional "startOffsetSec" (default 0), optional "endOffsetSec" (default clip duration), optional "easing" ("linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold", default "ease-in-out"), optional "keyframes" array of { "timeSec", "value", optional "easing" }, and "reason".
   Bounds: x/y 0..100 (percent), scale 0.1..2.0 (1.0=100%), rotation -360..360 (degrees), opacity 0..1, volume 0..2.
   - CRITICAL: MUST provide either BOTH "fromValue" and "toValue", OR a non-empty "keyframes" array.
   - For "Slowly zoom in the video", target primary video clip and set "property": "scale", "fromValue": 1.0, "toValue": 1.25, "easing": "ease-in-out".
   - For "Slide logo in from the left", target track_v2 overlay clip and set "property": "x", "fromValue": 10, "toValue": 84, "startOffsetSec": 0, "endOffsetSec": 1.5, "easing": "ease-out".
   - For "Fade volume down after 5 seconds", target track_a1 (or target clip) and set "property": "volume", "fromValue": 1.0, "toValue": 0.25, "startOffsetSec": 5, "endOffsetSec": 7.
15. "clear_clip_keyframes": remove keyframe animations from a clip ("clipId" optional, "property" optional to clear one property or omit to clear all, "reason").
16. "unsupported": use whenever the user asks for anything requiring offline/specialized media AI not available in timeline ops (such as generating/transcribing subtitles or captions from audio — remind them to use the Generate Subtitles panel — background noise removal, face blurring, AI object removal, or rendering/exporting MP4 files). Set "requestedAction", "reason", and "requiresBackendProcessing": true.

Always inspect the provided timelineMetadata carefully (trackId, clip names, selectedClipId, current effects/opacity/overlayTransform/keyframes). Match target clip IDs accurately: "first clip" -> earliest track_v1 clip id; "selected clip" -> selectedClipId; "logo"/"watermark"/"overlay"/"PiP" -> track_v2 clip id; music/audio volume -> track_a1 clip id. Only include fields relevant to each operation's type, and ALWAYS include the requested numeric or preset value.

Return ONLY valid JSON matching:
{
  "summary": "1-sentence summary",
  "operations": [ ... ]
}

Concrete examples:
- "Apply cinematic filter to the first clip." -> {"summary":"Apply cinematic filter to the first clip.","operations":[{"type":"set_clip_effects","clipId":"v1-clip-1","targetScope":"clip","preset":"cinematic","reason":"Apply cinematic preset to first clip."}]}
- "Add a 1-second cross dissolve between clips." -> {"summary":"Add a 1-second cross dissolve between V1 clips.","operations":[{"type":"set_clip_transition","targetScope":"between_v1_clips","edge":"out","transitionType":"dissolve","durationSec":1.0,"reason":"Add 1s cross dissolve between clips."}]}
- "Increase brightness of the selected clip." -> {"summary":"Increase brightness of selected clip.","operations":[{"type":"set_clip_effects","clipId":"v1-clip-1","targetScope":"clip","brightnessDelta":0.15,"reason":"Increase brightness of selected clip."}]}
- "Move the logo to the top-right corner." -> {"summary":"Move logo overlay to top-right.","operations":[{"type":"set_overlay_transform","clipId":"v2-logo","preset":"top-right","reason":"Place logo at top-right corner."}]}
- "Slowly zoom in on the first video clip." -> {"summary":"Slowly zoom in on the first clip.","operations":[{"type":"set_clip_keyframes","clipId":"v1-clip-1","property":"scale","fromValue":1.0,"toValue":1.25,"easing":"ease-in-out","reason":"Animate scale from 1.0x to 1.25x over clip duration."}]}`;

  const callGemini = async (extraReminder?: string) =>
    ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: `Current timeline metadata:\n${JSON.stringify(
        params.timelineMetadata,
        null,
        2
      )}\n\nUser editing instruction: "${params.prompt}"${
        extraReminder ? `\n\nValidation reminder: ${extraReminder}` : ""
      }`,
      config: {
        temperature: 0.1,
        systemInstruction,
        responseMimeType: "application/json",
      },
    });

  const validatePlanCompleteness = (plan: AiEditPlan): string | null => {
    for (const op of plan.operations) {
      if (
        op.type === "set_clip_effects" &&
        op.preset === undefined &&
        op.brightness === undefined &&
        op.brightnessDelta === undefined &&
        op.contrast === undefined &&
        op.saturation === undefined &&
        op.blur === undefined
      ) {
        return "Every 'set_clip_effects' operation MUST include at least one parameter: preset, brightness, brightnessDelta, contrast, saturation, or blur.";
      }
      if (
        op.type === "set_overlay_transform" &&
        op.preset === undefined &&
        op.x === undefined &&
        op.y === undefined &&
        op.widthPct === undefined &&
        op.heightPct === undefined &&
        op.scale === undefined &&
        op.lockAspectRatio === undefined
      ) {
        return "Every 'set_overlay_transform' operation MUST include at least one transform property (preset, x, y, widthPct, heightPct, scale, or lockAspectRatio).";
      }
      if (
        op.type === "set_clip_keyframes" &&
        (!op.keyframes || op.keyframes.length === 0) &&
        (op.fromValue === undefined || op.toValue === undefined)
      ) {
        return "Every 'set_clip_keyframes' operation MUST include either a non-empty 'keyframes' array or both 'fromValue' and 'toValue'.";
      }
    }
    return null;
  };

  let planParse: ReturnType<typeof AiEditPlanSchema.safeParse> | undefined;
  let extraReminder: string | undefined;

  for (let semanticAttempt = 1; semanticAttempt <= 2; semanticAttempt += 1) {
    let response: Awaited<ReturnType<typeof callGemini>> | undefined;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await callGemini(extraReminder);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes("503") ||
          msg.includes("429") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("RESOURCE_EXHAUSTED");
        if (!isTransient || attempt === maxAttempts) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }

    const rawText = (response?.text ?? "").trim();
    if (!rawText) {
      throw Object.assign(
        new Error("Gemini returned an empty response. Try rephrasing your editing instruction."),
        { statusCode: 502 }
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw Object.assign(new Error("Gemini returned non-JSON output that could not be parsed."), {
        statusCode: 502,
      });
    }

    planParse = AiEditPlanSchema.safeParse(parsedJson);
    if (!planParse.success) {
      if (semanticAttempt === 2) {
        throw Object.assign(
          new Error(
            `Proposed operations failed Zod validation: ${planParse.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`
          ),
          { statusCode: 422 }
        );
      }
      extraReminder = "Output valid JSON matching the exact schema field names and numeric bounds.";
      continue;
    }

    const completenessErr = validatePlanCompleteness(planParse.data);
    if (!completenessErr) {
      break;
    }
    if (semanticAttempt === 2) {
      throw Object.assign(new Error(completenessErr), { statusCode: 422 });
    }
    extraReminder = completenessErr;
  }

  if (!planParse || !planParse.success) {
    throw Object.assign(new Error("Failed to parse valid AI edit operations."), { statusCode: 422 });
  }

  let requestId: string | undefined;

  // Persist AI edit request to MongoDB when DB is connected and user owns a persisted Project
  if (
    isDatabaseConnected() &&
    params.userId &&
    mongoose.Types.ObjectId.isValid(params.timelineMetadata.projectId)
  ) {
    const ownsProject = await ProjectModel.exists({
      _id: params.timelineMetadata.projectId,
      userId: params.userId,
    });
    if (ownsProject) {
      const saved = await AiEditRequestModel.create({
        userId: new mongoose.Types.ObjectId(params.userId),
        projectId: new mongoose.Types.ObjectId(params.timelineMetadata.projectId),
        prompt: params.prompt,
        modelName: "gemini-4-hydrogen",
        timelineMetadataSnapshot: { ...params.timelineMetadata } as Record<string, unknown>,
        proposedPlan: planParse.data,
        status: "proposed",
      });
      requestId = saved._id.toString();
    }
  }

  return {
    model: "gemini-4-hydrogen",
    plan: planParse.data,
    requestId,
  };
}

export async function listUserAiRequests(
  userId: string,
  projectId?: string
): Promise<IAiEditRequest[]> {
  const filter: Record<string, unknown> = { userId };
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
    filter.projectId = projectId;
  }
  return AiEditRequestModel.find(filter).sort({ createdAt: -1 }).limit(50);
}

export async function updateUserAiRequestStatus(
  userId: string,
  requestId: string,
  status: "applied" | "discarded"
): Promise<IAiEditRequest | null> {
  return AiEditRequestModel.findOneAndUpdate(
    { _id: requestId, userId },
    {
      $set: {
        status,
        ...(status === "applied" ? { appliedAt: new Date() } : {}),
      },
    },
    { new: true }
  );
}
