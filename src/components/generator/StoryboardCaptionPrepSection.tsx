import React, { useState } from "react";
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Download,
  Palette,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  CaptionsStatusInfo,
  CaptionGenerationMode,
  StoryboardCaptionSettings,
  StoryboardCaptionSummary,
  TtsLanguageCode,
  VideoStoryboard,
} from "../../types/studio";
import {
  exportStoryboardCaptionsToSrt,
  exportStoryboardCaptionsToVtt,
  getDefaultCaptionSettings,
} from "../../utils/storyboardCaptions";
import { buildSubtitleFilenameSlug } from "../../utils/subtitles";
import { CaptionStyleInspector } from "./CaptionStyleInspector";

interface StoryboardCaptionPrepSectionProps {
  storyboard: VideoStoryboard;
  summary: StoryboardCaptionSummary;
  captionsStatus: CaptionsStatusInfo | null;
  captionsLoading: boolean;
  captionsError: string | null;
  isAuthenticated: boolean;
  readyVoiceoverCount: number;
  batchState: {
    active: boolean;
    mode: CaptionGenerationMode;
    currentSceneId: string | null;
    completedCount: number;
    totalCount: number;
    statusMessage: string | null;
  };
  onRefreshCaptionsStatus: () => void;
  onChangeCaptionSettings: (next: StoryboardCaptionSettings) => void;
  onGenerateMissingOrStale: (mode: CaptionGenerationMode) => void;
  onRegenerateAll: (mode: CaptionGenerationMode) => void;
  onCancelBatch: () => void;
  onClearAllCaptions: () => void;
}

function downloadStoryboardSubtitles(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StoryboardCaptionPrepSection({
  storyboard,
  summary,
  captionsStatus,
  captionsLoading,
  captionsError,
  isAuthenticated,
  readyVoiceoverCount,
  batchState,
  onRefreshCaptionsStatus,
  onChangeCaptionSettings,
  onGenerateMissingOrStale,
  onRegenerateAll,
  onCancelBatch,
  onClearAllCaptions,
}: StoryboardCaptionPrepSectionProps) {
  const [showStyleInspector, setShowStyleInspector] = useState(false);
  const [confirmRegenerateAll, setConfirmRegenerateAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const settings = storyboard.captionSettings ?? getDefaultCaptionSettings(storyboard);
  const activeMode = settings.defaultMode;
  const audioAvailable = Boolean(captionsStatus?.audioTranscriptionAvailable);
  const canRunAudioMode = isAuthenticated && audioAvailable && readyVoiceoverCount > 0;

  const missingOrStaleNeedWork =
    summary.unassignedCount + summary.staleCount + summary.failedCount;

  const batchProgressPercent =
    batchState.active && batchState.totalCount > 0
      ? Math.round((batchState.completedCount / batchState.totalCount) * 100)
      : summary.progressPercent;

  const slug = buildSubtitleFilenameSlug(storyboard.title || "storyboard");

  const handleRegenerateClick = () => {
    if (summary.manualCount > 0) {
      setConfirmRegenerateAll(true);
      return;
    }
    onRegenerateAll(activeMode);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3.5">
      {/* Header & Batch Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {summary.isCaptionsReady ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <Captions
                className={`h-4 w-4 shrink-0 ${
                  summary.failedCount > 0 ? "text-rose-400" : "text-blue-400"
                }`}
              />
            )}
            <h3 className="text-xs font-semibold text-white">
              Storyboard Captions &amp; Subtitle Editor (Phase 5.5.4)
            </h3>
            <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
              {summary.readyCount}/{summary.captionableScenes} Scenes Ready ({summary.progressPercent}%)
            </span>
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {summary.captionableScenes === 0
              ? "No scene currently has narration text."
              : "Generate instant script-estimated captions locally at ₹0 cost, or transcribe generated voiceover audio via local faster-whisper."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!batchState.active ? (
            <>
              <button
                type="button"
                disabled={
                  !settings.enabled ||
                  missingOrStaleNeedWork === 0 ||
                  (activeMode === "audio" && !canRunAudioMode)
                }
                onClick={() => onGenerateMissingOrStale(activeMode)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {missingOrStaleNeedWork > 0
                    ? `Generate Missing / Stale (${missingOrStaleNeedWork})`
                    : "All Captions Up to Date"}
                </span>
              </button>

              <button
                type="button"
                disabled={
                  !settings.enabled ||
                  summary.captionableScenes === 0 ||
                  (activeMode === "audio" && !canRunAudioMode)
                }
                onClick={handleRegenerateClick}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <RefreshCw className="h-3.5 w-3.5 text-violet-400" />
                <span>Regenerate All</span>
              </button>

              <button
                type="button"
                onClick={() => setShowStyleInspector((prev) => !prev)}
                aria-expanded={showStyleInspector}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  showStyleInspector
                    ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white"
                }`}
              >
                <Palette className="h-3.5 w-3.5 text-violet-400" />
                <span>Style Presets</span>
              </button>

              {summary.totalCueCount > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      downloadStoryboardSubtitles(
                        `${slug}.srt`,
                        "application/x-subrip;charset=utf-8",
                        exportStoryboardCaptionsToSrt(storyboard)
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    title="Export full storyboard SRT across sequential scenes"
                  >
                    <Download className="h-3.5 w-3.5 text-emerald-400" />
                    <span>.SRT</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      downloadStoryboardSubtitles(
                        `${slug}.vtt`,
                        "text/vtt;charset=utf-8",
                        exportStoryboardCaptionsToVtt(storyboard)
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white"
                    title="Export full storyboard WebVTT across sequential scenes"
                  >
                    <Download className="h-3.5 w-3.5 text-emerald-400" />
                    <span>.VTT</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfirmClearAll(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-400 hover:text-rose-300 hover:border-rose-500/40"
                    title="Remove generated captions across all scenes"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear</span>
                  </button>
                </>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={onCancelBatch}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/25"
            >
              <X className="h-3.5 w-3.5" />
              <span>
                Cancel Batch ({batchState.completedCount}/{batchState.totalCount})
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Confirmation Dialogs */}
      {confirmRegenerateAll && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <span>
            {summary.manualCount} scene(s) have manually edited captions. Regenerating all scenes
            will overwrite those manual cue edits.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmRegenerateAll(false);
                onRegenerateAll(activeMode);
              }}
              className="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-amber-400"
            >
              Confirm Overwrite All
            </button>
            <button
              type="button"
              onClick={() => setConfirmRegenerateAll(false)}
              className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmClearAll && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200 flex flex-wrap items-center justify-between gap-2">
          <span>Clear all caption cues across all scenes in this storyboard?</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmClearAll(false);
                onClearAllCaptions();
              }}
              className="rounded bg-rose-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-rose-500"
            >
              Confirm Clear All
            </button>
            <button
              type="button"
              onClick={() => setConfirmClearAll(false)}
              className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mode, Language & Options Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-[11px]">
        <label className="space-y-1">
          <span className="block text-zinc-400">Default Caption Mode</span>
          <select
            aria-label="Default caption generation mode"
            disabled={batchState.active}
            value={activeMode}
            onChange={(e) =>
              onChangeCaptionSettings({
                ...settings,
                defaultMode: e.target.value as CaptionGenerationMode,
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
          >
            <option value="script">Script Timing (Instant · Estimated)</option>
            <option value="audio">Audio Transcription (faster-whisper CPU)</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-zinc-400">Caption Language</span>
          <select
            aria-label="Caption language override"
            disabled={batchState.active}
            value={settings.language}
            onChange={(e) =>
              onChangeCaptionSettings({
                ...settings,
                language: e.target.value as "match_storyboard" | TtsLanguageCode,
              })
            }
            className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
          >
            <option value="match_storyboard">Match Storyboard ({storyboard.language})</option>
            <option value="en">English (en)</option>
            <option value="hi">Hindi (hi)</option>
            <option value="bn">Bengali (bn)</option>
          </select>
        </label>

        <div className="flex flex-col justify-end gap-1.5 pb-1">
          <label className="inline-flex items-center gap-2 text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) =>
                onChangeCaptionSettings({
                  ...settings,
                  enabled: e.target.checked,
                  style: { ...settings.style, enabled: e.target.checked },
                })
              }
              className="accent-violet-500"
            />
            <span>Captions Enabled in Preview</span>
          </label>
        </div>

        <div className="flex flex-col justify-end gap-1.5 pb-1">
          <label className="inline-flex items-center gap-2 text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              disabled={batchState.active}
              checked={settings.wordTimestamps}
              onChange={(e) =>
                onChangeCaptionSettings({
                  ...settings,
                  wordTimestamps: e.target.checked,
                })
              }
              className="accent-violet-500"
            />
            <span>Whisper Word Timestamps</span>
          </label>
        </div>
      </div>

      {/* Honest Audio Transcription Notice when audio mode selected or unavailable */}
      {activeMode === "audio" && (
        <>
          {!isAuthenticated ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>
                Sign in to transcribe scene audio via{" "}
                <code className="font-mono">/api/captions/from-audio</code>. Script Timing remains
                available locally without signing in.
              </span>
            </div>
          ) : captionsLoading && !captionsStatus ? (
            <p className="text-[11px] text-zinc-400">
              Checking local Python faster-whisper cache and CPU readiness...
            </p>
          ) : captionsError || !audioAvailable ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" />
                <div className="space-y-0.5">
                  <p className="font-medium">Audio Transcription Unavailable Offline</p>
                  <p className="opacity-90">
                    {captionsError ||
                      captionsStatus?.message ||
                      "Start local video-processor with faster-whisper and cache the Whisper model, or switch to Script Timing."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onRefreshCaptionsStatus}
                className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40 whitespace-nowrap shrink-0"
              >
                Re-check Whisper
              </button>
            </div>
          ) : readyVoiceoverCount === 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>
                No ready voiceover audio exists in IndexedDB yet. Generate voiceovers above first,
                or switch to Script Timing.
              </span>
            </div>
          ) : null}
        </>
      )}

      {/* Collapsible Style Inspector */}
      {showStyleInspector && (
        <CaptionStyleInspector
          style={settings.style}
          language={storyboard.language}
          onChange={(nextStyle) =>
            onChangeCaptionSettings({
              ...settings,
              enabled: nextStyle.enabled,
              style: nextStyle,
            })
          }
        />
      )}

      {/* Progress & Metrics */}
      <div className="space-y-2 pt-1">
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ${
              batchState.active
                ? "bg-blue-500"
                : summary.failedCount > 0
                  ? "bg-rose-500"
                  : summary.isCaptionsReady
                    ? "bg-emerald-500"
                    : "bg-blue-500"
            }`}
            style={{
              width: `${Math.max(
                batchProgressPercent,
                summary.readyCount > 0 || batchState.active ? 4 : 0
              )}%`,
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-3 font-mono text-zinc-400 tabular-nums">
            <span>Cues: {summary.totalCueCount}</span>
            <span>Estimated: {summary.estimatedCount}</span>
            <span>Whisper Audio: {summary.transcribedCount}</span>
            <span>Manual Edits: {summary.manualCount}</span>
            {summary.overflowCount > 0 && (
              <span className="text-amber-400">Overflows: {summary.overflowCount}</span>
            )}
          </div>
          <span className="font-mono text-zinc-500 tabular-nums">
            Composition Ready: No (Phase 5.5.5)
          </span>
        </div>

        {batchState.statusMessage && (
          <p className="text-[11px] text-blue-300">{batchState.statusMessage}</p>
        )}
      </div>
    </div>
  );
}
