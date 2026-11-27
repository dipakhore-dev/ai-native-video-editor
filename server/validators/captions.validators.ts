import { z } from "zod";

export const CLIENT_CAPTIONS_JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type CaptionLanguageCode = "en" | "hi" | "bn";

export function normalizeCaptionLanguageInput(
  raw?: string | null
): CaptionLanguageCode | "auto" {
  const cleaned = (raw || "").trim().toLowerCase();
  if (!cleaned || cleaned === "auto") return "auto";
  if (cleaned === "en" || cleaned === "english") return "en";
  if (cleaned === "hi" || cleaned === "hindi") return "hi";
  if (cleaned === "bn" || cleaned === "bengali" || cleaned === "bangla") return "bn";
  throw Object.assign(
    new Error(
      `Unsupported caption language "${raw}". Supported languages: English (en), Hindi (hi), Bengali (bn), or auto.`
    ),
    { statusCode: 400 }
  );
}

export function parseMultipartBoolean(raw: unknown, fallback = false): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(norm)) return true;
    if (["0", "false", "no", "off", ""].includes(norm)) return false;
  }
  return fallback;
}

export const AudioCaptionsRequestFieldsSchema = z.object({
  language: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((val) => normalizeCaptionLanguageInput(val)),
  wordTimestamps: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => parseMultipartBoolean(val, false)),
  clientJobId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .refine((val) => !val || CLIENT_CAPTIONS_JOB_ID_RE.test(val), {
      message: "Invalid caption clientJobId format.",
    }),
  sceneId: z.string().trim().max(64).optional(),
  storyboardId: z.string().trim().max(80).optional(),
});

export type ValidatedAudioCaptionsFields = z.infer<typeof AudioCaptionsRequestFieldsSchema>;
