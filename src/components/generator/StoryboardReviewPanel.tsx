import React, { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Film,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type {
  EffectPreset,
  StoryboardCameraMotion,
  StoryboardMediaType,
  StoryboardScene,
  TransitionType,
  VideoStoryboard,
} from "../../types/studio";
import { EFFECT_PRESETS, TRANSITION_OPTIONS } from "../../utils/effects";
import {
  buildCaptionsFromScenes,
  buildNarrationFromScenes,
  CAMERA_MOTION_OPTIONS,
  CAPTION_PREFERENCE_OPTIONS,
  createBlankStoryboardScene,
  fitSceneDurationsToTarget,
  MAX_STORYBOARD_SCENES,
  recalculateStoryboardTiming,
  reorderStoryboardScenes,
  STORYBOARD_MEDIA_TYPE_OPTIONS,
  validateStoryboardInvariants,
  VOICEOVER_PREFERENCE_OPTIONS,
} from "../../utils/storyboard";

interface StoryboardReviewPanelProps {
  storyboard: VideoStoryboard;
  onChange: (next: VideoStoryboard) => void;
  onSaveDraft: () => Promise<void> | void;
  onRegenerate: () => void;
  savingDraft: boolean;
  saveStatusMessage: string | null;
  saveError: string | null;
  regenerating: boolean;
  isAuthenticated: boolean;
}

function formatClockRange(start: number, duration: number): string {
  const end = Number((start + duration).toFixed(2));
  return `${start.toFixed(1)}s – ${end.toFixed(1)}s`;
}

export function StoryboardReviewPanel({
  storyboard,
  onChange,
  onSaveDraft,
  onRegenerate,
  savingDraft,
  saveStatusMessage,
  saveError,
  regenerating,
  isAuthenticated,
}: StoryboardReviewPanelProps) {
  const [keywordsDraftById, setKeywordsDraftById] = useState<Record<string, string>>({});

  const validation = useMemo(
    () =>
      validateStoryboardInvariants({
        totalDuration: storyboard.totalDuration,
        scenes: storyboard.scenes,
      }),
    [storyboard.scenes, storyboard.totalDuration]
  );

  const voiceoverLabel =
    VOICEOVER_PREFERENCE_OPTIONS.find((v) => v.value === storyboard.settings.voiceoverPreference)
      ?.label || "No Voiceover";
  const captionLabel =
    CAPTION_PREFERENCE_OPTIONS.find((c) => c.value === storyboard.settings.captionStyle)?.label ||
    "No Captions";

  const commitScenes = (nextScenes: StoryboardScene[]) => {
    const timed = recalculateStoryboardTiming(nextScenes);
    onChange({
      ...storyboard,
      scenes: timed,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleScenePatch = (sceneId: string, patch: Partial<StoryboardScene>) => {
    const updated = storyboard.scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, ...patch } : scene
    );
    commitScenes(updated);
  };

  const handleMoveScene = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= storyboard.scenes.length) return;
    commitScenes(reorderStoryboardScenes(storyboard.scenes, index, targetIndex));
  };

  const handleAddScene = (afterIndex?: number) => {
    if (storyboard.scenes.length >= MAX_STORYBOARD_SCENES) return;
    const remainingBudget = Math.max(1, storyboard.totalDuration - validation.actualDuration);
    const suggestedDuration = Math.min(8, Math.max(2, Number(remainingBudget.toFixed(1))));
    const newScene = createBlankStoryboardScene(storyboard.scenes, suggestedDuration);
    const next = [...storyboard.scenes];
    if (afterIndex !== undefined) {
      next.splice(afterIndex + 1, 0, newScene);
    } else {
      next.push(newScene);
    }
    commitScenes(next);
  };

  const handleRemoveScene = (sceneId: string) => {
    if (storyboard.scenes.length <= 1) return;
    const next = storyboard.scenes.filter((s) => s.id !== sceneId);
    setKeywordsDraftById((prev) => {
      const copy = { ...prev };
      delete copy[sceneId];
      return copy;
    });
    commitScenes(next);
  };

  const handleFitDurations = () => {
    commitScenes(fitSceneDurationsToTarget(storyboard.scenes, storyboard.totalDuration));
  };

  const handleSyncScriptFromScenes = () => {
    onChange({
      ...storyboard,
      fullNarrationScript: buildNarrationFromScenes(storyboard.scenes),
      captionText: buildCaptionsFromScenes(storyboard.scenes),
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <section
      aria-label="Editable Storyboard Review"
      className="rounded-2xl border border-zinc-800/80 bg-[#111114] divide-y divide-zinc-800/80"
    >
      {/* Top Storyboard Summary & Controls */}
      <div className="p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 tabular-nums">
              <span>{storyboard.sourceMode === "script-to-video" ? "Script Plan" : "Prompt Plan"}</span>
              <span aria-hidden="true">·</span>
              <span>{storyboard.totalDuration}s Target</span>
              <span aria-hidden="true">·</span>
              <span>{storyboard.aspectRatio}</span>
              <span aria-hidden="true">·</span>
              <span>{storyboard.style}</span>
              <span aria-hidden="true">·</span>
              <span>{storyboard.language}</span>
              <span aria-hidden="true">·</span>
              <span>
                {storyboard.scenes.length} / {MAX_STORYBOARD_SCENES} Scenes
              </span>
              {storyboard.model && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-zinc-500">{storyboard.model}</span>
                </>
              )}
            </div>

            <input
              type="text"
              aria-label="Storyboard Title"
              maxLength={120}
              value={storyboard.title}
              onChange={(e) =>
                onChange({
                  ...storyboard,
                  title: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              className="w-full bg-transparent font-display text-xl font-semibold text-white border-b border-transparent hover:border-zinc-700 focus:border-violet-500 focus:outline-none py-1"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={regenerating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
              <span>{regenerating ? "Regenerating..." : "Regenerate Storyboard"}</span>
            </button>

            <button
              type="button"
              onClick={() => void onSaveDraft()}
              disabled={savingDraft || !validation.valid || !storyboard.title.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" />
              <span>
                {savingDraft
                  ? "Saving..."
                  : isAuthenticated
                    ? "Save Storyboard Draft"
                    : "Save Local Draft"}
              </span>
            </button>
          </div>
        </div>

        {/* Duration Consistency Bar */}
        <div
          className={`rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
            validation.valid
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {validation.valid ? (
              <Check className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
            )}
            <div className="space-y-0.5">
              <p className="font-medium tabular-nums">
                Scene Duration Total: {validation.actualDuration}s / Target:{" "}
                {storyboard.totalDuration}s
              </p>
              <p className="opacity-90 leading-relaxed">
                {validation.valid
                  ? "All scenes are sequential with no gaps or overlaps and match the selected target duration."
                  : validation.errors[0]}
              </p>
            </div>
          </div>

          {!validation.valid && (
            <button
              type="button"
              onClick={handleFitDurations}
              className="rounded-lg border border-rose-400/40 bg-rose-500/20 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500/30 transition-colors whitespace-nowrap shrink-0"
            >
              Match {storyboard.totalDuration}s Target
            </button>
          )}
        </div>

        {saveStatusMessage && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-300 flex items-center gap-2">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>{saveStatusMessage}</span>
          </div>
        )}

        {saveError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300 flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}

        {/* Metadata & Full Script Fields */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Video Description
            </label>
            <input
              type="text"
              maxLength={500}
              value={storyboard.description}
              onChange={(e) =>
                onChange({
                  ...storyboard,
                  description: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Background Music Mood
            </label>
            <input
              type="text"
              maxLength={120}
              value={storyboard.backgroundMusicMood}
              onChange={(e) =>
                onChange({
                  ...storyboard,
                  backgroundMusicMood: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-300">
                Full Narration Script
              </label>
              <button
                type="button"
                onClick={handleSyncScriptFromScenes}
                className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors whitespace-nowrap"
              >
                Sync from Scenes
              </button>
            </div>
            <textarea
              rows={3}
              maxLength={5000}
              value={storyboard.fullNarrationScript}
              onChange={(e) =>
                onChange({
                  ...storyboard,
                  fullNarrationScript: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-y"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-300">
                Caption Text Preview
              </label>
              <span className="text-[11px] text-zinc-500">
                Voiceover: {voiceoverLabel} · Captions: {captionLabel}
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={5000}
              value={storyboard.captionText}
              onChange={(e) =>
                onChange({
                  ...storyboard,
                  captionText: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-y"
            />
          </div>
        </div>

        {/* Honest Phase Boundary Note */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 text-xs text-zinc-400">
          <div className="flex items-center gap-2">
            <Film className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
            <span>
              Voiceover audio is not synthesized yet; saved preferences prepare Phase 5.5.2+ FFmpeg
              composition.
            </span>
          </div>
          <span className="font-mono text-[11px] text-zinc-500 whitespace-nowrap">
            Rendering locked until composition phase
          </span>
        </div>
      </div>

      {/* Scene Cards List */}
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-semibold text-white">
              Scene Breakdown ({storyboard.scenes.length})
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Edit timing, narration, captions, visual prompts, and editor-compatible transitions or
              effects.
            </p>
          </div>

          <button
            type="button"
            onClick={() => handleAddScene()}
            disabled={storyboard.scenes.length >= MAX_STORYBOARD_SCENES}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5 text-violet-400" />
            <span>Add Scene</span>
          </button>
        </div>

        <div className="space-y-4">
          {storyboard.scenes.map((scene, index) => {
            const keywordsValue =
              keywordsDraftById[scene.id] ?? scene.mediaKeywords.join(", ");

            return (
              <article
                key={scene.id}
                className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 sm:p-5 space-y-4"
              >
                {/* Scene Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
                  <div className="flex flex-wrap items-center gap-3 min-w-0 flex-1">
                    <span className="font-mono text-xs font-semibold text-violet-400 tabular-nums whitespace-nowrap">
                      Scene {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-mono text-zinc-400 tabular-nums whitespace-nowrap">
                      <Clock className="h-3 w-3 text-zinc-500" />
                      {formatClockRange(scene.startTime, scene.duration)}
                    </span>
                    <input
                      type="text"
                      aria-label={`Scene ${index + 1} title`}
                      maxLength={120}
                      value={scene.title}
                      onChange={(e) =>
                        handleScenePatch(scene.id, { title: e.target.value })
                      }
                      className="min-w-[180px] flex-1 rounded-md border border-zinc-800 bg-[#111114] px-2.5 py-1 text-xs font-medium text-white focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMoveScene(index, -1)}
                      disabled={index === 0}
                      className="rounded-md border border-zinc-800 bg-[#111114] p-1.5 text-zinc-400 hover:text-white disabled:opacity-35"
                      title="Move scene earlier"
                      aria-label={`Move Scene ${index + 1} up`}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveScene(index, 1)}
                      disabled={index === storyboard.scenes.length - 1}
                      className="rounded-md border border-zinc-800 bg-[#111114] p-1.5 text-zinc-400 hover:text-white disabled:opacity-35"
                      title="Move scene later"
                      aria-label={`Move Scene ${index + 1} down`}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAddScene(index)}
                      disabled={storyboard.scenes.length >= MAX_STORYBOARD_SCENES}
                      className="rounded-md border border-zinc-800 bg-[#111114] p-1.5 text-zinc-400 hover:text-violet-400 disabled:opacity-35"
                      title="Insert scene after"
                      aria-label={`Insert scene after Scene ${index + 1}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveScene(scene.id)}
                      disabled={storyboard.scenes.length <= 1}
                      className="rounded-md border border-zinc-800 bg-[#111114] p-1.5 text-zinc-400 hover:text-rose-400 disabled:opacity-35"
                      title="Remove scene"
                      aria-label={`Remove Scene ${index + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Numeric & Dropdown Parameters */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Duration (sec)
                    </label>
                    <input
                      type="number"
                      min={0.5}
                      max={60}
                      step={0.5}
                      aria-label={`Scene ${index + 1} duration`}
                      value={scene.duration}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (!Number.isFinite(parsed)) return;
                        handleScenePatch(scene.id, {
                          duration: Math.max(0.5, Math.min(60, parsed)),
                        });
                      }}
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Asset Type
                    </label>
                    <select
                      value={scene.mediaType}
                      onChange={(e) =>
                        handleScenePatch(scene.id, {
                          mediaType: e.target.value as StoryboardMediaType,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {STORYBOARD_MEDIA_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Transition
                    </label>
                    <select
                      value={scene.transition}
                      onChange={(e) =>
                        handleScenePatch(scene.id, {
                          transition: e.target.value as TransitionType,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {TRANSITION_OPTIONS.map((tr) => (
                        <option key={tr.value} value={tr.value}>
                          {tr.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Visual Effect
                    </label>
                    <select
                      value={scene.effect}
                      onChange={(e) =>
                        handleScenePatch(scene.id, {
                          effect: e.target.value as EffectPreset,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {EFFECT_PRESETS.map((eff) => (
                        <option key={eff.value} value={eff.value}>
                          {eff.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Camera Motion (Plan)
                    </label>
                    <select
                      value={scene.cameraMotion}
                      onChange={(e) =>
                        handleScenePatch(scene.id, {
                          cameraMotion: e.target.value as StoryboardCameraMotion,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {CAMERA_MOTION_OPTIONS.map((cam) => (
                        <option key={cam.value} value={cam.value}>
                          {cam.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Text Fields */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Scene Narration
                    </label>
                    <textarea
                      rows={2}
                      maxLength={1500}
                      aria-label={`Scene ${index + 1} narration`}
                      value={scene.narration}
                      onChange={(e) =>
                        handleScenePatch(scene.id, { narration: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Visual Description
                    </label>
                    <textarea
                      rows={2}
                      maxLength={600}
                      aria-label={`Scene ${index + 1} visual description`}
                      value={scene.visualDescription}
                      onChange={(e) =>
                        handleScenePatch(scene.id, { visualDescription: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      On-Screen Text / Caption
                    </label>
                    <input
                      type="text"
                      maxLength={220}
                      aria-label={`Scene ${index + 1} on-screen text`}
                      value={scene.onScreenText}
                      onChange={(e) =>
                        handleScenePatch(scene.id, { onScreenText: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                      Stock Media Search Keywords (comma-separated)
                    </label>
                    <input
                      type="text"
                      maxLength={320}
                      aria-label={`Scene ${index + 1} search keywords`}
                      value={keywordsValue}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setKeywordsDraftById((prev) => ({ ...prev, [scene.id]: raw }));
                        const parsed = raw
                          .split(",")
                          .map((item) => item.trim().slice(0, 60))
                          .filter(Boolean)
                          .slice(0, 8);
                        if (parsed.length > 0) {
                          handleScenePatch(scene.id, { mediaKeywords: parsed });
                        }
                      }}
                      onBlur={() => {
                        setKeywordsDraftById((prev) => {
                          const copy = { ...prev };
                          delete copy[scene.id];
                          return copy;
                        });
                      }}
                      className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
