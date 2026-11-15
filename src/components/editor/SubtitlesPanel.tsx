import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Captions,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import { generateVideoSubtitles } from "../../services/api";
import type {
  Project,
  SubtitleMetadata,
  SubtitlePosition,
  SubtitleSegment,
  TimelineClip,
} from "../../types/studio";
import { formatTimecode, resolveClipSourceFile } from "../../utils/media";
import {
  buildSubtitleFilenameSlug,
  exportSubtitlesToSrt,
  exportSubtitlesToVtt,
  getSubtitleStyle,
  hexToRgba,
  mapWhisperSegmentsToClip,
  SUBTITLE_LANGUAGE_OPTIONS,
} from "../../utils/subtitles";

interface SubtitlesPanelProps {
  project: Project;
  selectedClip: TimelineClip | null;
  playheadTime: number;
  onSeek: (time: number) => void;
}

const COLOR_PRESETS = ["#FFFFFF", "#F4F4F5", "#FBBF24", "#60A5FA", "#A78BFA"];
const BG_COLOR_PRESETS = ["#09090B", "#000000", "#1E1B4B", "#18181B"];


function triggerTextDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function SubtitlesPanel({
  project,
  selectedClip,
  playheadTime,
  onSeek,
}: SubtitlesPanelProps) {
  const {
    mediaAssets,
    isAuthenticated,
    navigate,
    replaceClipSubtitles,
    updateSubtitleSegment,
    addSubtitleSegment,
    deleteSubtitleSegment,
    updateSubtitleStyle,
    saveSubtitlesToMongo,
  } = useStudio();

  const videoClips = useMemo(
    () =>
      project.clips
        .filter((c) => c.kind === "video" || c.kind === "audio")
        .sort((a, b) => a.startTime - b.startTime),
    [project.clips]
  );

  const [targetClipId, setTargetClipId] = useState<string>("");
  const [language, setLanguage] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [savingDb, setSavingDb] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error" | "auth" | "info";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (selectedClip && (selectedClip.kind === "video" || selectedClip.kind === "audio")) {
      setTargetClipId(selectedClip.id);
      return;
    }
    if (videoClips.length > 0 && !videoClips.some((c) => c.id === targetClipId)) {
      setTargetClipId(videoClips[0].id);
    } else if (videoClips.length === 0) {
      setTargetClipId("");
    }
  }, [selectedClip, videoClips, targetClipId]);

  const targetClip = useMemo(
    () => videoClips.find((c) => c.id === targetClipId) ?? videoClips[0] ?? null,
    [videoClips, targetClipId]
  );

  const subtitles = project.subtitles ?? [];
  const style = getSubtitleStyle(project);

  const handleGenerateSubtitles = async () => {
    if (!targetClip) {
      setFeedback({
        kind: "error",
        message: "Add a video or audio clip to the timeline before generating subtitles.",
      });
      return;
    }
    if (targetClip.needsRelink) {
      setFeedback({
        kind: "error",
        message: `Clip '${targetClip.name}' needs to be relinked from your local disk first.`,
      });
      return;
    }

    setFeedback(null);
    setGenerating(true);

    try {
      const fileObj = await resolveClipSourceFile(targetClip, mediaAssets);
      const formData = new FormData();
      formData.append("video", fileObj, fileObj.name);
      if (language.trim()) {
        formData.append("language", language.trim());
      }
      if (/^[a-f\d]{24}$/i.test(project.id)) {
        formData.append("projectId", project.id);
      }

      const res = await generateVideoSubtitles(formData);
      if (!res.ok || !res.data) {
        setGenerating(false);
        if (res.status === 401) {
          setFeedback({
            kind: "auth",
            message:
              "Sign in to your account to run local faster-whisper subtitle generation.",
          });
          return;
        }
        setFeedback({
          kind: "error",
          message: res.error || "Subtitle generation failed.",
        });
        return;
      }

      const rawSegments = res.data.segments ?? [];
      if (rawSegments.length === 0) {
        setGenerating(false);
        setFeedback({
          kind: "info",
          message:
            "No spoken words were detected in this clip (video may be silent or instrumental). You can still add subtitle cues manually below.",
        });
        return;
      }

      const mapped = mapWhisperSegmentsToClip(rawSegments, targetClip);
      if (mapped.length === 0) {
        setGenerating(false);
        setFeedback({
          kind: "info",
          message:
            "Speech was detected outside the clip's trimmed in/out window, leaving 0 cues for the trimmed range.",
        });
        return;
      }

      const meta: SubtitleMetadata = {
        language: res.data.language,
        model: res.data.model,
        generatedAt: new Date().toISOString(),
      };

      const { subtitles: mergedSubs, style: mergedStyle } = replaceClipSubtitles(
        targetClip.id,
        mapped,
        meta
      );

      if (isAuthenticated) {
        const dbRes = await saveSubtitlesToMongo({
          projectId: project.id,
          subtitles: mergedSubs,
          subtitleStyle: mergedStyle,
          subtitleMeta: meta,
        });
        setGenerating(false);
        if (dbRes.ok) {
          setFeedback({
            kind: "success",
            message: `Generated ${mapped.length} subtitle cues (${res.data.language}, ${res.data.model}) and saved to MongoDB.`,
          });
        } else {
          setFeedback({
            kind: "success",
            message: `Generated ${mapped.length} subtitle cues (${res.data.language}), but MongoDB sync failed: ${dbRes.error}`,
          });
        }
      } else {
        setGenerating(false);
        setFeedback({
          kind: "success",
          message: `Generated ${mapped.length} subtitle cues (${res.data.language}, ${res.data.model}). Sign in to save to MongoDB.`,
        });
      }
    } catch (err) {
      setGenerating(false);
      setFeedback({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not read video file bytes for subtitle generation.",
      });
    }
  };

  const handleSaveToMongo = async () => {
    setFeedback(null);
    setSavingDb(true);
    const res = await saveSubtitlesToMongo();
    setSavingDb(false);
    if (res.ok) {
      setFeedback({
        kind: "success",
        message: "Subtitles and styling saved to your MongoDB project.",
      });
    } else if (!isAuthenticated) {
      setFeedback({
        kind: "auth",
        message: res.error || "Sign in to save subtitles to MongoDB.",
      });
    } else {
      setFeedback({
        kind: "error",
        message: res.error || "Failed to save subtitles to MongoDB.",
      });
    }
  };

  const handleDownloadSrt = () => {
    const content = exportSubtitlesToSrt(subtitles);
    if (!content) {
      setFeedback({ kind: "error", message: "No valid subtitle cues to export as SRT." });
      return;
    }
    const base = buildSubtitleFilenameSlug(project.name);
    triggerTextDownload(content, `${base}.srt`, "application/x-subrip;charset=utf-8");
  };

  const handleDownloadVtt = () => {
    const content = exportSubtitlesToVtt(subtitles);
    if (subtitles.length === 0) {
      setFeedback({ kind: "error", message: "No valid subtitle cues to export as VTT." });
      return;
    }
    const base = buildSubtitleFilenameSlug(project.name);
    triggerTextDownload(content, `${base}.vtt`, "text/vtt;charset=utf-8");
  };

  const safeSlug = project.name.trim() || "Untitled";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 p-3.5 overflow-y-auto space-y-4">
        {/* Generation Controls */}
        <div className="rounded-xl border border-zinc-800/90 bg-[#111114] p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Captions className="h-3.5 w-3.5 text-violet-400" />
              <p className="text-xs font-medium text-white">Local Automatic Subtitles</p>
            </div>
            {project.subtitleMeta?.language && (
              <span className="text-[10px] font-mono text-zinc-400 uppercase">
                {project.subtitleMeta.language}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Source Clip</label>
              <select
                value={targetClip?.id ?? ""}
                onChange={(e) => setTargetClipId(e.target.value)}
                disabled={generating || videoClips.length === 0}
                className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              >
                {videoClips.length === 0 ? (
                  <option value="">No video/audio clips on timeline</option>
                ) : (
                  videoClips.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({formatTimecode(c.startTime)}–{formatTimecode(c.startTime + c.duration)})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Spoken Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={generating}
                className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              >
                {SUBTITLE_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value || "auto"} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleGenerateSubtitles()}
            disabled={generating || !targetClip}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 py-2 px-3 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50 transition-colors"
          >
            {generating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Transcribing locally...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                <span>Generate Subtitles</span>
              </>
            )}
          </button>
        </div>

        {/* Feedback Banner */}
        {feedback && (
          <div
            className={`rounded-lg border p-2.5 text-xs space-y-1.5 leading-relaxed ${
              feedback.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : feedback.kind === "info"
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-200"
                  : feedback.kind === "auth"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-200"
            }`}
          >
            <div className="flex items-start gap-2">
              {feedback.kind === "success" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <span>{feedback.message}</span>
            </div>
            {feedback.kind === "auth" && (
              <button
                type="button"
                onClick={() => navigate("auth")}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-white underline underline-offset-2"
              >
                <LogIn className="h-3 w-3" />
                <span>Sign In to Continue</span>
              </button>
            )}
          </div>
        )}

        {/* Subtitle Styling */}
        <div className="rounded-xl border border-zinc-800/90 bg-[#111114] p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-white">Subtitle Style</p>
            <button
              type="button"
              onClick={() => updateSubtitleStyle({ enabled: !style.enabled })}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                style.enabled
                  ? "border-violet-500/40 bg-violet-500/15 text-violet-200"
                  : "border-zinc-800 bg-[#09090B] text-zinc-400"
              }`}
            >
              {style.enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              <span>{style.enabled ? "Visible" : "Hidden"}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">
                Font Size ({style.fontSize}px)
              </label>
              <input
                type="range"
                min={14}
                max={64}
                value={style.fontSize}
                onChange={(e) => updateSubtitleStyle({ fontSize: Number(e.target.value) })}
                className="w-full accent-violet-500"
              />
            </div>

            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Position</label>
              <div className="grid grid-cols-3 gap-1">
                {(["top", "middle", "bottom"] as SubtitlePosition[]).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => updateSubtitleStyle({ position: pos })}
                    className={`rounded py-1 text-[10px] font-medium capitalize border transition-colors ${
                      style.position === pos
                        ? "border-violet-500 bg-violet-500/15 text-white"
                        : "border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {pos}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Text Color</label>
              <div className="flex items-center gap-1.5">
                {COLOR_PRESETS.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => updateSubtitleStyle({ color: col })}
                    style={{ backgroundColor: col }}
                    className={`h-5 w-5 rounded border ${
                      style.color.toUpperCase() === col
                        ? "border-white ring-1 ring-white"
                        : "border-zinc-700"
                    }`}
                    aria-label={`Subtitle text color ${col}`}
                  />
                ))}
                <input
                  type="color"
                  value={style.color}
                  onChange={(e) => updateSubtitleStyle({ color: e.target.value })}
                  className="h-5 w-6 rounded border border-zinc-700 bg-transparent cursor-pointer"
                  aria-label="Custom subtitle text color"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">Background</label>
              <div className="flex items-center gap-1.5">
                {BG_COLOR_PRESETS.map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => updateSubtitleStyle({ backgroundColor: col })}
                    style={{ backgroundColor: col }}
                    className={`h-5 w-5 rounded border ${
                      style.backgroundColor.toUpperCase() === col
                        ? "border-white ring-1 ring-white"
                        : "border-zinc-700"
                    }`}
                    aria-label={`Subtitle background color ${col}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-zinc-400">Background Opacity</span>
              <span className="font-mono text-zinc-200 tabular-nums">
                {Math.round(style.backgroundOpacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) =>
                updateSubtitleStyle({ backgroundOpacity: Number(e.target.value) })
              }
              className="w-full accent-blue-500"
            />
          </div>

          <div
            className="rounded-lg border border-zinc-800 bg-zinc-950/90 py-2.5 px-3 flex items-center justify-center"
            title={`Style preview for ${safeSlug}`}
          >
            <span
              style={{
                color: style.color,
                backgroundColor: hexToRgba(style.backgroundColor, style.backgroundOpacity),
                fontSize: `${Math.max(11, Math.min(20, Math.round(style.fontSize * 0.52)))}px`,
              }}
              className="px-2.5 py-1 rounded font-medium leading-snug"
            >
              Subtitle Style Preview
            </span>
          </div>
        </div>

        {/* Editable Timestamped Subtitle List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-zinc-400">
              Subtitle Cues ({subtitles.length})
            </p>
            <button
              type="button"
              onClick={() =>
                addSubtitleSegment(playheadTime, playheadTime + 2.5, "New subtitle", targetClip?.id)
              }
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800"
            >
              <Plus className="h-3 w-3 text-violet-400" />
              <span>Add Cue</span>
            </button>
          </div>

          {subtitles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-[#09090B] p-4 text-center space-y-1.5">
              <p className="text-xs text-zinc-400">No subtitles yet</p>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Click Generate Subtitles above to transcribe the selected clip locally with faster-whisper, or add cues manually.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {subtitles.map((cue, idx) => {
                const isActive = playheadTime >= cue.start && playheadTime < cue.end;
                return (
                  <div
                    key={cue.id}
                    className={`rounded-xl border p-2.5 space-y-2 transition-colors ${
                      isActive
                        ? "border-violet-500/70 bg-violet-500/10"
                        : "border-zinc-800/80 bg-[#111114]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSeek(cue.start)}
                        className="text-[11px] font-mono text-violet-300 hover:text-violet-200 tabular-nums"
                        title="Jump playhead to cue start"
                      >
                        #{idx + 1} · {formatTimecode(cue.start)}
                      </button>

                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={cue.start}
                          aria-label={`Cue ${idx + 1} start seconds`}
                          onChange={(e) => {
                            const nextStart = Math.max(0, Number(e.target.value) || 0);
                            const nextEnd = Math.max(
                              Number((nextStart + 0.1).toFixed(2)),
                              cue.end
                            );
                            updateSubtitleSegment(cue.id, {
                              start: Number(nextStart.toFixed(2)),
                              end: nextEnd,
                            });
                          }}
                          className="w-14 rounded border border-zinc-800 bg-[#09090B] px-1.5 py-0.5 text-[11px] font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-zinc-500">–</span>
                        <input
                          type="number"
                          min={Number((cue.start + 0.1).toFixed(2))}
                          step={0.1}
                          value={cue.end}
                          aria-label={`Cue ${idx + 1} end seconds`}
                          onChange={(e) => {
                            const parsed = Number(e.target.value);
                            const nextEnd = Math.max(
                              Number((cue.start + 0.1).toFixed(2)),
                              Number.isFinite(parsed) ? parsed : cue.start + 0.5
                            );
                            updateSubtitleSegment(cue.id, {
                              end: Number(nextEnd.toFixed(2)),
                            });
                          }}
                          className="w-14 rounded border border-zinc-800 bg-[#09090B] px-1.5 py-0.5 text-[11px] font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => deleteSubtitleSegment(cue.id)}
                          className="p-1 text-zinc-500 hover:text-rose-400"
                          aria-label={`Delete subtitle cue ${idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <textarea
                      rows={2}
                      dir="auto"
                      value={cue.text}
                      onChange={(e) =>
                        updateSubtitleSegment(cue.id, { text: e.target.value })
                      }
                      className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2.5 py-1.5 text-xs text-zinc-100 leading-relaxed focus:border-violet-500 focus:outline-none resize-none"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer Actions: Save to MongoDB + Download SRT/VTT */}
      <div className="p-3 border-t border-zinc-800/80 bg-[#09090B] space-y-2">
        <button
          type="button"
          onClick={() => void handleSaveToMongo()}
          disabled={savingDb}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 py-2 px-3 text-xs font-medium text-zinc-100 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          {savingDb ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
              <span>Saving to MongoDB...</span>
            </>
          ) : (
            <>
              <Database className="h-3.5 w-3.5 text-blue-400" />
              <span>{isAuthenticated ? "Save Subtitles to MongoDB" : "Sign In to Save to MongoDB"}</span>
            </>
          )}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleDownloadSrt}
            disabled={subtitles.length === 0}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] py-1.5 px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5 text-violet-400" />
            <span>Download .srt</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadVtt}
            disabled={subtitles.length === 0}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] py-1.5 px-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5 text-blue-400" />
            <span>Download .vtt</span>
          </button>
        </div>
      </div>
    </div>
  );
}
