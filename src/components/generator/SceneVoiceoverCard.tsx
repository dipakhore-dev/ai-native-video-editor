import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Mic,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type {
  StoryboardScene,
  StoryboardVoiceoverSettings,
  TtsStatusInfo,
  TtsVoiceOption,
  VideoStoryboard,
} from "../../types/studio";
import { formatBytes } from "../../utils/media";
import {
  evaluateSceneVoiceoverReadiness,
  formatTtsLanguageLabel,
  resolveEffectiveSceneVoiceParams,
  type SceneVoiceoverEvaluation,
} from "../../utils/storyboardVoiceover";
import { VoiceoverAudioPreview } from "./VoiceoverAudioPreview";
import { VoiceSelector } from "./VoiceSelector";

interface SceneVoiceoverCardProps {
  scene: StoryboardScene;
  sceneIndex: number;
  storyboard: VideoStoryboard;
  evaluation: SceneVoiceoverEvaluation;
  ttsStatus: TtsStatusInfo | null;
  voices: TtsVoiceOption[];
  ttsReadyForLang: boolean;
  isAuthenticated: boolean;
  activeGenerating: boolean;
  batchActive: boolean;
  activeAudioSceneId: string | null;
  onActivateSceneAudio: (sceneId: string | null) => void;
  onGenerateScene: (
    sceneId: string,
    overrideParams?: Partial<StoryboardVoiceoverSettings>
  ) => void;
  onCancelScene: (sceneId: string) => void;
  onRemoveVoiceover: (sceneId: string) => void;
  onUpdateVoiceoverVolume: (sceneId: string, volume: number) => void;
  onAdjustSceneDuration: (sceneId: string, nextDuration: number) => void;
  onFocusSceneNarration?: (sceneId: string) => void;
}

export function SceneVoiceoverCard({
  scene,
  sceneIndex,
  storyboard,
  evaluation,
  ttsStatus,
  voices,
  ttsReadyForLang,
  isAuthenticated,
  activeGenerating,
  batchActive,
  activeAudioSceneId,
  onActivateSceneAudio,
  onGenerateScene,
  onCancelScene,
  onRemoveVoiceover,
  onUpdateVoiceoverVolume,
  onAdjustSceneDuration,
  onFocusSceneNarration,
}: SceneVoiceoverCardProps) {
  const effectiveDefaults = resolveEffectiveSceneVoiceParams(scene, storyboard);
  const [showCustomControls, setShowCustomControls] = useState(false);
  const [confirmExtendDuration, setConfirmExtendDuration] = useState(false);
  const [customDraft, setCustomDraft] = useState<StoryboardVoiceoverSettings>({
    provider: effectiveDefaults.provider,
    voiceId: effectiveDefaults.voiceId,
    speakingRate: effectiveDefaults.speakingRate,
    pitch: effectiveDefaults.pitch,
    format: effectiveDefaults.format,
    volume: effectiveDefaults.volume,
  });

  useEffect(() => {
    setCustomDraft({
      provider: effectiveDefaults.provider,
      voiceId: effectiveDefaults.voiceId,
      speakingRate: effectiveDefaults.speakingRate,
      pitch: effectiveDefaults.pitch,
      format: effectiveDefaults.format,
      volume: effectiveDefaults.volume,
    });
  }, [
    effectiveDefaults.provider,
    effectiveDefaults.voiceId,
    effectiveDefaults.speakingRate,
    effectiveDefaults.pitch,
    effectiveDefaults.format,
    effectiveDefaults.volume,
  ]);

  useEffect(() => {
    setConfirmExtendDuration(false);
  }, [scene.duration, scene.voiceover?.durationSeconds]);

  const vo = scene.voiceover;
  const measuredDuration =
    evaluation.asset && evaluation.asset.duration > 0
      ? evaluation.asset.duration
      : vo?.durationSeconds ?? 0;

  const statusLabel =
    evaluation.status === "generating"
      ? "Generating..."
      : evaluation.status === "ready"
        ? "Ready"
        : evaluation.status === "stale"
          ? "Stale — Narration Edited"
          : evaluation.status === "missing"
            ? "Missing Audio"
            : evaluation.status === "failed"
              ? "Failed"
              : evaluation.status === "skipped_empty"
                ? "Skipped (Empty Narration)"
                : "No Audio";

  const statusColorClass =
    evaluation.status === "ready"
      ? "text-emerald-400"
      : evaluation.status === "generating"
        ? "text-violet-400"
        : evaluation.status === "stale" || evaluation.status === "none"
          ? "text-amber-400"
          : evaluation.status === "skipped_empty"
            ? "text-zinc-500"
            : "text-rose-400";

  const clampedAdjustedDuration = Math.max(
    0.5,
    Math.min(60, Number(Math.max(measuredDuration + 0.1, 0.5).toFixed(1)))
  );

  return (
    <div className="rounded-lg border border-zinc-800/90 bg-[#111114] p-3.5 space-y-2.5">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Mic className="h-3.5 w-3.5 text-violet-400 shrink-0" />
          <span className="text-xs font-medium text-zinc-200">Voiceover</span>
          <span className="text-zinc-600">·</span>
          <span className={`font-mono text-[11px] font-medium uppercase ${statusColorClass}`}>
            {statusLabel}
          </span>

          {vo && evaluation.status !== "failed" && evaluation.status !== "skipped_empty" && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                {measuredDuration.toFixed(2)}s / {scene.duration.toFixed(1)}s scene
              </span>
              <span className="text-zinc-600">·</span>
              <span className="text-[11px] text-zinc-400 truncate max-w-[220px]" title={vo.voiceLabel}>
                {vo.voiceLabel} ({vo.provider === "piper" ? "Piper" : vo.provider === "espeak_ng" ? "eSpeak NG" : "SAPI5"} ·{" "}
                {formatTtsLanguageLabel(vo.language)})
              </span>
              <span className="text-zinc-600">·</span>
              <span className="font-mono text-[11px] text-zinc-500 tabular-nums uppercase">
                {vo.format} · {(vo.sampleRateHz / 1000).toFixed(2)}kHz · {formatBytes(vo.sizeBytes)}
              </span>
            </>
          )}
        </div>

        {/* Scene Voiceover Actions */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {activeGenerating ? (
            <button
              type="button"
              onClick={() => onCancelScene(scene.id)}
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25"
            >
              <X className="h-3 w-3" />
              <span>Cancel</span>
            </button>
          ) : (
            evaluation.hasNarration && (
              <>
                <button
                  type="button"
                  disabled={!isAuthenticated || !ttsReadyForLang || batchActive}
                  onClick={() =>
                    onGenerateScene(scene.id, showCustomControls ? customDraft : undefined)
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-800 hover:border-violet-500/60 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <RefreshCw className="h-3 w-3 text-violet-400" />
                  <span>{vo ? "Regenerate Voiceover" : "Generate Voiceover"}</span>
                </button>

                <button
                  type="button"
                  disabled={batchActive}
                  onClick={() => setShowCustomControls((prev) => !prev)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-45 ${
                    showCustomControls
                      ? "border-violet-500/50 bg-violet-500/10 text-violet-200"
                      : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-200"
                  }`}
                  aria-expanded={showCustomControls}
                  title="Override engine, voice, speaking rate, pitch, or volume for this scene"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  <span>Voice Settings</span>
                </button>
              </>
            )
          )}

          {vo && !activeGenerating && (
            <button
              type="button"
              onClick={() => onRemoveVoiceover(scene.id)}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:border-rose-500/40"
              title="Detach generated voiceover from this scene"
            >
              <Trash2 className="h-3 w-3" />
              <span>Remove</span>
            </button>
          )}
        </div>
      </div>

      {/* Audio Preview when local IndexedDB blob is present */}
      {evaluation.asset && (evaluation.status === "ready" || evaluation.status === "stale") && (
        <VoiceoverAudioPreview
          sceneId={scene.id}
          src={evaluation.asset.objectUrl}
          durationSeconds={measuredDuration}
          volume={vo?.volume ?? 1.0}
          activeAudioSceneId={activeAudioSceneId}
          onActivateSceneAudio={onActivateSceneAudio}
          title={`Scene ${sceneIndex + 1}`}
        />
      )}

      {/* Warnings & Duration Overflow Handling (never silently auto-mutates scene.duration) */}
      {evaluation.warnings.length > 0 && (
        <div
          className={`rounded-md border px-3 py-2 text-[11px] space-y-2 ${
            evaluation.status === "failed" || evaluation.isMissing
              ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {evaluation.warnings.map((w, idx) => (
                <p key={idx}>{w}</p>
              ))}
            </div>
          </div>

          {evaluation.isOverflowing && !activeGenerating && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {onFocusSceneNarration && (
                <button
                  type="button"
                  onClick={() => onFocusSceneNarration(scene.id)}
                  className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40"
                >
                  Edit Narration
                </button>
              )}

              {evaluation.recommendedRateForFit !== null && (
                <button
                  type="button"
                  disabled={!isAuthenticated || !ttsReadyForLang || batchActive}
                  onClick={() =>
                    onGenerateScene(scene.id, {
                      ...customDraft,
                      speakingRate: evaluation.recommendedRateForFit!,
                    })
                  }
                  className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40 disabled:opacity-45"
                >
                  Speed Up to {evaluation.recommendedRateForFit.toFixed(2)}x &amp; Regenerate
                </button>
              )}

              {!confirmExtendDuration ? (
                <button
                  type="button"
                  onClick={() => setConfirmExtendDuration(true)}
                  className="rounded border border-amber-400/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-500/30"
                >
                  Extend Scene to {clampedAdjustedDuration}s
                </button>
              ) : (
                <div className="inline-flex items-center gap-1.5 rounded border border-amber-400/50 bg-black/40 px-2 py-0.5">
                  <span className="text-[11px] text-amber-100">
                    Set scene duration to {clampedAdjustedDuration}s?
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmExtendDuration(false);
                      onAdjustSceneDuration(scene.id, clampedAdjustedDuration);
                    }}
                    className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-black hover:bg-amber-400"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmExtendDuration(false)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Optional Per-Scene Override Controls */}
      {showCustomControls && evaluation.hasNarration && (
        <div className="rounded-md border border-zinc-800 bg-[#09090B] p-3 space-y-2.5">
          <VoiceSelector
            compact
            language={effectiveDefaults.language}
            ttsStatus={ttsStatus}
            voices={voices}
            provider={customDraft.provider}
            voiceId={customDraft.voiceId}
            speakingRate={customDraft.speakingRate}
            pitch={customDraft.pitch}
            format={customDraft.format}
            volume={customDraft.volume}
            disabled={activeGenerating || batchActive}
            onChange={(patch) => {
              setCustomDraft((prev) => ({ ...prev, ...patch }));
              if (patch.volume !== undefined && vo) {
                onUpdateVoiceoverVolume(scene.id, patch.volume);
              }
            }}
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!isAuthenticated || !ttsReadyForLang || activeGenerating || batchActive}
              onClick={() => onGenerateScene(scene.id, customDraft)}
              className="rounded-md bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-[11px] font-medium text-white transition-colors disabled:opacity-45"
            >
              Synthesize Scene With These Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
