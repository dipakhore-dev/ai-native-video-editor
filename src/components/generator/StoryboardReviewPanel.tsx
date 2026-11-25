import React, { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  ExternalLink,
  Eye,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import type { StockSearchItemDto } from "../../services/api";
import type {
  AspectRatioHandlingMode,
  EffectPreset,
  GeneratedSlideConfig,
  MediaAsset,
  StoryboardCameraMotion,
  StoryboardMediaType,
  StoryboardScene,
  TransitionType,
  VideoStoryboard,
} from "../../types/studio";
import { EFFECT_PRESETS, TRANSITION_OPTIONS } from "../../utils/effects";
import { formatTimecode } from "../../utils/media";
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
import {
  clampVideoSourceStartTime,
  computeStoryboardMediaSummary,
  evaluateSceneMediaReadiness,
} from "../../utils/storyboardMedia";
import { MediaPickerModal } from "./MediaPickerModal";
import { SlideGeneratorModal } from "./SlideGeneratorModal";
import { StoryboardMediaPrepSection } from "./StoryboardMediaPrepSection";

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
  mediaAssets?: MediaAsset[];
  idbHydrating?: boolean;
  mediaPrepActive?: boolean;
  mediaPrepStatusMessage?: string | null;
  onAutoMatchMedia?: (options: { overwriteManual: boolean }) => void;
  onUploadBatchMedia?: (files: FileList) => Promise<void> | void;
  onUploadSceneFile?: (files: FileList, sceneId: string) => Promise<void> | void;
  onSelectLibraryAsset?: (asset: MediaAsset, sceneId: string) => void;
  onImportStockResult?: (
    item: StockSearchItemDto,
    sceneId: string,
    signal: AbortSignal
  ) => Promise<{ ok: boolean; error?: string }>;
  onGenerateAndAssignSlide?: (result: {
    file: File;
    config: GeneratedSlideConfig;
    sceneId: string;
  }) => Promise<void> | void;
  onRelinkMissingSceneMedia?: (
    assetId: string,
    file: File,
    sceneId: string
  ) => Promise<void> | void;
  onCancelMediaPrep?: () => void;
}

function formatClockRange(start: number, duration: number): string {
  const end = Number((start + duration).toFixed(2));
  return `${start.toFixed(1)}s – ${end.toFixed(1)}s`;
}

function isSafeHttpsUrl(raw?: string): raw is string {
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

function formatSourceOriginLabel(
  mediaSource: NonNullable<StoryboardScene["mediaAssignment"]>["mediaSource"],
  providerName?: string
): string {
  if (mediaSource === "generated_slide") return "Generated Slide";
  if (mediaSource === "stock") return `Stock (${providerName || "Pexels"})`;
  if (mediaSource === "uploaded") return "Uploaded";
  return "Library";
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
  mediaAssets = [],
  idbHydrating = false,
  mediaPrepActive = false,
  mediaPrepStatusMessage = null,
  onAutoMatchMedia,
  onUploadBatchMedia,
  onUploadSceneFile,
  onSelectLibraryAsset,
  onImportStockResult,
  onGenerateAndAssignSlide,
  onRelinkMissingSceneMedia,
  onCancelMediaPrep,
}: StoryboardReviewPanelProps) {
  const [keywordsDraftById, setKeywordsDraftById] = useState<Record<string, string>>({});
  const [overwriteManual, setOverwriteManual] = useState(false);

  const [pickerState, setPickerState] = useState<{
    open: boolean;
    sceneId: string | null;
    initialTab: "library" | "stock";
  }>({ open: false, sceneId: null, initialTab: "library" });

  const [slideModalSceneId, setSlideModalSceneId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{
    scene: StoryboardScene;
    asset: MediaAsset;
  } | null>(null);

  const sceneFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSceneUploadRef = useRef<{
    sceneId: string;
    mode: "upload" | "relink";
    assetId?: string;
  } | null>(null);

  const validation = useMemo(
    () =>
      validateStoryboardInvariants({
        totalDuration: storyboard.totalDuration,
        scenes: storyboard.scenes,
      }),
    [storyboard.scenes, storyboard.totalDuration]
  );

  const assetsById = useMemo(
    () => new Map(mediaAssets.map((asset) => [asset.id, asset])),
    [mediaAssets]
  );

  const mediaSummary = useMemo(
    () => computeStoryboardMediaSummary(storyboard, mediaAssets, !idbHydrating),
    [storyboard, mediaAssets, idbHydrating]
  );

  const pickerScene = useMemo(
    () => storyboard.scenes.find((s) => s.id === pickerState.sceneId) ?? null,
    [storyboard.scenes, pickerState.sceneId]
  );

  const slideModalScene = useMemo(
    () => storyboard.scenes.find((s) => s.id === slideModalSceneId) ?? null,
    [storyboard.scenes, slideModalSceneId]
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
      mediaReadinessSummary: computeStoryboardMediaSummary(
        { ...storyboard, scenes: timed },
        mediaAssets,
        !idbHydrating
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleScenePatch = (sceneId: string, patch: Partial<StoryboardScene>) => {
    const updated = storyboard.scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, ...patch } : scene
    );
    commitScenes(updated);
  };

  const handleClearSceneAssignment = (sceneId: string) => {
    handleScenePatch(sceneId, { mediaAssignment: undefined });
  };

  const handleClearAllAssignments = () => {
    const updated = storyboard.scenes.map((scene) => ({
      ...scene,
      mediaAssignment: undefined,
    }));
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

  const triggerSingleSceneFileUpload = (
    sceneId: string,
    mode: "upload" | "relink",
    assetId?: string
  ) => {
    pendingSceneUploadRef.current = { sceneId, mode, assetId };
    sceneFileInputRef.current?.click();
  };

  const openFirstUnassignedLibrary = () => {
    const firstNeedsMedia =
      storyboard.scenes.find((scene) => {
        const evalRes = evaluateSceneMediaReadiness(scene, storyboard, assetsById, !idbHydrating);
        return !evalRes.isReady;
      }) ?? storyboard.scenes[0];

    if (firstNeedsMedia) {
      setPickerState({
        open: true,
        sceneId: firstNeedsMedia.id,
        initialTab: "library",
      });
    }
  };

  return (
    <section
      aria-label="Editable Storyboard Review"
      className="rounded-2xl border border-zinc-800/80 bg-[#111114] divide-y divide-zinc-800/80"
    >
      <input
        ref={sceneFileInputRef}
        type="file"
        multiple={false}
        accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          const target = pendingSceneUploadRef.current;
          pendingSceneUploadRef.current = null;
          if (files && files.length > 0 && target) {
            if (target.mode === "relink" && target.assetId && onRelinkMissingSceneMedia) {
              void onRelinkMissingSceneMedia(target.assetId, files[0], target.sceneId);
            } else if (onUploadSceneFile) {
              void onUploadSceneFile(files, target.sceneId);
            }
          }
          e.target.value = "";
        }}
      />

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

        {/* Phase 5.5.2 Media Preparation Bar */}
        <StoryboardMediaPrepSection
          summary={mediaSummary}
          mediaPrepActive={mediaPrepActive}
          overwriteManual={overwriteManual}
          onToggleOverwriteManual={setOverwriteManual}
          onAutoMatch={() => onAutoMatchMedia?.({ overwriteManual })}
          onUploadBatch={(files) => onUploadBatchMedia?.(files)}
          onOpenLibraryForFirstUnassigned={openFirstUnassignedLibrary}
          onClearAllAssignments={handleClearAllAssignments}
          onCancelPrep={() => onCancelMediaPrep?.()}
          statusMessage={mediaPrepStatusMessage}
        />

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
              Phase 5.5.2 matches and validates local visual media for scenes. Voiceover synthesis,
              captions, and FFmpeg MP4 composition arrive in Phase 5.5.3.
            </span>
          </div>
          <span className="font-mono text-[11px] text-zinc-500 whitespace-nowrap">
            Composition locked until Phase 5.5.3
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
              Edit timing, narration, captions, visual media assignments, and editor-compatible
              transitions or effects.
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
            const readiness = evaluateSceneMediaReadiness(
              scene,
              storyboard,
              assetsById,
              !idbHydrating
            );
            const assignment = scene.mediaAssignment;
            const assignedAsset = readiness.asset;
            const thumbSrc = assignedAsset?.thumbnailUrl || (assignedAsset?.kind === "image" ? assignedAsset.objectUrl : undefined);

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

                {/* Scene Visual Media Assignment Slot (Lightweight Thumbnails Only) */}
                <div className="rounded-lg border border-zinc-800/90 bg-[#111114] p-3.5 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3.5">
                    {/* Lightweight Preview Thumbnail (never mounts <video> in scene list) */}
                    <div className="w-full sm:w-36 h-20 rounded-md border border-zinc-800 bg-black overflow-hidden shrink-0 flex items-center justify-center relative">
                      {thumbSrc ? (
                        <img
                          src={thumbSrc}
                          alt={assignment?.assetTitle || scene.title}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : readiness.isMissing || readiness.isInvalid ? (
                        <AlertTriangle className="h-5 w-5 text-rose-400" />
                      ) : scene.mediaType === "image" || scene.mediaType === "text_card" ? (
                        <ImageIcon className="h-5 w-5 text-zinc-600" />
                      ) : (
                        <Film className="h-5 w-5 text-zinc-600" />
                      )}
                      {assignment && (
                        <span className="absolute bottom-1 left-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200 uppercase">
                          {assignment.mediaType === "generated_slide"
                            ? "SLIDE"
                            : assignment.mediaType}
                        </span>
                      )}
                    </div>

                    {/* Assignment Status & Metadata */}
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span
                            className={`text-[11px] font-mono font-medium uppercase ${
                              readiness.status === "assigned"
                                ? "text-emerald-400"
                                : readiness.status === "missing" ||
                                    readiness.status === "invalid" ||
                                    readiness.status === "failed"
                                  ? "text-rose-400"
                                  : readiness.status === "matching"
                                    ? "text-violet-400"
                                    : "text-amber-400"
                            }`}
                          >
                            {readiness.status === "assigned"
                              ? "Assigned"
                              : readiness.status === "missing"
                                ? "Missing in IndexedDB"
                                : readiness.status === "invalid"
                                  ? "Invalid Media"
                                  : readiness.status === "matching"
                                    ? "Restoring..."
                                    : readiness.status === "failed"
                                      ? "Import Failed"
                                      : "Unassigned"}
                          </span>

                          {assignment && (
                            <>
                              <span className="text-zinc-600">·</span>
                              <span className="text-[11px] text-zinc-400">
                                {formatSourceOriginLabel(
                                  assignment.mediaSource,
                                  assignment.providerName
                                )}
                              </span>
                            </>
                          )}

                          {assignment?.matchScore !== undefined && (
                            <>
                              <span className="text-zinc-600">·</span>
                              <span className="font-mono text-[11px] text-violet-400 tabular-nums">
                                {assignment.matchScore}% match
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {assignment ? (
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-white truncate">
                            {assignment.assetTitle}
                          </p>
                          <p className="text-[11px] font-mono text-zinc-400 tabular-nums">
                            {assignedAsset?.width && assignedAsset?.height
                              ? `${assignedAsset.width}×${assignedAsset.height}`
                              : assignment.width && assignment.height
                                ? `${assignment.width}×${assignment.height}`
                                : "Dimensions pending"}
                            {assignedAsset?.kind === "video"
                              ? ` · Source ${formatTimecode(assignedAsset.duration)}`
                              : ""}
                          </p>
                          {assignment.matchExplanation && (
                            <p className="text-[11px] text-zinc-400 leading-snug">
                              {assignment.matchExplanation}
                            </p>
                          )}
                          {assignment.mediaSource === "stock" &&
                            isSafeHttpsUrl(assignment.attributionUrl) && (
                              <a
                                href={assignment.attributionUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200 underline"
                              >
                                <span>
                                  {assignment.mediaType === "video" ? "Video" : "Photo"} by{" "}
                                  {assignment.creatorName || "Contributor"} on Pexels
                                </span>
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                        </div>
                      ) : (
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          No visual asset assigned yet. Pick from IndexedDB Library, import free
                          Pexels stock media, upload a local file, or render a PNG text slide.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Per-Scene Framing & Trim Controls (when assigned) */}
                  {assignment && readiness.isReady && (
                    <div className="pt-2.5 border-t border-zinc-800/80 flex flex-wrap items-center gap-3 text-[11px]">
                      <label className="inline-flex items-center gap-1.5 text-zinc-300">
                        <span className="text-zinc-400">Framing:</span>
                        <select
                          aria-label={`Scene ${index + 1} aspect ratio framing`}
                          value={assignment.aspectRatioHandling}
                          onChange={(e) =>
                            handleScenePatch(scene.id, {
                              mediaAssignment: {
                                ...assignment,
                                aspectRatioHandling: e.target.value as AspectRatioHandlingMode,
                              },
                            })
                          }
                          className="rounded border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
                        >
                          <option value="fit">Fit (Preserve Frame)</option>
                          <option value="fill">Fill (Crop to {storyboard.aspectRatio})</option>
                          <option value="preserve">Preserve Source</option>
                        </select>
                      </label>

                      {assignedAsset?.kind === "video" && (
                        <label className="inline-flex items-center gap-1.5 text-zinc-300">
                          <span className="text-zinc-400">Clip Start (s):</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, readiness.maxSourceStartTime)}
                            step={0.1}
                            aria-label={`Scene ${index + 1} source start time`}
                            value={assignment.sourceStartTime}
                            onChange={(e) => {
                              const parsed = Number(e.target.value);
                              if (!Number.isFinite(parsed)) return;
                              const clamped = clampVideoSourceStartTime(
                                parsed,
                                scene.duration,
                                assignedAsset.duration
                              );
                              handleScenePatch(scene.id, {
                                mediaAssignment: {
                                  ...assignment,
                                  sourceStartTime: clamped,
                                },
                              });
                            }}
                            className="w-20 rounded border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                          />
                        </label>
                      )}

                      {readiness.shorterThanScene &&
                        assignedAsset?.kind === "video" &&
                        assignedAsset.duration >= 0.5 && (
                          <button
                            type="button"
                            onClick={() =>
                              handleScenePatch(scene.id, {
                                duration: Number(
                                  Math.max(0.5, Math.min(60, assignedAsset.duration)).toFixed(2)
                                ),
                                mediaAssignment: {
                                  ...assignment,
                                  sourceStartTime: 0,
                                },
                              })
                            }
                            className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20"
                          >
                            Match Scene Duration ({assignedAsset.duration.toFixed(1)}s)
                          </button>
                        )}
                    </div>
                  )}

                  {/* Warnings */}
                  {readiness.warnings.length > 0 && (
                    <div
                      className={`rounded-md border px-3 py-2 text-[11px] space-y-0.5 ${
                        readiness.isMissing || readiness.isInvalid
                          ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      }`}
                    >
                      {readiness.warnings.map((w, wIdx) => (
                        <p key={wIdx}>{w}</p>
                      ))}
                    </div>
                  )}

                  {/* Scene Media Action Buttons */}
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {readiness.isMissing && assignment && onRelinkMissingSceneMedia && (
                      <button
                        type="button"
                        onClick={() =>
                          triggerSingleSceneFileUpload(
                            scene.id,
                            "relink",
                            assignment.mediaAssetId
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-md bg-rose-600 hover:bg-rose-500 px-2.5 py-1 text-[11px] font-medium text-white"
                      >
                        <Upload className="h-3 w-3" />
                        <span>Re-link File</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        setPickerState({ open: true, sceneId: scene.id, initialTab: "library" })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    >
                      <FolderOpen className="h-3 w-3 text-emerald-400" />
                      <span>{assignment ? "Replace From Library" : "Choose Library"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setPickerState({ open: true, sceneId: scene.id, initialTab: "stock" })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    >
                      <Search className="h-3 w-3 text-violet-400" />
                      <span>Free Stock</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => triggerSingleSceneFileUpload(scene.id, "upload")}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    >
                      <Upload className="h-3 w-3 text-blue-400" />
                      <span>Upload File</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSlideModalSceneId(scene.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    >
                      <Type className="h-3 w-3 text-amber-400" />
                      <span>Generate Slide</span>
                    </button>

                    {readiness.isReady && assignedAsset && (
                      <button
                        type="button"
                        onClick={() => setPreviewTarget({ scene, asset: assignedAsset })}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                      >
                        <Eye className="h-3 w-3 text-zinc-300" />
                        <span>Preview</span>
                      </button>
                    )}

                    {assignment && (
                      <button
                        type="button"
                        onClick={() => handleClearSceneAssignment(scene.id)}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:border-rose-500/40"
                        title="Remove scene assignment without deleting file from IndexedDB"
                      >
                        <X className="h-3 w-3" />
                        <span>Clear Slot</span>
                      </button>
                    )}
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

      {/* Library & Stock Picker Modal */}
      <MediaPickerModal
        open={pickerState.open}
        initialTab={pickerState.initialTab}
        scene={pickerScene}
        aspectRatio={storyboard.aspectRatio}
        mediaAssets={mediaAssets}
        isAuthenticated={isAuthenticated}
        onClose={() => setPickerState({ open: false, sceneId: null, initialTab: "library" })}
        onSelectLibraryAsset={(asset, sceneId) => onSelectLibraryAsset?.(asset, sceneId)}
        onUploadFilesForScene={async (files, sceneId) => {
          await onUploadSceneFile?.(files, sceneId);
        }}
        onImportStockResult={async (item, sceneId, signal) => {
          if (!onImportStockResult) {
            return { ok: false, error: "Stock media import handler is unavailable." };
          }
          return onImportStockResult(item, sceneId, signal);
        }}
      />

      {/* Local HTML5 Canvas Text Slide Generator Modal */}
      <SlideGeneratorModal
        open={Boolean(slideModalScene)}
        scene={slideModalScene}
        aspectRatio={storyboard.aspectRatio}
        language={storyboard.language}
        onClose={() => setSlideModalSceneId(null)}
        onGenerateAndAssign={async (result) => {
          await onGenerateAndAssignSlide?.(result);
        }}
      />

      {/* On-Demand Single-Asset Media Preview Modal */}
      {previewTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Scene Assigned Media Preview"
        >
          <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-[#111114] overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {previewTarget.scene.title} — {previewTarget.asset.name}
                </p>
                <p className="text-[11px] font-mono text-zinc-400 tabular-nums">
                  {previewTarget.asset.kind.toUpperCase()}
                  {previewTarget.asset.width && previewTarget.asset.height
                    ? ` · ${previewTarget.asset.width}×${previewTarget.asset.height}`
                    : ""}
                  {previewTarget.asset.kind === "video"
                    ? ` · ${formatTimecode(previewTarget.asset.duration)}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTarget(null)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                aria-label="Close media preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="bg-black flex items-center justify-center min-h-[280px] max-h-[65vh] p-4">
              {previewTarget.asset.kind === "video" ? (
                <video
                  src={previewTarget.asset.objectUrl}
                  controls
                  autoPlay
                  className="max-h-[58vh] w-full rounded-lg"
                />
              ) : (
                <img
                  src={previewTarget.asset.objectUrl}
                  alt={previewTarget.asset.name}
                  className="max-h-[58vh] max-w-full object-contain rounded-lg"
                />
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
              <div className="min-w-0">
                {previewTarget.asset.creatorName && (
                  <span>
                    Creator: {previewTarget.asset.creatorName}
                    {previewTarget.asset.licenseInfo ? ` · ${previewTarget.asset.licenseInfo}` : ""}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewTarget(null)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-zinc-200 hover:text-white"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
