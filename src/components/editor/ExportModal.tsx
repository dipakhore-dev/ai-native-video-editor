import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Download,
  AlertCircle,
  FileJson,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LogIn,
  Captions,
  Ban,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import {
  cancelExportMp4,
  exportTimelineMp4,
  fetchExportProgress,
} from "../../services/api";
import type { Project, RenderTimelinePayload } from "../../types/studio";
import { formatBytes, formatTimecode, resolveClipSourceFile } from "../../utils/media";
import { getSubtitleStyle } from "../../utils/subtitles";
import { buildStructuredTimelineSpec } from "../../utils/timeline";

interface ExportModalProps {
  project: Project;
  totalDuration: number;
  onClose: () => void;
}

interface ExportFeedbackState {
  kind: "success" | "error" | "cancelled" | "integration" | "auth";
  message: string;
  downloadUrl?: string;
  filename?: string;
  sizeBytes?: number;
}

interface LiveExportProgress {
  stage: string;
  stageLabel: string;
  progress: number;
  measurable: boolean;
  elapsedMs: number;
}

function formatElapsedDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function validateTimelineForLocalMp4(
  project: Project,
  format: "mp4" | "webm" | "mov",
  resolution: string,
  fps: number
): string | null {
  if (format !== "mp4") {
    return `Format '${format.toUpperCase()}' is not supported. Synchronous local FFmpeg export supports MP4 (H.264) only.`;
  }

  if (resolution === "3840x2160") {
    return "4K export is not supported in synchronous local MP4 export. Choose 1080p or 720p.";
  }

  if (![24, 30, 60].includes(fps)) {
    return `Frame rate ${fps} fps is not supported. Choose 24, 30, or 60 fps.`;
  }

  if (project.clips.length === 0) {
    return "Timeline is empty. Add at least one video or image clip to track V1 before exporting.";
  }

  if (project.clips.length > 24) {
    return "Synchronous local MP4 export supports up to 24 clips (up to 8 per track).";
  }

  const v1Clips = [];
  const v2Clips = [];
  const t1Clips = [];
  const a1Clips = [];

  for (const clip of project.clips) {
    if ((clip.kind === "video" || clip.kind === "image") && clip.trackId === "track_v1") {
      v1Clips.push(clip);
    } else if ((clip.kind === "image" || clip.kind === "video") && clip.trackId === "track_v2") {
      v2Clips.push(clip);
    } else if (clip.kind === "text" && clip.trackId === "track_t1") {
      t1Clips.push(clip);
    } else if (clip.kind === "audio" && clip.trackId === "track_a1") {
      a1Clips.push(clip);
    } else {
      return `Clip '${clip.name}' (${clip.kind} on '${clip.trackId}') is not a supported track/type combination for MP4 export.`;
    }

    if (clip.kind !== "text" && clip.needsRelink) {
      return `Clip '${clip.name}' is missing from local IndexedDB storage. Use "Re-link File" in the Media Bin or Timeline before exporting.`;
    }
    if (!Number.isFinite(clip.speed) || clip.speed < 0.5 || clip.speed > 2.0) {
      return `Clip '${clip.name}' uses unsupported ${clip.speed}x speed. Supported export speed range is 0.5x to 2.0x.`;
    }
    if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 2) {
      return `Clip '${clip.name}' volume (${Math.round(clip.volume * 100)}%) must be between 0% and 200%.`;
    }
    const fadeIn = clip.fadeInSec ?? 0;
    const fadeOut = clip.fadeOutSec ?? 0;
    if (fadeIn < 0 || fadeIn > 30 || fadeOut < 0 || fadeOut > 30) {
      return `Clip '${clip.name}' fade-in/fade-out durations must be between 0s and 30s.`;
    }
    if (!Number.isFinite(clip.opacity) || clip.opacity < 0 || clip.opacity > 1) {
      return `Clip '${clip.name}' opacity (${Math.round(clip.opacity * 100)}%) must be between 0% and 100%.`;
    }
    for (const [label, tr] of [
      ["Transition In", clip.transitionIn],
      ["Transition Out", clip.transitionOut],
    ] as const) {
      if (
        tr &&
        tr.type !== "none" &&
        (!Number.isFinite(tr.durationSec) || tr.durationSec < 0.2 || tr.durationSec > 2.0)
      ) {
        return `Clip '${clip.name}' ${label} duration must be between 0.2s and 2.0s.`;
      }
    }
  }

  if (v1Clips.length === 0) {
    return "Timeline must include at least one video or image clip on track V1 before exporting MP4.";
  }
  if (
    v1Clips.length > 8 ||
    v2Clips.length > 8 ||
    t1Clips.length > 8 ||
    a1Clips.length > 8
  ) {
    return "Synchronous local MP4 export supports up to 8 clips per track.";
  }

  const sortedV1 = [...v1Clips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (sortedV1[0].startTime > 0.15) {
    return "Timeline starts with an empty gap before the first V1 clip. Move the first clip to 00:00 before exporting.";
  }

  for (let i = 0; i < sortedV1.length - 1; i++) {
    const curEnd = sortedV1[i].startTime + sortedV1[i].duration;
    const gap = sortedV1[i + 1].startTime - curEnd;
    if (gap < -0.05) {
      return "Overlapping clips on track V1 are not supported in FFmpeg MP4 export. Arrange clips sequentially without overlap.";
    }
    if (gap > 0.15) {
      return "Empty gaps between clips on track V1 are not supported in FFmpeg MP4 export. Close timeline gaps before exporting.";
    }
  }

  return null;
}

function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function ExportModal({ project, totalDuration, onClose }: ExportModalProps) {
  const { mediaAssets, recordExportAttempt, navigate } = useStudio();
  const [format, setFormat] = useState<"mp4" | "webm" | "mov">("mp4");
  const [resolution, setResolution] = useState(
    project.resolution === "4K"
      ? "3840x2160"
      : project.resolution === "720p"
        ? "1280x720"
        : "1920x1080"
  );
  const validSubtitles = useMemo(
    () =>
      (project.subtitles ?? []).filter(
        (s) => s.text.trim().length > 0 && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0
      ),
    [project.subtitles]
  );
  const subtitleStyle = useMemo(() => getSubtitleStyle(project), [project]);

  const [fps, setFps] = useState<number>(project.fps);
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(validSubtitles.length > 0);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [liveProgress, setLiveProgress] = useState<LiveExportProgress | null>(null);
  const [feedback, setFeedback] = useState<ExportFeedbackState | null>(null);

  const activeJobIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const stopProgressTimers = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (feedback?.downloadUrl) {
        URL.revokeObjectURL(feedback.downloadUrl);
      }
    };
  }, [feedback?.downloadUrl]);

  useEffect(() => {
    return () => {
      stopProgressTimers();
      if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
        abortControllerRef.current.abort();
        if (activeJobIdRef.current) {
          void cancelExportMp4(activeJobIdRef.current);
        }
      }
    };
  }, []);

  const structuredSpec = useMemo(
    () => buildStructuredTimelineSpec(project, resolution, fps),
    [project, resolution, fps]
  );

  const snapshotJson = useMemo(() => JSON.stringify(structuredSpec, null, 2), [structuredSpec]);

  const handleCancelExport = async () => {
    if (!submitting || cancelling) return;
    setCancelling(true);
    setLiveProgress((prev) =>
      prev
        ? { ...prev, stage: "cancelled", stageLabel: "Cancelling export...", measurable: false }
        : {
            stage: "cancelled",
            stageLabel: "Cancelling export...",
            progress: 0,
            measurable: false,
            elapsedMs: Date.now() - startedAtRef.current,
          }
    );
    const jobId = activeJobIdRef.current;
    abortControllerRef.current?.abort();
    if (jobId) {
      await cancelExportMp4(jobId).catch(() => undefined);
    }
  };

  const handleExportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (feedback?.downloadUrl) {
      URL.revokeObjectURL(feedback.downloadUrl);
    }
    setFeedback(null);

    const validationError = validateTimelineForLocalMp4(project, format, resolution, fps);
    if (validationError) {
      setFeedback({ kind: "error", message: validationError });
      recordExportAttempt({
        id: `exp_${Date.now()}`,
        projectId: project.id,
        projectName: project.name,
        resolution,
        format,
        fps,
        clipCount: project.clips.length,
        totalDuration,
        status: "failed",
        message: validationError,
        requestedAt: new Date().toISOString(),
        timelineSnapshotJson: snapshotJson,
      });
      return;
    }

    const clientJobId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const abortController = new AbortController();
    activeJobIdRef.current = clientJobId;
    abortControllerRef.current = abortController;
    startedAtRef.current = Date.now();

    setCancelling(false);
    setSubmitting(true);
    setLiveProgress({
      stage: "preparing",
      stageLabel: "Reading local media assets",
      progress: 0,
      measurable: false,
      elapsedMs: 0,
    });

    elapsedTimerRef.current = window.setInterval(() => {
      setLiveProgress((prev) =>
        prev ? { ...prev, elapsedMs: Date.now() - startedAtRef.current } : prev
      );
    }, 250);

    try {
      const sortedClips = [...project.clips].sort(
        (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)
      );

      // Deduplicate source binary uploads when a single video is split into multiple clips
      const uniqueFiles: File[] = [];
      const sourceKeyToIndex = new Map<string, number>();
      const clipFileIndexById: Record<string, number> = {};

      for (const clip of sortedClips) {
        if (clip.kind === "text") {
          continue;
        }
        const key = clip.assetId || clip.objectUrl || clip.id;
        let idx = sourceKeyToIndex.get(key);
        if (idx === undefined) {
          const fileObj = await resolveClipSourceFile(clip, mediaAssets);
          idx = uniqueFiles.length;
          uniqueFiles.push(fileObj);
          sourceKeyToIndex.set(key, idx);
        }
        clipFileIndexById[clip.id] = idx;
      }

      if (abortController.signal.aborted) {
        stopProgressTimers();
        setSubmitting(false);
        setCancelling(false);
        setLiveProgress(null);
        setFeedback({
          kind: "cancelled",
          message: "Export cancelled by user before upload started.",
        });
        return;
      }

      const resolutionPreset = resolution === "1920x1080" ? "1080p" : "720p";
      const shouldBurnSubtitles = burnSubtitles && validSubtitles.length > 0;
      const exportSpec: RenderTimelinePayload & { format: "mp4" } = {
        ...structuredSpec,
        format: "mp4",
        project: {
          ...structuredSpec.project,
          resolution: resolutionPreset,
        },
        clips: structuredSpec.clips.map((c) => {
          if (c.kind === "text") {
            return c;
          }
          return {
            ...c,
            fileIndex: clipFileIndexById[c.id] ?? 0,
          };
        }),
        ...(shouldBurnSubtitles
          ? {
              burnSubtitles: true,
              subtitles: validSubtitles,
              subtitleStyle,
            }
          : {}),
      };

      const formData = new FormData();
      for (const fileObj of uniqueFiles) {
        formData.append("videos", fileObj, fileObj.name);
      }
      formData.append("format", "mp4");
      formData.append("resolution", resolutionPreset);
      formData.append("fps", String(fps));
      formData.append("aspectRatio", project.aspectRatio);
      formData.append("timelineSpec", JSON.stringify(exportSpec));
      formData.append("clientJobId", clientJobId);
      if (/^[a-f\d]{24}$/i.test(project.id)) {
        formData.append("projectId", project.id);
      }

      let uploadCompleted = false;
      setLiveProgress({
        stage: "uploading",
        stageLabel: "Uploading media to local processor",
        progress: 0,
        measurable: false,
        elapsedMs: Date.now() - startedAtRef.current,
      });

      const pollServerProgress = async () => {
        if (abortController.signal.aborted || !uploadCompleted) return;
        const snapRes = await fetchExportProgress(clientJobId);
        if (!snapRes.ok || !snapRes.data?.progress || abortController.signal.aborted) {
          return;
        }
        const snap = snapRes.data.progress;
        setLiveProgress({
          stage: snap.stage,
          stageLabel: snap.stageLabel,
          progress: snap.progress,
          measurable: snap.measurable,
          elapsedMs: Math.max(snap.elapsedMs, Date.now() - startedAtRef.current),
        });
      };

      pollTimerRef.current = window.setInterval(() => {
        void pollServerProgress();
      }, 450);

      const res = await exportTimelineMp4(formData, {
        signal: abortController.signal,
        onUploadProgress: (pct) => {
          if (abortController.signal.aborted || uploadCompleted) return;
          setLiveProgress({
            stage: "uploading",
            stageLabel:
              pct !== null
                ? `Uploading media (${pct}%)`
                : "Uploading media to local processor",
            progress: pct ?? 0,
            measurable: pct !== null,
            elapsedMs: Date.now() - startedAtRef.current,
          });
        },
        onUploadComplete: () => {
          uploadCompleted = true;
          if (abortController.signal.aborted) return;
          setLiveProgress((prev) => ({
            stage: "processing",
            stageLabel: "Starting FFmpeg render pipeline",
            progress: 5,
            measurable: false,
            elapsedMs: prev ? Date.now() - startedAtRef.current : 0,
          }));
          void pollServerProgress();
        },
      });

      stopProgressTimers();
      setSubmitting(false);
      setCancelling(false);
      setLiveProgress(null);
      activeJobIdRef.current = null;
      abortControllerRef.current = null;

      if (res.ok && res.data) {
        const downloadUrl = URL.createObjectURL(res.data.blob);
        triggerBrowserDownload(downloadUrl, res.data.filename);

        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
        const successMsg = `Exported ${res.data.filename} (${formatBytes(res.data.sizeBytes)}) in ${elapsedSec}s using FFmpeg.`;
        setFeedback({
          kind: "success",
          message: successMsg,
          downloadUrl,
          filename: res.data.filename,
          sizeBytes: res.data.sizeBytes,
        });

        recordExportAttempt({
          id: `exp_${Date.now()}`,
          projectId: project.id,
          projectName: project.name,
          resolution,
          format,
          fps,
          clipCount: project.clips.length,
          totalDuration,
          status: "completed",
          message: successMsg,
          requestedAt: new Date().toISOString(),
          timelineSnapshotJson: snapshotJson,
          outputFilename: res.data.filename,
          outputSizeBytes: res.data.sizeBytes,
        });
        return;
      }

      if (res.cancelled || res.status === 499) {
        const cancelMsg = "Export cancelled and temporary processing files were cleaned up.";
        setFeedback({ kind: "cancelled", message: cancelMsg });
        recordExportAttempt({
          id: `exp_${Date.now()}`,
          projectId: project.id,
          projectName: project.name,
          resolution,
          format,
          fps,
          clipCount: project.clips.length,
          totalDuration,
          status: "cancelled",
          message: cancelMsg,
          requestedAt: new Date().toISOString(),
          timelineSnapshotJson: snapshotJson,
        });
        return;
      }

      if (res.status === 401) {
        const authMsg =
          "Sign in to your account before exporting MP4 video through the backend FFmpeg worker.";
        setFeedback({ kind: "auth", message: authMsg });
        recordExportAttempt({
          id: `exp_${Date.now()}`,
          projectId: project.id,
          projectName: project.name,
          resolution,
          format,
          fps,
          clipCount: project.clips.length,
          totalDuration,
          status: "failed",
          message: authMsg,
          requestedAt: new Date().toISOString(),
          timelineSnapshotJson: snapshotJson,
        });
        return;
      }

      const errorMsg = res.error || "MP4 export failed.";
      const isWorkerUnavailable = res.status === 503;
      setFeedback({
        kind: isWorkerUnavailable ? "integration" : "error",
        message: errorMsg,
      });

      recordExportAttempt({
        id: `exp_${Date.now()}`,
        projectId: project.id,
        projectName: project.name,
        resolution,
        format,
        fps,
        clipCount: project.clips.length,
        totalDuration,
        status: isWorkerUnavailable ? "integration_required" : "failed",
        message: errorMsg,
        requestedAt: new Date().toISOString(),
        timelineSnapshotJson: snapshotJson,
      });
    } catch (err) {
      stopProgressTimers();
      setSubmitting(false);
      setCancelling(false);
      setLiveProgress(null);
      activeJobIdRef.current = null;
      abortControllerRef.current = null;
      const errMsg = err instanceof Error ? err.message : "Could not read local video file bytes.";
      setFeedback({ kind: "error", message: errMsg });
      recordExportAttempt({
        id: `exp_${Date.now()}`,
        projectId: project.id,
        projectName: project.name,
        resolution,
        format,
        fps,
        clipCount: project.clips.length,
        totalDuration,
        status: "failed",
        message: errMsg,
        requestedAt: new Date().toISOString(),
        timelineSnapshotJson: snapshotJson,
      });
    }
  };

  const downloadJson = () => {
    const blob = new Blob([snapshotJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    triggerBrowserDownload(
      url,
      `${project.name.toLowerCase().replace(/\s+/g, "-")}-render-spec.json`
    );
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#111114] p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-violet-400" />
            <h2 className="text-base font-semibold text-white">Export Video</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            aria-label="Close export modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleExportSubmit} className="mt-5 space-y-4">
          <div className="rounded-lg border border-zinc-800/80 bg-[#09090B] p-3 text-xs flex items-center justify-between">
            <span className="text-zinc-300 font-medium truncate">{project.name}</span>
            <span className="font-mono text-zinc-400 tabular-nums shrink-0">
              {project.aspectRatio} · {project.clips.length} clips · {formatTimecode(totalDuration)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Format</label>
              <select
                value={format}
                disabled={submitting}
                onChange={(e) => setFormat(e.target.value as "mp4" | "webm" | "mov")}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              >
                <option value="mp4">MP4 (H.264)</option>
                <option value="webm">WebM (Unsupported)</option>
                <option value="mov">MOV (Unsupported)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Resolution</label>
              <select
                value={resolution}
                disabled={submitting}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              >
                <option value="1920x1080">1080p</option>
                <option value="1280x720">720p</option>
                <option value="3840x2160">4K (Unsupported)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Frame Rate</label>
              <select
                value={fps}
                disabled={submitting}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
              >
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>

          {/* Burn-in Subtitles Option */}
          <label
            className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs transition-colors ${
              validSubtitles.length > 0
                ? "border-zinc-800 bg-[#09090B] cursor-pointer hover:border-zinc-700"
                : "border-zinc-800/60 bg-[#09090B]/60 opacity-60 cursor-not-allowed"
            }`}
          >
            <input
              type="checkbox"
              checked={burnSubtitles && validSubtitles.length > 0}
              disabled={submitting || validSubtitles.length === 0}
              onChange={(e) => setBurnSubtitles(e.target.checked)}
              className="mt-0.5 accent-violet-500 rounded"
            />
            <div className="space-y-0.5 min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-zinc-200">
                <Captions className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                <span>Burn subtitles into exported MP4 (FFmpeg)</span>
              </div>
              <p className="text-[11px] text-zinc-400">
                {validSubtitles.length > 0
                  ? `${validSubtitles.length} cues · ${subtitleStyle.fontSize}px · ${subtitleStyle.position} position`
                  : "No subtitle cues in project yet. Generate or add subtitles in the Subtitles tab to burn them into MP4."}
              </p>
            </div>
          </label>

          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Renders V1 video/images, V2 overlays, T1 text titles, playback speed (0.5x–2x with pitch preservation), transitions, color grading &amp; blur effects, opacity, A1 audio mixing, and optional burned subtitles into {project.aspectRatio} MP4 via local FFmpeg.
          </p>

          {submitting && liveProgress && (
            <div
              className="rounded-lg border border-violet-500/30 bg-[#09090B] p-3 space-y-2"
              data-testid="export-progress-panel"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400 shrink-0" />
                  <span className="font-medium text-zinc-100 truncate">
                    {liveProgress.stageLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums">
                  {liveProgress.measurable && (
                    <span className="text-violet-300 font-semibold">
                      {liveProgress.progress}%
                    </span>
                  )}
                  <span>{formatElapsedDuration(liveProgress.elapsedMs)}</span>
                </div>
              </div>
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                {liveProgress.measurable ? (
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500 transition-[width] duration-200"
                    style={{ width: `${Math.max(2, Math.min(100, liveProgress.progress))}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-violet-500 to-blue-500 animate-pulse" />
                )}
              </div>
            </div>
          )}

          {feedback && (
            <div
              className={`rounded-lg border p-3 text-xs space-y-2 ${
                feedback.kind === "success"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : feedback.kind === "cancelled"
                    ? "border-zinc-700 bg-zinc-900/80 text-zinc-200"
                    : feedback.kind === "integration"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-200"
              }`}
            >
              <div className="flex items-start gap-2">
                {feedback.kind === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
                ) : feedback.kind === "cancelled" ? (
                  <Ban className="h-4 w-4 shrink-0 mt-0.5 text-zinc-400" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <p className="leading-relaxed">{feedback.message}</p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {feedback.downloadUrl && feedback.filename && (
                  <button
                    type="button"
                    onClick={() => triggerBrowserDownload(feedback.downloadUrl!, feedback.filename!)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-white underline underline-offset-2"
                  >
                    <Download className="h-3 w-3" />
                    <span>Download Again</span>
                  </button>
                )}
                {feedback.kind === "auth" && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate("auth");
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-white underline underline-offset-2"
                  >
                    <LogIn className="h-3 w-3" />
                    <span>Go to Sign In</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate("exports");
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-white underline underline-offset-2"
                >
                  <span>View Export History</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-2">
            <button
              type="button"
              onClick={downloadJson}
              disabled={submitting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              <FileJson className="h-3.5 w-3.5 text-blue-400" />
              <span>Download Render JSON</span>
            </button>
            <div className="flex items-center gap-2">
              {submitting ? (
                <button
                  type="button"
                  onClick={handleCancelExport}
                  disabled={cancelling}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                >
                  <Ban className="h-3.5 w-3.5" />
                  <span>{cancelling ? "Cancelling..." : "Cancel Export"}</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Export MP4</span>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
