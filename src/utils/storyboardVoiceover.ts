import type {
  MediaAsset,
  SceneVoiceoverStatus,
  StoryboardLanguage,
  StoryboardScene,
  StoryboardSceneVoiceover,
  StoryboardVoiceoverSettings,
  StoryboardVoiceoverSummary,
  TtsAudioFormat,
  TtsLanguageCode,
  TtsProviderId,
  TtsVoiceOption,
  VideoStoryboard,
} from "../types/studio";
import { roundTo2 } from "./storyboard";

export const DEFAULT_VOICEOVER_SETTINGS: StoryboardVoiceoverSettings = {
  provider: "auto",
  speakingRate: 1.0,
  pitch: 0,
  format: "wav",
  volume: 1.0,
};

export const DURATION_OVERFLOW_TOLERANCE_SEC = 0.15;

export function normalizeTtsLanguage(
  raw: StoryboardLanguage | string | undefined | null
): TtsLanguageCode {
  const norm = String(raw || "en")
    .trim()
    .toLowerCase();
  if (norm === "hindi" || norm === "hi" || norm.startsWith("hi-") || norm.startsWith("hi_")) {
    return "hi";
  }
  if (norm === "bengali" || norm === "bangla" || norm === "bn" || norm.startsWith("bn-") || norm.startsWith("bn_")) {
    return "bn";
  }
  return "en";
}

export function formatTtsLanguageLabel(code: TtsLanguageCode | StoryboardLanguage): string {
  const norm = normalizeTtsLanguage(code);
  if (norm === "hi") return "Hindi (hi)";
  if (norm === "bn") return "Bengali (bn)";
  return "English (en)";
}

/**
 * Deterministic 64-bit-ish hash string (dual 32-bit FNV-1a) for narration fingerprint.
 * Changes ONLY when synthesis-affecting inputs change: narration text, language,
 * provider, voiceId, speakingRate, or pitch.
 * Ignores visual media assignments, scene title, order, startTime, and volume.
 */
export function computeNarrationFingerprint(input: {
  text: string;
  language: TtsLanguageCode | StoryboardLanguage;
  provider: TtsProviderId | string;
  voiceId?: string;
  speakingRate: number;
  pitch: number;
}): string {
  const canonical = JSON.stringify([
    input.text.trim().replace(/\r\n/g, "\n"),
    normalizeTtsLanguage(input.language),
    String(input.provider || "auto").trim().toLowerCase(),
    String(input.voiceId || "").trim(),
    Number(input.speakingRate || 1).toFixed(3),
    Number(input.pitch || 0).toFixed(2),
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

  return `vo_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function resolveEffectiveSceneVoiceParams(
  scene: StoryboardScene,
  storyboard: Pick<VideoStoryboard, "language" | "voiceoverSettings">
): {
  language: TtsLanguageCode;
  provider: TtsProviderId;
  voiceId: string;
  speakingRate: number;
  pitch: number;
  format: TtsAudioFormat;
  volume: number;
} {
  const globalCfg = storyboard.voiceoverSettings ?? DEFAULT_VOICEOVER_SETTINGS;
  const existing = scene.voiceover;

  const language = normalizeTtsLanguage(storyboard.language);
  const provider = existing?.provider ?? globalCfg.provider ?? "auto";
  const voiceId =
    existing && existing.language === language
      ? existing.voiceId
      : globalCfg.voiceId || "";
  const speakingRate = existing?.speakingRate ?? globalCfg.speakingRate ?? 1.0;
  const pitch = existing?.pitch ?? globalCfg.pitch ?? 0;
  const format = existing?.format ?? globalCfg.format ?? "wav";
  const volume = existing?.volume ?? globalCfg.volume ?? 1.0;

  return {
    language,
    provider,
    voiceId,
    speakingRate,
    pitch,
    format,
    volume,
  };
}

export function isSceneVoiceoverStale(
  scene: StoryboardScene,
  storyboardLanguage: StoryboardLanguage | TtsLanguageCode,
  globalSettings?: StoryboardVoiceoverSettings
): boolean {
  const vo = scene.voiceover;
  if (!vo || !vo.mediaAssetId) return false;
  if (vo.status === "failed" || vo.status === "missing") return false;
  if (!scene.narration.trim()) return true;

  const currentLang = normalizeTtsLanguage(storyboardLanguage);
  if (vo.language !== currentLang) return true;

  const expectedProvider = vo.provider;
  const expectedVoiceId = vo.voiceId;
  const expectedRate = vo.speakingRate;
  const expectedPitch = vo.pitch;

  // Also mark stale if global voiceover settings explicitly specify a different concrete voice/rate/pitch
  // only when the user changed global voiceover settings after generation
  const fpCurrent = computeNarrationFingerprint({
    text: scene.narration,
    language: currentLang,
    provider: expectedProvider,
    voiceId: expectedVoiceId,
    speakingRate: expectedRate,
    pitch: expectedPitch,
  });

  if (vo.narrationFingerprint !== fpCurrent) {
    return true;
  }

  if (globalSettings && globalSettings.voiceId && globalSettings.voiceId !== vo.voiceId) {
    // Only consider global voice override stale if user switched global voice for matching language
    return false;
  }

  return false;
}

export interface SceneVoiceoverEvaluation {
  status: SceneVoiceoverStatus;
  asset: MediaAsset | null;
  hasNarration: boolean;
  isReady: boolean;
  isStale: boolean;
  isMissing: boolean;
  isOverflowing: boolean;
  overflowSeconds: number;
  recommendedRateForFit: number | null;
  warnings: string[];
}

export function evaluateSceneVoiceoverReadiness(
  scene: StoryboardScene,
  storyboard: Pick<VideoStoryboard, "language" | "voiceoverSettings">,
  assetsById: Map<string, MediaAsset>,
  isStorageReady: boolean,
  activeGeneratingSceneIds?: Set<string>
): SceneVoiceoverEvaluation {
  const trimmedNarration = scene.narration.trim();
  const hasNarration = trimmedNarration.length > 0;
  const vo = scene.voiceover;

  if (activeGeneratingSceneIds?.has(scene.id)) {
    return {
      status: "generating",
      asset: vo?.mediaAssetId ? assetsById.get(vo.mediaAssetId) ?? null : null,
      hasNarration,
      isReady: false,
      isStale: false,
      isMissing: false,
      isOverflowing: false,
      overflowSeconds: 0,
      recommendedRateForFit: null,
      warnings: [],
    };
  }

  if (!hasNarration) {
    return {
      status: "skipped_empty",
      asset: null,
      hasNarration: false,
      isReady: false,
      isStale: false,
      isMissing: false,
      isOverflowing: false,
      overflowSeconds: 0,
      recommendedRateForFit: null,
      warnings: [],
    };
  }

  if (!vo) {
    return {
      status: "none",
      asset: null,
      hasNarration: true,
      isReady: false,
      isStale: false,
      isMissing: false,
      isOverflowing: false,
      overflowSeconds: 0,
      recommendedRateForFit: null,
      warnings: [],
    };
  }

  if (vo.status === "failed") {
    return {
      status: "failed",
      asset: null,
      hasNarration: true,
      isReady: false,
      isStale: false,
      isMissing: false,
      isOverflowing: false,
      overflowSeconds: 0,
      recommendedRateForFit: null,
      warnings: vo.errorMessage ? [vo.errorMessage] : ["Voiceover generation failed."],
    };
  }

  const asset = vo.mediaAssetId ? assetsById.get(vo.mediaAssetId) ?? null : null;
  if (isStorageReady && (!vo.mediaAssetId || !asset || asset.kind !== "audio")) {
    return {
      status: "missing",
      asset: null,
      hasNarration: true,
      isReady: false,
      isStale: false,
      isMissing: true,
      isOverflowing: false,
      overflowSeconds: 0,
      recommendedRateForFit: null,
      warnings: [
        "Generated voiceover audio is missing from this browser's IndexedDB storage. Click Regenerate to synthesize it again.",
      ],
    };
  }

  const stale = isSceneVoiceoverStale(scene, storyboard.language, storyboard.voiceoverSettings);
  const measuredDuration =
    asset && Number.isFinite(asset.duration) && asset.duration > 0
      ? asset.duration
      : vo.durationSeconds;

  const overflowRaw = measuredDuration - scene.duration;
  const isOverflowing = overflowRaw > DURATION_OVERFLOW_TOLERANCE_SEC;
  const overflowSeconds = isOverflowing ? roundTo2(overflowRaw) : 0;

  let recommendedRateForFit: number | null = null;
  if (isOverflowing && scene.duration > 0) {
    const neededRate = vo.speakingRate * (measuredDuration / scene.duration);
    if (neededRate <= 1.5) {
      recommendedRateForFit = Math.min(1.5, Math.max(0.6, Number(neededRate.toFixed(2))));
    }
  }

  const warnings: string[] = [];
  if (stale) {
    warnings.push(
      "Narration text, language, or voice parameters changed since this audio was generated."
    );
  }
  if (isOverflowing) {
    warnings.push(
      `Spoken voiceover (${measuredDuration.toFixed(1)}s) is ${overflowSeconds.toFixed(
        1
      )}s longer than this scene (${scene.duration.toFixed(1)}s).`
    );
  }

  return {
    status: stale ? "stale" : "ready",
    asset,
    hasNarration: true,
    isReady: !stale,
    isStale: stale,
    isMissing: false,
    isOverflowing,
    overflowSeconds,
    recommendedRateForFit,
    warnings,
  };
}

export function computeStoryboardVoiceoverSummary(
  storyboard: Pick<VideoStoryboard, "language" | "voiceoverSettings" | "scenes">,
  mediaAssets: MediaAsset[],
  isStorageReady: boolean,
  activeGeneratingSceneIds?: Set<string>
): StoryboardVoiceoverSummary {
  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const totalScenes = storyboard.scenes.length;

  let spokenScenes = 0;
  let readyCount = 0;
  let staleCount = 0;
  let missingCount = 0;
  let failedCount = 0;
  let unassignedCount = 0;
  let overflowCount = 0;
  let totalAudioDurationSec = 0;

  for (const scene of storyboard.scenes) {
    const evalResult = evaluateSceneVoiceoverReadiness(
      scene,
      storyboard,
      assetsById,
      isStorageReady,
      activeGeneratingSceneIds
    );
    if (!evalResult.hasNarration) continue;
    spokenScenes += 1;

    if (evalResult.status === "ready") {
      readyCount += 1;
      totalAudioDurationSec +=
        evalResult.asset?.duration ?? scene.voiceover?.durationSeconds ?? 0;
    } else if (evalResult.status === "stale") {
      staleCount += 1;
      totalAudioDurationSec +=
        evalResult.asset?.duration ?? scene.voiceover?.durationSeconds ?? 0;
    } else if (evalResult.status === "missing") {
      missingCount += 1;
    } else if (evalResult.status === "failed") {
      failedCount += 1;
    } else if (evalResult.status === "none") {
      unassignedCount += 1;
    }

    if (evalResult.isOverflowing) {
      overflowCount += 1;
    }
  }

  const progressPercent =
    spokenScenes > 0 ? Math.round((readyCount / spokenScenes) * 100) : 100;

  return {
    totalScenes,
    spokenScenes,
    readyCount,
    staleCount,
    missingCount,
    failedCount,
    unassignedCount,
    overflowCount,
    totalAudioDurationSec: roundTo2(totalAudioDurationSec),
    progressPercent,
    isVoiceoverReady: spokenScenes > 0 && readyCount === spokenScenes && missingCount === 0 && failedCount === 0,
  };
}

export function createSceneVoiceoverRecord(params: {
  scene: StoryboardScene;
  mediaAssetId: string;
  provider: StoryboardSceneVoiceover["provider"];
  voiceId: string;
  voiceLabel: string;
  language: TtsLanguageCode;
  speakingRate: number;
  pitch: number;
  volume: number;
  format: TtsAudioFormat;
  mimeType: string;
  durationSeconds: number;
  sizeBytes: number;
  sampleRateHz: number;
  channels: number;
}): StoryboardSceneVoiceover {
  return {
    sceneId: params.scene.id,
    mediaAssetId: params.mediaAssetId,
    provider: params.provider,
    voiceId: params.voiceId,
    voiceLabel: params.voiceLabel,
    language: params.language,
    speakingRate: roundTo2(params.speakingRate),
    pitch: roundTo2(params.pitch),
    volume: roundTo2(params.volume),
    format: params.format,
    mimeType: params.mimeType,
    durationSeconds: Number(params.durationSeconds.toFixed(3)),
    sizeBytes: Math.max(0, Math.round(params.sizeBytes)),
    sampleRateHz: Math.max(8000, Math.round(params.sampleRateHz)),
    channels: Math.max(1, Math.round(params.channels)),
    narrationFingerprint: computeNarrationFingerprint({
      text: params.scene.narration,
      language: params.language,
      provider: params.provider,
      voiceId: params.voiceId,
      speakingRate: params.speakingRate,
      pitch: params.pitch,
    }),
    generatedAt: new Date().toISOString(),
    status: "ready",
  };
}

export function pickDefaultVoiceForLanguage(
  voices: TtsVoiceOption[],
  language: TtsLanguageCode,
  preferredProvider: TtsProviderId = "auto"
): TtsVoiceOption | null {
  const langVoices = voices.filter((v) => v.language === language);
  if (langVoices.length === 0) return null;

  if (preferredProvider !== "auto" && preferredProvider !== "none") {
    const providerFiltered = langVoices.filter((v) => v.provider === preferredProvider);
    if (providerFiltered.length > 0) return providerFiltered[0];
  }

  // Prefer Piper ONNX neural voice first, then eSpeak NG, then Windows SAPI
  const piper = langVoices.find((v) => v.provider === "piper");
  if (piper) return piper;
  const espeak = langVoices.find((v) => v.provider === "espeak_ng");
  if (espeak) return espeak;
  return langVoices[0];
}
