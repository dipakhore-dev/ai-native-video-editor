import { useEffect, useState } from "react";
import {
  Download,
  FileJson,
  Film,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
  Ban,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import type { ExportAttempt, ExportProfileId } from "../types/studio";
import { formatBytes, formatTimecode } from "../utils/media";
import {
  canRetryExportAttempt,
  getExportFileBlob,
  listAvailableExportFileIds,
} from "../utils/exportHistoryStorage";

const PROFILE_LABELS: Record<ExportProfileId, string> = {
  fast_preview: "Fast Preview",
  balanced: "Balanced",
  high_quality: "High Quality",
};

function formatRenderDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export function ExportsPage() {
  const {
    exportAttempts,
    deleteExportAttempt,
    retryFailedExport,
    navigate,
  } = useStudio();

  const [availableIds, setAvailableIds] = useState<Set<string>>(() => new Set());
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExportAttempt | null>(null);

  useEffect(() => {
    let active = true;
    const ids = exportAttempts.map((a) => a.id);
    if (ids.length === 0) {
      setAvailableIds(new Set());
      return;
    }
    void listAvailableExportFileIds(ids).then((found) => {
      if (active) {
        setAvailableIds(found);
      }
    });
    return () => {
      active = false;
    };
  }, [exportAttempts]);

  const downloadMp4 = async (attempt: ExportAttempt) => {
    if (downloadingId) return;
    setDownloadError(null);
    setDownloadingId(attempt.id);
    try {
      const blob = await getExportFileBlob(attempt.id);
      if (!blob || blob.size === 0) {
        setAvailableIds((prev) => {
          const next = new Set(prev);
          next.delete(attempt.id);
          return next;
        });
        setDownloadError(
          `The exported MP4 for "${attempt.projectName}" is no longer available in local browser storage.`
        );
        return;
      }

      const url = URL.createObjectURL(blob);
      const filename =
        attempt.outputFilename ||
        `${attempt.projectName.toLowerCase().replace(/\s+/g, "-") || "export"}.mp4`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setDownloadingId(null);
    }
  };

  const downloadSnapshot = (filename: string, json: string) => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <StudioShell
      headerAction={
        <button
          type="button"
          onClick={() => navigate("editor")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Film className="h-3.5 w-3.5 text-violet-400" />
          <span>Back to Editor</span>
        </button>
      }
    >
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">Export History</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Track MP4 renders, inspect export profiles and durations, retry failed jobs, and download available local MP4 files.
          </p>
        </div>

        {downloadError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-center justify-between gap-2">
            <span>{downloadError}</span>
            <button
              type="button"
              onClick={() => setDownloadError(null)}
              className="text-amber-300 hover:text-white text-xs font-medium"
            >
              Dismiss
            </button>
          </div>
        )}

        {exportAttempts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#111114]/70 p-12 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-blue-400 mb-4">
              <Download className="h-5 w-5" />
            </div>
            <h2 className="text-base font-medium text-white">No export jobs submitted yet</h2>
            <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
              Open a sequence in the Video Editor and click Export Video to render an MP4 or download a timeline specification.
            </p>
            <div className="mt-5">
              <button
                type="button"
                onClick={() => navigate("editor")}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Film className="h-3.5 w-3.5" />
                <span>Open Video Editor</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800/80 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Project &amp; Date</th>
                  <th className="py-3.5 px-4 font-medium">Profile &amp; Output</th>
                  <th className="py-3.5 px-4 font-medium text-right">Size</th>
                  <th className="py-3.5 px-4 font-medium text-right">Durations</th>
                  <th className="py-3.5 px-4 font-medium">Status</th>
                  <th className="py-3.5 px-5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {exportAttempts.map((item) => {
                  const hasActualBlob = item.status === "completed" && availableIds.has(item.id);
                  const canRetry = canRetryExportAttempt(item);
                  const hasSnapshot =
                    typeof item.timelineSnapshotJson === "string" &&
                    item.timelineSnapshotJson.trim().length > 2;
                  const profileLabel = item.exportProfile
                    ? PROFILE_LABELS[item.exportProfile]
                    : "Standard";

                  return (
                    <tr key={item.id} className="hover:bg-zinc-900/50">
                      <td className="py-3.5 px-5">
                        <p className="font-medium text-white">{item.projectName}</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                          {new Date(item.requestedAt).toLocaleString()}
                        </p>
                      </td>

                      <td className="py-3.5 px-4 font-mono text-zinc-300 tabular-nums">
                        <p className="text-zinc-200">
                          {profileLabel} · {item.resolution} · {item.fps}fps
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          {item.format.toUpperCase()}
                          {item.encoderUsed ? ` · ${item.encoderUsed}` : ""}
                          {item.aspectRatio ? ` · ${item.aspectRatio}` : ""}
                        </p>
                      </td>

                      <td className="py-3.5 px-4 font-mono text-zinc-300 text-right tabular-nums">
                        {item.outputSizeBytes && item.outputSizeBytes > 0
                          ? formatBytes(item.outputSizeBytes)
                          : "—"}
                      </td>

                      <td className="py-3.5 px-4 font-mono text-zinc-300 text-right tabular-nums">
                        <p>{formatRenderDuration(item.exportDurationMs)}</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          Seq {formatTimecode(item.totalDuration)}
                        </p>
                      </td>

                      <td className="py-3.5 px-4">
                        {item.status === "completed" ? (
                          <div className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>Completed</span>
                          </div>
                        ) : item.status === "failed" ? (
                          <div className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
                            <XCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>Failed</span>
                          </div>
                        ) : item.status === "cancelled" ? (
                          <div className="inline-flex items-center gap-1.5 text-zinc-300 font-medium">
                            <Ban className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span>Cancelled</span>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            <span>Worker Unavailable</span>
                          </div>
                        )}
                        <p className="text-[11px] text-zinc-500 mt-0.5 max-w-xs break-words">
                          {item.message}
                        </p>
                        {item.status === "completed" && !hasActualBlob && (
                          <p className="text-[10px] text-zinc-500 mt-0.5">
                            MP4 unavailable locally
                          </p>
                        )}
                      </td>

                      <td className="py-3.5 px-5 text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          {hasActualBlob && (
                            <button
                              type="button"
                              disabled={downloadingId === item.id}
                              onClick={() => void downloadMp4(item)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>{downloadingId === item.id ? "Saving..." : "Download MP4"}</span>
                            </button>
                          )}

                          {canRetry && (
                            <button
                              type="button"
                              onClick={() => retryFailedExport(item)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20 transition-colors whitespace-nowrap"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Retry</span>
                            </button>
                          )}

                          {hasSnapshot && (
                            <button
                              type="button"
                              onClick={() =>
                                downloadSnapshot(
                                  `${item.projectName.toLowerCase().replace(/\s+/g, "-")}-timeline.json`,
                                  item.timelineSnapshotJson
                                )
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap"
                              title="Download timeline render specification JSON"
                            >
                              <FileJson className="h-3.5 w-3.5 text-blue-400" />
                              <span>JSON</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => setPendingDelete(item)}
                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400 transition-colors"
                            aria-label={`Delete export record for ${item.projectName}`}
                            title="Delete export history entry"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <IntegrationNotice
          title="Local MP4 Cache & Export History"
          endpoint="POST /api/video/export-mp4"
          description="Recently exported MP4 files are cached locally in browser IndexedDB (bounded to 5 files / 150 MB) for direct re-download. When signed in, export history metadata syncs with MongoDB."
        />
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete Export Entry"
        description={
          pendingDelete
            ? `Remove the export record for "${pendingDelete.projectName}"? This removes the history entry and any locally cached MP4 file for this export.`
            : ""
        }
        confirmLabel="Delete Entry"
        cancelLabel="Keep Entry"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteExportAttempt(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </StudioShell>
  );
}
