import React, { useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { StoryboardMediaSummary } from "../../types/studio";

interface StoryboardMediaPrepSectionProps {
  summary: StoryboardMediaSummary;
  mediaPrepActive: boolean;
  overwriteManual: boolean;
  onToggleOverwriteManual: (next: boolean) => void;
  onAutoMatch: () => void;
  onUploadBatch: (files: FileList) => Promise<void> | void;
  onOpenLibraryForFirstUnassigned: () => void;
  onClearAllAssignments: () => void;
  onCancelPrep: () => void;
  statusMessage: string | null;
}

export function StoryboardMediaPrepSection({
  summary,
  mediaPrepActive,
  overwriteManual,
  onToggleOverwriteManual,
  onAutoMatch,
  onUploadBatch,
  onOpenLibraryForFirstUnassigned,
  onClearAllAssignments,
  onCancelPrep,
  statusMessage,
}: StoryboardMediaPrepSectionProps) {
  const batchInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3.5">
      <input
        ref={batchInputRef}
        type="file"
        multiple
        accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void onUploadBatch(e.target.files);
          }
          e.target.value = "";
        }}
      />

      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {summary.isMediaReady ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle
                className={`h-4 w-4 shrink-0 ${
                  summary.missingOrInvalidCount > 0 ? "text-rose-400" : "text-amber-400"
                }`}
              />
            )}
            <h3 className="text-xs font-semibold text-white">
              Scene Media Preparation (Phase 5.5.2)
            </h3>
            <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
              {summary.readyCount}/{summary.totalScenes} Ready ({summary.progressPercent}%)
            </span>
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {summary.isMediaReady
              ? "All scenes have valid local visual media assigned and are prepared for future timeline composition."
              : summary.missingOrInvalidCount > 0
                ? `${summary.missingOrInvalidCount} scene(s) reference missing or invalid media files in IndexedDB. Re-link or replace them before saving as ready.`
                : `${summary.unassignedCount} scene(s) still need a video, image, stock asset, or locally rendered text slide.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={mediaPrepActive}
            onClick={onAutoMatch}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Auto Match Media</span>
          </button>

          <button
            type="button"
            disabled={mediaPrepActive}
            onClick={() => batchInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5 text-blue-400" />
            <span>Upload Media</span>
          </button>

          <button
            type="button"
            disabled={mediaPrepActive}
            onClick={onOpenLibraryForFirstUnassigned}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5 text-emerald-400" />
            <span>Assign From Library / Stock</span>
          </button>

          {summary.assignedCount + summary.missingOrInvalidCount > 0 && !mediaPrepActive && (
            <button
              type="button"
              onClick={onClearAllAssignments}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-400 hover:text-rose-300 hover:border-rose-500/40 transition-colors"
              title="Clear scene media assignments without deleting library files"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear Assignments</span>
            </button>
          )}

          {mediaPrepActive && (
            <button
              type="button"
              onClick={onCancelPrep}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/25"
            >
              <X className="h-3.5 w-3.5" />
              <span>Cancel Prep</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress & Metrics Row */}
      <div className="space-y-2">
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ${
              summary.missingOrInvalidCount > 0
                ? "bg-rose-500"
                : summary.isMediaReady
                  ? "bg-emerald-500"
                  : "bg-violet-500"
            }`}
            style={{ width: `${Math.max(summary.progressPercent, summary.readyCount > 0 ? 4 : 0)}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-3 font-mono text-zinc-400 tabular-nums">
            <span>Assigned: {summary.assignedCount}</span>
            <span>Unassigned: {summary.unassignedCount}</span>
            <span>Missing/Invalid: {summary.missingOrInvalidCount}</span>
            <span>Composition Ready: No (Phase 5.5.3+)</span>
          </div>

          <label className="inline-flex items-center gap-1.5 text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={overwriteManual}
              onChange={(e) => onToggleOverwriteManual(e.target.checked)}
              className="accent-violet-500"
            />
            <span>Overwrite already assigned scenes on Auto Match</span>
          </label>
        </div>

        {statusMessage && (
          <p className="text-[11px] text-violet-300">{statusMessage}</p>
        )}
      </div>
    </div>
  );
}
