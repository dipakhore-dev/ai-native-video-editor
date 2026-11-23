import type {
  ClipKeyframe,
  KeyframeEasing,
  KeyframeProperty,
  TimelineClip,
} from "../types/studio";

export interface KeyframePropertySpec {
  property: KeyframeProperty;
  label: string;
  shortLabel: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: "%" | "deg" | "x";
  displayMultiplier: number;
  precision: number;
}

export const KEYFRAME_PROPERTY_SPECS: Record<KeyframeProperty, KeyframePropertySpec> = {
  x: {
    property: "x",
    label: "Position X",
    shortLabel: "Pos X",
    min: 0,
    max: 100,
    step: 0.5,
    defaultValue: 50,
    unit: "%",
    displayMultiplier: 1,
    precision: 1,
  },
  y: {
    property: "y",
    label: "Position Y",
    shortLabel: "Pos Y",
    min: 0,
    max: 100,
    step: 0.5,
    defaultValue: 50,
    unit: "%",
    displayMultiplier: 1,
    precision: 1,
  },
  scale: {
    property: "scale",
    label: "Scale",
    shortLabel: "Scale",
    min: 0.1,
    max: 2.0,
    step: 0.05,
    defaultValue: 1.0,
    unit: "%",
    displayMultiplier: 100,
    precision: 2,
  },
  rotation: {
    property: "rotation",
    label: "Rotation",
    shortLabel: "Rotate",
    min: -360,
    max: 360,
    step: 1,
    defaultValue: 0,
    unit: "deg",
    displayMultiplier: 1,
    precision: 1,
  },
  opacity: {
    property: "opacity",
    label: "Opacity",
    shortLabel: "Opacity",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 1,
    unit: "%",
    displayMultiplier: 100,
    precision: 2,
  },
  volume: {
    property: "volume",
    label: "Audio Volume",
    shortLabel: "Volume",
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 1,
    unit: "%",
    displayMultiplier: 100,
    precision: 2,
  },
};

export const ALL_KEYFRAME_PROPERTIES: KeyframeProperty[] = [
  "x",
  "y",
  "scale",
  "rotation",
  "opacity",
  "volume",
];

export const KEYFRAME_EASING_OPTIONS: Array<{
  value: KeyframeEasing;
  label: string;
}> = [
  { value: "linear", label: "Linear" },
  { value: "ease-in", label: "Ease In" },
  { value: "ease-out", label: "Ease Out" },
  { value: "ease-in-out", label: "Ease In-Out" },
  { value: "hold", label: "Hold (Step)" },
];

export function createKeyframeId(): string {
  return `kf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function isValidKeyframeProperty(prop: unknown): prop is KeyframeProperty {
  return (
    prop === "x" ||
    prop === "y" ||
    prop === "scale" ||
    prop === "rotation" ||
    prop === "opacity" ||
    prop === "volume"
  );
}

export function normalizeEasing(easing: unknown): KeyframeEasing {
  if (
    easing === "linear" ||
    easing === "ease-in" ||
    easing === "ease-out" ||
    easing === "ease-in-out" ||
    easing === "hold"
  ) {
    return easing;
  }
  return "linear";
}

export function clampPropertyValue(property: KeyframeProperty, value: number): number {
  const spec = KEYFRAME_PROPERTY_SPECS[property];
  const num = Number(value);
  if (!Number.isFinite(num)) return spec.defaultValue;
  const clamped = Math.min(spec.max, Math.max(spec.min, num));
  const factor = Math.pow(10, spec.precision);
  return Math.round(clamped * factor) / factor;
}

export function clampKeyframeTime(timeSec: number, durationSec?: number): number {
  const num = Number(timeSec);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const upper =
    durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : Number.POSITIVE_INFINITY;
  const clamped = Math.min(upper, Math.max(0, num));
  return Number(clamped.toFixed(3));
}

export function clampClipRotation(rotation: number | undefined, fallback = 0): number {
  const num = Number(rotation);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(360, Math.max(-360, Number(num.toFixed(1))));
}

export function getSupportedKeyframeProperties(
  clip: Pick<TimelineClip, "kind" | "trackId">
): KeyframeProperty[] {
  if (clip.kind === "audio" || clip.trackId === "track_a1") {
    return ["volume"];
  }
  if (clip.kind === "image" || clip.kind === "text" || clip.trackId === "track_t1") {
    return ["x", "y", "scale", "rotation", "opacity"];
  }
  return ["x", "y", "scale", "rotation", "opacity", "volume"];
}

export function getStaticClipPropertyValue(
  clip: Pick<
    TimelineClip,
    "kind" | "trackId" | "opacity" | "volume" | "rotation" | "overlayTransform" | "textStyle"
  >,
  property: KeyframeProperty
): number {
  switch (property) {
    case "x":
      if (clip.trackId === "track_t1" || clip.kind === "text") {
        return clampPropertyValue("x", clip.textStyle?.x ?? 50);
      }
      if (clip.trackId === "track_v2" || clip.overlayTransform) {
        return clampPropertyValue("x", clip.overlayTransform?.x ?? 50);
      }
      return 50;
    case "y":
      if (clip.trackId === "track_t1" || clip.kind === "text") {
        return clampPropertyValue("y", clip.textStyle?.y ?? 82);
      }
      if (clip.trackId === "track_v2" || clip.overlayTransform) {
        return clampPropertyValue("y", clip.overlayTransform?.y ?? 50);
      }
      return 50;
    case "scale":
      if (clip.trackId === "track_v2" || clip.overlayTransform) {
        return clampPropertyValue("scale", clip.overlayTransform?.scale ?? 1);
      }
      return 1;
    case "rotation":
      return clampPropertyValue("rotation", clip.rotation ?? 0);
    case "opacity":
      return clampPropertyValue("opacity", clip.opacity ?? 1);
    case "volume":
      return clampPropertyValue("volume", clip.volume ?? 1);
  }
}

export function normalizeKeyframe(
  kf: Partial<ClipKeyframe> & { property: KeyframeProperty; value: number; timeSec: number },
  durationSec?: number
): ClipKeyframe {
  const prop = isValidKeyframeProperty(kf.property) ? kf.property : "opacity";
  return {
    id: typeof kf.id === "string" && kf.id.trim() ? kf.id.trim() : createKeyframeId(),
    timeSec: clampKeyframeTime(kf.timeSec, durationSec),
    property: prop,
    value: clampPropertyValue(prop, kf.value),
    easing: normalizeEasing(kf.easing),
  };
}

export function cloneKeyframes(keyframes?: ClipKeyframe[]): ClipKeyframe[] | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  return keyframes.map((kf) => ({ ...kf }));
}

/**
 * Sorts keyframes chronologically within each property (stable tie-break on id)
 * and removes invalid entries. If multiple keyframes share the exact same
 * (property, timeSec) within 0.001s, keeps the last entry cleanly.
 */
export function sortAndDedupeKeyframes(
  keyframes: ClipKeyframe[] | undefined,
  durationSec?: number
): ClipKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  const normalized = keyframes
    .filter((kf) => kf && isValidKeyframeProperty(kf.property))
    .map((kf) => normalizeKeyframe(kf, durationSec));

  const dedupedByKey = new Map<string, ClipKeyframe>();
  for (const kf of normalized) {
    const key = `${kf.property}::${kf.timeSec.toFixed(3)}`;
    dedupedByKey.set(key, kf);
  }

  return Array.from(dedupedByKey.values()).sort((a, b) => {
    if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
    if (a.property !== b.property) return a.property.localeCompare(b.property);
    return a.id.localeCompare(b.id);
  });
}

export function getPropertyKeyframes(
  keyframes: ClipKeyframe[] | undefined,
  property: KeyframeProperty
): ClipKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  return sortAndDedupeKeyframes(keyframes.filter((kf) => kf.property === property));
}

export function applyEasing(tNorm: number, easing: KeyframeEasing): number {
  const p = Number.isFinite(tNorm) ? Math.min(1, Math.max(0, tNorm)) : 0;
  switch (easing) {
    case "hold":
      return p >= 1 ? 1 : 0;
    case "ease-in":
      return p * p;
    case "ease-out":
      return 1 - (1 - p) * (1 - p);
    case "ease-in-out":
      return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    case "linear":
    default:
      return p;
  }
}

export function interpolateProperty(
  keyframes: ClipKeyframe[] | undefined,
  property: KeyframeProperty,
  localTimeSec: number,
  fallbackValue: number
): number {
  const safeFallback = clampPropertyValue(property, fallbackValue);
  const propFrames = getPropertyKeyframes(keyframes, property);
  if (propFrames.length === 0) return safeFallback;
  if (propFrames.length === 1) return clampPropertyValue(property, propFrames[0].value);

  const t = Number.isFinite(localTimeSec) ? localTimeSec : 0;
  if (t <= propFrames[0].timeSec) {
    return clampPropertyValue(property, propFrames[0].value);
  }
  const last = propFrames[propFrames.length - 1];
  if (t >= last.timeSec) {
    return clampPropertyValue(property, last.value);
  }

  for (let i = 0; i < propFrames.length - 1; i++) {
    const k0 = propFrames[i];
    const k1 = propFrames[i + 1];
    if (t >= k0.timeSec && t <= k1.timeSec) {
      const span = k1.timeSec - k0.timeSec;
      if (span <= 0.00001) {
        return clampPropertyValue(property, k1.value);
      }
      const p = (t - k0.timeSec) / span;
      const eased = applyEasing(p, k0.easing);
      const val = k0.value + (k1.value - k0.value) * eased;
      return clampPropertyValue(property, val);
    }
  }

  return clampPropertyValue(property, last.value);
}

export interface EvaluatedClipValues {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volume: number;
}

export function evaluateClipProperty(
  clip: Pick<
    TimelineClip,
    "kind" | "trackId" | "opacity" | "volume" | "rotation" | "overlayTransform" | "textStyle" | "keyframes"
  >,
  property: KeyframeProperty,
  localTimeSec: number
): number {
  const fallback = getStaticClipPropertyValue(clip, property);
  return interpolateProperty(clip.keyframes, property, localTimeSec, fallback);
}

export function evaluateClipKeyframes(
  clip: Pick<
    TimelineClip,
    "kind" | "trackId" | "opacity" | "volume" | "rotation" | "overlayTransform" | "textStyle" | "keyframes"
  >,
  localTimeSec: number
): EvaluatedClipValues {
  const safeLocal = Number.isFinite(localTimeSec) ? Math.max(0, localTimeSec) : 0;
  if (!clip.keyframes || clip.keyframes.length === 0) {
    return {
      x: getStaticClipPropertyValue(clip, "x"),
      y: getStaticClipPropertyValue(clip, "y"),
      scale: getStaticClipPropertyValue(clip, "scale"),
      rotation: getStaticClipPropertyValue(clip, "rotation"),
      opacity: getStaticClipPropertyValue(clip, "opacity"),
      volume: getStaticClipPropertyValue(clip, "volume"),
    };
  }
  return {
    x: evaluateClipProperty(clip, "x", safeLocal),
    y: evaluateClipProperty(clip, "y", safeLocal),
    scale: evaluateClipProperty(clip, "scale", safeLocal),
    rotation: evaluateClipProperty(clip, "rotation", safeLocal),
    opacity: evaluateClipProperty(clip, "opacity", safeLocal),
    volume: evaluateClipProperty(clip, "volume", safeLocal),
  };
}

/**
 * Adds or updates a keyframe at `timeSec` (snapped within 0.05s to existing keyframe of same property).
 */
export function upsertClipKeyframe(
  keyframes: ClipKeyframe[] | undefined,
  input: {
    property: KeyframeProperty;
    timeSec: number;
    value: number;
    easing?: KeyframeEasing;
    id?: string;
  },
  durationSec?: number
): { keyframes: ClipKeyframe[]; saved: ClipKeyframe } {
  const targetTime = clampKeyframeTime(input.timeSec, durationSec);
  const existingList = sortAndDedupeKeyframes(keyframes, durationSec);
  const tolerance = 0.05;

  let matchedIndex = existingList.findIndex(
    (kf) =>
      kf.property === input.property &&
      (input.id ? kf.id === input.id : Math.abs(kf.timeSec - targetTime) <= tolerance)
  );
  if (matchedIndex === -1 && input.id) {
    matchedIndex = existingList.findIndex(
      (kf) => kf.property === input.property && Math.abs(kf.timeSec - targetTime) <= tolerance
    );
  }

  const nextKf: ClipKeyframe = normalizeKeyframe(
    {
      id:
        matchedIndex >= 0
          ? existingList[matchedIndex].id
          : input.id || createKeyframeId(),
      property: input.property,
      timeSec: matchedIndex >= 0 ? targetTime : targetTime,
      value: input.value,
      easing:
        input.easing ??
        (matchedIndex >= 0 ? existingList[matchedIndex].easing : "linear"),
    },
    durationSec
  );

  const nextList = [...existingList];
  if (matchedIndex >= 0) {
    nextList[matchedIndex] = nextKf;
  } else {
    nextList.push(nextKf);
  }

  return {
    keyframes: sortAndDedupeKeyframes(nextList, durationSec),
    saved: nextKf,
  };
}

export function updateClipKeyframeById(
  keyframes: ClipKeyframe[] | undefined,
  keyframeId: string,
  patch: Partial<Pick<ClipKeyframe, "timeSec" | "value" | "easing">>,
  durationSec?: number
): ClipKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  const updated = keyframes.map((kf) => {
    if (kf.id !== keyframeId) return kf;
    return normalizeKeyframe(
      {
        ...kf,
        ...patch,
        property: kf.property,
      },
      durationSec
    );
  });
  return sortAndDedupeKeyframes(updated, durationSec);
}

export function removeClipKeyframe(
  keyframes: ClipKeyframe[] | undefined,
  keyframeId: string
): ClipKeyframe[] | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  const filtered = keyframes.filter((kf) => kf.id !== keyframeId);
  return filtered.length > 0 ? filtered : undefined;
}

export function clearPropertyKeyframes(
  keyframes: ClipKeyframe[] | undefined,
  property?: KeyframeProperty
): ClipKeyframe[] | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  if (!property) return undefined;
  const remaining = keyframes.filter((kf) => kf.property !== property);
  return remaining.length > 0 ? remaining : undefined;
}

export function adjustKeyframesForTrimStart(
  clip: TimelineClip,
  deltaSec: number,
  nextDuration: number
): ClipKeyframe[] | undefined {
  const source = clip.keyframes;
  if (!source || source.length === 0) return undefined;
  if (Math.abs(deltaSec) < 0.001) {
    return sortAndDedupeKeyframes(source, nextDuration);
  }

  const out: ClipKeyframe[] = [];
  const propsSeen = new Set(source.map((k) => k.property));

  for (const prop of propsSeen) {
    const propFrames = getPropertyKeyframes(source, prop);
    if (propFrames.length === 0) continue;

    // Shift keyframes by -deltaSec; clamp/sample boundary at new 0s if deltaSec > 0 removed keyframes before deltaSec
    const shifted = propFrames
      .map((kf) => ({
        ...kf,
        timeSec: Number((kf.timeSec - deltaSec).toFixed(3)),
      }))
      .filter((kf) => kf.timeSec >= -0.001 && kf.timeSec <= nextDuration + 0.001)
      .map((kf) => normalizeKeyframe({ ...kf, timeSec: Math.max(0, kf.timeSec) }, nextDuration));

    if (deltaSec > 0 && propFrames.some((k) => k.timeSec < deltaSec) && !shifted.some((k) => k.timeSec <= 0.001)) {
      const valAtNewStart = interpolateProperty(source, prop, deltaSec, getStaticClipPropertyValue(clip, prop));
      shifted.unshift(
        normalizeKeyframe(
          {
            id: createKeyframeId(),
            property: prop,
            timeSec: 0,
            value: valAtNewStart,
            easing: propFrames[0].easing,
          },
          nextDuration
        )
      );
    }

    out.push(...shifted);
  }

  const sorted = sortAndDedupeKeyframes(out, nextDuration);
  return sorted.length > 0 ? sorted : undefined;
}

export function adjustKeyframesForTrimEnd(
  clip: TimelineClip,
  nextDuration: number
): ClipKeyframe[] | undefined {
  const source = clip.keyframes;
  if (!source || source.length === 0) return undefined;

  const out: ClipKeyframe[] = [];
  const propsSeen = new Set(source.map((k) => k.property));

  for (const prop of propsSeen) {
    const propFrames = getPropertyKeyframes(source, prop);
    const kept = propFrames
      .filter((kf) => kf.timeSec <= nextDuration + 0.001)
      .map((kf) => normalizeKeyframe(kf, nextDuration));

    if (propFrames.some((kf) => kf.timeSec > nextDuration) && !kept.some((kf) => Math.abs(kf.timeSec - nextDuration) <= 0.001)) {
      const valAtEnd = interpolateProperty(source, prop, nextDuration, getStaticClipPropertyValue(clip, prop));
      kept.push(
        normalizeKeyframe(
          {
            id: createKeyframeId(),
            property: prop,
            timeSec: nextDuration,
            value: valAtEnd,
            easing: "linear",
          },
          nextDuration
        )
      );
    }

    out.push(...kept);
  }

  const sorted = sortAndDedupeKeyframes(out, nextDuration);
  return sorted.length > 0 ? sorted : undefined;
}

export function sliceKeyframesForSplit(
  clip: TimelineClip,
  splitOffsetSec: number,
  leftDuration: number,
  rightDuration: number
): {
  leftKeyframes?: ClipKeyframe[];
  rightKeyframes?: ClipKeyframe[];
} {
  const source = clip.keyframes;
  if (!source || source.length === 0) {
    return { leftKeyframes: undefined, rightKeyframes: undefined };
  }

  const leftOut: ClipKeyframe[] = [];
  const rightOut: ClipKeyframe[] = [];
  const propsSeen = new Set(source.map((k) => k.property));

  for (const prop of propsSeen) {
    const propFrames = getPropertyKeyframes(source, prop);
    if (propFrames.length === 0) continue;

    const fallback = getStaticClipPropertyValue(clip, prop);
    const boundaryVal = interpolateProperty(source, prop, splitOffsetSec, fallback);
    const hasLeftAfterSplit = propFrames.some((k) => k.timeSec > splitOffsetSec + 0.001);
    const hasLeftBeforeSplit = propFrames.some((k) => k.timeSec < splitOffsetSec - 0.001);

    const leftProp = propFrames
      .filter((k) => k.timeSec <= splitOffsetSec + 0.001)
      .map((k) => normalizeKeyframe(k, leftDuration));

    if (hasLeftAfterSplit && !leftProp.some((k) => Math.abs(k.timeSec - leftDuration) <= 0.005)) {
      leftProp.push(
        normalizeKeyframe(
          {
            id: createKeyframeId(),
            property: prop,
            timeSec: leftDuration,
            value: boundaryVal,
            easing: "linear",
          },
          leftDuration
        )
      );
    }

    const rightProp = propFrames
      .filter((k) => k.timeSec >= splitOffsetSec - 0.001)
      .map((k) =>
        normalizeKeyframe(
          {
            ...k,
            id: createKeyframeId(),
            timeSec: Math.max(0, Number((k.timeSec - splitOffsetSec).toFixed(3))),
          },
          rightDuration
        )
      );

    if (hasLeftBeforeSplit && !rightProp.some((k) => k.timeSec <= 0.005)) {
      const activeSeg = [...propFrames].reverse().find((k) => k.timeSec <= splitOffsetSec);
      rightProp.unshift(
        normalizeKeyframe(
          {
            id: createKeyframeId(),
            property: prop,
            timeSec: 0,
            value: boundaryVal,
            easing: activeSeg?.easing ?? "linear",
          },
          rightDuration
        )
      );
    }

    leftOut.push(...leftProp);
    rightOut.push(...rightProp);
  }

  const leftSorted = sortAndDedupeKeyframes(leftOut, leftDuration);
  const rightSorted = sortAndDedupeKeyframes(rightOut, rightDuration);

  return {
    leftKeyframes: leftSorted.length > 0 ? leftSorted : undefined,
    rightKeyframes: rightSorted.length > 0 ? rightSorted : undefined,
  };
}

export function scaleKeyframesForSpeed(
  keyframes: ClipKeyframe[] | undefined,
  oldDuration: number,
  nextDuration: number
): ClipKeyframe[] | undefined {
  if (!keyframes || keyframes.length === 0) return undefined;
  if (oldDuration <= 0.001 || nextDuration <= 0.001) {
    return sortAndDedupeKeyframes(keyframes, nextDuration);
  }
  const ratio = nextDuration / oldDuration;
  const scaled = keyframes.map((kf) =>
    normalizeKeyframe(
      {
        ...kf,
        timeSec: Number((kf.timeSec * ratio).toFixed(3)),
      },
      nextDuration
    )
  );
  const sorted = sortAndDedupeKeyframes(scaled, nextDuration);
  return sorted.length > 0 ? sorted : undefined;
}

export function hasVolumeKeyframesWithSound(clip: Pick<TimelineClip, "volume" | "muted" | "keyframes">): boolean {
  if (clip.muted) return false;
  if (clip.volume > 0.001) return true;
  if (!clip.keyframes || clip.keyframes.length === 0) return false;
  return clip.keyframes.some((kf) => kf.property === "volume" && kf.value > 0.001);
}

export function formatKeyframeValueDisplay(property: KeyframeProperty, value: number): string {
  const spec = KEYFRAME_PROPERTY_SPECS[property];
  const scaled = value * spec.displayMultiplier;
  if (spec.unit === "deg") {
    return `${Math.round(scaled)}°`;
  }
  if (spec.unit === "%") {
    return `${Math.round(scaled)}%`;
  }
  return `${scaled.toFixed(spec.precision)}`;
}
