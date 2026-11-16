import type { CSSProperties } from "react";
import type {
  ClipTransition,
  ClipVisualEffects,
  EffectPreset,
  TimelineClip,
  TransitionType,
} from "../types/studio";

export const DEFAULT_CLIP_EFFECTS: ClipVisualEffects = {
  preset: "none",
  brightness: 0,
  contrast: 1,
  saturation: 1,
  blur: 0,
};

export const DEFAULT_CLIP_TRANSITION: ClipTransition = {
  type: "none",
  durationSec: 0.6,
};

export const TRANSITION_OPTIONS: ReadonlyArray<{
  value: TransitionType;
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade (Black)" },
  { value: "dissolve", label: "Cross Dissolve" },
  { value: "wipeleft", label: "Wipe Left" },
  { value: "wiperight", label: "Wipe Right" },
  { value: "slideleft", label: "Slide Left" },
  { value: "slideright", label: "Slide Right" },
  { value: "zoomin", label: "Zoom In" },
];

export const EFFECT_PRESETS: ReadonlyArray<{
  value: EffectPreset;
  label: string;
  brightnessDelta: number;
  contrastMult: number;
  saturationMult: number;
  sepia: number;
  hueRotateDeg: number;
}> = [
  {
    value: "none",
    label: "Original",
    brightnessDelta: 0,
    contrastMult: 1,
    saturationMult: 1,
    sepia: 0,
    hueRotateDeg: 0,
  },
  {
    value: "cinematic",
    label: "Cinematic",
    brightnessDelta: -0.04,
    contrastMult: 1.15,
    saturationMult: 0.9,
    sepia: 0.08,
    hueRotateDeg: 0,
  },
  {
    value: "bw",
    label: "B&W",
    brightnessDelta: 0,
    contrastMult: 1.14,
    saturationMult: 0,
    sepia: 0,
    hueRotateDeg: 0,
  },
  {
    value: "vintage",
    label: "Vintage",
    brightnessDelta: 0.03,
    contrastMult: 0.92,
    saturationMult: 0.72,
    sepia: 0.35,
    hueRotateDeg: -6,
  },
  {
    value: "warm",
    label: "Warm",
    brightnessDelta: 0.02,
    contrastMult: 1.05,
    saturationMult: 1.12,
    sepia: 0.18,
    hueRotateDeg: -4,
  },
  {
    value: "cool",
    label: "Cool",
    brightnessDelta: -0.01,
    contrastMult: 1.06,
    saturationMult: 0.95,
    sepia: 0,
    hueRotateDeg: 10,
  },
  {
    value: "vivid",
    label: "Vivid",
    brightnessDelta: 0.02,
    contrastMult: 1.16,
    saturationMult: 1.38,
    sepia: 0,
    hueRotateDeg: 0,
  },
];

export function normalizeEffects(raw?: Partial<ClipVisualEffects> | null): ClipVisualEffects {
  const validPreset = EFFECT_PRESETS.some((p) => p.value === raw?.preset)
    ? (raw!.preset as EffectPreset)
    : "none";
  const brightness = Number.isFinite(Number(raw?.brightness))
    ? Math.max(-0.5, Math.min(0.5, Number(raw!.brightness)))
    : 0;
  const contrast = Number.isFinite(Number(raw?.contrast))
    ? Math.max(0.5, Math.min(1.8, Number(raw!.contrast)))
    : 1;
  const saturation = Number.isFinite(Number(raw?.saturation))
    ? Math.max(0, Math.min(2, Number(raw!.saturation)))
    : 1;
  const blur = Number.isFinite(Number(raw?.blur))
    ? Math.max(0, Math.min(10, Number(raw!.blur)))
    : 0;

  return {
    preset: validPreset,
    brightness: Number(brightness.toFixed(2)),
    contrast: Number(contrast.toFixed(2)),
    saturation: Number(saturation.toFixed(2)),
    blur: Number(blur.toFixed(2)),
  };
}

export function normalizeTransition(
  raw?: Partial<ClipTransition> | null,
  clipDurationSec?: number
): ClipTransition {
  const validType = TRANSITION_OPTIONS.some((t) => t.value === raw?.type)
    ? (raw!.type as TransitionType)
    : "none";
  const rawDur = Number(raw?.durationSec ?? 0.6);
  const clamped = Number.isFinite(rawDur) ? Math.max(0.2, Math.min(2.0, rawDur)) : 0.6;
  const maxAllowed =
    clipDurationSec !== undefined && Number.isFinite(clipDurationSec)
      ? Math.max(0.2, Math.min(2.0, Number((clipDurationSec * 0.45).toFixed(2))))
      : 2.0;

  return {
    type: validType,
    durationSec: Number(Math.min(clamped, maxAllowed).toFixed(2)),
  };
}

export function hasCustomEffects(effects?: Partial<ClipVisualEffects> | null): boolean {
  const norm = normalizeEffects(effects);
  return (
    norm.preset !== "none" ||
    Math.abs(norm.brightness) > 0.01 ||
    Math.abs(norm.contrast - 1) > 0.01 ||
    Math.abs(norm.saturation - 1) > 0.01 ||
    norm.blur > 0.05
  );
}

export function resolveEffectiveVisualEffects(effects?: Partial<ClipVisualEffects> | null): {
  preset: EffectPreset;
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  sepia: number;
  hueRotateDeg: number;
} {
  const norm = normalizeEffects(effects);
  const presetSpec =
    EFFECT_PRESETS.find((p) => p.value === norm.preset) ?? EFFECT_PRESETS[0];

  const effBrightness = Math.max(
    -0.5,
    Math.min(0.5, norm.brightness + presetSpec.brightnessDelta)
  );
  const effContrast = Math.max(
    0.4,
    Math.min(2.0, norm.contrast * presetSpec.contrastMult)
  );
  const effSaturation =
    presetSpec.value === "bw"
      ? 0
      : Math.max(0, Math.min(2.5, norm.saturation * presetSpec.saturationMult));

  return {
    preset: norm.preset,
    brightness: Number(effBrightness.toFixed(3)),
    contrast: Number(effContrast.toFixed(3)),
    saturation: Number(effSaturation.toFixed(3)),
    blur: norm.blur,
    sepia: presetSpec.sepia,
    hueRotateDeg: presetSpec.hueRotateDeg,
  };
}

export function buildPreviewCssFilter(effects?: Partial<ClipVisualEffects> | null): string {
  const eff = resolveEffectiveVisualEffects(effects);
  const parts: string[] = [];

  if (Math.abs(eff.brightness) > 0.005) {
    parts.push(`brightness(${Math.max(0.2, 1 + eff.brightness).toFixed(3)})`);
  }
  if (Math.abs(eff.contrast - 1) > 0.005) {
    parts.push(`contrast(${eff.contrast.toFixed(3)})`);
  }
  if (Math.abs(eff.saturation - 1) > 0.005) {
    parts.push(`saturate(${eff.saturation.toFixed(3)})`);
  }
  if (eff.sepia > 0.005) {
    parts.push(`sepia(${eff.sepia.toFixed(2)})`);
  }
  if (Math.abs(eff.hueRotateDeg) > 0.1) {
    parts.push(`hue-rotate(${eff.hueRotateDeg}deg)`);
  }
  if (eff.blur > 0.05) {
    parts.push(`blur(${eff.blur.toFixed(2)}px)`);
  }

  return parts.length > 0 ? parts.join(" ") : "none";
}

export function computeClipTransitionStyle(
  clip: Pick<TimelineClip, "startTime" | "duration" | "opacity" | "transitionIn" | "transitionOut">,
  timelineTimeSec: number,
  prevAdjacentClip?: Pick<TimelineClip, "startTime" | "duration" | "transitionOut"> | null
): CSSProperties {
  const baseOpacity = Number.isFinite(clip.opacity)
    ? Math.max(0, Math.min(1, clip.opacity))
    : 1;
  const elapsed = Math.max(0, timelineTimeSec - clip.startTime);
  const remaining = Math.max(0, clip.startTime + clip.duration - timelineTimeSec);

  let effectiveIn = normalizeTransition(clip.transitionIn, clip.duration);
  if (effectiveIn.type === "none" && prevAdjacentClip) {
    const gap = Math.abs(clip.startTime - (prevAdjacentClip.startTime + prevAdjacentClip.duration));
    if (gap <= 0.15) {
      const prevOut = normalizeTransition(prevAdjacentClip.transitionOut, prevAdjacentClip.duration);
      if (prevOut.type !== "none") {
        effectiveIn = prevOut;
      }
    }
  }

  const effectiveOut = normalizeTransition(clip.transitionOut, clip.duration);

  let opacityFactor = 1;
  let clipPath: string | undefined;
  let transform: string | undefined;

  if (effectiveIn.type !== "none" && effectiveIn.durationSec > 0.05 && elapsed < effectiveIn.durationSec) {
    const p = Math.max(0, Math.min(1, elapsed / effectiveIn.durationSec));
    switch (effectiveIn.type) {
      case "fade":
      case "dissolve":
        opacityFactor *= p;
        break;
      case "wipeleft":
        clipPath = `inset(0 ${((1 - p) * 100).toFixed(1)}% 0 0)`;
        break;
      case "wiperight":
        clipPath = `inset(0 0 0 ${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "slideleft":
        transform = `translateX(${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "slideright":
        transform = `translateX(-${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "zoomin":
        transform = `scale(${(0.84 + p * 0.16).toFixed(3)})`;
        opacityFactor *= p;
        break;
    }
  }

  if (effectiveOut.type !== "none" && effectiveOut.durationSec > 0.05 && remaining < effectiveOut.durationSec) {
    const p = Math.max(0, Math.min(1, remaining / effectiveOut.durationSec));
    switch (effectiveOut.type) {
      case "fade":
      case "dissolve":
        opacityFactor *= p;
        break;
      case "wipeleft":
        clipPath = `inset(0 0 0 ${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "wiperight":
        clipPath = `inset(0 ${((1 - p) * 100).toFixed(1)}% 0 0)`;
        break;
      case "slideleft":
        transform = `translateX(-${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "slideright":
        transform = `translateX(${((1 - p) * 100).toFixed(1)}%)`;
        break;
      case "zoomin":
        transform = `scale(${(1 + (1 - p) * 0.15).toFixed(3)})`;
        opacityFactor *= p;
        break;
    }
  }

  return {
    opacity: Number((baseOpacity * opacityFactor).toFixed(3)),
    ...(clipPath ? { clipPath } : {}),
    ...(transform ? { transform } : {}),
  };
}
