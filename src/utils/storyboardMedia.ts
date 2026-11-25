import type {
  AspectRatioHandlingMode,
  AspectRatioOption,
  MediaAsset,
  SceneAssignedMediaType,
  SceneMediaAssignmentStatus,
  SceneMediaSource,
  StoryboardMediaSummary,
  StoryboardScene,
  StoryboardSceneMediaAssignment,
  VideoStoryboard,
} from "../types/studio";
import { roundTo2, validateStoryboardInvariants } from "./storyboard";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "over",
  "under",
  "about",
  "your",
  "their",
  "there",
  "clip",
  "video",
  "image",
  "photo",
  "file",
  "media",
  "asset",
  "mp4",
  "mov",
  "webm",
  "mkv",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
]);

const ASPECT_RATIO_NUMERIC: Record<AspectRatioOption, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

export interface AspectMismatchInfo {
  hasDimensions: boolean;
  assetRatio: number | null;
  targetRatio: number;
  mismatchRatio: number;
  isMismatch: boolean;
  recommendedHandling: AspectRatioHandlingMode;
  message?: string;
}

export interface SceneMediaScoreBreakdown {
  score: number; // 0..100
  matchedKeywords: string[];
  aspectCompatible: boolean;
  durationFits: boolean;
  warnings: string[];
  explanation: string;
}

export interface AutoMatchOptions {
  overwriteManual?: boolean;
  minScore?: number;
  avoidDuplicates?: boolean;
  signal?: AbortSignal;
}

export interface AutoMatchResult {
  storyboard: VideoStoryboard;
  matchedCount: number;
  skippedCount: number;
  unmatchedSceneIds: string[];
  cancelled: boolean;
}

export interface SceneReadinessEvaluation {
  status: SceneMediaAssignmentStatus;
  asset: MediaAsset | null;
  hasAssignment: boolean;
  isReady: boolean;
  isMissing: boolean;
  isInvalid: boolean;
  shorterThanScene: boolean;
  effectivePlayableDuration: number;
  maxSourceStartTime: number;
  aspectInfo: AspectMismatchInfo | null;
  warnings: string[];
  errorMessage?: string;
}

export function normalizeMediaKeywords(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  const withoutExtension = raw.replace(/\.[a-z0-9]{2,5}$/i, "");
  const splitCamel = withoutExtension.replace(/([a-z])([A-Z])/g, "$1 $2");
  const rawTokens = splitCamel
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f\u0980-\u09ff]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));

  return Array.from(new Set(rawTokens));
}

export function getAssetSearchTokens(asset: MediaAsset): string[] {
  const parts: string[] = [asset.name];
  if (asset.description) parts.push(asset.description);
  if (Array.isArray(asset.tags) && asset.tags.length > 0) {
    parts.push(asset.tags.join(" "));
  }
  if (asset.generatedSlideConfig) {
    parts.push(asset.generatedSlideConfig.headingText);
    if (asset.generatedSlideConfig.bodyText) {
      parts.push(asset.generatedSlideConfig.bodyText);
    }
  }
  return normalizeMediaKeywords(parts.join(" "));
}

export function getSceneSearchTokens(scene: StoryboardScene): {
  primaryKeywords: string[];
  secondaryKeywords: string[];
} {
  const primaryKeywords = normalizeMediaKeywords(
    [scene.mediaKeywords.join(" "), scene.title].join(" ")
  );
  const secondaryKeywords = normalizeMediaKeywords(
    [scene.visualDescription, scene.onScreenText, scene.narration].join(" ")
  ).filter((t) => !primaryKeywords.includes(t));

  return { primaryKeywords, secondaryKeywords };
}

export function detectAspectRatioMismatch(
  targetAspectRatio: AspectRatioOption,
  width?: number,
  height?: number
): AspectMismatchInfo {
  const targetRatio = ASPECT_RATIO_NUMERIC[targetAspectRatio];
  if (!width || !height || width <= 0 || height <= 0) {
    return {
      hasDimensions: false,
      assetRatio: null,
      targetRatio,
      mismatchRatio: 1,
      isMismatch: false,
      recommendedHandling: "fit",
    };
  }

  const assetRatio = width / height;
  const mismatchRatio = Math.max(assetRatio / targetRatio, targetRatio / assetRatio);
  const isMismatch = mismatchRatio > 1.25;
  const recommendedHandling: AspectRatioHandlingMode = isMismatch ? "fit" : "preserve";

  return {
    hasDimensions: true,
    assetRatio,
    targetRatio,
    mismatchRatio: Number(mismatchRatio.toFixed(2)),
    isMismatch,
    recommendedHandling,
    ...(isMismatch
      ? {
          message: `Media dimensions (${width}×${height}) differ from ${targetAspectRatio} storyboard aspect ratio (${mismatchRatio.toFixed(
            2
          )}x difference). Use Fit or Fill framing.`,
        }
      : {}),
  };
}

export function clampVideoSourceStartTime(
  sourceStartTime: number,
  sceneDuration: number,
  videoDuration?: number
): number {
  if (!Number.isFinite(sourceStartTime) || sourceStartTime <= 0) {
    return 0;
  }
  if (!videoDuration || !Number.isFinite(videoDuration) || videoDuration <= 0) {
    return roundTo2(sourceStartTime);
  }
  const maxStart = Math.max(0, roundTo2(videoDuration - Math.min(sceneDuration, videoDuration)));
  return roundTo2(Math.min(sourceStartTime, maxStart));
}

export function inferSceneAssignedMediaType(asset: MediaAsset): SceneAssignedMediaType {
  if (asset.sourceOrigin === "generated_slide" || asset.generatedSlideConfig) {
    return "generated_slide";
  }
  return asset.kind === "video" ? "video" : "image";
}

export function inferSceneMediaSource(
  asset: MediaAsset,
  overrideSource?: SceneMediaSource
): SceneMediaSource {
  if (overrideSource) return overrideSource;
  if (asset.sourceOrigin === "generated_slide" || asset.generatedSlideConfig) {
    return "generated_slide";
  }
  if (asset.sourceOrigin === "stock") {
    return "stock";
  }
  if (asset.sourceOrigin === "uploaded") {
    return "uploaded";
  }
  return "existing_library";
}

export function createAssignmentFromAsset(
  scene: StoryboardScene,
  asset: MediaAsset,
  targetAspectRatio: AspectRatioOption,
  options?: {
    mediaSource?: SceneMediaSource;
    matchScore?: number;
    matchExplanation?: string;
    sourceStartTime?: number;
    aspectRatioHandling?: AspectRatioHandlingMode;
  }
): StoryboardSceneMediaAssignment {
  if (asset.kind !== "video" && asset.kind !== "image") {
    throw new Error(
      `Cannot assign ${asset.kind} asset '${asset.name}' as a visual scene asset.`
    );
  }

  const aspectInfo = detectAspectRatioMismatch(targetAspectRatio, asset.width, asset.height);
  const mediaType = inferSceneAssignedMediaType(asset);
  const mediaSource = inferSceneMediaSource(asset, options?.mediaSource);
  const isVideo = asset.kind === "video";
  const safeStartTime = isVideo
    ? clampVideoSourceStartTime(options?.sourceStartTime ?? 0, scene.duration, asset.duration)
    : 0;

  return {
    sceneId: scene.id,
    mediaAssetId: asset.id,
    mediaType,
    mediaSource,
    assetTitle: asset.name.slice(0, 255),
    mimeType: asset.mimeType || (isVideo ? "video/mp4" : "image/png"),
    ...(asset.width && asset.width > 0 ? { width: Math.round(asset.width) } : {}),
    ...(asset.height && asset.height > 0 ? { height: Math.round(asset.height) } : {}),
    ...(isVideo && Number.isFinite(asset.duration)
      ? { duration: Math.max(0, roundTo2(asset.duration)) }
      : {}),
    ...(asset.sourceUrl && !/^blob:/i.test(asset.sourceUrl)
      ? { sourceUrl: asset.sourceUrl }
      : {}),
    ...(asset.providerName ? { providerName: asset.providerName } : {}),
    ...(asset.providerAssetId ? { providerAssetId: asset.providerAssetId } : {}),
    ...(asset.creatorName ? { creatorName: asset.creatorName } : {}),
    ...(asset.attributionUrl && !/^blob:/i.test(asset.attributionUrl)
      ? { attributionUrl: asset.attributionUrl }
      : {}),
    ...(asset.licenseInfo ? { licenseInfo: asset.licenseInfo } : {}),
    ...(options?.matchScore !== undefined
      ? { matchScore: Math.max(0, Math.min(100, Math.round(options.matchScore))) }
      : {}),
    ...(options?.matchExplanation
      ? { matchExplanation: options.matchExplanation.slice(0, 320) }
      : {}),
    assignmentStatus: "assigned",
    sourceStartTime: safeStartTime,
    aspectRatioHandling: options?.aspectRatioHandling ?? aspectInfo.recommendedHandling,
    assignedAt: new Date().toISOString(),
  };
}

export function scoreAssetForScene(
  scene: StoryboardScene,
  targetAspectRatio: AspectRatioOption,
  asset: MediaAsset,
  options?: {
    alreadyUsedAssetIds?: Set<string>;
  }
): SceneMediaScoreBreakdown {
  if (asset.kind !== "video" && asset.kind !== "image") {
    return {
      score: 0,
      matchedKeywords: [],
      aspectCompatible: false,
      durationFits: false,
      warnings: ["Audio-only media cannot be assigned as the primary scene visual."],
      explanation: "Excluded: audio-only asset.",
    };
  }

  const assetTokens = getAssetSearchTokens(asset);
  const assetTokenSet = new Set(assetTokens);
  const { primaryKeywords, secondaryKeywords } = getSceneSearchTokens(scene);

  const matchedPrimary = primaryKeywords.filter(
    (kw) =>
      assetTokenSet.has(kw) ||
      assetTokens.some((tok) => tok.length >= 4 && (tok.includes(kw) || kw.includes(tok)))
  );
  const matchedSecondary = secondaryKeywords.filter((kw) => assetTokenSet.has(kw));
  const matchedKeywords = Array.from(new Set([...matchedPrimary, ...matchedSecondary]));

  // 1. Metadata & filename token score (up to 55 pts)
  const primaryHitScore =
    primaryKeywords.length > 0
      ? Math.min(40, Math.round((matchedPrimary.length / Math.max(1, primaryKeywords.length)) * 40))
      : 0;
  const secondaryHitScore = Math.min(15, matchedSecondary.length * 5);
  const keywordScore = primaryHitScore + secondaryHitScore;

  // 2. Media type alignment (up to 20 pts)
  let typeScore = 0;
  if (scene.mediaType === "video") {
    typeScore = asset.kind === "video" ? 20 : 8;
  } else if (scene.mediaType === "image") {
    typeScore = asset.kind === "image" ? 20 : 12;
  } else if (scene.mediaType === "text_card") {
    typeScore = asset.sourceOrigin === "generated_slide" ? 20 : asset.kind === "image" ? 14 : 6;
  } else {
    // motion_graphic
    typeScore = asset.kind === "video" ? 18 : asset.sourceOrigin === "generated_slide" ? 16 : 12;
  }

  // 3. Aspect ratio alignment (up to 15 pts)
  const aspectInfo = detectAspectRatioMismatch(targetAspectRatio, asset.width, asset.height);
  let aspectScore = 8;
  if (aspectInfo.hasDimensions) {
    if (aspectInfo.mismatchRatio <= 1.1) {
      aspectScore = 15;
    } else if (!aspectInfo.isMismatch) {
      aspectScore = 12;
    } else if (aspectInfo.mismatchRatio <= 1.8) {
      aspectScore = 5;
    } else {
      aspectScore = 1;
    }
  }

  // 4. Duration fit (up to 10 pts)
  let durationScore = 10;
  let durationFits = true;
  const warnings: string[] = [];
  if (asset.kind === "video") {
    if (asset.duration >= scene.duration) {
      durationScore = 10;
    } else {
      durationFits = false;
      const coverage = Math.max(0, Math.min(1, asset.duration / Math.max(0.5, scene.duration)));
      durationScore = Math.round(coverage * 6);
      warnings.push(
        `Clip duration (${asset.duration.toFixed(1)}s) is shorter than scene duration (${scene.duration.toFixed(
          1
        )}s).`
      );
    }
  }

  if (aspectInfo.isMismatch && aspectInfo.message) {
    warnings.push(aspectInfo.message);
  }

  let totalScore = keywordScore + typeScore + aspectScore + durationScore;
  const alreadyUsed = Boolean(options?.alreadyUsedAssetIds?.has(asset.id));
  if (alreadyUsed) {
    totalScore = Math.max(0, totalScore - 22);
    warnings.push("Asset is already assigned to another scene.");
  }

  totalScore = Math.max(0, Math.min(100, Math.round(totalScore)));

  const reasons: string[] = [];
  if (matchedKeywords.length > 0) {
    reasons.push(`Matched metadata/filename tokens (${matchedKeywords.slice(0, 4).join(", ")})`);
  } else {
    reasons.push("No keyword/tag overlap; scored by asset type and dimensions");
  }
  reasons.push(`${asset.kind === "video" ? "video" : "image"} type`);
  if (aspectInfo.hasDimensions) {
    reasons.push(
      aspectInfo.isMismatch
        ? `${asset.width}×${asset.height} (${aspectInfo.mismatchRatio}x aspect diff)`
        : `${targetAspectRatio} aspect fit`
    );
  }
  if (asset.kind === "video") {
    reasons.push(`${asset.duration.toFixed(1)}s duration`);
  }

  return {
    score: totalScore,
    matchedKeywords,
    aspectCompatible: !aspectInfo.isMismatch,
    durationFits,
    warnings,
    explanation: reasons.join("; "),
  };
}

export function autoMatchStoryboardScenes(
  storyboard: VideoStoryboard,
  mediaAssets: MediaAsset[],
  options?: AutoMatchOptions
): AutoMatchResult {
  if (options?.signal?.aborted) {
    return {
      storyboard,
      matchedCount: 0,
      skippedCount: storyboard.scenes.length,
      unmatchedSceneIds: storyboard.scenes.map((s) => s.id),
      cancelled: true,
    };
  }

  const overwriteManual = Boolean(options?.overwriteManual);
  const avoidDuplicates = options?.avoidDuplicates !== false;
  const minScore = options?.minScore ?? 24;

  const eligibleAssets = mediaAssets.filter((a) => a.kind === "video" || a.kind === "image");
  const assetsById = new Map(eligibleAssets.map((a) => [a.id, a]));
  const usedAssetIds = new Set<string>();

  // First track already preserved assignments so auto-matcher avoids reusing them when possible
  for (const scene of storyboard.scenes) {
    const existing = scene.mediaAssignment;
    if (
      !overwriteManual &&
      existing &&
      existing.assignmentStatus === "assigned" &&
      assetsById.has(existing.mediaAssetId)
    ) {
      usedAssetIds.add(existing.mediaAssetId);
    }
  }

  let matchedCount = 0;
  let skippedCount = 0;
  const unmatchedSceneIds: string[] = [];
  let cancelled = false;

  const nextScenes: StoryboardScene[] = storyboard.scenes.map((scene) => {
    if (options?.signal?.aborted) {
      cancelled = true;
      return scene;
    }

    const existing = scene.mediaAssignment;
    const hasValidExisting = Boolean(
      existing &&
        existing.assignmentStatus === "assigned" &&
        assetsById.has(existing.mediaAssetId)
    );

    if (!overwriteManual && hasValidExisting) {
      skippedCount += 1;
      return scene;
    }

    if (eligibleAssets.length === 0) {
      unmatchedSceneIds.push(scene.id);
      return scene;
    }

    let bestCandidate: {
      asset: MediaAsset;
      breakdown: SceneMediaScoreBreakdown;
    } | null = null;

    for (const candidate of eligibleAssets) {
      if (avoidDuplicates && usedAssetIds.has(candidate.id)) {
        continue;
      }
      const breakdown = scoreAssetForScene(scene, storyboard.aspectRatio, candidate, {
        alreadyUsedAssetIds: usedAssetIds,
      });
      if (!bestCandidate || breakdown.score > bestCandidate.breakdown.score) {
        bestCandidate = { asset: candidate, breakdown };
      }
    }

    // If all unused candidates fell short and duplicates are allowed as fallback, consider remaining library assets
    if ((!bestCandidate || bestCandidate.breakdown.score < minScore) && !avoidDuplicates) {
      for (const candidate of eligibleAssets) {
        const breakdown = scoreAssetForScene(scene, storyboard.aspectRatio, candidate, {
          alreadyUsedAssetIds: usedAssetIds,
        });
        if (!bestCandidate || breakdown.score > bestCandidate.breakdown.score) {
          bestCandidate = { asset: candidate, breakdown };
        }
      }
    }

    if (!bestCandidate || bestCandidate.breakdown.score < minScore) {
      unmatchedSceneIds.push(scene.id);
      return scene;
    }

    usedAssetIds.add(bestCandidate.asset.id);
    matchedCount += 1;
    const assignment = createAssignmentFromAsset(
      scene,
      bestCandidate.asset,
      storyboard.aspectRatio,
      {
        mediaSource:
          bestCandidate.asset.sourceOrigin === "generated_slide"
            ? "generated_slide"
            : bestCandidate.asset.sourceOrigin === "stock"
              ? "stock"
              : "existing_library",
        matchScore: bestCandidate.breakdown.score,
        matchExplanation: bestCandidate.breakdown.explanation,
      }
    );

    return {
      ...scene,
      mediaAssignment: assignment,
    };
  });

  const nextStoryboard: VideoStoryboard = {
    ...storyboard,
    scenes: nextScenes,
    updatedAt: new Date().toISOString(),
  };

  return {
    storyboard: nextStoryboard,
    matchedCount,
    skippedCount,
    unmatchedSceneIds,
    cancelled,
  };
}

export function evaluateSceneMediaReadiness(
  scene: StoryboardScene,
  storyboard: Pick<VideoStoryboard, "aspectRatio">,
  assetsById: Map<string, MediaAsset>,
  isStorageReady: boolean
): SceneReadinessEvaluation {
  const assignment = scene.mediaAssignment;
  if (!assignment) {
    return {
      status: "unassigned",
      asset: null,
      hasAssignment: false,
      isReady: false,
      isMissing: false,
      isInvalid: false,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: [],
    };
  }

  if (assignment.assignmentStatus === "matching") {
    return {
      status: "matching",
      asset: null,
      hasAssignment: true,
      isReady: false,
      isMissing: false,
      isInvalid: false,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: [],
    };
  }

  if (assignment.assignmentStatus === "failed") {
    return {
      status: "failed",
      asset: null,
      hasAssignment: true,
      isReady: false,
      isMissing: false,
      isInvalid: true,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: ["Last media import or assignment failed. Replace or retry."],
      errorMessage: "Last media assignment failed.",
    };
  }

  const asset = assetsById.get(assignment.mediaAssetId) ?? null;
  if (!asset) {
    if (!isStorageReady) {
      return {
        status: "matching",
        asset: null,
        hasAssignment: true,
        isReady: false,
        isMissing: false,
        isInvalid: false,
        shorterThanScene: false,
        effectivePlayableDuration: 0,
        maxSourceStartTime: 0,
        aspectInfo: null,
        warnings: ["Restoring local media files from browser IndexedDB..."],
      };
    }
    return {
      status: "missing",
      asset: null,
      hasAssignment: true,
      isReady: false,
      isMissing: true,
      isInvalid: false,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: [
        `Media file "${assignment.assetTitle}" was not found in this browser's IndexedDB. Re-link or replace it.`,
      ],
      errorMessage: `Missing local file "${assignment.assetTitle}" in IndexedDB.`,
    };
  }

  if (asset.kind !== "video" && asset.kind !== "image") {
    return {
      status: "invalid",
      asset,
      hasAssignment: true,
      isReady: false,
      isMissing: false,
      isInvalid: true,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: [`Asset "${asset.name}" is ${asset.kind}; only video, image, or text slide media can be assigned.`],
      errorMessage: `Unsupported media kind "${asset.kind}" for scene visual.`,
    };
  }

  if ((asset.width !== undefined && asset.width <= 0) || (asset.height !== undefined && asset.height <= 0)) {
    return {
      status: "invalid",
      asset,
      hasAssignment: true,
      isReady: false,
      isMissing: false,
      isInvalid: true,
      shorterThanScene: false,
      effectivePlayableDuration: 0,
      maxSourceStartTime: 0,
      aspectInfo: null,
      warnings: [`Asset "${asset.name}" reported invalid zero dimensions.`],
      errorMessage: "Corrupted or unreadable media dimensions.",
    };
  }

  const warnings: string[] = [];
  const aspectInfo = detectAspectRatioMismatch(
    storyboard.aspectRatio,
    asset.width ?? assignment.width,
    asset.height ?? assignment.height
  );
  if (aspectInfo.isMismatch && aspectInfo.message) {
    warnings.push(aspectInfo.message);
  }

  let shorterThanScene = false;
  let effectivePlayableDuration = scene.duration;
  let maxSourceStartTime = 0;

  if (asset.kind === "video") {
    const clipDuration = Math.max(0, asset.duration || assignment.duration || 0);
    if (clipDuration <= 0) {
      return {
        status: "invalid",
        asset,
        hasAssignment: true,
        isReady: false,
        isMissing: false,
        isInvalid: true,
        shorterThanScene: false,
        effectivePlayableDuration: 0,
        maxSourceStartTime: 0,
        aspectInfo,
        warnings: [`Video "${asset.name}" has zero duration.`],
        errorMessage: "Assigned video has zero playable duration.",
      };
    }

    const startOffset = Math.max(0, assignment.sourceStartTime || 0);
    maxSourceStartTime = Math.max(0, roundTo2(clipDuration - Math.min(scene.duration, clipDuration)));
    const remainingFromOffset = Math.max(0, roundTo2(clipDuration - startOffset));
    effectivePlayableDuration = Math.min(scene.duration, remainingFromOffset);

    if (clipDuration + 0.05 < scene.duration) {
      shorterThanScene = true;
      warnings.push(
        `Source video (${clipDuration.toFixed(1)}s) is shorter than scene duration (${scene.duration.toFixed(
          1
        )}s). Trim scene duration, loop/freeze later in composition, or replace clip.`
      );
    } else if (remainingFromOffset + 0.05 < scene.duration) {
      shorterThanScene = true;
      warnings.push(
        `Source start offset (${startOffset.toFixed(1)}s) leaves only ${remainingFromOffset.toFixed(
          1
        )}s for a ${scene.duration.toFixed(1)}s scene. Adjust Start Time or replace clip.`
      );
    }
  }

  return {
    status: "assigned",
    asset,
    hasAssignment: true,
    isReady: true,
    isMissing: false,
    isInvalid: false,
    shorterThanScene,
    effectivePlayableDuration,
    maxSourceStartTime,
    aspectInfo,
    warnings,
  };
}

export function computeStoryboardMediaSummary(
  storyboard: VideoStoryboard,
  mediaAssets: MediaAsset[],
  isStorageReady = true
): StoryboardMediaSummary {
  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const totalScenes = storyboard.scenes.length;

  let assignedCount = 0;
  let unassignedCount = 0;
  let missingOrInvalidCount = 0;
  let readyCount = 0;
  let anyMatching = false;

  for (const scene of storyboard.scenes) {
    const evalResult = evaluateSceneMediaReadiness(scene, storyboard, assetsById, isStorageReady);
    if (evalResult.status === "matching") {
      anyMatching = true;
    } else if (evalResult.status === "unassigned") {
      unassignedCount += 1;
    } else if (evalResult.status === "missing" || evalResult.status === "invalid" || evalResult.status === "failed") {
      missingOrInvalidCount += 1;
    } else if (evalResult.status === "assigned") {
      assignedCount += 1;
      readyCount += 1;
    }
  }

  const timingReport = validateStoryboardInvariants(storyboard);
  const progressPercent =
    totalScenes > 0 ? Math.round((readyCount / totalScenes) * 100) : 0;

  let overallStatus: SceneMediaAssignmentStatus = "unassigned";
  if (anyMatching) {
    overallStatus = "matching";
  } else if (missingOrInvalidCount > 0) {
    overallStatus = "missing";
  } else if (totalScenes > 0 && readyCount === totalScenes) {
    overallStatus = "assigned";
  } else if (readyCount > 0) {
    overallStatus = "unassigned";
  }

  return {
    totalScenes,
    assignedCount,
    unassignedCount,
    missingOrInvalidCount,
    readyCount,
    progressPercent,
    overallStatus,
    isMediaReady: totalScenes > 0 && readyCount === totalScenes && timingReport.valid,
  };
}

export function findDuplicateMediaAsset(
  file: Pick<File, "name" | "size" | "type">,
  existingAssets: MediaAsset[]
): MediaAsset | null {
  const normalizedName = file.name.trim().toLowerCase();
  return (
    existingAssets.find(
      (asset) =>
        asset.name.trim().toLowerCase() === normalizedName &&
        asset.sizeBytes === file.size &&
        (asset.kind === "video" || asset.kind === "image" || asset.kind === "audio")
    ) ?? null
  );
}

export function findStoryboardsUsingAsset(
  assetId: string,
  storyboards: VideoStoryboard[]
): VideoStoryboard[] {
  return storyboards.filter((sb) =>
    sb.scenes.some((scene) => scene.mediaAssignment?.mediaAssetId === assetId)
  );
}
