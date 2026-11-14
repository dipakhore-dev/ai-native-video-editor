import React, { useMemo, useState } from "react";
import { X, Download, AlertCircle, FileJson, ArrowRight } from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import { submitExportJob } from "../../services/api";
import type { Project } from "../../types/studio";
import { formatTimecode } from "../../utils/media";
import { buildStructuredTimelineSpec } from "../../utils/timeline";

interface ExportModalProps {
  project: Project;
  totalDuration: number;
  onClose: () => void;
}

export function ExportModal({ project, totalDuration, onClose }: ExportModalProps) {
  const { recordExportAttempt, navigate } = useStudio();
  const [format, setFormat] = useState<"mp4" | "webm" | "mov">("mp4");
  const [resolution, setResolution] = useState(
    project.resolution === "4K"
      ? "3840x2160"
      : project.resolution === "720p"
      ? "1280x720"
      : "1920x1080"
  );
  const [fps, setFps] = useState<number>(project.fps);
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const structuredSpec = useMemo(
    () => buildStructuredTimelineSpec(project, resolution, fps),
    [project, resolution, fps]
  );

  const snapshotJson = useMemo(() => JSON.stringify(structuredSpec, null, 2), [structuredSpec]);

  const handleExportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResultMessage(null);

    const res = await submitExportJob({
      projectId: project.id,
      projectName: project.name,
      resolution,
      format,
      fps,
      clipCount: project.clips.length,
      totalDuration,
      timelineSpec: structuredSpec,
    });

    setSubmitting(false);

    const msg =
      res.error ||
      "Cloud render worker is not connected. No video was exported. Structured timeline specification recorded in Export History.";
    setResultMessage(msg);

    recordExportAttempt({
      id: `exp_${Date.now()}`,
      projectId: project.id,
      projectName: project.name,
      resolution,
      format,
      fps,
      clipCount: project.clips.length,
      totalDuration,
      status: "integration_required",
      message: msg,
      requestedAt: new Date().toISOString(),
      timelineSnapshotJson: snapshotJson,
    });
  };

  const downloadJson = () => {
    const blob = new Blob([snapshotJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name.toLowerCase().replace(/\s+/g, "-")}-render-spec.json`;
    a.click();
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
            <h2 className="text-base font-semibold text-white">Prepare Render Specification</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            aria-label="Close export modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleExportSubmit} className="mt-5 space-y-4">
          <div className="rounded-lg border border-zinc-800/80 bg-[#09090B] p-3 text-xs flex items-center justify-between">
            <span className="text-zinc-300 font-medium truncate">{project.name}</span>
            <span className="font-mono text-zinc-400 tabular-nums shrink-0">
              {project.clips.length} clips · {formatTimecode(totalDuration)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Format</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as "mp4" | "webm" | "mov")}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
              >
                <option value="mp4">MP4 (H.264)</option>
                <option value="webm">WebM (VP9)</option>
                <option value="mov">MOV (ProRes)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Resolution</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
              >
                <option value="1920x1080">1080p</option>
                <option value="3840x2160">4K UHD</option>
                <option value="1280x720">720p</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">Frame Rate</label>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
              >
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </div>
          </div>

          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Schema v{structuredSpec.schemaVersion} includes {structuredSpec.clips.length} timed clips and text overlays. Video transcoding requires a connected backend render worker.
          </p>

          {resultMessage && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p className="leading-relaxed">{resultMessage}</p>
              </div>
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
          )}

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-2">
            <button
              type="button"
              onClick={downloadJson}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
            >
              <FileJson className="h-3.5 w-3.5 text-blue-400" />
              <span>Download Render JSON</span>
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50"
            >
              <span>{submitting ? "Dispatching..." : "Dispatch to Render API"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
