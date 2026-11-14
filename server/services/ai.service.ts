import { GoogleGenAI, Type } from "@google/genai";
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
8. "set_clip_volume": change clip volume between 0 and 1 ("volume", optional "clipId", "reason").
9. "reorder_clip": move a clip "earlier" or "later" on its track ("clipId", "direction", "reason").
10. "unsupported": use whenever the user asks for anything requiring server-side media/audio processing or unimplemented capabilities (such as generating/transcribing subtitles or captions from audio, background noise removal, face blurring, color grading LUTs, AI object removal, or rendering/exporting MP4 files). Set "requestedAction", "reason" (explaining clearly why a media-processing backend is required), and "requiresBackendProcessing": true.

Always inspect the provided timelineMetadata carefully. If the user says "Add a title at the beginning", set startTime: 0 and pick a concise, sensible title unless they specified exact text. Only include fields relevant to each operation's type.`;

  const callGemini = async () =>
    ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: `Current timeline metadata:\n${JSON.stringify(
        params.timelineMetadata,
        null,
        2
      )}\n\nUser editing instruction: "${params.prompt}"`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: "A concise 1-sentence summary of the proposed edits.",
            },
            operations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: {
                    type: Type.STRING,
                    description:
                      "One of: trim_start, trim_end, set_aspect_ratio, add_text_overlay, split_clip, delete_clip, set_clip_speed, set_clip_volume, reorder_clip, unsupported",
                  },
                  clipId: { type: Type.STRING },
                  removeSeconds: { type: Type.NUMBER },
                  rippleShift: { type: Type.BOOLEAN },
                  aspectRatio: { type: Type.STRING },
                  text: { type: Type.STRING },
                  startTime: { type: Type.NUMBER },
                  duration: { type: Type.NUMBER },
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER },
                  fontSize: { type: Type.NUMBER },
                  color: { type: Type.STRING },
                  atTime: { type: Type.NUMBER },
                  speed: { type: Type.NUMBER },
                  volume: { type: Type.NUMBER },
                  direction: { type: Type.STRING },
                  requestedAction: { type: Type.STRING },
                  requiresBackendProcessing: { type: Type.BOOLEAN },
                  reason: { type: Type.STRING },
                },
                required: ["type", "reason"],
              },
            },
          },
          required: ["summary", "operations"],
        },
      },
    });

  let response: Awaited<ReturnType<typeof callGemini>> | undefined;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await callGemini();
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

  const planParse = AiEditPlanSchema.safeParse(parsedJson);
  if (!planParse.success) {
    throw Object.assign(
      new Error(
        `Proposed operations failed Zod validation: ${planParse.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      ),
      { statusCode: 422 }
    );
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
