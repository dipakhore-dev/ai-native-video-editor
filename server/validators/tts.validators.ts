import { z } from "zod";

export const CLIENT_TTS_JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const SAFE_TTS_VOICE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

const SUPPORTED_LANGUAGE_INPUT_RE = /^(en|en-[a-z]{2}|english|hi|hi-[a-z]{2}|hindi|bn|bn-[a-z]{2}|bengali|bangla)$/i;

export function normalizeTtsLanguageInput(raw: string): "en" | "hi" | "bn" {
  const norm = raw.trim().toLowerCase();
  if (norm === "hi" || norm === "hindi" || norm.startsWith("hi-") || norm.startsWith("hi_")) {
    return "hi";
  }
  if (
    norm === "bn" ||
    norm === "bengali" ||
    norm === "bangla" ||
    norm.startsWith("bn-") ||
    norm.startsWith("bn_")
  ) {
    return "bn";
  }
  if (norm === "en" || norm === "english" || norm.startsWith("en-") || norm.startsWith("en_")) {
    return "en";
  }
  throw Object.assign(
    new Error(`Unsupported TTS language '${raw}'. Choose English (en), Hindi (hi), or Bengali (bn).`),
    { statusCode: 400 }
  );
}

export const TtsGenerateRequestSchema = z.object({
  text: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 1, {
      message: "Scene narration text cannot be empty.",
    })
    .refine((s) => s.length <= 5000, {
      message: "Narration text exceeds the maximum 5,000 character limit.",
    })
    .refine(
      (s) => {
        for (let i = 0; i < s.length; i += 1) {
          const code = s.charCodeAt(i);
          if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
            return false;
          }
        }
        return true;
      },
      { message: "Narration text contains unsupported control characters." }
    ),
  language: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .refine((val) => SUPPORTED_LANGUAGE_INPUT_RE.test(val), {
      message: "Unsupported language. Supported languages: English (en), Hindi (hi), Bengali (bn).",
    })
    .default("en"),
  provider: z
    .enum(["auto", "piper", "espeak_ng", "windows_sapi"])
    .optional(),
  voiceId: z
    .string()
    .trim()
    .max(160)
    .refine((val) => val === "" || SAFE_TTS_VOICE_ID_RE.test(val), {
      message: "Invalid voice identifier format.",
    })
    .optional(),
  speakingRate: z.number().finite().min(0.6).max(1.5).optional().default(1.0),
  pitch: z.number().finite().min(-20).max(20).optional().default(0),
  format: z.enum(["wav", "mp3"]).optional().default("wav"),
  clientJobId: z
    .string()
    .trim()
    .refine((val) => val === "" || CLIENT_TTS_JOB_ID_RE.test(val), {
      message: "Invalid client TTS job ID format.",
    })
    .optional(),
  sceneId: z.string().trim().max(64).optional(),
  storyboardId: z.string().trim().max(80).optional(),
});

export type ValidatedTtsGenerateRequest = z.infer<typeof TtsGenerateRequestSchema>;
