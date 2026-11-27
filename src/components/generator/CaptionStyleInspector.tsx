import React, { useMemo } from "react";
import { AlertTriangle, Palette, RotateCcw } from "lucide-react";
import type {
  CaptionStyleConfig,
  CaptionStylePresetId,
  StoryboardLanguage,
} from "../../types/studio";
import { getSlideFontFamily } from "../../utils/generatedSlides";
import {
  CAPTION_STYLE_PRESETS,
  checkCaptionFontSupport,
  getCaptionPresetById,
} from "../../utils/storyboardCaptions";

interface CaptionStyleInspectorProps {
  style: CaptionStyleConfig;
  language: StoryboardLanguage;
  onChange: (next: CaptionStyleConfig) => void;
}

const FONT_FAMILY_CHOICES: ReadonlyArray<{ label: string; value: string }> = [
  {
    label: "Plus Jakarta Sans (Default)",
    value: '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif',
  },
  {
    label: "Inter / System UI",
    value: '"Inter", system-ui, -apple-system, sans-serif',
  },
  {
    label: "Georgia / Editorial Serif",
    value: 'Georgia, "Times New Roman", serif',
  },
  {
    label: "JetBrains Mono / Technical",
    value: '"JetBrains Mono", ui-monospace, monospace',
  },
];

export function CaptionStyleInspector({
  style,
  language,
  onChange,
}: CaptionStyleInspectorProps) {
  const fontCheck = useMemo(() => checkCaptionFontSupport(language), [language]);

  const applyPreset = (presetId: CaptionStylePresetId) => {
    const preset = getCaptionPresetById(presetId);
    onChange({
      ...preset,
      enabled: style.enabled,
      fontFamily:
        language === "Hindi" || language === "Bengali"
          ? getSlideFontFamily(language)
          : preset.fontFamily,
    });
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-[#09090B] p-3.5 space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Palette className="h-3.5 w-3.5 text-violet-400" />
          <span className="text-xs font-medium text-white">Caption Style Presets &amp; Typography</span>
        </div>

        <button
          type="button"
          onClick={() => applyPreset(style.presetId)}
          className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-[#111114] px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Reset Preset</span>
        </button>
      </div>

      {/* 6 Presets Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {CAPTION_STYLE_PRESETS.map((preset) => {
          const active = style.presetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              title={preset.description}
              className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                active
                  ? "border-violet-500 bg-violet-500/15 text-white"
                  : "border-zinc-800 bg-[#111114] text-zinc-300 hover:border-zinc-700 hover:text-white"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[11px] font-medium truncate">{preset.label}</span>
                <span
                  className="h-2.5 w-2.5 rounded-full border border-white/20 shrink-0"
                  style={{ backgroundColor: preset.style.color }}
                />
              </div>
              <p className="mt-0.5 text-[10px] text-zinc-400 line-clamp-1">{preset.style.position}</p>
            </button>
          );
        })}
      </div>

      {!fontCheck.supported && fontCheck.warning && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" />
          <span>{fontCheck.warning}</span>
        </div>
      )}

      {/* Detailed Controls */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
        <label className="space-y-1 col-span-2 sm:col-span-2">
          <span className="block text-zinc-400">
            Font Family {language !== "English" ? `(${language} fallback active)` : ""}
          </span>
          <select
            aria-label="Caption font family"
            value={style.fontFamily}
            disabled={language !== "English"}
            onChange={(e) => onChange({ ...style, fontFamily: e.target.value })}
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-55"
          >
            {FONT_FAMILY_CHOICES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
            {!FONT_FAMILY_CHOICES.some((f) => f.value === style.fontFamily) && (
              <option value={style.fontFamily}>Language Default ({language})</option>
            )}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Font Size ({style.fontSize}px ref)</span>
          <input
            type="range"
            min={20}
            max={68}
            step={2}
            aria-label="Caption font size"
            value={style.fontSize}
            onChange={(e) => onChange({ ...style, fontSize: Number(e.target.value) })}
            className="w-full accent-violet-500 cursor-pointer"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Font Weight</span>
          <select
            aria-label="Caption font weight"
            value={style.fontWeight}
            onChange={(e) =>
              onChange({
                ...style,
                fontWeight: Number(e.target.value) as CaptionStyleConfig["fontWeight"],
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
          >
            <option value={400}>Regular (400)</option>
            <option value={500}>Medium (500)</option>
            <option value={600}>Semibold (600)</option>
            <option value={700}>Bold (700)</option>
            <option value={800}>Extra Bold (800)</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Text Color</span>
          <div className="flex items-center gap-2 rounded border border-zinc-800 bg-[#111114] px-2 py-1">
            <input
              type="color"
              aria-label="Caption text color"
              value={style.color}
              onChange={(e) => onChange({ ...style, color: e.target.value })}
              className="h-5 w-7 cursor-pointer bg-transparent border-0 p-0"
            />
            <span className="font-mono text-[10px] text-zinc-300 uppercase">{style.color}</span>
          </div>
        </label>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Backdrop Box</span>
            <input
              type="checkbox"
              aria-label="Enable caption background box"
              checked={style.backgroundEnabled}
              onChange={(e) => onChange({ ...style, backgroundEnabled: e.target.checked })}
              className="accent-violet-500"
            />
          </div>
          <div className="flex items-center gap-2 rounded border border-zinc-800 bg-[#111114] px-2 py-1">
            <input
              type="color"
              aria-label="Caption background color"
              disabled={!style.backgroundEnabled}
              value={style.backgroundColor}
              onChange={(e) => onChange({ ...style, backgroundColor: e.target.value })}
              className="h-5 w-7 cursor-pointer bg-transparent border-0 p-0 disabled:opacity-40"
            />
            <span className="font-mono text-[10px] text-zinc-300 uppercase">
              {Math.round(style.backgroundOpacity * 100)}%
            </span>
          </div>
        </div>

        <label className="space-y-1">
          <span className="block text-zinc-400">
            Bg Opacity ({Math.round(style.backgroundOpacity * 100)}%)
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            disabled={!style.backgroundEnabled}
            aria-label="Caption background opacity"
            value={style.backgroundOpacity}
            onChange={(e) => onChange({ ...style, backgroundOpacity: Number(e.target.value) })}
            className="w-full accent-violet-500 cursor-pointer disabled:opacity-40"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Outline ({style.outlineWidth.toFixed(1)}px)</span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={5}
              step={0.5}
              aria-label="Caption outline width"
              value={style.outlineWidth}
              onChange={(e) => onChange({ ...style, outlineWidth: Number(e.target.value) })}
              className="flex-1 accent-violet-500 cursor-pointer"
            />
            <input
              type="color"
              aria-label="Caption outline color"
              value={style.outlineColor}
              onChange={(e) => onChange({ ...style, outlineColor: e.target.value })}
              className="h-5 w-6 cursor-pointer bg-transparent border-0 p-0 shrink-0"
            />
          </div>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Vertical Position</span>
          <select
            aria-label="Caption vertical position"
            value={style.position}
            onChange={(e) =>
              onChange({
                ...style,
                position: e.target.value as CaptionStyleConfig["position"],
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
          >
            <option value="bottom">Bottom Safe Area</option>
            <option value="middle">Middle Center</option>
            <option value="top">Top Safe Area</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Alignment</span>
          <select
            aria-label="Caption alignment"
            value={style.alignment}
            onChange={(e) =>
              onChange({
                ...style,
                alignment: e.target.value as CaptionStyleConfig["alignment"],
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Safe Margin ({style.safeMarginBottomPct}%)</span>
          <input
            type="range"
            min={4}
            max={28}
            step={1}
            aria-label="Caption safe margin percentage"
            value={style.safeMarginBottomPct}
            onChange={(e) =>
              onChange({ ...style, safeMarginBottomPct: Number(e.target.value) })
            }
            className="w-full accent-violet-500 cursor-pointer"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Max Lines</span>
          <select
            aria-label="Caption maximum lines"
            value={style.maxLines}
            onChange={(e) =>
              onChange({
                ...style,
                maxLines: Number(e.target.value) as 1 | 2 | 3,
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
          >
            <option value={1}>1 Line</option>
            <option value={2}>2 Lines (Recommended)</option>
            <option value={3}>3 Lines</option>
          </select>
        </label>
      </div>

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Preview styling renders proportionally across 16:9, 9:16, and 1:1 frames. Standard{" "}
        <code className="font-mono text-zinc-400">.srt</code> and{" "}
        <code className="font-mono text-zinc-400">.vtt</code> downloads export cue timestamps and plain
        text (visual styling applies during live preview and Phase 5.5.5+ FFmpeg composition).
      </p>
    </div>
  );
}
