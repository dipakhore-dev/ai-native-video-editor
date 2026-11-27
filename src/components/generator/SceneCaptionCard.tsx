import React, { useState } from "react";
import {
  AlertTriangle,
  Captions,
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  CaptionsStatusInfo,
  CaptionStyleConfig,
  MediaAsset,
  StoryboardCaptionSegment,
  StoryboardScene,
  VideoStoryboard,
} from "../../types/studio";
import {
  exportSceneCaptionsToSrt,
  exportSceneCaptionsToVtt,
  type SceneCaptionsEvaluation,
} from "../../utils/storyboardCaptions";
import { normalizeTtsLanguage } from "../../utils/storyboardVoiceover";
import { CaptionPreview } from "./CaptionPreview";
import { CaptionSegmentEditor } from "./CaptionSegmentEditor";

interface SceneCaptionCardProps {
  scene: StoryboardScene;
  sceneIndex: number;
  storyboard: VideoStoryboard;
  evaluation: SceneCaptionsEvaluation;
  captionStyle: CaptionStyleConfig;
  captionsStatus: CaptionsStatusInfo | null;
  voiceoverAsset: MediaAsset | null;
  visualThumbSrc?: string;
  isAuthenticated: boolean;
  activeGenerating: boolean;
  batchActive: boolean;
  activeAudioSceneId: string | null;
  onActivateSceneAudio: (token: string | null) => void;
  onGenerateScriptCaptions: (sceneId: string) => void;
  onTranscribeAudioCaptions: (sceneId: string) => void;
  onCancelSceneCaptions: (sceneId: string) => void;
  onUpdateSceneSegments: (sceneId: string, nextSegments: StoryboardCaptionSegment[]) => void;
  onRemoveSceneCaptions: (sceneId: string) => void;
  onTrimCuesToSceneDuration: (sceneId: string) => void;
  onAdjustSceneDuration: (sceneId: string, nextDuration: number) => void;
}

function downloadTextAsset(filename: string, mimeType: string, content: string): void {
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

export function SceneCaptionCard({
  scene,
  sceneIndex,
  storyboard,
  evaluation,
  captionStyle,
  captionsStatus,
  voiceoverAsset,
  visualThumbSrc,
  isAuthenticated,
  activeGenerating,
  batchActive,
  activeAudioSceneId,
  onActivateSceneAudio,
  onGenerateScriptCaptions,
  onTranscribeAudioCaptions,
  onCancelSceneCaptions,
  onUpdateSceneSegments,
  onRemoveSceneCaptions,
  onTrimCuesToSceneDuration,
  onAdjustSceneDuration,
}: SceneCaptionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmOverwriteMode, setConfirmOverwriteMode] = useState<"script" | "audio" | null>(null);
  const [confirmExtendDuration, setConfirmExtendDuration] = useState(false);
  const [seekRequest, setSeekRequest] = useState<{ timeSec: number; nonce: number } | null>(null);

  const cap = scene.captions;
  const segments = cap?.segments ?? [];
  const hasVoiceoverAudio = Boolean(
    voiceoverAsset && voiceoverAsset.kind === "audio" && voiceoverAsset.sourceFile
  );
  const audioAvailable = Boolean(captionsStatus?.audioTranscriptionAvailable);
  const canTranscribeAudio =
    isAuthenticated &&
    audioAvailable &&
    hasVoiceoverAudio &&
    !activeGenerating &&
    !batchActive;

  const langCode = normalizeTtsLanguage(storyboard.language);
  const locale = langCode === "hi" ? "hi-IN" : langCode === "bn" ? "bn-IN" : "en-US";

  const statusLabel =
    evaluation.status === "generating"
      ? "Transcribing..."
      : evaluation.status === "ready"
        ? "Ready"
        : evaluation.status === "stale"
          ? "Stale — Input Changed"
          : evaluation.status === "failed"
            ? "Failed"
            : evaluation.status === "skipped_empty"
              ? "Skipped (Empty Narration)"
              : "No Captions";

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

  const sourceBadge =
    cap && cap.segments.length > 0
      ? evaluation.hasManualEdits
        ? cap.mode === "audio"
          ? "Audio + Manual Edit"
          : "Estimated + Manual Edit"
        : cap.timingSource === "audio_transcription"
          ? "Whisper Audio"
          : "Estimated Timing"
      : null;

  const requestGenerate = (targetMode: "script" | "audio") => {
    if (evaluation.hasManualEdits && segments.length > 0) {
      setConfirmOverwriteMode(targetMode);
      return;
    }
    if (targetMode === "script") {
      onGenerateScriptCaptions(scene.id);
    } else {
      onTranscribeAudioCaptions(scene.id);
    }
    setExpanded(true);
  };

  const maxCueEnd = segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 0;
  const clampedExtendDuration = Math.max(
    0.5,
    Math.min(60, Number(Math.max(maxCueEnd + 0.1, 0.5).toFixed(1)))
  );

  const sceneSlug = `scene_${String(sceneIndex + 1).padStart(2, "0")}`;

  return (
    <div className="rounded-lg border border-zinc-800/90 bg-[#111114] p-3.5 space-y-2.5">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Captions className="h-3.5 w-3.5 text-blue-400 shrink-0" />
          <span className="text-xs font-medium text-zinc-200">Captions</span>
          <span className="text-zinc-600">·</span>
          <span className={`font-mono text-[11px] font-medium uppercase ${statusColorClass}`}>
            {statusLabel}
          </span>

          {sourceBadge && (
            <>
              <span className="text-zinc-600">·</span>
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  cap?.timingSource === "audio_transcription"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-blue-500/15 text-blue-300"
                }`}
              >
                {sourceBadge}
              </span>
            </>
          )}

          {segments.length > 0 && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                {segments.length} cue{segments.length === 1 ? "" : "s"}
                {cap?.model ? ` · ${cap.model}` : ""}
                {cap?.detectedLanguage ? ` (${cap.detectedLanguage})` : ""}
              </span>
            </>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {activeGenerating ? (
            <button
              type="button"
              onClick={() => onCancelSceneCaptions(scene.id)}
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
                  disabled={batchActive}
                  onClick={() => requestGenerate("script")}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-800 hover:border-blue-500/60 disabled:opacity-45"
                  title="Generate or update captions locally from scene narration text"
                >
                  <Sparkles className="h-3 w-3 text-blue-400" />
                  <span>Script Captions</span>
                </button>

                <button
                  type="button"
                  disabled={!canTranscribeAudio}
                  onClick={() => requestGenerate("audio")}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-800 hover:border-emerald-500/60 disabled:opacity-45 disabled:cursor-not-allowed"
                  title={
                    !isAuthenticated
                      ? "Sign in to transcribe voiceover audio with faster-whisper"
                      : !hasVoiceoverAudio
                        ? "Generate or restore scene voiceover audio first to transcribe from audio"
                        : !audioAvailable
                          ? captionsStatus?.message ||
                            "Local faster-whisper model is not ready; use Script Captions"
                          : "Transcribe local voiceover audio via faster-whisper CPU"
                  }
                >
                  <FileAudio className="h-3 w-3 text-emerald-400" />
                  <span>From Audio</span>
                </button>
              </>
            )
          )}

          {segments.length > 0 && !activeGenerating && (
            <>
              <button
                type="button"
                onClick={() =>
                  downloadTextAsset(
                    `${sceneSlug}.srt`,
                    "application/x-subrip;charset=utf-8",
                    exportSceneCaptionsToSrt(scene)
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] text-zinc-300 hover:text-white"
                title="Download scene-relative SubRip (.srt) cues"
              >
                <Download className="h-3 w-3 text-zinc-400" />
                <span>.SRT</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  downloadTextAsset(
                    `${sceneSlug}.vtt`,
                    "text/vtt;charset=utf-8",
                    exportSceneCaptionsToVtt(scene)
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] text-zinc-300 hover:text-white"
                title="Download scene-relative WebVTT (.vtt) cues"
              >
                <Download className="h-3 w-3 text-zinc-400" />
                <span>.VTT</span>
              </button>
            </>
          )}

          {(segments.length > 0 || evaluation.hasNarration) && !activeGenerating && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                expanded
                  ? "border-blue-500/50 bg-blue-500/10 text-blue-200"
                  : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <span>{expanded ? "Hide Editor" : "Preview & Edit"}</span>
            </button>
          )}

          {cap && !activeGenerating && (
            <button
              type="button"
              onClick={() => onRemoveSceneCaptions(scene.id)}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:border-rose-500/40"
              title="Clear captions for this scene"
            >
              <Trash2 className="h-3 w-3" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Manual Edit Overwrite Confirmation */}
      {confirmOverwriteMode && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <span>
            This scene has manually edited caption cues. Regenerating{" "}
            {confirmOverwriteMode === "audio" ? "from audio" : "from script"} will overwrite your
            manual edits.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const mode = confirmOverwriteMode;
                setConfirmOverwriteMode(null);
                if (mode === "script") {
                  onGenerateScriptCaptions(scene.id);
                } else {
                  onTranscribeAudioCaptions(scene.id);
                }
                setExpanded(true);
              }}
              className="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-amber-400"
            >
              Confirm Overwrite
            </button>
            <button
              type="button"
              onClick={() => setConfirmOverwriteMode(null)}
              className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Warnings & Explicit User Choices */}
      {evaluation.warnings.length > 0 && (
        <div
          className={`rounded-md border px-3 py-2 text-[11px] space-y-2 ${
            evaluation.status === "failed" || evaluation.overlappingCueIds.size > 0
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

          <div className="flex flex-wrap items-center gap-2">
            {(evaluation.isStale || evaluation.narrationDiverged) && !activeGenerating && (
              <button
                type="button"
                disabled={batchActive}
                onClick={() => requestGenerate("script")}
                className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40"
              >
                Update Script Captions
              </button>
            )}

            {evaluation.overflowsSceneDuration && !activeGenerating && (
              <>
                <button
                  type="button"
                  onClick={() => onTrimCuesToSceneDuration(scene.id)}
                  className="rounded border border-amber-400/40 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-black/40"
                >
                  Clamp Cue End to {scene.duration.toFixed(1)}s
                </button>

                {!confirmExtendDuration ? (
                  <button
                    type="button"
                    onClick={() => setConfirmExtendDuration(true)}
                    className="rounded border border-amber-400/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-500/30"
                  >
                    Extend Scene to {clampedExtendDuration}s
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-1.5 rounded border border-amber-400/50 bg-black/40 px-2 py-0.5">
                    <span className="text-[11px] text-amber-100">
                      Set scene duration to {clampedExtendDuration}s?
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmExtendDuration(false);
                        onAdjustSceneDuration(scene.id, clampedExtendDuration);
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
              </>
            )}
          </div>
        </div>
      )}

      {/* Collapsible Live Preview + Segment Editor */}
      {expanded && (
        <div className="space-y-3 pt-1">
          <CaptionPreview
            sceneId={scene.id}
            sceneTitle={scene.title}
            sceneDuration={scene.duration}
            aspectRatio={storyboard.aspectRatio}
            language={storyboard.language}
            style={captionStyle}
            segments={segments}
            thumbnailSrc={visualThumbSrc}
            audioSrc={voiceoverAsset?.kind === "audio" ? voiceoverAsset.objectUrl : undefined}
            audioDurationSeconds={voiceoverAsset?.duration ?? scene.voiceover?.durationSeconds ?? 0}
            audioVolume={scene.voiceover?.volume ?? 1}
            seekRequest={seekRequest}
            activeAudioSceneId={activeAudioSceneId}
            onActivateSceneAudio={onActivateSceneAudio}
          />

          <CaptionSegmentEditor
            sceneId={scene.id}
            sceneDuration={scene.duration}
            locale={locale}
            segments={segments}
            onChangeSegments={(nextSegs) => onUpdateSceneSegments(scene.id, nextSegs)}
            onSeekToSec={(timeSec) =>
              setSeekRequest((prev) => ({ timeSec, nonce: (prev?.nonce ?? 0) + 1 }))
            }
          />
        </div>
      )}
    </div>
  );
}
