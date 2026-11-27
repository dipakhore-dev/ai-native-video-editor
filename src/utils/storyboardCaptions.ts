import type {
  AudioCaptionSegmentDto,
  AudioCaptionsGenerateResult,
} from "../services/api";
import type {
  AspectRatioOption,
  CaptionGenerationMode,
  CaptionStyleConfig,
  CaptionStylePresetId,
  CaptionTimingSource,
  MediaAsset,
  SceneCaptionStatus,
  StoryboardCaptionSegment,
  StoryboardCaptionSettings,
  StoryboardCaptionSummary,
  StoryboardLanguage,
  StoryboardScene,
  StoryboardSceneCaptions,
  TtsLanguageCode,
  VideoStoryboard,
} from "../types/studio";
import {
  checkLanguageFontSupport,
  getSlideFontFamily,
  type LanguageFontSupportStatus,
} from "./generatedSlides";
import { roundTo2 } from "./storyboard";
import { normalizeTtsLanguage } from "./storyboardVoiceover";
import { formatSrtTimestamp, formatVttTimestamp } from "./subtitles";

export const CAPTION_OVERFLOW_TOLERANCE_SEC = 0.15;
export const MIN_CAPTION_CUE_DURATION_SEC = 0.25;
export const MAX_CAPTIONS_PER_SCENE = 100;

export interface CaptionStylePresetDefinition {
  id: CaptionStylePresetId;
  label: string;
  description: string;
  style: CaptionStyleConfig;
}

export const CAPTION_STYLE_PRESETS: ReadonlyArray<CaptionStylePresetDefinition> = [
  {
    id: "classic",
    label: "Classic",
    description: "Balanced white subtitles over a subtle dark backdrop.",
    style: {
      presetId: "classic",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 40,
      fontWeight: 600,
      color: "#FFFFFF",
      backgroundEnabled: true,
      backgroundColor: "#09090B",
      backgroundOpacity: 0.72,
      outlineWidth: 2,
      outlineColor: "#000000",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 10,
      maxLines: 2,
    },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Clean film-style ivory captions without a solid box.",
    style: {
      presetId: "cinematic",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 36,
      fontWeight: 500,
      color: "#F8FAFC",
      backgroundEnabled: false,
      backgroundColor: "#09090B",
      backgroundOpacity: 0.35,
      outlineWidth: 2.5,
      outlineColor: "#000000",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 9,
      maxLines: 2,
    },
  },
  {
    id: "educational",
    label: "Educational",
    description: "High-legibility slate plate tailored for tutorials and explainers.",
    style: {
      presetId: "educational",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 38,
      fontWeight: 600,
      color: "#F8FAFC",
      backgroundEnabled: true,
      backgroundColor: "#0F172A",
      backgroundOpacity: 0.88,
      outlineWidth: 1,
      outlineColor: "#020617",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 8,
      maxLines: 2,
    },
  },
  {
    id: "social_media",
    label: "Social Media",
    description: "High-impact bold captions sized for Reels, Shorts, and square feeds.",
    style: {
      presetId: "social_media",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 48,
      fontWeight: 800,
      color: "#FFFFFF",
      backgroundEnabled: true,
      backgroundColor: "#111114",
      backgroundOpacity: 0.65,
      outlineWidth: 3.5,
      outlineColor: "#000000",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 14,
      maxLines: 2,
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Lightweight lower-third text with gentle drop outline.",
    style: {
      presetId: "minimal",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 34,
      fontWeight: 500,
      color: "#E4E4E7",
      backgroundEnabled: false,
      backgroundColor: "#09090B",
      backgroundOpacity: 0,
      outlineWidth: 1.5,
      outlineColor: "#09090B",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 7,
      maxLines: 2,
    },
  },
  {
    id: "yellow_highlight",
    label: "Yellow Highlight",
    description: "High-contrast broadcast yellow text with crisp black stroke.",
    style: {
      presetId: "yellow_highlight",
      enabled: true,
      fontFamily: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
      fontSize: 44,
      fontWeight: 700,
      color: "#FACC15",
      backgroundEnabled: true,
      backgroundColor: "#09090B",
      backgroundOpacity: 0.48,
      outlineWidth: 3,
      outlineColor: "#000000",
      position: "bottom",
      alignment: "center",
      safeMarginBottomPct: 11,
      maxLines: 2,
    },
  },
];

export function getCaptionPresetById(presetId: CaptionStylePresetId): CaptionStyleConfig {
  const found = CAPTION_STYLE_PRESETS.find((p) => p.id === presetId) ?? CAPTION_STYLE_PRESETS[0];
  return { ...found.style };
}

export function getDefaultCaptionSettings(
  storyboard?: Pick<VideoStoryboard, "language" | "settings"> | null
): StoryboardCaptionSettings {
  const lang = storyboard?.language ?? "English";
  const pref = storyboard?.settings?.captionStyle;
  const presetId: CaptionStylePresetId =
    pref === "bold_social"
      ? "social_media"
      : pref === "minimal_lower"
        ? "minimal"
        : "classic";
  const baseStyle = getCaptionPresetById(presetId);

  return {
    enabled: storyboard?.settings?.captionsEnabled ?? true,
    defaultMode: "script",
    language: "match_storyboard",
    wordTimestamps: false,
    style: {
      ...baseStyle,
      enabled: storyboard?.settings?.captionsEnabled ?? true,
      fontFamily: getSlideFontFamily(lang),
    },
  };
}

export function roundTo3(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(3));
}

export function normalizeUnicodeNfc(text: string): string {
  return (text || "").normalize("NFC");
}

/**
 * Strips carriage returns, C0 control chars, WEBVTT headers, and cue arrow sequences (`-->`)
 * so user-edited or transcribed text cannot corrupt SRT/WebVTT exports or inject HTML.
 */
export function sanitizeCaptionCueText(raw: string): string {
  const normalized = normalizeUnicodeNfc(raw || "").replace(/\r\n?/g, "\n");
  let cleaned = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code === 10) {
      cleaned += "\n";
    } else if (code >= 32 && code !== 127) {
      cleaned += normalized[i];
    }
  }

  return cleaned
    .replace(/-->/g, "—>")
    .split("\n")
    .map((line) => line.replace(/^\s*WEBVTT\b/i, "WEBVTT:"))
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 400);
}

/**
 * Unicode-safe grapheme cluster splitter that never splits Indic matras, vowel signs, or diacritics.
 */
export function splitGraphemes(text: string, locale = "en"): string[] {
  const normalized = normalizeUnicodeNfc(text);
  if (!normalized) return [];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: "grapheme" });
      return Array.from(segmenter.segment(normalized), (s) => s.segment);
    } catch {
      // Fall through to combining-mark-aware splitter
    }
  }

  const matches = normalized.match(/\P{M}\p{M}*/gu);
  return matches ?? Array.from(normalized);
}

/**
 * Unicode-safe word tokenizer keeping punctuation attached sensibly or using Intl.Segmenter.
 */
export function tokenizeWordsForWrapping(text: string, locale = "en"): string[] {
  const normalized = normalizeUnicodeNfc(text).trim();
  if (!normalized) return [];

  // Space-separated tokens preserve Indic conjuncts & matras completely intact
  const spaceTokens = normalized.split(/\s+/).filter(Boolean);
  if (spaceTokens.length > 1) {
    return spaceTokens;
  }

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: "word" });
      const parts = Array.from(seg.segment(normalized), (s) => s.segment.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    } catch {
      // Fallback below
    }
  }

  return spaceTokens;
}

export function getTargetCharsPerLine(aspectRatio: AspectRatioOption = "16:9"): number {
  if (aspectRatio === "9:16") return 26;
  if (aspectRatio === "1:1") return 34;
  return 42;
}

/**
 * Wraps caption text cleanly into <= maxLines lines without splitting inside Unicode grapheme clusters.
 */
export function wrapCaptionTextLines(
  text: string,
  options?: {
    aspectRatio?: AspectRatioOption;
    maxCharsPerLine?: number;
    maxLines?: 1 | 2 | 3;
    locale?: string;
  }
): string[] {
  const clean = sanitizeCaptionCueText(text).replace(/\n+/g, " ");
  if (!clean) return [];

  const locale = options?.locale || "en";
  const maxChars = Math.max(
    14,
    options?.maxCharsPerLine ?? getTargetCharsPerLine(options?.aspectRatio ?? "16:9")
  );
  const maxLines = options?.maxLines ?? 2;
  const words = tokenizeWordsForWrapping(clean, locale);
  const lines: string[] = [];

  let current = "";
  let currentLen = 0;

  for (const word of words) {
    const wordGraphemes = splitGraphemes(word, locale);
    const wordLen = wordGraphemes.length;

    if (!current) {
      if (wordLen <= maxChars) {
        current = word;
        currentLen = wordLen;
      } else {
        // Extremely long unbroken word: chunk by grapheme clusters, never splitting combining marks
        let chunk = "";
        let chunkLen = 0;
        for (const g of wordGraphemes) {
          if (chunkLen + 1 > maxChars && chunk) {
            lines.push(chunk);
            chunk = g;
            chunkLen = 1;
          } else {
            chunk += g;
            chunkLen += 1;
          }
        }
        current = chunk;
        currentLen = chunkLen;
      }
      continue;
    }

    if (currentLen + 1 + wordLen <= maxChars) {
      current = `${current} ${word}`;
      currentLen += 1 + wordLen;
    } else {
      lines.push(current);
      if (wordLen <= maxChars) {
        current = word;
        currentLen = wordLen;
      } else {
        let chunk = "";
        let chunkLen = 0;
        for (const g of wordGraphemes) {
          if (chunkLen + 1 > maxChars && chunk) {
            lines.push(chunk);
            chunk = g;
            chunkLen = 1;
          } else {
            chunk += g;
            chunkLen += 1;
          }
        }
        current = chunk;
        currentLen = chunkLen;
      }
    }
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  // Collapse excess tail lines into the final permitted line so NO words are ever truncated
  const head = lines.slice(0, maxLines - 1);
  const tail = lines.slice(maxLines - 1).join(" ");
  return [...head, tail];
}

/**
 * Splits a scene narration into readable subtitle chunks respecting sentence boundaries,
 * Indic dandas (`।`, `॥`), punctuation pauses, and target line budgets.
 */
export function segmentNarrationIntoCueTexts(
  narration: string,
  options?: {
    aspectRatio?: AspectRatioOption;
    language?: TtsLanguageCode | StoryboardLanguage;
    maxLines?: 1 | 2 | 3;
  }
): string[] {
  const clean = sanitizeCaptionCueText(narration);
  if (!clean) return [];

  const langCode = normalizeTtsLanguage(options?.language ?? "en");
  const locale = langCode === "hi" ? "hi-IN" : langCode === "bn" ? "bn-IN" : "en-US";
  const maxCharsPerLine = getTargetCharsPerLine(options?.aspectRatio ?? "16:9");
  const maxLines = options?.maxLines ?? 2;
  const maxCueChars = maxCharsPerLine * maxLines;

  let sentences: string[] = [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: "sentence" });
      sentences = Array.from(seg.segment(clean), (s) => s.segment.trim()).filter(Boolean);
    } catch {
      sentences = [];
    }
  }

  if (sentences.length === 0) {
    sentences = clean
      .split(/(?<=[.!?।॥\n])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Refine sentences with Indic dandas (`।`, `॥`) if Intl.Segmenter left multiple clauses together
  const refinedSentences: string[] = [];
  for (const s of sentences) {
    const parts = s
      .split(/(?<=[।॥.!?])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    refinedSentences.push(...(parts.length > 0 ? parts : [s]));
  }

  const cueTexts: string[] = [];

  for (const sentence of refinedSentences) {
    const graphemes = splitGraphemes(sentence, locale);
    if (graphemes.length <= maxCueChars) {
      cueTexts.push(wrapCaptionTextLines(sentence, { aspectRatio: options?.aspectRatio, maxLines, locale }).join("\n"));
      continue;
    }

    // Split long sentences softly at commas, semicolons, colons, or dashes first
    const clauses = sentence
      .split(/(?<=[,;:\u2014-])\s+/)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const clause of clauses) {
      const clauseGraphemes = splitGraphemes(clause, locale);
      if (clauseGraphemes.length <= maxCueChars) {
        cueTexts.push(
          wrapCaptionTextLines(clause, { aspectRatio: options?.aspectRatio, maxLines, locale }).join("\n")
        );
        continue;
      }

      // Split long clause into balanced word groups matching cue budget
      const words = tokenizeWordsForWrapping(clause, locale);
      let buffer: string[] = [];
      let bufferLen = 0;

      for (const word of words) {
        const wLen = splitGraphemes(word, locale).length;
        if (buffer.length > 0 && bufferLen + 1 + wLen > maxCueChars) {
          const joined = buffer.join(" ");
          cueTexts.push(
            wrapCaptionTextLines(joined, { aspectRatio: options?.aspectRatio, maxLines, locale }).join("\n")
          );
          buffer = [word];
          bufferLen = wLen;
        } else {
          buffer.push(word);
          bufferLen = buffer.length === 1 ? wLen : bufferLen + 1 + wLen;
        }
      }

      if (buffer.length > 0) {
        const joined = buffer.join(" ");
        cueTexts.push(
          wrapCaptionTextLines(joined, { aspectRatio: options?.aspectRatio, maxLines, locale }).join("\n")
        );
      }
    }
  }

  return cueTexts.filter(Boolean).slice(0, MAX_CAPTIONS_PER_SCENE);
}

function computeCueWeight(cueText: string, locale: string): number {
  const words = tokenizeWordsForWrapping(cueText, locale);
  const graphemes = splitGraphemes(cueText.replace(/\s+/g, ""), locale).length;
  let pauseWeight = 0;
  if (/[.!?।॥]$/.test(cueText.trim())) {
    pauseWeight = 4.5;
  } else if (/[,;:\u2014-]$/.test(cueText.trim())) {
    pauseWeight = 2.0;
  }
  // Combine word count + grapheme length + punctuation pause weight
  return Math.max(2, words.length * 1.8 + graphemes * 0.25 + pauseWeight);
}

export function resolveEffectiveCaptionLanguage(
  storyboard: Pick<VideoStoryboard, "language" | "captionSettings">,
  settingsOverride?: StoryboardCaptionSettings
): TtsLanguageCode {
  const cfg = settingsOverride ?? storyboard.captionSettings;
  if (cfg && cfg.language !== "match_storyboard") {
    return cfg.language;
  }
  return normalizeTtsLanguage(storyboard.language);
}

export function resolveCaptionTargetDuration(
  scene: StoryboardScene,
  voiceoverAsset?: MediaAsset | null
): {
  durationSec: number;
  usedVoiceoverDuration: boolean;
  voiceoverMediaAssetId?: string;
} {
  const vo = scene.voiceover;
  const assetReady =
    vo &&
    vo.status === "ready" &&
    vo.mediaAssetId &&
    (!voiceoverAsset || voiceoverAsset.kind === "audio");

  if (assetReady) {
    const measured =
      voiceoverAsset && Number.isFinite(voiceoverAsset.duration) && voiceoverAsset.duration > 0
        ? voiceoverAsset.duration
        : vo.durationSeconds;
    if (Number.isFinite(measured) && measured > 0.1) {
      return {
        durationSec: roundTo3(measured),
        usedVoiceoverDuration: true,
        voiceoverMediaAssetId: vo.mediaAssetId,
      };
    }
  }

  return {
    durationSec: roundTo3(Math.max(0.5, scene.duration || 0.5)),
    usedVoiceoverDuration: false,
    voiceoverMediaAssetId: undefined,
  };
}

/**
 * Deterministic dual-32bit FNV-1a hash for caption stale detection.
 * Changes ONLY when narration, caption mode, effective language, voiceover audio source (in audio mode
 * or when voiceover audio exists), or scene duration (only when estimated from scene duration) change.
 * Deliberately IGNORES visual media assignment, scene title, order, startTime, effects, transitions, and styling.
 */
export function computeCaptionFingerprint(input: {
  narration: string;
  mode: CaptionGenerationMode;
  language: TtsLanguageCode | StoryboardLanguage;
  voiceoverMediaAssetId?: string;
  voiceoverNarrationFingerprint?: string;
  sceneDurationSec?: number;
  usedVoiceoverDuration: boolean;
}): string {
  const canonical = JSON.stringify([
    normalizeUnicodeNfc(input.narration).trim().replace(/\r\n/g, "\n"),
    input.mode,
    normalizeTtsLanguage(input.language),
    input.voiceoverMediaAssetId || "",
    input.voiceoverNarrationFingerprint || "",
    input.usedVoiceoverDuration
      ? "vo"
      : Number(input.sceneDurationSec || 0).toFixed(2),
  ]);

  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }

  return `cap_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function generateScriptCaptionsForScene(params: {
  scene: StoryboardScene;
  storyboard: Pick<VideoStoryboard, "aspectRatio" | "language" | "captionSettings">;
  voiceoverAsset?: MediaAsset | null;
  languageOverride?: TtsLanguageCode;
  maxLines?: 1 | 2 | 3;
}): StoryboardSceneCaptions {
  const { scene, storyboard, voiceoverAsset } = params;
  const effectiveLang =
    params.languageOverride ?? resolveEffectiveCaptionLanguage(storyboard);
  const locale = effectiveLang === "hi" ? "hi-IN" : effectiveLang === "bn" ? "bn-IN" : "en-US";
  const maxLines = params.maxLines ?? storyboard.captionSettings?.style?.maxLines ?? 2;

  const trimmedNarration = normalizeUnicodeNfc(scene.narration).trim();
  const targetInfo = resolveCaptionTargetDuration(scene, voiceoverAsset);
  const fingerprint = computeCaptionFingerprint({
    narration: scene.narration,
    mode: "script",
    language: effectiveLang,
    voiceoverMediaAssetId: targetInfo.voiceoverMediaAssetId,
    voiceoverNarrationFingerprint: scene.voiceover?.narrationFingerprint,
    sceneDurationSec: scene.duration,
    usedVoiceoverDuration: targetInfo.usedVoiceoverDuration,
  });

  if (!trimmedNarration) {
    return {
      sceneId: scene.id,
      mode: "script",
      timingSource: "estimated",
      language: effectiveLang,
      status: "skipped_empty",
      segments: [],
      fingerprint,
      sourceNarrationSnapshot: "",
      sourceSceneDurationSec: roundTo2(scene.duration),
      generatedAt: new Date().toISOString(),
      hasManualEdits: false,
      overflowsSceneDuration: false,
      warnings: ["Scene has no narration text; skipped caption generation."],
    };
  }

  const cueTexts = segmentNarrationIntoCueTexts(trimmedNarration, {
    aspectRatio: storyboard.aspectRatio,
    language: effectiveLang,
    maxLines,
  });

  const totalBudget = Math.max(0.4, targetInfo.durationSec);
  const weights = cueTexts.map((txt) => computeCueWeight(txt, locale));
  const weightSum = weights.reduce((a, b) => a + b, 0) || cueTexts.length || 1;

  const segments: StoryboardCaptionSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < cueTexts.length; i += 1) {
    const isLast = i === cueTexts.length - 1;
    const rawSlice = (weights[i] / weightSum) * totalBudget;
    const end = isLast
      ? roundTo3(totalBudget)
      : roundTo3(Math.min(totalBudget, Math.max(cursor + 0.15, cursor + rawSlice)));
    const safeStart = roundTo3(Math.min(cursor, Math.max(0, end - 0.1)));

    segments.push({
      id: `cap_${scene.id}_${i + 1}`,
      start: safeStart,
      end: Math.max(roundTo3(safeStart + 0.1), end),
      text: cueTexts[i],
      timingSource: "estimated",
      isManuallyEdited: false,
    });
    cursor = end;
  }

  const warnings: string[] = [];
  const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
  const overflowsSceneDuration = lastEnd > scene.duration + CAPTION_OVERFLOW_TOLERANCE_SEC;

  if (overflowsSceneDuration) {
    warnings.push(
      `Caption cues span ${lastEnd.toFixed(1)}s, exceeding the ${scene.duration.toFixed(
        1
      )}s scene slot.`
    );
  }
  const hasShortCue = segments.some((seg) => seg.end - seg.start < 0.7 && seg.text.length > 22);
  if (hasShortCue) {
    warnings.push(
      "Some script-estimated cues have tight timing for this scene duration; consider shortening narration or extending scene duration."
    );
  }

  return {
    sceneId: scene.id,
    mode: "script",
    timingSource: "estimated",
    language: effectiveLang,
    status: "ready",
    segments,
    fingerprint,
    sourceNarrationSnapshot: normalizeUnicodeNfc(scene.narration),
    ...(targetInfo.voiceoverMediaAssetId
      ? {
          sourceVoiceoverMediaAssetId: targetInfo.voiceoverMediaAssetId,
          sourceVoiceoverDurationSec: targetInfo.durationSec,
        }
      : {}),
    sourceSceneDurationSec: roundTo2(scene.duration),
    generatedAt: new Date().toISOString(),
    hasManualEdits: false,
    overflowsSceneDuration,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function buildAudioTranscriptionCaptionsRecord(params: {
  scene: StoryboardScene;
  storyboard: Pick<VideoStoryboard, "aspectRatio" | "language" | "captionSettings">;
  narrationSnapshot: string;
  effectiveLang: TtsLanguageCode;
  voiceoverAssetId: string;
  voiceoverFingerprint?: string;
  transcription: AudioCaptionsGenerateResult;
}): StoryboardSceneCaptions {
  const { scene, storyboard, narrationSnapshot, effectiveLang, voiceoverAssetId, transcription } = params;
  const maxLines = storyboard.captionSettings?.style?.maxLines ?? 2;
  const locale = effectiveLang === "hi" ? "hi-IN" : effectiveLang === "bn" ? "bn-IN" : "en-US";

  const segments: StoryboardCaptionSegment[] = transcription.segments
    .slice(0, MAX_CAPTIONS_PER_SCENE)
    .map((seg: AudioCaptionSegmentDto, idx: number) => {
      const sanitized = sanitizeCaptionCueText(seg.text || "");
      const wrapped = wrapCaptionTextLines(sanitized, {
        aspectRatio: storyboard.aspectRatio,
        maxLines,
        locale,
      }).join("\n");
      const start = Math.max(0, roundTo3(Number(seg.start) || 0));
      const end = Math.max(roundTo3(start + 0.1), roundTo3(Number(seg.end) || start + 0.5));
      return {
        id: `cap_${scene.id}_w${idx + 1}`,
        start,
        end,
        text: wrapped || sanitized,
        timingSource: "audio_transcription" as const,
        isManuallyEdited: false,
        ...(Array.isArray(seg.words) && seg.words.length > 0
          ? {
              words: seg.words.slice(0, 80).map((w) => ({
                word: sanitizeCaptionCueText(w.word),
                start: Math.max(0, roundTo3(w.start)),
                end: Math.max(roundTo3(w.start + 0.02), roundTo3(w.end)),
              })),
            }
          : {}),
      };
    })
    .filter((s) => s.text.trim().length > 0 && s.end > s.start);

  const fingerprint = computeCaptionFingerprint({
    narration: narrationSnapshot,
    mode: "audio",
    language: effectiveLang,
    voiceoverMediaAssetId: voiceoverAssetId,
    voiceoverNarrationFingerprint: params.voiceoverFingerprint,
    sceneDurationSec: scene.duration,
    usedVoiceoverDuration: true,
  });

  const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
  const maxEnd = Math.max(lastEnd, transcription.durationSeconds || 0);
  const overflowsSceneDuration = maxEnd > scene.duration + CAPTION_OVERFLOW_TOLERANCE_SEC;

  const warnings: string[] = [];
  if (segments.length === 0) {
    warnings.push("Whisper did not detect spoken words inside this scene audio.");
  }
  if (overflowsSceneDuration) {
    warnings.push(
      `Transcribed speech (${maxEnd.toFixed(1)}s) is longer than the scene slot (${scene.duration.toFixed(1)}s).`
    );
  }
  const detectedLower = (transcription.language || "").toLowerCase();
  if (detectedLower && detectedLower !== effectiveLang && detectedLower !== "unknown") {
    warnings.push(
      `Requested language ${effectiveLang.toUpperCase()}, but Whisper reported "${detectedLower}".`
    );
  }

  return {
    sceneId: scene.id,
    mode: "audio",
    timingSource: "audio_transcription",
    language: effectiveLang,
    status: scene.narration.trim() === narrationSnapshot.trim() ? "ready" : "stale",
    segments,
    fingerprint,
    sourceNarrationSnapshot: normalizeUnicodeNfc(narrationSnapshot),
    sourceVoiceoverMediaAssetId: voiceoverAssetId,
    sourceVoiceoverDurationSec: roundTo3(transcription.durationSeconds || maxEnd),
    sourceSceneDurationSec: roundTo2(scene.duration),
    model: transcription.model,
    detectedLanguage: transcription.language,
    languageProbability: Number((transcription.languageProbability || 0).toFixed(3)),
    generatedAt: new Date().toISOString(),
    hasManualEdits: false,
    overflowsSceneDuration,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function findCaptionSegmentOverlaps(
  segments: StoryboardCaptionSegment[]
): Set<string> {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const overlappingIds = new Set<string>();
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (sorted[i + 1].start < sorted[i].end - 0.01) {
      overlappingIds.add(sorted[i].id);
      overlappingIds.add(sorted[i + 1].id);
    }
  }
  return overlappingIds;
}

export function sortCaptionSegments(
  segments: StoryboardCaptionSegment[]
): StoryboardCaptionSegment[] {
  return [...segments].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)
  );
}

export function updateCaptionSegment(
  segments: StoryboardCaptionSegment[],
  segmentId: string,
  patch: Partial<Pick<StoryboardCaptionSegment, "start" | "end" | "text">>
): StoryboardCaptionSegment[] {
  const next = segments.map((seg) => {
    if (seg.id !== segmentId) return seg;
    const nextStart =
      patch.start !== undefined && Number.isFinite(patch.start)
        ? Math.max(0, roundTo3(patch.start))
        : seg.start;
    let nextEnd =
      patch.end !== undefined && Number.isFinite(patch.end)
        ? Math.max(0.05, roundTo3(patch.end))
        : seg.end;
    if (nextEnd <= nextStart) {
      nextEnd = roundTo3(nextStart + MIN_CAPTION_CUE_DURATION_SEC);
    }
    const nextText =
      patch.text !== undefined ? sanitizeCaptionCueText(patch.text) : seg.text;

    return {
      ...seg,
      start: nextStart,
      end: nextEnd,
      text: nextText,
      isManuallyEdited: true,
      timingSource: "manual" as CaptionTimingSource,
    };
  });
  return sortCaptionSegments(next);
}

export function splitCaptionSegment(
  segments: StoryboardCaptionSegment[],
  segmentId: string,
  locale = "en"
): StoryboardCaptionSegment[] {
  const idx = segments.findIndex((s) => s.id === segmentId);
  if (idx < 0 || segments.length >= MAX_CAPTIONS_PER_SCENE) return segments;
  const target = segments[idx];
  const duration = target.end - target.start;
  if (duration < MIN_CAPTION_CUE_DURATION_SEC * 1.5) {
    return segments;
  }

  const midTime = roundTo3((target.start + target.end) / 2);
  const normalizedText = target.text.replace(/\n+/g, " ").trim();
  const words = tokenizeWordsForWrapping(normalizedText, locale);

  let leftText = normalizedText;
  let rightText = normalizedText;

  if (words.length >= 2) {
    const splitWordIdx = Math.max(1, Math.floor(words.length / 2));
    leftText = words.slice(0, splitWordIdx).join(" ");
    rightText = words.slice(splitWordIdx).join(" ");
  } else {
    const graphemes = splitGraphemes(normalizedText, locale);
    if (graphemes.length >= 2) {
      const half = Math.max(1, Math.floor(graphemes.length / 2));
      leftText = graphemes.slice(0, half).join("");
      rightText = graphemes.slice(half).join("");
    }
  }

  const first: StoryboardCaptionSegment = {
    ...target,
    end: midTime,
    text: leftText,
    timingSource: "manual",
    isManuallyEdited: true,
    words: undefined,
  };
  const second: StoryboardCaptionSegment = {
    id: `${target.id}_sp_${Date.now().toString(36).slice(-4)}`,
    start: midTime,
    end: target.end,
    text: rightText,
    timingSource: "manual",
    isManuallyEdited: true,
  };

  const next = [...segments];
  next.splice(idx, 1, first, second);
  return sortCaptionSegments(next);
}

export function mergeCaptionSegmentWithNext(
  segments: StoryboardCaptionSegment[],
  segmentId: string
): StoryboardCaptionSegment[] {
  const sorted = sortCaptionSegments(segments);
  const idx = sorted.findIndex((s) => s.id === segmentId);
  if (idx < 0 || idx >= sorted.length - 1) return segments;
  const current = sorted[idx];
  const nextSeg = sorted[idx + 1];

  const merged: StoryboardCaptionSegment = {
    ...current,
    start: Math.min(current.start, nextSeg.start),
    end: Math.max(current.end, nextSeg.end),
    text: sanitizeCaptionCueText(`${current.text.replace(/\n+/g, " ")} ${nextSeg.text.replace(/\n+/g, " ")}`),
    timingSource: "manual",
    isManuallyEdited: true,
    words: undefined,
  };

  const result = [...sorted];
  result.splice(idx, 2, merged);
  return sortCaptionSegments(result);
}

export function addCaptionSegment(
  segments: StoryboardCaptionSegment[],
  sceneDuration: number
): StoryboardCaptionSegment[] {
  if (segments.length >= MAX_CAPTIONS_PER_SCENE) return segments;
  const sorted = sortCaptionSegments(segments);
  const lastEnd = sorted.length > 0 ? sorted[sorted.length - 1].end : 0;
  const start = roundTo3(Math.max(0, lastEnd));
  const preferredEnd = roundTo3(start + Math.min(2.0, Math.max(0.8, sceneDuration - start)));
  const end = Math.max(roundTo3(start + 0.5), preferredEnd);

  const created: StoryboardCaptionSegment = {
    id: `cap_custom_${Date.now().toString(36)}_${sorted.length + 1}`,
    start,
    end,
    text: "New caption line",
    timingSource: "manual",
    isManuallyEdited: true,
  };

  return sortCaptionSegments([...sorted, created]);
}

export function deleteCaptionSegment(
  segments: StoryboardCaptionSegment[],
  segmentId: string
): StoryboardCaptionSegment[] {
  return segments.filter((s) => s.id !== segmentId);
}

export function hasNarrationDivergedFromCaptions(scene: StoryboardScene): boolean {
  const cap = scene.captions;
  if (!cap) return false;
  return (
    normalizeUnicodeNfc(scene.narration).trim() !==
    normalizeUnicodeNfc(cap.sourceNarrationSnapshot || "").trim()
  );
}

export interface SceneCaptionsEvaluation {
  status: SceneCaptionStatus;
  hasNarration: boolean;
  isReady: boolean;
  isStale: boolean;
  hasManualEdits: boolean;
  overflowsSceneDuration: boolean;
  narrationDiverged: boolean;
  cueCount: number;
  overlappingCueIds: Set<string>;
  warnings: string[];
}

export function evaluateSceneCaptionsReadiness(
  scene: StoryboardScene,
  storyboard: Pick<VideoStoryboard, "language" | "captionSettings">,
  assetsById: Map<string, MediaAsset>,
  activeGeneratingSceneIds?: Set<string>
): SceneCaptionsEvaluation {
  const hasNarration = normalizeUnicodeNfc(scene.narration).trim().length > 0;
  const cap = scene.captions;

  if (activeGeneratingSceneIds?.has(scene.id)) {
    return {
      status: "generating",
      hasNarration,
      isReady: false,
      isStale: false,
      hasManualEdits: Boolean(cap?.hasManualEdits || cap?.segments.some((s) => s.isManuallyEdited)),
      overflowsSceneDuration: false,
      narrationDiverged: false,
      cueCount: cap?.segments.length ?? 0,
      overlappingCueIds: new Set(),
      warnings: [],
    };
  }

  if (!cap) {
    if (!hasNarration) {
      return {
        status: "skipped_empty",
        hasNarration: false,
        isReady: false,
        isStale: false,
        hasManualEdits: false,
        overflowsSceneDuration: false,
        narrationDiverged: false,
        cueCount: 0,
        overlappingCueIds: new Set(),
        warnings: [],
      };
    }
    return {
      status: "none",
      hasNarration: true,
      isReady: false,
      isStale: false,
      hasManualEdits: false,
      overflowsSceneDuration: false,
      narrationDiverged: false,
      cueCount: 0,
      overlappingCueIds: new Set(),
      warnings: [],
    };
  }

  if (cap.status === "failed") {
    return {
      status: "failed",
      hasNarration,
      isReady: false,
      isStale: false,
      hasManualEdits: Boolean(cap.hasManualEdits),
      overflowsSceneDuration: false,
      narrationDiverged: hasNarrationDivergedFromCaptions(scene),
      cueCount: cap.segments.length,
      overlappingCueIds: new Set(),
      warnings: cap.errorMessage ? [cap.errorMessage] : ["Caption generation failed."],
    };
  }

  if (cap.status === "skipped_empty" && !hasNarration) {
    return {
      status: "skipped_empty",
      hasNarration: false,
      isReady: false,
      isStale: false,
      hasManualEdits: false,
      overflowsSceneDuration: false,
      narrationDiverged: false,
      cueCount: 0,
      overlappingCueIds: new Set(),
      warnings: [],
    };
  }

  const effectiveLang = resolveEffectiveCaptionLanguage(storyboard);
  const voiceoverAsset = scene.voiceover?.mediaAssetId
    ? assetsById.get(scene.voiceover.mediaAssetId) ?? null
    : null;
  const targetInfo = resolveCaptionTargetDuration(scene, voiceoverAsset);

  const expectedFingerprint = computeCaptionFingerprint({
    narration: scene.narration,
    mode: cap.mode,
    language: effectiveLang,
    voiceoverMediaAssetId: targetInfo.voiceoverMediaAssetId,
    voiceoverNarrationFingerprint: scene.voiceover?.narrationFingerprint,
    sceneDurationSec: scene.duration,
    usedVoiceoverDuration: targetInfo.usedVoiceoverDuration,
  });

  const isStale = cap.fingerprint !== expectedFingerprint || !hasNarration;
  const narrationDiverged = hasNarrationDivergedFromCaptions(scene);
  const hasManualEdits = Boolean(
    cap.hasManualEdits || cap.segments.some((s) => s.isManuallyEdited)
  );
  const overlappingCueIds = findCaptionSegmentOverlaps(cap.segments);
  const lastEnd = cap.segments.length > 0 ? Math.max(...cap.segments.map((s) => s.end)) : 0;
  const overflowsSceneDuration = lastEnd > scene.duration + CAPTION_OVERFLOW_TOLERANCE_SEC;

  const warnings: string[] = [...(cap.warnings ?? []).filter((w) => !/exceeding|longer than/i.test(w))];
  if (isStale) {
    warnings.push(
      cap.mode === "audio"
        ? "Narration text, language, or voiceover audio changed since captions were transcribed."
        : "Narration text, language, or timing source changed since captions were estimated."
    );
  }
  if (overflowsSceneDuration) {
    warnings.push(
      `Last caption ends at ${lastEnd.toFixed(1)}s, exceeding the ${scene.duration.toFixed(
        1
      )}s scene slot.`
    );
  }
  if (overlappingCueIds.size > 0) {
    warnings.push("One or more caption cues overlap in time.");
  }

  return {
    status: isStale ? "stale" : "ready",
    hasNarration,
    isReady: !isStale && cap.segments.length > 0,
    isStale,
    hasManualEdits,
    overflowsSceneDuration,
    narrationDiverged,
    cueCount: cap.segments.length,
    overlappingCueIds,
    warnings,
  };
}

export function computeStoryboardCaptionsSummary(
  storyboard: Pick<VideoStoryboard, "language" | "captionSettings" | "scenes">,
  mediaAssets: MediaAsset[],
  activeGeneratingSceneIds?: Set<string>
): StoryboardCaptionSummary {
  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const totalScenes = storyboard.scenes.length;

  let captionableScenes = 0;
  let readyCount = 0;
  let staleCount = 0;
  let failedCount = 0;
  let unassignedCount = 0;
  let manualCount = 0;
  let overflowCount = 0;
  let totalCueCount = 0;
  let estimatedCount = 0;
  let transcribedCount = 0;

  for (const scene of storyboard.scenes) {
    const evalRes = evaluateSceneCaptionsReadiness(
      scene,
      storyboard,
      assetsById,
      activeGeneratingSceneIds
    );

    if (!evalRes.hasNarration && (!scene.captions || scene.captions.segments.length === 0)) {
      continue;
    }

    captionableScenes += 1;
    totalCueCount += evalRes.cueCount;

    if (evalRes.status === "ready") {
      readyCount += 1;
    } else if (evalRes.status === "stale") {
      staleCount += 1;
    } else if (evalRes.status === "failed") {
      failedCount += 1;
    } else if (evalRes.status === "none") {
      unassignedCount += 1;
    }

    if (evalRes.hasManualEdits) manualCount += 1;
    if (evalRes.overflowsSceneDuration) overflowCount += 1;
    if (scene.captions?.timingSource === "audio_transcription") {
      transcribedCount += 1;
    } else if (scene.captions && scene.captions.segments.length > 0) {
      estimatedCount += 1;
    }
  }

  const progressPercent =
    captionableScenes > 0 ? Math.round((readyCount / captionableScenes) * 100) : 100;

  return {
    totalScenes,
    captionableScenes,
    readyCount,
    staleCount,
    failedCount,
    unassignedCount,
    manualCount,
    overflowCount,
    totalCueCount,
    estimatedCount,
    transcribedCount,
    progressPercent,
    isCaptionsReady:
      captionableScenes > 0 &&
      readyCount === captionableScenes &&
      failedCount === 0 &&
      unassignedCount === 0,
  };
}

export function exportSceneCaptionsToSrt(
  scene: StoryboardScene,
  offsetSec = 0
): string {
  const segments = sortCaptionSegments(scene.captions?.segments ?? []);
  const valid = segments
    .map((seg) => ({
      start: Math.max(0, roundTo3(seg.start + offsetSec)),
      end: Math.max(0, roundTo3(seg.end + offsetSec)),
      text: sanitizeCaptionCueText(seg.text),
    }))
    .filter((cue) => cue.text.length > 0 && cue.end > cue.start);

  return valid
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`
    )
    .join("\n\n");
}

export function exportSceneCaptionsToVtt(
  scene: StoryboardScene,
  offsetSec = 0
): string {
  const segments = sortCaptionSegments(scene.captions?.segments ?? []);
  const valid = segments
    .map((seg) => ({
      start: Math.max(0, roundTo3(seg.start + offsetSec)),
      end: Math.max(0, roundTo3(seg.end + offsetSec)),
      text: sanitizeCaptionCueText(seg.text),
    }))
    .filter((cue) => cue.text.length > 0 && cue.end > cue.start);

  const body = valid
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`
    )
    .join("\n\n");

  return body ? `WEBVTT\n\n${body}\n` : "WEBVTT\n\n";
}

export function collectTimelineCaptionCues(
  storyboard: Pick<VideoStoryboard, "scenes">
): Array<{ start: number; end: number; text: string; sceneId: string }> {
  const cues: Array<{ start: number; end: number; text: string; sceneId: string }> = [];
  let runningOffset = 0;

  for (const scene of storyboard.scenes) {
    const segs = sortCaptionSegments(scene.captions?.segments ?? []);
    for (const seg of segs) {
      const start = Math.max(0, roundTo3(runningOffset + seg.start));
      const end = Math.max(0, roundTo3(runningOffset + seg.end));
      const text = sanitizeCaptionCueText(seg.text);
      if (text && end > start) {
        cues.push({ start, end, text, sceneId: scene.id });
      }
    }
    // Always advance timeline offset by scene.duration so empty/silent scene gaps remain intact
    runningOffset = roundTo3(runningOffset + Math.max(0.5, scene.duration));
  }

  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function exportStoryboardCaptionsToSrt(
  storyboard: Pick<VideoStoryboard, "scenes">
): string {
  const cues = collectTimelineCaptionCues(storyboard);
  return cues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}`
    )
    .join("\n\n");
}

export function exportStoryboardCaptionsToVtt(
  storyboard: Pick<VideoStoryboard, "scenes">
): string {
  const cues = collectTimelineCaptionCues(storyboard);
  const body = cues
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`
    )
    .join("\n\n");
  return body ? `WEBVTT\n\n${body}\n` : "WEBVTT\n\n";
}

export function hexToRgbaSafe(hex: string, opacity: number): string {
  const clean = (hex || "#09090B").replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const sr = Number.isFinite(r) ? r : 9;
  const sg = Number.isFinite(g) ? g : 9;
  const sb = Number.isFinite(b) ? b : 11;
  const a = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 0.75));
  return `rgba(${sr}, ${sg}, ${sb}, ${a})`;
}

export interface ComputedCaptionPreviewStyles {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  color: string;
  backgroundColor: string;
  textShadow: string;
  textAlign: "left" | "center" | "right";
  paddingX: number;
  paddingY: number;
  safeMarginBottomPct: number;
  maxWidthPct: number;
}

/**
 * Scales reference 1080p caption typography proportionally for any preview box dimensions
 * and aspect ratio, preventing wide horizontal clipping on 9:16 vertical canvases.
 */
export function computeScaledCaptionPreviewStyle(
  style: CaptionStyleConfig,
  containerHeightPx: number,
  aspectRatio: AspectRatioOption,
  language: StoryboardLanguage
): ComputedCaptionPreviewStyles {
  const referenceHeight = aspectRatio === "9:16" ? 1280 : aspectRatio === "1:1" ? 1080 : 1080;
  const scale = Math.max(0.14, Math.min(1.5, containerHeightPx / referenceHeight));
  const aspectWidthPenalty = aspectRatio === "9:16" ? 0.92 : 1;
  const fontSizePx = Math.max(10, Math.round(style.fontSize * scale * aspectWidthPenalty));
  const strokePx = Math.max(0, Number((style.outlineWidth * scale).toFixed(1)));

  const fontFamily =
    language === "Hindi" || language === "Bengali"
      ? getSlideFontFamily(language)
      : style.fontFamily || getSlideFontFamily(language);

  const oc = style.outlineColor || "#000000";
  const textShadow =
    strokePx > 0
      ? [
          `${strokePx}px 0 0 ${oc}`,
          `${-strokePx}px 0 0 ${oc}`,
          `0 ${strokePx}px 0 ${oc}`,
          `0 ${-strokePx}px 0 ${oc}`,
          `0 2px 6px rgba(0,0,0,0.65)`,
        ].join(", ")
      : "0 2px 6px rgba(0,0,0,0.65)";

  return {
    fontFamily,
    fontSizePx,
    fontWeight: style.fontWeight,
    color: style.color,
    backgroundColor: style.backgroundEnabled
      ? hexToRgbaSafe(style.backgroundColor, style.backgroundOpacity)
      : "transparent",
    textShadow,
    textAlign: style.alignment,
    paddingX: Math.max(6, Math.round(fontSizePx * 0.45)),
    paddingY: Math.max(3, Math.round(fontSizePx * 0.22)),
    safeMarginBottomPct: Math.max(4, Math.min(30, style.safeMarginBottomPct)),
    maxWidthPct: aspectRatio === "9:16" ? 88 : 84,
  };
}

export function checkCaptionFontSupport(
  language: StoryboardLanguage
): LanguageFontSupportStatus {
  return checkLanguageFontSupport(language);
}

export function findActiveCaptionCueAtTime(
  segments: StoryboardCaptionSegment[],
  timeSec: number
): StoryboardCaptionSegment | null {
  for (const seg of segments) {
    if (timeSec >= seg.start && timeSec <= seg.end) {
      return seg;
    }
  }
  return null;
}
