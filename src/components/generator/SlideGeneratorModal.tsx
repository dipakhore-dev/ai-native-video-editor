import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Sparkles, Type, X } from "lucide-react";
import type {
  AspectRatioOption,
  GeneratedSlideConfig,
  GeneratedSlideTemplate,
  StoryboardLanguage,
  StoryboardScene,
} from "../../types/studio";
import {
  checkLanguageFontSupport,
  generateSlideImageFile,
  renderTextSlideToCanvas,
  SLIDE_COLOR_PRESETS,
  SLIDE_TEMPLATE_OPTIONS,
} from "../../utils/generatedSlides";

interface SlideGeneratorModalProps {
  open: boolean;
  scene: StoryboardScene | null;
  aspectRatio: AspectRatioOption;
  language: StoryboardLanguage;
  onClose: () => void;
  onGenerateAndAssign: (result: {
    file: File;
    config: GeneratedSlideConfig;
    sceneId: string;
  }) => Promise<void> | void;
}

export function SlideGeneratorModal({
  open,
  scene,
  aspectRatio,
  language,
  onClose,
  onGenerateAndAssign,
}: SlideGeneratorModalProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [template, setTemplate] = useState<GeneratedSlideTemplate>("educational");
  const [headingText, setHeadingText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [backgroundColor, setBackgroundColor] = useState("#0F0C1D");
  const [gradientColor, setGradientColor] = useState("#1E1638");
  const [useGradient, setUseGradient] = useState(true);
  const [textColor, setTextColor] = useState("#F8FAFC");
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  const [fontSize, setFontSize] = useState(54);
  const [slideLanguage, setSlideLanguage] = useState<StoryboardLanguage>(language);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !scene) return;
    setTemplate(scene.mediaType === "text_card" ? "title" : "educational");
    setHeadingText(scene.onScreenText.trim() || scene.title.trim() || "Scene Title");
    setBodyText(scene.narration.trim().slice(0, 220));
    setFooterText("");
    setSlideLanguage(language);
    setError(null);
  }, [open, scene, language]);

  const currentConfig: GeneratedSlideConfig = useMemo(
    () => ({
      template,
      headingText: headingText.trim() || "Untitled Slide",
      bodyText: bodyText.trim(),
      footerText: footerText.trim(),
      backgroundColor,
      gradientColor,
      useGradient,
      textColor,
      textAlign,
      fontSize,
      aspectRatio,
      language: slideLanguage,
    }),
    [
      aspectRatio,
      backgroundColor,
      bodyText,
      fontSize,
      footerText,
      gradientColor,
      headingText,
      slideLanguage,
      template,
      textAlign,
      textColor,
      useGradient,
    ]
  );

  const fontSupport = useMemo(
    () => checkLanguageFontSupport(slideLanguage),
    [slideLanguage]
  );

  useEffect(() => {
    if (!open || !previewCanvasRef.current) return;
    try {
      renderTextSlideToCanvas(previewCanvasRef.current, currentConfig);
    } catch {
      // Preview rendering handles validation softly while typing
    }
  }, [open, currentConfig]);

  if (!open || !scene) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!headingText.trim()) {
      setError("Heading text is required to render a slide graphic.");
      return;
    }
    setRendering(true);
    setError(null);
    try {
      const rendered = await generateSlideImageFile(currentConfig, scene.title);
      await onGenerateAndAssign({
        file: rendered.file,
        config: rendered.config,
        sceneId: scene.id,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render PNG slide graphic.");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Generate Local Text Slide"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl border border-zinc-800 bg-[#111114] overflow-hidden shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Type className="h-4 w-4 text-violet-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">
                Locally Rendered Text Graphic — {scene.title}
              </p>
              <p className="text-[11px] text-zinc-400">
                Rendered directly via HTML5 Canvas ({aspectRatio}) as a real PNG saved in IndexedDB.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            aria-label="Close slide generator"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Controls */}
          <div className="lg:col-span-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Slide Template
                </label>
                <select
                  value={template}
                  onChange={(e) => setTemplate(e.target.value as GeneratedSlideTemplate)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  {SLIDE_TEMPLATE_OPTIONS.map((tpl) => (
                    <option key={tpl.value} value={tpl.value}>
                      {tpl.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Script / Font Language
                </label>
                <select
                  value={slideLanguage}
                  onChange={(e) => setSlideLanguage(e.target.value as StoryboardLanguage)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  <option value="English">English</option>
                  <option value="Hindi">Hindi (Devanagari)</option>
                  <option value="Bengali">Bengali</option>
                </select>
              </div>
            </div>

            {!fontSupport.supported && fontSupport.warning && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
                <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span>{fontSupport.warning}</span>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                Heading Text
              </label>
              <input
                type="text"
                maxLength={180}
                value={headingText}
                onChange={(e) => setHeadingText(e.target.value)}
                placeholder="Main title or headline..."
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                Body / Bullet Text (optional)
              </label>
              <textarea
                rows={3}
                maxLength={480}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Supporting point or narration quote..."
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Footer Label
                </label>
                <input
                  type="text"
                  maxLength={90}
                  value={footerText}
                  onChange={(e) => setFooterText(e.target.value)}
                  placeholder="Optional note"
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Alignment
                </label>
                <select
                  value={textAlign}
                  onChange={(e) => setTextAlign(e.target.value as "left" | "center" | "right")}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  <option value="center">Center</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                  Font Size ({fontSize}px)
                </label>
                <input
                  type="range"
                  min={32}
                  max={84}
                  step={2}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full accent-violet-500 mt-1.5"
                />
              </div>
            </div>

            {/* Color Presets & Custom Inputs */}
            <div className="space-y-2 pt-1 border-t border-zinc-800/80">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-zinc-300">Theme Palette</span>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useGradient}
                    onChange={(e) => setUseGradient(e.target.checked)}
                    className="accent-violet-500"
                  />
                  <span>Subtle Gradient</span>
                </label>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {SLIDE_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setBackgroundColor(preset.backgroundColor);
                      setGradientColor(preset.gradientColor);
                      setTextColor(preset.textColor);
                    }}
                    className="rounded-lg border border-zinc-800 bg-[#09090B] px-2 py-1.5 text-[11px] text-zinc-300 hover:border-violet-500 transition-colors flex items-center gap-1.5"
                  >
                    <span
                      className="h-3 w-3 rounded-sm border border-white/20 shrink-0"
                      style={{ backgroundColor: preset.backgroundColor }}
                    />
                    <span className="truncate">{preset.label}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-[11px] text-zinc-400">
                  <span>Bg 1</span>
                  <input
                    type="color"
                    value={backgroundColor}
                    onChange={(e) => setBackgroundColor(e.target.value)}
                    className="h-5 w-7 bg-transparent border-0 cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-[11px] text-zinc-400">
                  <span>Bg 2</span>
                  <input
                    type="color"
                    value={gradientColor}
                    onChange={(e) => setGradientColor(e.target.value)}
                    className="h-5 w-7 bg-transparent border-0 cursor-pointer"
                  />
                </label>
                <label className="flex items-center justify-between rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-[11px] text-zinc-400">
                  <span>Text</span>
                  <input
                    type="color"
                    value={textColor}
                    onChange={(e) => setTextColor(e.target.value)}
                    className="h-5 w-7 bg-transparent border-0 cursor-pointer"
                  />
                </label>
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {error}
              </div>
            )}
          </div>

          {/* Live Canvas Preview */}
          <div className="lg:col-span-6 flex flex-col justify-between rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3">
            <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
              <span>Live Canvas Preview ({aspectRatio})</span>
              <span>PNG Output</span>
            </div>
            <div className="flex-1 flex items-center justify-center min-h-[240px] bg-black/50 rounded-lg p-2">
              <canvas
                ref={previewCanvasRef}
                className="max-h-[320px] max-w-full rounded border border-zinc-800 object-contain"
              />
            </div>
            <p className="text-[11px] text-zinc-500">
              Saved into browser IndexedDB with source origin metadata so it persists across page refreshes.
            </p>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-zinc-800 flex items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={rendering || !headingText.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50"
          >
            {rendering ? (
              <>
                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                <span>Rendering PNG...</span>
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />
                <span>Render &amp; Assign Slide</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
