import React, { useMemo, useRef, useState } from "react";
import {
  Upload,
  Search,
  Film,
  Image as ImageIcon,
  Music,
  Trash2,
  Play,
  Plus,
  LayoutGrid,
  List,
  X,
  HardDrive,
  AlertTriangle,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import type { MediaAsset, MediaKind } from "../types/studio";
import { formatBytes, formatTimecode } from "../utils/media";

export function MediaLibraryPage() {
  const {
    mediaAssets,
    projects,
    uploadLocalFiles,
    uploadingMedia,
    idbHydrating,
    storageEstimate,
    mediaError,
    clearMediaError,
    getProjectsUsingAsset,
    removeMediaAsset,
    cleanupUnusedMediaAssets,
    addClipToTimeline,
    navigate,
  } = useStudio();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState<"all" | MediaKind>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [dragOver, setDragOver] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
  const [confirmDeleteAssetId, setConfirmDeleteAssetId] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  const filteredAssets = useMemo(() => {
    return mediaAssets.filter((asset) => {
      const matchesKind = filter === "all" || asset.kind === filter;
      const matchesSearch = asset.name.toLowerCase().includes(search.trim().toLowerCase());
      return matchesKind && matchesSearch;
    });
  }, [mediaAssets, filter, search]);

  const unusedCount = useMemo(() => {
    const usedIds = new Set(projects.flatMap((p) => p.clips.map((c) => c.assetId)));
    return mediaAssets.filter((a) => !usedIds.has(a.id)).length;
  }, [mediaAssets, projects]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setCleanupNotice(null);
    await uploadLocalFiles(files);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    await handleFiles(e.dataTransfer.files);
  };

  const sendToEditor = (asset: MediaAsset) => {
    addClipToTimeline(asset);
    navigate("editor");
  };

  const handleRequestDeleteAsset = async (assetId: string) => {
    setCleanupNotice(null);
    const usedBy = getProjectsUsingAsset(assetId);
    if (usedBy.length > 0 && confirmDeleteAssetId !== assetId) {
      setConfirmDeleteAssetId(assetId);
      return;
    }
    setConfirmDeleteAssetId(null);
    await removeMediaAsset(assetId, usedBy.length > 0);
  };

  const handleCleanUnused = async () => {
    const removed = await cleanupUnusedMediaAssets();
    setCleanupNotice(
      removed > 0
        ? `Removed ${removed} unused local media file${removed > 1 ? "s" : ""} from IndexedDB.`
        : "No unused media files found."
    );
  };

  return (
    <StudioShell
      headerAction={
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingMedia}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Upload className="h-3.5 w-3.5" />
          <span>{uploadingMedia ? "Inspecting..." : "Upload Local Files"}</span>
        </button>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
        className="hidden"
      />

      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">Media Library</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Select local video, image, and audio files stored persistently in IndexedDB for playback, trimming, subtitles, and export.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {unusedCount > 0 && (
              <button
                type="button"
                onClick={() => void handleCleanUnused()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5 text-zinc-400" />
                <span>Clean Unused ({unusedCount})</span>
              </button>
            )}
            <p className="text-xs font-mono text-zinc-400 tabular-nums">
              {idbHydrating ? "Restoring..." : `${mediaAssets.length} assets`} · {formatBytes(mediaAssets.reduce((s, a) => s + a.sizeBytes, 0))}
            </p>
          </div>
        </div>

        {/* Browser-local IndexedDB Warning & Quota Meter */}
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-2.5 text-xs text-amber-200/90">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-amber-100">
                IndexedDB Local Browser Storage Active (₹0 Free Mode)
              </p>
              <p className="text-amber-200/80 leading-relaxed">
                Uploaded media files stay inside IndexedDB on this browser and device across page refreshes and browser restarts. Clearing browser site data will permanently remove local files, and media does not sync across separate browsers or devices.
              </p>
            </div>
          </div>
          {storageEstimate?.supported && (
            <div className="shrink-0 min-w-[200px] space-y-1.5 rounded-lg border border-zinc-800 bg-[#09090B]/80 px-3 py-2">
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-300">
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-3 w-3 text-blue-400" />
                  <span>Browser Quota</span>
                </span>
                <span>{storageEstimate.percentUsed}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    storageEstimate.percentUsed > 85 ? "bg-rose-500" : "bg-blue-500"
                  }`}
                  style={{ width: `${Math.max(2, storageEstimate.percentUsed)}%` }}
                />
              </div>
              <p className="text-[10px] font-mono text-zinc-400 tabular-nums">
                {formatBytes(storageEstimate.usageBytes)} used
                {storageEstimate.quotaBytes > 0 ? ` of ${formatBytes(storageEstimate.quotaBytes)}` : ""}
              </p>
            </div>
          )}
        </div>

        {/* Upload Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void handleDrop(e)}
          className={`rounded-2xl border border-dashed p-8 text-center transition-colors ${
            dragOver
              ? "border-violet-500 bg-violet-500/10"
              : "border-zinc-800 bg-[#111114]/70 hover:border-zinc-700"
          }`}
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-blue-400 mb-3">
            <Upload className="h-4 w-4" />
          </div>
          <p className="text-sm font-medium text-zinc-100">
            Drop local video, image, or audio files here
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Supports MP4, WebM, MOV, PNG, JPG, MP3, WAV. Files persist locally in IndexedDB with stable asset IDs.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingMedia}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <span>{uploadingMedia ? "Saving to IndexedDB..." : "Browse Computer"}</span>
            </button>
          </div>
        </div>

        {cleanupNotice && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200 flex items-center justify-between">
            <span>{cleanupNotice}</span>
            <button type="button" onClick={() => setCleanupNotice(null)} className="text-emerald-300 hover:text-white">
              Dismiss
            </button>
          </div>
        )}

        {mediaError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300 flex items-center justify-between">
            <span>{mediaError}</span>
            <button type="button" onClick={clearMediaError} className="text-rose-200 hover:text-white">
              Dismiss
            </button>
          </div>
        )}

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#111114] border border-zinc-800/80 self-start">
            {(["all", "video", "image", "audio"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  filter === tab ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {tab === "all" ? "All Media" : `${tab}s`}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5">
            <div className="relative flex-1 sm:w-64">
              <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search filenames..."
                className="w-full rounded-lg border border-zinc-800 bg-[#111114] pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-[#111114] p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`rounded-md p-1.5 ${
                  viewMode === "grid" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
                }`}
                aria-label="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`rounded-md p-1.5 ${
                  viewMode === "list" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
                }`}
                aria-label="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Empty State or Asset View */}
        {filteredAssets.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-12 text-center">
            <p className="text-sm font-medium text-zinc-200">
              {mediaAssets.length === 0
                ? "Your media library is empty"
                : "No assets match the current filter"}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {mediaAssets.length === 0
                ? "Upload local video clips, still frames, or audio tracks to preview and edit them."
                : "Try clearing the search query or switching media categories."}
            </p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredAssets.map((asset) => (
              <div
                key={asset.id}
                className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-hidden flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => setPreviewAsset(asset)}
                  className="relative h-40 bg-zinc-950 w-full group overflow-hidden text-left"
                >
                  {asset.thumbnailUrl ? (
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.name}
                      className="h-full w-full object-cover group-hover:scale-[1.03] transition-transform duration-200"
                    />
                  ) : (
                    <div className="h-full w-full flex flex-col items-center justify-center text-zinc-500 gap-2">
                      {asset.kind === "audio" ? (
                        <Music className="h-7 w-7 text-blue-400" />
                      ) : (
                        <Film className="h-7 w-7 text-violet-400" />
                      )}
                      <span className="text-[11px] font-mono uppercase">{asset.kind}</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/75 text-white border border-white/15">
                      <Play className="h-4 w-4 ml-0.5" />
                    </span>
                  </div>
                  <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-[11px] font-mono text-zinc-200 tabular-nums">
                    <span>{asset.kind.toUpperCase()}</span>
                    <span>{formatTimecode(asset.duration)}</span>
                  </div>
                </button>

                <div className="p-3.5 flex-1 flex flex-col justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-white truncate" title={asset.name}>
                      {asset.name}
                    </p>
                    <p className="mt-1 text-[11px] font-mono text-zinc-500 tabular-nums">
                      {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ""}
                      {formatBytes(asset.sizeBytes)}
                    </p>
                  </div>

                  {(() => {
                    const usedBy = getProjectsUsingAsset(asset.id);
                    const isConfirming = confirmDeleteAssetId === asset.id;
                    return (
                      <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => sendToEditor(asset)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            <span>Add to Timeline</span>
                          </button>
                          <div className="flex items-center gap-1.5">
                            {usedBy.length > 0 && (
                              <span className="text-[10px] font-mono text-zinc-500">
                                {usedBy.length} proj
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRequestDeleteAsset(asset.id)}
                              className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 transition-colors"
                              aria-label={`Remove ${asset.name}`}
                              title={
                                usedBy.length > 0
                                  ? `Used by ${usedBy.map((p) => p.name).join(", ")}`
                                  : "Delete media asset"
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        {isConfirming && (
                          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-200 space-y-1.5">
                            <p className="leading-snug">
                              Used in {usedBy.map((p) => p.name).join(", ")}. Delete anyway?
                            </p>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteAssetId(null)}
                                className="rounded px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeMediaAsset(asset.id, true)}
                                className="rounded bg-rose-600 px-2 py-0.5 font-medium text-white hover:bg-rose-500"
                              >
                                Delete Anyway
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800/80 text-zinc-400">
                <tr>
                  <th className="py-3 px-4 font-medium">Filename</th>
                  <th className="py-3 px-4 font-medium">Type</th>
                  <th className="py-3 px-4 font-medium">Resolution</th>
                  <th className="py-3 px-4 font-medium text-right">Duration</th>
                  <th className="py-3 px-4 font-medium text-right">Size</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredAssets.map((asset) => (
                  <tr key={asset.id} className="hover:bg-zinc-900/50">
                    <td className="py-3 px-4 font-medium text-zinc-100 max-w-[240px] truncate">
                      <button
                        type="button"
                        onClick={() => setPreviewAsset(asset)}
                        className="hover:text-violet-400 transition-colors flex items-center gap-2 truncate"
                      >
                        {asset.kind === "video" && <Film className="h-3.5 w-3.5 text-violet-400 shrink-0" />}
                        {asset.kind === "image" && <ImageIcon className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                        {asset.kind === "audio" && <Music className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
                        <span className="truncate">{asset.name}</span>
                      </button>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 capitalize">{asset.kind}</td>
                    <td className="py-3 px-4 font-mono text-zinc-400 tabular-nums">
                      {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-300 text-right tabular-nums">
                      {formatTimecode(asset.duration)}
                    </td>
                    <td className="py-3 px-4 font-mono text-zinc-400 text-right tabular-nums">
                      {formatBytes(asset.sizeBytes)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {confirmDeleteAssetId === asset.id ? (
                        <div className="inline-flex items-center gap-2 text-[11px]">
                          <span className="text-rose-200">
                            Used in {getProjectsUsingAsset(asset.id).length} project(s).
                          </span>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteAssetId(null)}
                            className="rounded px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteAssetId(null);
                              void removeMediaAsset(asset.id, true);
                            }}
                            className="rounded bg-rose-600 px-2 py-0.5 font-medium text-white hover:bg-rose-500"
                          >
                            Delete Anyway
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => sendToEditor(asset)}
                            className="text-violet-400 hover:text-violet-300 font-medium"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRequestDeleteAsset(asset.id)}
                            className="text-zinc-500 hover:text-rose-400"
                            aria-label={`Remove ${asset.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <IntegrationNotice
          title="IndexedDB Local Media + MongoDB Metadata Architecture"
          endpoint="POST /api/media"
          description="Actual media Blobs persist locally in IndexedDB on this browser/device across refreshes and restarts, while stable asset IDs and metadata sync to MongoDB (no temporary blob URLs saved)."
        />
      </div>

      {/* Preview Modal */}
      {previewAsset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-[#111114] overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{previewAsset.name}</p>
                <p className="text-[11px] font-mono text-zinc-400 tabular-nums">
                  {previewAsset.width && previewAsset.height
                    ? `${previewAsset.width}×${previewAsset.height} · `
                    : ""}
                  {formatTimecode(previewAsset.duration)} · {formatBytes(previewAsset.sizeBytes)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewAsset(null)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="bg-black flex items-center justify-center min-h-[320px] max-h-[70vh] p-4">
              {previewAsset.kind === "video" && (
                <video
                  src={previewAsset.objectUrl}
                  controls
                  autoPlay
                  className="max-h-[60vh] w-full rounded-lg"
                />
              )}
              {previewAsset.kind === "image" && (
                <img
                  src={previewAsset.objectUrl}
                  alt={previewAsset.name}
                  className="max-h-[60vh] max-w-full object-contain rounded-lg"
                />
              )}
              {previewAsset.kind === "audio" && (
                <div className="w-full max-w-md py-10 space-y-4 text-center">
                  <Music className="h-10 w-10 text-blue-400 mx-auto" />
                  <audio src={previewAsset.objectUrl} controls autoPlay className="w-full" />
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-zinc-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPreviewAsset(null)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:text-white"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = previewAsset;
                  setPreviewAsset(null);
                  sendToEditor(target);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add to Timeline</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </StudioShell>
  );
}
