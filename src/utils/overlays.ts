import type { AspectRatioOption, OverlayPresetId, OverlayTransform } from "../types/studio";

export const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  x: 50,
  y: 50,
  widthPct: 100,
  heightPct: 100,
  scale: 1,
  lockAspectRatio: true,
};

export const OVERLAY_POSITION_PRESETS: ReadonlyArray<{
  id: Exclude<OverlayPresetId, "pip" | "watermark" | "fullscreen">;
  label: string;
  shortLabel: string;
  x: number;
  y: number;
}> = [
  { id: "top-left", label: "Top Left", shortLabel: "TL", x: 16, y: 16 },
  { id: "top-center", label: "Top Center", shortLabel: "TC", x: 50, y: 16 },
  { id: "top-right", label: "Top Right", shortLabel: "TR", x: 84, y: 16 },
  { id: "bottom-left", label: "Bottom Left", shortLabel: "BL", x: 16, y: 84 },
  { id: "center", label: "Center", shortLabel: "CTR", x: 50, y: 50 },
  { id: "bottom-right", label: "Bottom Right", shortLabel: "BR", x: 84, y: 84 },
];

export const OVERLAY_MODE_PRESETS: ReadonlyArray<{
  id: "pip" | "watermark" | "fullscreen";
  label: string;
}> = [
  { id: "pip", label: "PiP" },
  { id: "watermark", label: "Watermark" },
  { id: "fullscreen", label: "Full Frame" },
];

function clampNum(value: number, min: number, max: number, decimals = 2): number {
  if (!Number.isFinite(value)) return min;
  return Number(Math.max(min, Math.min(max, value)).toFixed(decimals));
}

export function normalizeOverlayTransform(
  raw?: Partial<OverlayTransform> | null
): OverlayTransform {
  return {
    x: raw?.x !== undefined ? clampNum(Number(raw.x), 0, 100, 1) : DEFAULT_OVERLAY_TRANSFORM.x,
    y: raw?.y !== undefined ? clampNum(Number(raw.y), 0, 100, 1) : DEFAULT_OVERLAY_TRANSFORM.y,
    widthPct:
      raw?.widthPct !== undefined
        ? clampNum(Number(raw.widthPct), 5, 100, 1)
        : DEFAULT_OVERLAY_TRANSFORM.widthPct,
    heightPct:
      raw?.heightPct !== undefined
        ? clampNum(Number(raw.heightPct), 5, 100, 1)
        : DEFAULT_OVERLAY_TRANSFORM.heightPct,
    scale:
      raw?.scale !== undefined
        ? clampNum(Number(raw.scale), 0.1, 2, 2)
        : DEFAULT_OVERLAY_TRANSFORM.scale,
    lockAspectRatio:
      raw?.lockAspectRatio !== undefined
        ? Boolean(raw.lockAspectRatio)
        : DEFAULT_OVERLAY_TRANSFORM.lockAspectRatio,
  };
}

export function hasCustomOverlayTransform(
  raw?: Partial<OverlayTransform> | null
): boolean {
  if (!raw) return false;
  const norm = normalizeOverlayTransform(raw);
  return (
    Math.abs(norm.x - DEFAULT_OVERLAY_TRANSFORM.x) > 0.1 ||
    Math.abs(norm.y - DEFAULT_OVERLAY_TRANSFORM.y) > 0.1 ||
    Math.abs(norm.widthPct - DEFAULT_OVERLAY_TRANSFORM.widthPct) > 0.1 ||
    Math.abs(norm.heightPct - DEFAULT_OVERLAY_TRANSFORM.heightPct) > 0.1 ||
    Math.abs(norm.scale - DEFAULT_OVERLAY_TRANSFORM.scale) > 0.01 ||
    norm.lockAspectRatio !== DEFAULT_OVERLAY_TRANSFORM.lockAspectRatio
  );
}

export function computeEffectiveOverlayBox(raw?: Partial<OverlayTransform> | null): {
  x: number;
  y: number;
  widthPct: number;
  heightPct: number;
  lockAspectRatio: boolean;
} {
  const norm = normalizeOverlayTransform(raw);
  return {
    x: norm.x,
    y: norm.y,
    widthPct: clampNum(norm.widthPct * norm.scale, 5, 100, 1),
    heightPct: clampNum(norm.heightPct * norm.scale, 5, 100, 1),
    lockAspectRatio: norm.lockAspectRatio,
  };
}

function resolveCanvasAspectRatio(aspectRatio?: AspectRatioOption): number {
  if (aspectRatio === "9:16") return 9 / 16;
  if (aspectRatio === "1:1") return 1;
  return 16 / 9;
}

/**
 * Computes updated widthPct/heightPct respecting aspect-ratio lock.
 * When sourceWidth/sourceHeight are present, normalizes percentage ratio against the canvas aspect ratio;
 * otherwise preserves the clip's current widthPct / heightPct ratio.
 */
export function updateOverlayBoxDimensions(
  current: OverlayTransform,
  changed: { widthPct?: number; heightPct?: number },
  options?: {
    aspectRatio?: AspectRatioOption;
    sourceWidth?: number;
    sourceHeight?: number;
  }
): Pick<OverlayTransform, "widthPct" | "heightPct"> {
  const norm = normalizeOverlayTransform(current);
  const nextW =
    changed.widthPct !== undefined
      ? clampNum(changed.widthPct, 5, 100, 1)
      : norm.widthPct;
  const nextH =
    changed.heightPct !== undefined
      ? clampNum(changed.heightPct, 5, 100, 1)
      : norm.heightPct;

  if (!norm.lockAspectRatio) {
    return { widthPct: nextW, heightPct: nextH };
  }

  let pctRatio = norm.heightPct > 0 ? norm.widthPct / norm.heightPct : 1;
  if (
    options?.sourceWidth &&
    options?.sourceHeight &&
    options.sourceWidth > 0 &&
    options.sourceHeight > 0
  ) {
    const mediaAspect = options.sourceWidth / options.sourceHeight;
    const canvasAspect = resolveCanvasAspectRatio(options.aspectRatio);
    pctRatio = mediaAspect / canvasAspect;
  }

  if (changed.widthPct !== undefined && changed.heightPct === undefined) {
    return {
      widthPct: nextW,
      heightPct: clampNum(nextW / Math.max(0.2, pctRatio), 5, 100, 1),
    };
  }

  if (changed.heightPct !== undefined && changed.widthPct === undefined) {
    return {
      widthPct: clampNum(nextH * pctRatio, 5, 100, 1),
      heightPct: nextH,
    };
  }

  return { widthPct: nextW, heightPct: nextH };
}

export function applyOverlayPreset(
  current: Partial<OverlayTransform> | null | undefined,
  preset: OverlayPresetId
): { overlayTransform: OverlayTransform; suggestedOpacity?: number } {
  const base = normalizeOverlayTransform(current);

  if (preset === "fullscreen") {
    return {
      overlayTransform: {
        x: 50,
        y: 50,
        widthPct: 100,
        heightPct: 100,
        scale: 1,
        lockAspectRatio: base.lockAspectRatio,
      },
      suggestedOpacity: 1,
    };
  }

  if (preset === "pip") {
    return {
      overlayTransform: {
        x: 82,
        y: 80,
        widthPct: 28,
        heightPct: 28,
        scale: 1,
        lockAspectRatio: true,
      },
      suggestedOpacity: 1,
    };
  }

  if (preset === "watermark") {
    return {
      overlayTransform: {
        x: 86,
        y: 14,
        widthPct: 18,
        heightPct: 18,
        scale: 1,
        lockAspectRatio: true,
      },
      suggestedOpacity: 0.65,
    };
  }

  const pos = OVERLAY_POSITION_PRESETS.find((p) => p.id === preset);
  if (!pos) {
    return { overlayTransform: base };
  }

  const isFullFrameDefault =
    base.widthPct >= 95 && base.heightPct >= 95 && base.scale >= 0.95;

  return {
    overlayTransform: {
      ...base,
      x: pos.x,
      y: pos.y,
      ...(isFullFrameDefault
        ? {
            widthPct: 26,
            heightPct: 26,
            scale: 1,
          }
        : {}),
    },
  };
}
