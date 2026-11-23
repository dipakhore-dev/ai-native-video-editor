import React, { useState } from "react";
import {
  Sliders,
  Sparkles,
  Send,
  AlertCircle,
  Trash2,
  Copy,
  ArrowLeft,
  ArrowRight,
  Check,
  X,
  Code2,
  Captions,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import { requestAiAssistant } from "../../services/api";
import type { Project, TimelineClip } from "../../types/studio";
import { describeAiOperation, type AiEditPlan } from "../../utils/aiOperations";
import {
  buildSpeechIntervals,
  clampDuckingAmount,
  clampFadeSeconds,
  clampVolume,
} from "../../utils/audio";
import {
  DEFAULT_CLIP_EFFECTS,
  EFFECT_PRESETS,
  TRANSITION_OPTIONS,
  hasCustomEffects,
  normalizeEffects,
  normalizeTransition,
} from "../../utils/effects";
import {
  DEFAULT_OVERLAY_TRANSFORM,
  OVERLAY_MODE_PRESETS,
  OVERLAY_POSITION_PRESETS,
  applyOverlayPreset,
  computeEffectiveOverlayBox,
  hasCustomOverlayTransform,
  normalizeOverlayTransform,
  updateOverlayBoxDimensions,
} from "../../utils/overlays";
import { formatTimecode } from "../../utils/media";
import { clampClipRotation } from "../../utils/keyframes";
import { trimClipEnd, trimClipStart } from "../../utils/timeline";
import type { TimelinePlaybackClock } from "../../utils/timelineClock";
import { ClipKeyframeInspector } from "./ClipKeyframeInspector";
import { SubtitlesPanel } from "./SubtitlesPanel";

export type EditorPanelTab = "inspector" | "assistant" | "subtitles";

interface AiAssistantPanelProps {
  project: Project;
  selectedClip: TimelineClip | null;
  totalDuration: number;
  playheadTime?: number;
  playbackClock?: TimelinePlaybackClock;
  onSeek: (time: number) => void;
  activeTab?: EditorPanelTab;
  onTabChange?: (tab: EditorPanelTab) => void;
}

type PlanStatus = "pending" | "applied" | "discarded";

interface AssistantMessage {
  id: string;
  role: "user" | "plan" | "error";
  text?: string;
  plan?: AiEditPlan;
  planStatus?: PlanStatus;
  applyFeedback?: string;
}

const EXAMPLE_PROMPTS = [
  "Apply cinematic filter to the first clip.",
  "Add a 1-second cross dissolve between clips.",
  "Move the logo to the top-right corner.",
  "Convert the video to 9:16.",
];

export const AiAssistantPanel = React.memo(function AiAssistantPanel({
  project,
  selectedClip,
  totalDuration,
  playheadTime = 0,
  playbackClock,
  onSeek,
  activeTab,
  onTabChange,
}: AiAssistantPanelProps) {
  const {
    updateClip,
    setClipSpeed,
    moveClipOnTimeline,
    updateTextStyle,
    deleteClip,
    duplicateClip,
    reorderClip,
    applyAiEditPlan,
  } = useStudio();

  const [internalTab, setInternalTab] = useState<EditorPanelTab>("assistant");
  const tab = activeTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);

  const submitInstruction = async (instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed || loading) return;

    const userMsg: AssistantMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      text: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setPrompt("");
    setLoading(true);

    const res = await requestAiAssistant({
      prompt: trimmed,
      timelineMetadata: {
        projectId: project.id,
        projectName: project.name,
        aspectRatio: project.aspectRatio,
        resolution: project.resolution,
        fps: project.fps,
        durationSeconds: Number(totalDuration.toFixed(2)),
        selectedClipId: selectedClip?.id ?? null,
        playheadTime: Number((playbackClock ? playbackClock.getTime() : playheadTime).toFixed(2)),
        clips: project.clips.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          trackId: c.trackId,
          startTime: c.startTime,
          duration: c.duration,
          inPoint: c.inPoint,
          sourceDuration: c.sourceDuration,
          speed: c.speed,
          volume: c.volume,
          opacity: c.opacity,
          ...(Math.abs(c.rotation ?? 0) > 0.05 ? { rotation: c.rotation } : {}),
          ...(c.keyframes?.length ? { keyframes: c.keyframes } : {}),
          ...(c.effects ? { effects: { ...c.effects } } : {}),
          ...(c.transitionIn ? { transitionIn: { ...c.transitionIn } } : {}),
          ...(c.transitionOut ? { transitionOut: { ...c.transitionOut } } : {}),
          ...(c.overlayTransform ? { overlayTransform: { ...c.overlayTransform } } : {}),
          ...(c.textStyle ? { text: c.textStyle.text } : {}),
        })),
      },
    });

    setLoading(false);

    if (res.ok && res.data?.plan) {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}_plan`,
          role: "plan",
          plan: res.data!.plan!,
          planStatus: "pending",
        },
      ]);
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg_${Date.now()}_err`,
          role: "error",
          text:
            res.error ||
            "Could not process editing instruction with the server-side Gemini API.",
        },
      ]);
    }
  };

  const handleAskAssistant = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitInstruction(prompt);
  };

  const handleConfirmPlan = (messageId: string, plan: AiEditPlan) => {
    const supportedOps = plan.operations.filter((op) => op.type !== "unsupported");
    if (supportedOps.length === 0) return;

    const result = applyAiEditPlan(supportedOps, selectedClip?.id ?? null);
    const feedbackParts: string[] = [];
    if (result.appliedCount > 0) {
      feedbackParts.push(
        `Applied ${result.appliedCount} timeline ${
          result.appliedCount === 1 ? "change" : "changes"
        }. Original media files remain unchanged.`
      );
    }
    if (result.skippedMessages.length > 0) {
      feedbackParts.push(`Skipped: ${result.skippedMessages.join(" ")}`);
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              planStatus: "applied",
              applyFeedback: feedbackParts.join(" "),
            }
          : m
      )
    );
  };

  const handleDiscardPlan = (messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, planStatus: "discarded" } : m))
    );
  };

  return (
    <aside className="w-full xl:w-84 shrink-0 border-t xl:border-t-0 xl:border-l border-zinc-800/80 bg-[#0D0D10] flex flex-col min-h-[360px] xl:min-h-0">
      {/* Panel Tabs */}
      <div className="p-2.5 border-b border-zinc-800/80 grid grid-cols-3 gap-1 bg-[#09090B]">
        <button
          type="button"
          onClick={() => setTab("inspector")}
          className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            tab === "inspector" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Sliders className="h-3.5 w-3.5" />
          <span>Inspector</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("assistant")}
          className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            tab === "assistant" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 text-violet-400" />
          <span>AI Edit</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("subtitles")}
          className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            tab === "subtitles" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Captions className="h-3.5 w-3.5 text-blue-400" />
          <span>Subtitles</span>
          {(project.subtitles?.length ?? 0) > 0 && (
            <span className="ml-0.5 rounded bg-violet-500/20 px-1 text-[10px] font-mono text-violet-300">
              {project.subtitles!.length}
            </span>
          )}
        </button>
      </div>

      {tab === "subtitles" ? (
        <SubtitlesPanel
          project={project}
          selectedClip={selectedClip}
          playheadTime={playheadTime}
          playbackClock={playbackClock}
          onSeek={onSeek}
        />
      ) : tab === "inspector" ? (
        <div className="p-4 flex-1 overflow-y-auto space-y-5">
          {selectedClip ? (
            <>
              <div>
                <p className="text-[11px] font-medium text-zinc-400">
                  {selectedClip.kind === "text" ? "Text Overlay" : "Selected Clip"}
                </p>
                <h3
                  className="mt-1 text-sm font-medium text-white truncate"
                  title={selectedClip.name}
                >
                  {selectedClip.kind === "text"
                    ? selectedClip.textStyle?.text || selectedClip.name
                    : selectedClip.name}
                </h3>
                <p className="mt-0.5 text-[11px] font-mono text-zinc-500 tabular-nums">
                  {selectedClip.kind.toUpperCase()} ·{" "}
                  {selectedClip.kind === "text"
                    ? `${formatTimecode(selectedClip.duration)} overlay`
                    : `Source ${formatTimecode(selectedClip.sourceDuration)}`}
                </p>
              </div>

              {selectedClip.kind === "text" && selectedClip.textStyle && (
                <div className="space-y-3.5 pt-2 border-t border-zinc-800/80">
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">Overlay Text</label>
                    <textarea
                      rows={2}
                      value={selectedClip.textStyle.text}
                      onChange={(e) =>
                        updateTextStyle(selectedClip.id, { text: e.target.value })
                      }
                      className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-white focus:border-violet-500 focus:outline-none resize-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Font Size ({selectedClip.textStyle.fontSize}px)
                      </label>
                      <input
                        type="range"
                        min={16}
                        max={72}
                        value={selectedClip.textStyle.fontSize}
                        onChange={(e) =>
                          updateTextStyle(selectedClip.id, { fontSize: Number(e.target.value) })
                        }
                        className="w-full accent-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">Text Color</label>
                      <div className="flex items-center gap-1.5">
                        {["#FFFFFF", "#F4F4F5", "#A78BFA", "#60A5FA", "#FBBF24"].map((col) => (
                          <button
                            key={col}
                            type="button"
                            onClick={() => updateTextStyle(selectedClip.id, { color: col })}
                            style={{ backgroundColor: col }}
                            className={`h-5 w-5 rounded border ${
                              selectedClip.textStyle?.color === col
                                ? "border-white ring-1 ring-white"
                                : "border-zinc-700"
                            }`}
                            aria-label={`Set text color ${col}`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        X Position ({Math.round(selectedClip.textStyle.x)}%)
                      </label>
                      <input
                        type="range"
                        min={10}
                        max={90}
                        value={selectedClip.textStyle.x}
                        onChange={(e) =>
                          updateTextStyle(selectedClip.id, { x: Number(e.target.value) })
                        }
                        className="w-full accent-violet-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        Y Position ({Math.round(selectedClip.textStyle.y)}%)
                      </label>
                      <input
                        type="range"
                        min={10}
                        max={90}
                        value={selectedClip.textStyle.y}
                        onChange={(e) =>
                          updateTextStyle(selectedClip.id, { y: Number(e.target.value) })
                        }
                        className="w-full accent-violet-500"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-zinc-400">Backdrop Opacity</span>
                      <span className="font-mono text-zinc-200 tabular-nums">
                        {Math.round(selectedClip.textStyle.backgroundOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedClip.textStyle.backgroundOpacity}
                      onChange={(e) =>
                        updateTextStyle(selectedClip.id, {
                          backgroundOpacity: Number(e.target.value),
                        })
                      }
                      className="w-full accent-blue-500"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-zinc-800/80">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Timeline Start (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={selectedClip.startTime}
                    onChange={(e) =>
                      moveClipOnTimeline(
                        selectedClip.id,
                        Math.max(0, Number(e.target.value) || 0)
                      )
                    }
                    className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs font-mono text-white tabular-nums focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">Duration (s)</label>
                  <input
                    type="number"
                    min={0.5}
                    max={
                      selectedClip.kind === "image" || selectedClip.kind === "text"
                        ? 60
                        : Math.max(0.5, (selectedClip.sourceDuration - selectedClip.inPoint) / selectedClip.speed)
                    }
                    step={0.1}
                    value={selectedClip.duration}
                    onChange={(e) => {
                      const trackClips = project.clips.filter(
                        (c) => c.trackId === selectedClip.trackId
                      );
                      const patch = trimClipEnd(
                        selectedClip,
                        Math.max(0.5, Number(e.target.value) || 1),
                        trackClips
                      );
                      updateClip(selectedClip.id, patch);
                    }}
                    className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs font-mono text-white tabular-nums focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              {(selectedClip.kind === "video" || selectedClip.kind === "audio") && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">Trim In (s)</label>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, selectedClip.sourceDuration - 0.5)}
                      step={0.1}
                      value={selectedClip.inPoint}
                      onChange={(e) => {
                        const targetIn = Math.max(0, Number(e.target.value) || 0);
                        const deltaStart = (targetIn - selectedClip.inPoint) / selectedClip.speed;
                        const trackClips = project.clips.filter(
                          (c) => c.trackId === selectedClip.trackId
                        );
                        const patch = trimClipStart(
                          selectedClip,
                          selectedClip.startTime + deltaStart,
                          trackClips
                        );
                        updateClip(selectedClip.id, patch);
                      }}
                      className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs font-mono text-white tabular-nums focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">Trim Out (s)</label>
                    <input
                      type="number"
                      min={Number((selectedClip.inPoint + 0.5).toFixed(1))}
                      max={Number(selectedClip.sourceDuration.toFixed(1))}
                      step={0.1}
                      value={Number(
                        (selectedClip.inPoint + selectedClip.duration * selectedClip.speed).toFixed(2)
                      )}
                      onChange={(e) => {
                        const outSec = Math.min(
                          selectedClip.sourceDuration,
                          Math.max(selectedClip.inPoint + 0.5, Number(e.target.value) || 0.5)
                        );
                        const nextDur = Number(
                          ((outSec - selectedClip.inPoint) / selectedClip.speed).toFixed(2)
                        );
                        const trackClips = project.clips.filter(
                          (c) => c.trackId === selectedClip.trackId
                        );
                        const patch = trimClipEnd(selectedClip, nextDur, trackClips);
                        updateClip(selectedClip.id, patch);
                      }}
                      className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs font-mono text-white tabular-nums focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {(selectedClip.kind === "video" || selectedClip.kind === "audio") && (
                <div className="space-y-3.5 pt-2 border-t border-zinc-800/80">
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1.5">
                      <span className="text-zinc-300 font-medium">
                        {selectedClip.kind === "video" ? "Video Audio Volume" : "Clip Volume"}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-zinc-200 tabular-nums">
                          {selectedClip.muted ? "Muted" : `${Math.round(selectedClip.volume * 100)}%`}
                        </span>
                        {Math.abs(selectedClip.volume - 1) > 0.02 && !selectedClip.muted && (
                          <button
                            type="button"
                            onClick={() => updateClip(selectedClip.id, { volume: 1 })}
                            className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 hover:text-white"
                            title="Reset volume to 100%"
                          >
                            100%
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            updateClip(selectedClip.id, { muted: !selectedClip.muted })
                          }
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            selectedClip.muted
                              ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                              : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white"
                          }`}
                          title={selectedClip.muted ? "Unmute clip audio" : "Mute clip audio"}
                        >
                          {selectedClip.muted ? (
                            <VolumeX className="h-3 w-3" />
                          ) : (
                            <Volume2 className="h-3 w-3" />
                          )}
                          <span>{selectedClip.muted ? "Unmute" : "Mute"}</span>
                        </button>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={selectedClip.volume}
                      onChange={(e) =>
                        updateClip(selectedClip.id, {
                          volume: clampVolume(Number(e.target.value)),
                          ...(selectedClip.muted && Number(e.target.value) > 0 ? { muted: false } : {}),
                        })
                      }
                      className="w-full accent-violet-500"
                      aria-label="Clip volume"
                    />
                    <div className="flex justify-between text-[10px] font-mono text-zinc-500 mt-0.5">
                      <span>0%</span>
                      <span>100%</span>
                      <span>200%</span>
                    </div>
                  </div>

                  {/* Fade In / Fade Out */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-zinc-400">Fade In (s)</span>
                        <span className="font-mono text-zinc-300 tabular-nums">
                          {(selectedClip.fadeInSec ?? 0).toFixed(1)}s
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.min(10, Number(selectedClip.duration.toFixed(1)))}
                        step={0.1}
                        value={Math.min(selectedClip.duration, selectedClip.fadeInSec ?? 0)}
                        onChange={(e) =>
                          updateClip(selectedClip.id, {
                            fadeInSec: clampFadeSeconds(
                              Number(e.target.value),
                              selectedClip.duration
                            ),
                          })
                        }
                        className="w-full accent-sky-400"
                        aria-label="Fade in duration"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-zinc-400">Fade Out (s)</span>
                        <span className="font-mono text-zinc-300 tabular-nums">
                          {(selectedClip.fadeOutSec ?? 0).toFixed(1)}s
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.min(10, Number(selectedClip.duration.toFixed(1)))}
                        step={0.1}
                        value={Math.min(selectedClip.duration, selectedClip.fadeOutSec ?? 0)}
                        onChange={(e) =>
                          updateClip(selectedClip.id, {
                            fadeOutSec: clampFadeSeconds(
                              Number(e.target.value),
                              selectedClip.duration
                            ),
                          })
                        }
                        className="w-full accent-sky-400"
                        aria-label="Fade out duration"
                      />
                    </div>
                  </div>

                  {/* Optional Speech-Aware Audio Ducking (A1 Audio Clips) */}
                  {selectedClip.kind === "audio" && (
                    <div className="rounded-lg border border-zinc-800/80 bg-[#09090B] p-2.5 space-y-2.5">
                      <label className="flex items-center justify-between gap-2 cursor-pointer">
                        <div>
                          <p className="text-xs font-medium text-zinc-200">
                            Speech-Aware Ducking
                          </p>
                          <p className="text-[10px] text-zinc-500">
                            Automatically lower music when dialogue plays
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedClip.duckingEnabled)}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              duckingEnabled: e.target.checked,
                              ...(selectedClip.duckingAmount === undefined
                                ? { duckingAmount: 0.6 }
                                : {}),
                            })
                          }
                          className="accent-amber-400 h-4 w-4 rounded"
                        />
                      </label>

                      {selectedClip.duckingEnabled && (
                        <>
                          <div>
                            <div className="flex items-center justify-between text-[11px] mb-1">
                              <span className="text-zinc-400">Ducking Reduction</span>
                              <span className="font-mono text-amber-300 tabular-nums">
                                -{Math.round(clampDuckingAmount(selectedClip.duckingAmount) * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0.1}
                              max={0.9}
                              step={0.05}
                              value={clampDuckingAmount(selectedClip.duckingAmount)}
                              onChange={(e) =>
                                updateClip(selectedClip.id, {
                                  duckingAmount: clampDuckingAmount(Number(e.target.value)),
                                })
                              }
                              className="w-full accent-amber-400"
                              aria-label="Ducking reduction amount"
                            />
                          </div>
                          <p className="text-[10px] text-zinc-400 leading-snug">
                            {(() => {
                              const ivCount = buildSpeechIntervals(project.subtitles).length;
                              if (ivCount > 0) {
                                return `Synced to ${ivCount} subtitle speech ${ivCount === 1 ? "window" : "windows"} during preview & MP4 export.`;
                              }
                              return "No subtitle cues yet: ducks automatically against V1 dialogue audio (sidechain compression in MP4 export).";
                            })()}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {selectedClip.kind !== "audio" && (
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-zinc-400">Opacity</span>
                      <span className="font-mono text-zinc-200 tabular-nums">
                        {Math.round(selectedClip.opacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedClip.opacity}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { opacity: Number(e.target.value) })
                      }
                      className="w-full accent-blue-500"
                      aria-label="Clip opacity"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-zinc-400">Rotation</span>
                      <span className="font-mono text-zinc-200 tabular-nums">
                        {Math.round(selectedClip.rotation ?? 0)}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={Math.max(-180, Math.min(180, selectedClip.rotation ?? 0))}
                      onChange={(e) =>
                        updateClip(selectedClip.id, {
                          rotation: clampClipRotation(Number(e.target.value)),
                        })
                      }
                      className="w-full accent-amber-400"
                      aria-label="Clip rotation"
                    />
                  </div>
                </div>
              )}

              <ClipKeyframeInspector
                clip={selectedClip}
                playheadTime={playheadTime}
                playbackClock={playbackClock}
                onSeek={onSeek}
                onUpdateClip={updateClip}
              />

              {selectedClip.trackId === "track_v2" &&
                (selectedClip.kind === "image" || selectedClip.kind === "video") &&
                (() => {
                  const ov = normalizeOverlayTransform(selectedClip.overlayTransform);
                  const effBox = computeEffectiveOverlayBox(ov);
                  const customized = hasCustomOverlayTransform(ov);

                  return (
                    <div className="space-y-3 pt-2 border-t border-zinc-800/80">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-zinc-300">
                          Overlay Transform &amp; PiP
                        </span>
                        {customized && (
                          <button
                            type="button"
                            onClick={() =>
                              updateClip(selectedClip.id, {
                                overlayTransform: { ...DEFAULT_OVERLAY_TRANSFORM },
                              })
                            }
                            className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:text-white"
                          >
                            Reset
                          </button>
                        )}
                      </div>

                      {/* Mode Presets: PiP / Watermark / Full Frame */}
                      <div className="grid grid-cols-3 gap-1">
                        {OVERLAY_MODE_PRESETS.map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            onClick={() => {
                              const applied = applyOverlayPreset(ov, mode.id);
                              updateClip(selectedClip.id, {
                                overlayTransform: applied.overlayTransform,
                                ...(applied.suggestedOpacity !== undefined
                                  ? { opacity: applied.suggestedOpacity }
                                  : {}),
                              });
                            }}
                            className="rounded-md border border-zinc-800 bg-[#09090B] py-1 px-1.5 text-[10px] font-medium text-zinc-300 hover:border-blue-500/60 hover:text-white transition-colors"
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>

                      {/* Corner & Center Position Presets */}
                      <div>
                        <p className="text-[10px] text-zinc-500 mb-1">
                          Corner &amp; Center Presets
                        </p>
                        <div className="grid grid-cols-3 gap-1">
                          {OVERLAY_POSITION_PRESETS.map((pos) => {
                            const isAtPos =
                              Math.abs(ov.x - pos.x) < 1.5 && Math.abs(ov.y - pos.y) < 1.5;
                            return (
                              <button
                                key={pos.id}
                                type="button"
                                onClick={() => {
                                  const applied = applyOverlayPreset(ov, pos.id);
                                  updateClip(selectedClip.id, {
                                    overlayTransform: applied.overlayTransform,
                                  });
                                }}
                                className={`rounded-md py-1 px-1 text-[10px] font-medium border truncate transition-colors ${
                                  isAtPos
                                    ? "border-blue-500 bg-blue-500/15 text-white"
                                    : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-200"
                                }`}
                              >
                                {pos.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* X / Y Position Sliders */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-zinc-400">X (%)</span>
                            <span className="font-mono text-zinc-300 tabular-nums">
                              {ov.x.toFixed(0)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={ov.x}
                            onChange={(e) =>
                              updateClip(selectedClip.id, {
                                overlayTransform: normalizeOverlayTransform({
                                  ...ov,
                                  x: Number(e.target.value),
                                }),
                              })
                            }
                            className="w-full accent-blue-500"
                            aria-label="Overlay X position"
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-zinc-400">Y (%)</span>
                            <span className="font-mono text-zinc-300 tabular-nums">
                              {ov.y.toFixed(0)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={ov.y}
                            onChange={(e) =>
                              updateClip(selectedClip.id, {
                                overlayTransform: normalizeOverlayTransform({
                                  ...ov,
                                  y: Number(e.target.value),
                                }),
                              })
                            }
                            className="w-full accent-blue-500"
                            aria-label="Overlay Y position"
                          />
                        </div>
                      </div>

                      {/* Uniform Scale */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-zinc-400">Scale</span>
                          <span className="font-mono text-zinc-300 tabular-nums">
                            {Math.round(ov.scale * 100)}% ({effBox.widthPct.toFixed(0)}% ×{" "}
                            {effBox.heightPct.toFixed(0)}%)
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.1}
                          max={1.5}
                          step={0.05}
                          value={ov.scale}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              overlayTransform: normalizeOverlayTransform({
                                ...ov,
                                scale: Number(e.target.value),
                              }),
                            })
                          }
                          className="w-full accent-violet-500"
                          aria-label="Overlay scale"
                        />
                      </div>

                      {/* Width / Height with Aspect Ratio Lock */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-zinc-400">Width (%)</span>
                            <span className="font-mono text-zinc-300 tabular-nums">
                              {ov.widthPct.toFixed(0)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={5}
                            max={100}
                            step={1}
                            value={ov.widthPct}
                            onChange={(e) => {
                              const dims = updateOverlayBoxDimensions(
                                ov,
                                { widthPct: Number(e.target.value) },
                                {
                                  aspectRatio: project.aspectRatio,
                                  sourceWidth: selectedClip.sourceWidth,
                                  sourceHeight: selectedClip.sourceHeight,
                                }
                              );
                              updateClip(selectedClip.id, {
                                overlayTransform: normalizeOverlayTransform({
                                  ...ov,
                                  ...dims,
                                }),
                              });
                            }}
                            className="w-full accent-blue-500"
                            aria-label="Overlay width percentage"
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-zinc-400">Height (%)</span>
                            <span className="font-mono text-zinc-300 tabular-nums">
                              {ov.heightPct.toFixed(0)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={5}
                            max={100}
                            step={1}
                            value={ov.heightPct}
                            onChange={(e) => {
                              const dims = updateOverlayBoxDimensions(
                                ov,
                                { heightPct: Number(e.target.value) },
                                {
                                  aspectRatio: project.aspectRatio,
                                  sourceWidth: selectedClip.sourceWidth,
                                  sourceHeight: selectedClip.sourceHeight,
                                }
                              );
                              updateClip(selectedClip.id, {
                                overlayTransform: normalizeOverlayTransform({
                                  ...ov,
                                  ...dims,
                                }),
                              });
                            }}
                            className="w-full accent-blue-500"
                            aria-label="Overlay height percentage"
                          />
                        </div>
                      </div>

                      <label className="flex items-center justify-between text-[11px] text-zinc-300 cursor-pointer pt-0.5">
                        <span>Lock Aspect Ratio</span>
                        <input
                          type="checkbox"
                          checked={ov.lockAspectRatio}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              overlayTransform: normalizeOverlayTransform({
                                ...ov,
                                lockAspectRatio: e.target.checked,
                              }),
                            })
                          }
                          className="accent-blue-500 h-3.5 w-3.5 rounded"
                        />
                      </label>
                    </div>
                  );
                })()}

              {(selectedClip.kind === "video" || selectedClip.kind === "image") && (() => {
                const eff = normalizeEffects(selectedClip.effects);
                const customized = hasCustomEffects(eff);
                return (
                  <div className="space-y-3 pt-2 border-t border-zinc-800/80">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-zinc-300">
                        Color &amp; Effects
                      </span>
                      {customized && (
                        <button
                          type="button"
                          onClick={() =>
                            updateClip(selectedClip.id, { effects: { ...DEFAULT_CLIP_EFFECTS } })
                          }
                          className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:text-white"
                        >
                          Reset
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-1">
                      {EFFECT_PRESETS.map((preset) => {
                        const isActive = eff.preset === preset.value;
                        return (
                          <button
                            key={preset.value}
                            type="button"
                            onClick={() =>
                              updateClip(selectedClip.id, {
                                effects: { ...eff, preset: preset.value },
                              })
                            }
                            className={`rounded-md py-1 px-1 text-[10px] font-medium border truncate transition-colors ${
                              isActive
                                ? "border-violet-500 bg-violet-500/15 text-white"
                                : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-200"
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-zinc-400">Brightness</span>
                          <span className="font-mono text-zinc-300 tabular-nums">
                            {eff.brightness > 0 ? `+${eff.brightness.toFixed(2)}` : eff.brightness.toFixed(2)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={-0.5}
                          max={0.5}
                          step={0.05}
                          value={eff.brightness}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              effects: normalizeEffects({
                                ...eff,
                                brightness: Number(e.target.value),
                              }),
                            })
                          }
                          className="w-full accent-violet-500"
                          aria-label="Clip brightness"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-zinc-400">Contrast</span>
                          <span className="font-mono text-zinc-300 tabular-nums">
                            {Math.round(eff.contrast * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0.5}
                          max={1.8}
                          step={0.05}
                          value={eff.contrast}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              effects: normalizeEffects({
                                ...eff,
                                contrast: Number(e.target.value),
                              }),
                            })
                          }
                          className="w-full accent-violet-500"
                          aria-label="Clip contrast"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-zinc-400">Saturation</span>
                          <span className="font-mono text-zinc-300 tabular-nums">
                            {Math.round(eff.saturation * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.05}
                          value={eff.saturation}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              effects: normalizeEffects({
                                ...eff,
                                saturation: Number(e.target.value),
                              }),
                            })
                          }
                          className="w-full accent-blue-500"
                          aria-label="Clip saturation"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-zinc-400">Blur</span>
                          <span className="font-mono text-zinc-300 tabular-nums">
                            {eff.blur.toFixed(1)}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={10}
                          step={0.5}
                          value={eff.blur}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              effects: normalizeEffects({
                                ...eff,
                                blur: Number(e.target.value),
                              }),
                            })
                          }
                          className="w-full accent-blue-500"
                          aria-label="Clip blur"
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}

              {selectedClip.kind !== "audio" && (() => {
                const trIn = normalizeTransition(selectedClip.transitionIn, selectedClip.duration);
                const trOut = normalizeTransition(selectedClip.transitionOut, selectedClip.duration);
                const availableOptions =
                  selectedClip.kind === "text"
                    ? TRANSITION_OPTIONS.filter(
                        (opt) =>
                          opt.value === "none" ||
                          opt.value === "fade" ||
                          opt.value === "dissolve"
                      )
                    : TRANSITION_OPTIONS;
                const maxDur = Math.max(
                  0.2,
                  Math.min(2.0, Number((selectedClip.duration * 0.45).toFixed(1)))
                );

                return (
                  <div className="space-y-3 pt-2 border-t border-zinc-800/80">
                    <span className="block text-[11px] font-medium text-zinc-300">
                      Transitions
                    </span>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-[11px] text-zinc-400">
                          Transition In
                        </label>
                        <select
                          value={trIn.type}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              transitionIn: normalizeTransition(
                                {
                                  type: e.target.value as typeof trIn.type,
                                  durationSec: trIn.durationSec,
                                },
                                selectedClip.duration
                              ),
                            })
                          }
                          className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
                          aria-label="Transition in type"
                        >
                          {availableOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        {trIn.type !== "none" && (
                          <div>
                            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 tabular-nums">
                              <span>Duration</span>
                              <span>{trIn.durationSec.toFixed(1)}s</span>
                            </div>
                            <input
                              type="range"
                              min={0.2}
                              max={maxDur}
                              step={0.1}
                              value={Math.min(maxDur, trIn.durationSec)}
                              onChange={(e) =>
                                updateClip(selectedClip.id, {
                                  transitionIn: normalizeTransition(
                                    {
                                      type: trIn.type,
                                      durationSec: Number(e.target.value),
                                    },
                                    selectedClip.duration
                                  ),
                                })
                              }
                              className="w-full accent-amber-400"
                              aria-label="Transition in duration"
                            />
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="block text-[11px] text-zinc-400">
                          Transition Out
                        </label>
                        <select
                          value={trOut.type}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              transitionOut: normalizeTransition(
                                {
                                  type: e.target.value as typeof trOut.type,
                                  durationSec: trOut.durationSec,
                                },
                                selectedClip.duration
                              ),
                            })
                          }
                          className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
                          aria-label="Transition out type"
                        >
                          {availableOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        {trOut.type !== "none" && (
                          <div>
                            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 tabular-nums">
                              <span>Duration</span>
                              <span>{trOut.durationSec.toFixed(1)}s</span>
                            </div>
                            <input
                              type="range"
                              min={0.2}
                              max={maxDur}
                              step={0.1}
                              value={Math.min(maxDur, trOut.durationSec)}
                              onChange={(e) =>
                                updateClip(selectedClip.id, {
                                  transitionOut: normalizeTransition(
                                    {
                                      type: trOut.type,
                                      durationSec: Number(e.target.value),
                                    },
                                    selectedClip.duration
                                  ),
                                })
                              }
                              className="w-full accent-amber-400"
                              aria-label="Transition out duration"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {(selectedClip.kind === "video" || selectedClip.kind === "audio") && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400">Playback Speed</span>
                    <span className="font-mono text-[10px] text-zinc-400 tabular-nums">
                      {formatTimecode(selectedClip.duration)} · Pitch preserved
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {[0.5, 1, 1.5, 2].map((spd) => (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => setClipSpeed(selectedClip.id, spd)}
                        className={`rounded-md py-1 text-[11px] font-mono tabular-nums border transition-colors ${
                          Math.abs(selectedClip.speed - spd) < 0.01
                            ? "border-violet-500 bg-violet-500/15 text-white"
                            : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-white"
                        }`}
                      >
                        {spd}x
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-zinc-800/80 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => reorderClip(selectedClip.id, "earlier")}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>Move Earlier</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => reorderClip(selectedClip.id, "later")}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    <span>Move Later</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => duplicateClip(selectedClip.id)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Duplicate</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteClip(selectedClip.id)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-[11px] font-medium text-zinc-400">Sequence Info</p>
                <h3 className="mt-1 text-sm font-medium text-white">{project.name}</h3>
              </div>
              <dl className="space-y-2 text-xs border-t border-zinc-800/80 pt-3">
                <div className="flex justify-between">
                  <dt className="text-zinc-400">Aspect Ratio</dt>
                  <dd className="font-mono text-zinc-200">{project.aspectRatio}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-400">Resolution</dt>
                  <dd className="font-mono text-zinc-200">{project.resolution}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-400">Frame Rate</dt>
                  <dd className="font-mono text-zinc-200 tabular-nums">{project.fps} fps</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-400">Timeline Clips</dt>
                  <dd className="font-mono text-zinc-200 tabular-nums">{project.clips.length}</dd>
                </div>
              </dl>
              <p className="text-xs text-zinc-500 leading-relaxed pt-2 border-t border-zinc-800/80">
                Select any video, audio, image, or text clip on the timeline to trim start/end points, reorder sequence placement, or customize overlay text.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 p-3.5 overflow-y-auto space-y-3">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-3.5 space-y-1.5">
                  <p className="text-xs font-medium text-white">AI Video Editing Assistant</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Describe an edit in plain language. Gemini translates your instruction into validated timeline operations that require your confirmation before applying.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-zinc-400 px-0.5">Try an instruction</p>
                  {EXAMPLE_PROMPTS.map((example) => (
                    <button
                      key={example}
                      type="button"
                      disabled={loading}
                      onClick={() => void submitInstruction(example)}
                      className="w-full text-left rounded-lg border border-zinc-800/80 bg-[#09090B] px-3 py-2 text-xs text-zinc-300 hover:border-violet-500/50 hover:text-white transition-colors"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                if (m.role === "user") {
                  return (
                    <div
                      key={m.id}
                      className="rounded-xl bg-violet-600/20 border border-violet-500/30 p-3 text-xs text-zinc-100 ml-5 leading-relaxed"
                    >
                      {m.text}
                    </div>
                  );
                }

                if (m.role === "error") {
                  return (
                    <div
                      key={m.id}
                      className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-start gap-2 leading-relaxed"
                    >
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                      <span>{m.text}</span>
                    </div>
                  );
                }

                if (m.role === "plan" && m.plan) {
                  const supportedOps = m.plan.operations.filter((o) => o.type !== "unsupported");
                  const unsupportedOps = m.plan.operations.filter((o) => o.type === "unsupported");
                  const isJsonOpen = expandedJsonId === m.id;

                  return (
                    <div
                      key={m.id}
                      className="rounded-xl border border-zinc-800 bg-[#111114] p-3.5 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-medium text-white leading-snug">
                          {m.plan.summary}
                        </p>
                        <button
                          type="button"
                          onClick={() => setExpandedJsonId(isJsonOpen ? null : m.id)}
                          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 shrink-0"
                          title="Inspect Zod-validated JSON operations"
                        >
                          <Code2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {supportedOps.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[11px] font-medium text-zinc-400">
                            Proposed Timeline Changes
                          </p>
                          <ul className="space-y-1.5">
                            {supportedOps.map((op, idx) => (
                              <li
                                key={idx}
                                className="rounded-lg border border-zinc-800/80 bg-[#09090B] p-2.5 text-xs space-y-0.5"
                              >
                                <p className="text-zinc-100 font-medium">
                                  {describeAiOperation(op, project)}
                                </p>
                                <p className="text-[11px] text-zinc-500">{op.reason}</p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {unsupportedOps.length > 0 && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-1.5">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>Unsupported Operation</span>
                          </div>
                          {unsupportedOps.map((op, idx) =>
                            op.type === "unsupported" ? (
                              <div key={idx} className="text-[11px] text-amber-200/90 leading-relaxed">
                                <span className="font-medium">{op.requestedAction}:</span> {op.reason}
                              </div>
                            ) : null
                          )}
                        </div>
                      )}

                      {isJsonOpen && (
                        <pre className="rounded-lg border border-zinc-800 bg-[#09090B] p-2.5 text-[10px] font-mono text-zinc-300 overflow-x-auto max-h-40">
                          {JSON.stringify(m.plan, null, 2)}
                        </pre>
                      )}

                      {m.planStatus === "pending" && supportedOps.length > 0 && (
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => handleConfirmPlan(m.id, m.plan!)}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 py-2 px-3 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Apply Changes</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDiscardPlan(m.id)}
                            className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 py-2 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>Discard</span>
                          </button>
                        </div>
                      )}

                      {m.planStatus === "applied" && (
                        <div className="flex items-start gap-1.5 text-[11px] text-emerald-400 pt-1">
                          <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <span>{m.applyFeedback || "Changes applied to timeline."}</span>
                        </div>
                      )}

                      {m.planStatus === "discarded" && (
                        <p className="text-[11px] text-zinc-500 pt-1">
                          Proposal discarded. Timeline was not modified.
                        </p>
                      )}
                    </div>
                  );
                }

                return null;
              })
            )}

            {loading && (
              <div className="rounded-xl border border-zinc-800 bg-[#111114] p-3 text-xs text-zinc-400 flex items-center gap-2">
                <div className="h-3.5 w-3.5 rounded-full border-2 border-violet-500 border-t-transparent animate-spin shrink-0" />
                <span>Translating instruction with Gemini...</span>
              </div>
            )}
          </div>

          <form onSubmit={handleAskAssistant} className="p-3 border-t border-zinc-800/80 flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Remove the first 5 seconds..."
              className="flex-1 min-w-0 rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              className="rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 p-2 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50 shrink-0"
              aria-label="Send editing instruction"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </aside>
  );
});
