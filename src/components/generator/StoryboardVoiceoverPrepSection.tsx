import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Mic,
  RefreshCw,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import type {
  StoryboardVoiceoverSettings,
  StoryboardVoiceoverSummary,
  TtsStatusInfo,
  TtsVoiceOption,
  VideoStoryboard,
} from "../../types/studio";
import {
  DEFAULT_VOICEOVER_SETTINGS,
  formatTtsLanguageLabel,
  normalizeTtsLanguage,
} from "../../utils/storyboardVoiceover";
import { VoiceSelector } from "./VoiceSelector";

interface StoryboardVoiceoverPrepSectionProps {
  storyboard: VideoStoryboard;
  summary: StoryboardVoiceoverSummary;
  ttsStatus: TtsStatusInfo | null;
  ttsLoading: boolean;
  ttsError: string | null;
  voices: TtsVoiceOption[];
  isAuthenticated: boolean;
  batchState: {
    active: boolean;
    currentSceneId: string | null;
    completedCount: number;
    totalCount: number;
    statusMessage: string | null;
  };
  onRefreshTts: () => void;
  onChangeGlobalSettings: (next: StoryboardVoiceoverSettings) => void;
  onGenerateMissingOrStale: () => void;
  onRegenerateAll: () => void;
  onCancelBatch: () => void;
  onClearAllVoiceovers: () => void;
}

export function StoryboardVoiceoverPrepSection({
  storyboard,
  summary,
  ttsStatus,
  ttsLoading,
  ttsError,
  voices,
  isAuthenticated,
  batchState,
  onRefreshTts,
  onChangeGlobalSettings,
  onGenerateMissingOrStale,
  onRegenerateAll,
  onCancelBatch,
  onClearAllVoiceovers,
}: StoryboardVoiceoverPrepSectionProps) {
  const languageCode = normalizeTtsLanguage(storyboard.language);
  const globalSettings = storyboard.voiceoverSettings ?? DEFAULT_VOICEOVER_SETTINGS;

  const matchingLangVoices = voices.filter(
    (v) =>
      v.language === languageCode &&
      (globalSettings.provider === "auto" ||
        globalSettings.provider === "none" ||
        v.provider === globalSettings.provider)
  );
  const ttsAvailable = Boolean(ttsStatus?.available);
  const canSynthesize =
    isAuthenticated && ttsAvailable && matchingLangVoices.length > 0 && !batchState.active;

  const missingOrStaleNeedWork =
    summary.unassignedCount + summary.staleCount + summary.missingCount + summary.failedCount;

  const batchProgressPercent =
    batchState.active && batchState.totalCount > 0
      ? Math.round((batchState.completedCount / batchState.totalCount) * 100)
      : summary.progressPercent;

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3.5">
      {/* Header & Batch Action Buttons */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {summary.isVoiceoverReady ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <Mic
                className={`h-4 w-4 shrink-0 ${
                  summary.failedCount > 0 || summary.missingCount > 0
                    ? "text-rose-400"
                    : "text-violet-400"
                }`}
              />
            )}
            <h3 className="text-xs font-semibold text-white">
              Storyboard Voiceover Generation (Phase 5.5.3 · Offline TTS)
            </h3>
            <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
              {summary.readyCount}/{summary.spokenScenes} Spoken Scenes Ready ({summary.progressPercent}%)
            </span>
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {summary.spokenScenes === 0
              ? "No scene currently has narration text."
              : summary.isVoiceoverReady
                ? `All ${summary.spokenScenes} spoken scene(s) have verified local voiceover audio stored in IndexedDB (${summary.totalAudioDurationSec.toFixed(1)}s total speech).`
                : "Synthesize free local voiceovers per scene using Piper ONNX or eSpeak NG. Audio files persist locally in IndexedDB."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!batchState.active ? (
            <>
              <button
                type="button"
                disabled={!canSynthesize || missingOrStaleNeedWork === 0}
                onClick={onGenerateMissingOrStale}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <Volume2 className="h-3.5 w-3.5" />
                <span>
                  {missingOrStaleNeedWork > 0
                    ? `Generate Missing / Stale (${missingOrStaleNeedWork})`
                    : "All Voiceovers Up to Date"}
                </span>
              </button>

              <button
                type="button"
                disabled={!canSynthesize || summary.spokenScenes === 0}
                onClick={onRegenerateAll}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <RefreshCw className="h-3.5 w-3.5 text-blue-400" />
                <span>Regenerate All</span>
              </button>

              {summary.readyCount + summary.staleCount + summary.missingCount + summary.failedCount >
                0 && (
                <button
                  type="button"
                  onClick={onClearAllVoiceovers}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-400 hover:text-rose-300 hover:border-rose-500/40 transition-colors"
                  title="Detach voiceover audio links from scenes without deleting files from IndexedDB"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear Voiceovers</span>
                </button>
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

      {/* Honest TTS Engine Status Notice */}
      {!isAuthenticated ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>
            Sign in to synthesize local voiceovers via <code className="font-mono">/api/tts/generate</code>.
          </span>
        </div>
      ) : ttsLoading && !ttsStatus ? (
        <p className="text-[11px] text-zinc-400">
          Checking local Python TTS providers (Piper ONNX / eSpeak NG)...
        </p>
      ) : ttsError || !ttsAvailable ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" />
            <div className="space-y-0.5">
              <p className="font-medium">Local TTS Engine Unavailable</p>
              <p className="opacity-90">
                {ttsError ||
                  ttsStatus?.message ||
                  "Install eSpeak NG or Piper TTS inside the Python video-processor environment to synthesize offline voiceovers."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefreshTts}
            className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40 whitespace-nowrap shrink-0"
          >
            Re-check Engine
          </button>
        </div>
      ) : null}

      {/* Global Voiceover Controls */}
      <VoiceSelector
        language={languageCode}
        ttsStatus={ttsStatus}
        voices={voices}
        provider={globalSettings.provider}
        voiceId={globalSettings.voiceId}
        speakingRate={globalSettings.speakingRate}
        pitch={globalSettings.pitch}
        format={globalSettings.format}
        volume={globalSettings.volume}
        disabled={batchState.active}
        onChange={(patch) =>
          onChangeGlobalSettings({
            ...globalSettings,
            ...patch,
          })
        }
      />

      {/* Progress & Metrics */}
      <div className="space-y-2 pt-1">
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ${
              batchState.active
                ? "bg-blue-500"
                : summary.failedCount > 0 || summary.missingCount > 0
                  ? "bg-rose-500"
                  : summary.isVoiceoverReady
                    ? "bg-emerald-500"
                    : "bg-violet-500"
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
            <span>Ready: {summary.readyCount}</span>
            <span>Stale: {summary.staleCount}</span>
            <span>Unassigned: {summary.unassignedCount}</span>
            {summary.overflowCount > 0 && (
              <span className="text-amber-400">Overflows: {summary.overflowCount}</span>
            )}
            <span>Total Speech: {summary.totalAudioDurationSec.toFixed(1)}s</span>
            <span>
              Engine: {ttsStatus?.activeProvider ? `${ttsStatus.activeProvider} (${formatTtsLanguageLabel(languageCode)})` : "Unavailable"}
            </span>
          </div>
          <span className="font-mono text-zinc-500 tabular-nums">
            Composition Ready: No (Phase 5.5.4+)
          </span>
        </div>

        {batchState.statusMessage && (
          <p className="text-[11px] text-violet-300">{batchState.statusMessage}</p>
        )}
      </div>
    </div>
  );
}
