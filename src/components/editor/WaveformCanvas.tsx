import React, { useEffect, useRef } from "react";
import type { MediaKind } from "../../types/studio";

interface WaveformCanvasProps {
  bars: number[];
  widthPx: number;
  kind: MediaKind;
  gainScale: number;
  isMuted: boolean;
}

export const WaveformCanvas = React.memo(function WaveformCanvas({
  bars,
  widthPx,
  kind,
  gainScale,
  isMuted,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || bars.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const cssWidth = Math.max(24, Math.round(canvas.clientWidth || widthPx));
    const cssHeight = Math.max(24, Math.round(canvas.clientHeight || 44));
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.fillStyle =
      kind === "audio"
        ? isMuted
          ? "rgba(113, 113, 122, 0.45)"
          : "rgba(125, 211, 252, 0.48)"
        : "rgba(221, 214, 254, 0.36)";

    const count = bars.length;
    const step = cssWidth / count;
    const barW = Math.max(1, step - 1);

    for (let i = 0; i < count; i++) {
      const rawAmp = bars[i] ?? 0.04;
      const barPct = Math.max(0.08, Math.min(0.92, rawAmp * 0.88 * gainScale));
      const h = Math.max(2, cssHeight * (kind === "audio" ? barPct : barPct * 0.48));
      const x = i * step;
      const y = kind === "audio" ? (cssHeight - h) * 0.5 : cssHeight - h - 2;
      ctx.fillRect(x, y, barW, h);
    }
  }, [bars, widthPx, kind, gainScale, isMuted]);

  if (bars.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full pointer-events-none"
    />
  );
});
