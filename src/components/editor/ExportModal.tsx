import React, { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import { exportTimelineMp4 } from "../../services/api";
import type { MediaAsset, Project, RenderTimelinePayload, TimelineClip } from "../../types/studio";
import { formatBytes, formatTimecode } from "../../utils/media";
import { getSubtitleStyle } from "../../utils/subtitles";
import { buildStructuredTimelineSpec } from "../../utils/timeline";

interface ExportModalProps {
  project: Project;
  totalDuration: number;
  onClose: () => void;
}

interface ExportFeedbackState {
  kind: "success" | "error" | "integration" | "auth";
  message: string;
  downloadUrl?: string;
  filename?: string;
  sizeBytes?: number;
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
    return "Timeline is empty. Add at least one video clip to track V1 before exporting.";
  }

  if (project.clips.length > 8) {
    return "Synchronous local MP4 export supports up to 8 clips per timeline.";
  }

  const mutedTrackIds = new Set(project.tracks.filter((t) => t.muted).map((t) => t.id));

  for (const clip of project.clips) {
    if (mutedTrackIds.has(clip.trackId)) {
      return `Track '${clip.trackId}' is muted while containing '${clip.name}'. Unmute the track or remove its clips before exporting.`;
    }
    if (clip.kind !== "video") {
      return `Clip '${clip.name}' (${clip.kind}) is not supported in FFmpeg MP4 export yet. Only video clips on track V1 are supported (text overlays, images, and standalone audio clips are not burned into MP4).`;
    }
    if (clip.trackId !== "track_v1") {
      return `Clip '${clip.name}' is on track '${clip.trackId}'. FFmpeg MP4 export currently supports primary video track V1 only.`;
    }
    if (clip.needsRelink) {
      return `Clip '${clip.name}' needs to be relinked from your local disk before exporting.`;
    }
    if (Math.abs(clip.speed - 1) > 0.01) {
      return `Clip '${clip.name}' uses ${clip.speed}x speed. Variable clip speed is not supported in FFmpeg MP4 export yet; reset speed to 1.0x.`;
    }
    if (Math.abs(clip.volume - 1) > 0.05) {
      return `Clip '${clip.name}' uses ${Math.round(clip.volume * 100)}% volume. Per-clip volume changes are not supported in FFmpeg MP4 export yet; set volume to 100%.`;
    }
    if (Math.abs(clip.opacity - 1) > 0.01) {
      return `Clip '${clip.name}' uses ${Math.round(clip.opacity * 100)}% opacity. Clip opacity changes are not supported in FFmpeg MP4 export yet; set opacity to 100%.`;
    }
  }

  const sorted = [...project.clips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (sorted[0].startTime > 0.15) {
    return "Timeline starts with an empty gap before the first clip. Move the first clip to 00:00 before exporting.";
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const curEnd = sorted[i].startTime + sorted[i].duration;
    const gap = sorted[i + 1].startTime - curEnd;
    if (gap < -0.05) {
      return "Overlapping clips on track V1 are not supported in FFmpeg MP4 export. Arrange clips sequentially without overlap.";
    }
    if (gap > 0.15) {
      return "Empty gaps between clips on track V1 are not supported in FFmpeg MP4 export. Close timeline gaps before exporting.";
    }
  }

  return null;
}

async function resolveClipFile(
  clip: TimelineClip,
  mediaAssets: MediaAsset[]
): Promise<File> {
  const asset = mediaAssets.find((a) => a.id === clip.assetId);
  if (asset?.sourceFile && asset.sourceFile.size > 0) {
    return asset.sourceFile;
  }

  const candidateUrl = clip.objectUrl || asset?.objectUrl || "";
  if (candidateUrl.startsWith("blob:")) {
    const response = await fetch(candidateUrl);
    if (!response.ok) {
      throw new Error(`Unable to read local file bytes for '${clip.name}'.`);
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Local media file for '${clip.name}' is empty.`);
    }
    const filename = clip.sourceName || clip.name || "clip.mp4";
    return new File([blob], filename, {
      type: blob.type || clip.sourceMimeType || "video/mp4",
    });
  }

  throw new Error(
    `Original video file bytes for '${clip.name}' are unavailable in this browser session. Re-import or relink the video file before exporting.`
  );
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
  const [feedback, setFeedback] = useState<ExportFeedbackState | null>(null);

  useEffect(() => {
    return () => {
      if (feedback?.downloadUrl) {
        URL.revokeObjectURL(feedback.downloadUrl);
      }
    };
  }, [feedback?.downloadUrl]);

  const structuredSpec = useMemo(
    () => buildStructuredTimelineSpec(project, resolution, fps),
    [project, resolution, fps]
  );

  const snapshotJson = useMemo(() => JSON.stringify(structuredSpec, null, 2), [structuredSpec]);

  const handleExportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

    setSubmitting(true);

    try {
      const sortedClips = [...project.clips].sort(
        (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)
      );

      // Deduplicate source binary uploads when a single video is split into multiple clips
      const uniqueFiles: File[] = [];
      const sourceKeyToIndex = new Map<string, number>();
      const clipFileIndexById: Record<string, number> = {};

      for (const clip of sortedClips) {
        const key = clip.assetId || clip.objectUrl || clip.id;
        let idx = sourceKeyToIndex.get(key);
        if (idx === undefined) {
          const fileObj = await resolveClipFile(clip, mediaAssets);
          idx = uniqueFiles.length;
          uniqueFiles.push(fileObj);
          sourceKeyToIndex.set(key, idx);
        }
        clipFileIndexById[clip.id] = idx;
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
        clips: structuredSpec.clips.map((c) => ({
          ...c,
          fileIndex: clipFileIndexById[c.id] ?? 0,
        })),
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
      if (/^[a-f\d]{24}$/i.test(project.id)) {
        formData.append("projectId", project.id);
      }

      const res = await exportTimelineMp4(formData);
      setSubmitting(false);

      if (res.ok && res.data) {
        const downloadUrl = URL.createObjectURL(res.data.blob);
        triggerBrowserDownload(downloadUrl, res.data.filename);

        const successMsg = `Exported ${res.data.filename} (${formatBytes(res.data.sizeBytes)}) using FFmpeg.`;
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
      setSubmitting(false);
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
            Uploads local track V1 video clips directly to the authenticated FFmpeg processor for clip trimming, merging, and {project.aspectRatio} MP4 rendering.
          </p>

          {feedback && (
            <div
              className={`rounded-lg border p-3 text-xs space-y-2 ${
                feedback.kind === "success"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : feedback.kind === "integration"
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
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Rendering MP4...</span>
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  <span>Export MP4</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
