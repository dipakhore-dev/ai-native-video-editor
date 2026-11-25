import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Download,
  Film,
  Image as ImageIcon,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  fetchStockMediaStatus,
  searchStockMediaApi,
  type StockMediaStatusDto,
  type StockSearchItemDto,
} from "../../services/api";
import type {
  AspectRatioOption,
  MediaAsset,
  StoryboardScene,
} from "../../types/studio";
import { formatBytes, formatTimecode } from "../../utils/media";
import { scoreAssetForScene } from "../../utils/storyboardMedia";

interface MediaPickerModalProps {
  open: boolean;
  initialTab?: "library" | "stock";
  scene: StoryboardScene | null;
  aspectRatio: AspectRatioOption;
  mediaAssets: MediaAsset[];
  isAuthenticated: boolean;
  onClose: () => void;
  onSelectLibraryAsset: (asset: MediaAsset, sceneId: string) => void;
  onUploadFilesForScene: (files: FileList, sceneId: string) => Promise<void>;
  onImportStockResult: (
    item: StockSearchItemDto,
    sceneId: string,
    signal: AbortSignal
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function MediaPickerModal({
  open,
  initialTab = "library",
  scene,
  aspectRatio,
  mediaAssets,
  isAuthenticated,
  onClose,
  onSelectLibraryAsset,
  onUploadFilesForScene,
  onImportStockResult,
}: MediaPickerModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);

  const [activeTab, setActiveTab] = useState<"library" | "stock">(initialTab);
  const [libraryFilter, setLibraryFilter] = useState<"all" | "video" | "image">("all");
  const [librarySearch, setLibrarySearch] = useState("");
  const [uploading, setUploading] = useState(false);

  // Stock search state
  const [stockStatus, setStockStatus] = useState<StockMediaStatusDto | null>(null);
  const [loadingStockStatus, setLoadingStockStatus] = useState(false);
  const [stockQuery, setStockQuery] = useState("");
  const [stockMediaType, setStockMediaType] = useState<"video" | "image">("video");
  const [stockResults, setStockResults] = useState<StockSearchItemDto[]>([]);
  const [searchingStock, setSearchingStock] = useState(false);
  const [importingStockId, setImportingStockId] = useState<string | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      searchAbortRef.current?.abort();
      importAbortRef.current?.abort();
      setImportingStockId(null);
      setSearchingStock(false);
      return;
    }
    setActiveTab(initialTab);
    setStockError(null);
    if (scene) {
      setStockQuery(scene.mediaKeywords.slice(0, 3).join(" ") || scene.title);
      setStockMediaType(
        scene.mediaType === "image" || scene.mediaType === "text_card" ? "image" : "video"
      );
    }
  }, [open, initialTab, scene]);

  useEffect(() => {
    if (!open || activeTab !== "stock" || !isAuthenticated) return;
    let cancelled = false;
    setLoadingStockStatus(true);
    void fetchStockMediaStatus().then((res) => {
      if (cancelled) return;
      setLoadingStockStatus(false);
      if (res.ok && res.data?.stockMedia) {
        setStockStatus(res.data.stockMedia);
      } else {
        setStockStatus({
          enabled: false,
          configured: false,
          provider: "none",
          maxResults: 15,
          maxImportMb: 80,
          message: res.error || "Could not check server stock media status.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, isAuthenticated]);

  const rankedLibraryAssets = useMemo(() => {
    const visualAssets = mediaAssets.filter(
      (a) => a.kind === "video" || a.kind === "image"
    );
    const q = librarySearch.trim().toLowerCase();
    const filtered = visualAssets.filter((a) => {
      if (libraryFilter !== "all" && a.kind !== libraryFilter) return false;
      if (!q) return true;
      const hay = [
        a.name,
        a.description || "",
        ...(a.tags ?? []),
        a.creatorName || "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    if (!scene) {
      return filtered.map((asset) => ({ asset, score: 0, explanation: "" }));
    }

    return filtered
      .map((asset) => {
        const scored = scoreAssetForScene(scene, aspectRatio, asset);
        return {
          asset,
          score: scored.score,
          explanation: scored.explanation,
        };
      })
      .sort((a, b) => b.score - a.score);
  }, [mediaAssets, libraryFilter, librarySearch, scene, aspectRatio]);

  if (!open || !scene) return null;

  const handleLibraryFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      await onUploadFilesForScene(files, scene.id);
      onClose();
    } finally {
      setUploading(false);
    }
  };

  const handleStockSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stockQuery.trim() || searchingStock) return;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setSearchingStock(true);
    setStockError(null);
    const res = await searchStockMediaApi(
      {
        query: stockQuery.trim(),
        mediaType: stockMediaType,
        aspectRatio,
        page: 1,
      },
      { signal: controller.signal }
    );
    setSearchingStock(false);

    if (res.cancelled) return;
    if (!res.ok || !res.data) {
      setStockError(res.error || "Stock media search failed.");
      return;
    }
    setStockResults(res.data.items);
  };

  const handlePickStockItem = async (item: StockSearchItemDto) => {
    if (importingStockId) return;
    importAbortRef.current?.abort();
    const controller = new AbortController();
    importAbortRef.current = controller;

    setImportingStockId(item.providerAssetId);
    setStockError(null);
    try {
      const result = await onImportStockResult(item, scene.id, controller.signal);
      if (result.ok) {
        onClose();
      } else if (result.error && !controller.signal.aborted) {
        setStockError(result.error);
      }
    } finally {
      setImportingStockId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose Scene Visual Media"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple={false}
        accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          void handleLibraryFileUpload(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-zinc-800 bg-[#111114] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">
              Select Visual Media — {scene.title}
            </p>
            <p className="text-[11px] text-zinc-400">
              Target: {aspectRatio} · Scene Duration {scene.duration.toFixed(1)}s · Keywords:{" "}
              {scene.mediaKeywords.join(", ")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            aria-label="Close media picker"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab("library")}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "library"
                  ? "border-violet-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              IndexedDB Media Library ({rankedLibraryAssets.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("stock")}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === "stock"
                  ? "border-violet-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Free Stock Search
            </button>
          </div>

          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5 text-violet-400" />
            <span>{uploading ? "Importing..." : "Upload File for Scene"}</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {activeTab === "library" ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800 self-start">
                  {(["all", "video", "image"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setLibraryFilter(kind)}
                      className={`rounded-md px-3 py-1 text-xs font-medium capitalize ${
                        libraryFilter === kind
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {kind === "all" ? "All Visuals" : `${kind}s`}
                    </button>
                  ))}
                </div>

                <div className="relative flex-1 sm:max-w-xs">
                  <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="Filter filenames or tags..."
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] pl-9 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              {rankedLibraryAssets.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-10 text-center space-y-2">
                  <p className="text-sm font-medium text-zinc-200">
                    No matching local visual assets found
                  </p>
                  <p className="text-xs text-zinc-400">
                    Upload a video or image file, generate a text slide, or search free stock media.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {rankedLibraryAssets.map(({ asset, score, explanation }) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => {
                        onSelectLibraryAsset(asset, scene.id);
                        onClose();
                      }}
                      className="text-left rounded-xl border border-zinc-800 bg-[#09090B] hover:border-violet-500/70 transition-colors overflow-hidden flex flex-col"
                    >
                      <div className="relative h-32 bg-zinc-950 w-full">
                        {asset.thumbnailUrl ? (
                          <img
                            src={asset.thumbnailUrl}
                            alt={asset.name}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-zinc-500">
                            {asset.kind === "video" ? (
                              <Film className="h-6 w-6 text-violet-400" />
                            ) : (
                              <ImageIcon className="h-6 w-6 text-emerald-400" />
                            )}
                          </div>
                        )}
                        <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-[10px] font-mono text-zinc-200 bg-black/75 rounded px-1.5 py-0.5 tabular-nums">
                          <span>{asset.kind.toUpperCase()}</span>
                          <span>
                            {asset.kind === "video"
                              ? formatTimecode(asset.duration)
                              : asset.width && asset.height
                                ? `${asset.width}×${asset.height}`
                                : formatBytes(asset.sizeBytes)}
                          </span>
                        </div>
                      </div>

                      <div className="p-3 space-y-1 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-white truncate">{asset.name}</p>
                          <span className="font-mono text-[10px] text-violet-400 shrink-0 tabular-nums">
                            {score}% match
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 line-clamp-2 leading-snug">
                          {explanation}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              {!isAuthenticated ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-start gap-2.5">
                  <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Sign in required for server stock media search</p>
                    <p className="mt-0.5 opacity-90">
                      Stock API searches and SSRF-hardened downloads run through your authenticated backend session. Local uploads and generated text slides remain available without signing in.
                    </p>
                  </div>
                </div>
              ) : loadingStockStatus ? (
                <p className="text-xs text-zinc-400">Checking server stock provider status...</p>
              ) : stockStatus && !stockStatus.enabled ? (
                <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-5 space-y-2 text-xs">
                  <p className="font-semibold text-white">
                    Stock Media Integration Disabled ({stockStatus.provider})
                  </p>
                  <p className="text-zinc-400 leading-relaxed">{stockStatus.message}</p>
                </div>
              ) : (
                <>
                  <form onSubmit={handleStockSearch} className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        maxLength={120}
                        value={stockQuery}
                        onChange={(e) => setStockQuery(e.target.value)}
                        placeholder="Search free Pexels photos or videos..."
                        className="w-full rounded-lg border border-zinc-800 bg-[#09090B] pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <select
                      value={stockMediaType}
                      onChange={(e) => setStockMediaType(e.target.value as "video" | "image")}
                      className="rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      <option value="video">Stock Videos</option>
                      <option value="image">Stock Photos</option>
                    </select>

                    <button
                      type="submit"
                      disabled={searchingStock || !stockQuery.trim()}
                      className="rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-50"
                    >
                      {searchingStock ? "Searching..." : "Search Pexels"}
                    </button>
                  </form>

                  {stockError && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300 flex items-center justify-between gap-3">
                      <span>{stockError}</span>
                      {importingStockId && (
                        <button
                          type="button"
                          onClick={() => importAbortRef.current?.abort()}
                          className="text-white underline shrink-0"
                        >
                          Cancel Download
                        </button>
                      )}
                    </div>
                  )}

                  {stockResults.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {stockResults.map((item) => {
                        const isImporting = importingStockId === item.providerAssetId;
                        return (
                          <div
                            key={`${item.mediaType}_${item.providerAssetId}`}
                            className="rounded-xl border border-zinc-800 bg-[#09090B] overflow-hidden flex flex-col"
                          >
                            <div className="relative h-32 bg-zinc-950">
                              {item.previewImageUrl ? (
                                <img
                                  src={item.previewImageUrl}
                                  alt={item.title}
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="h-full w-full flex items-center justify-center text-zinc-500">
                                  <Film className="h-6 w-6" />
                                </div>
                              )}
                              <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-[10px] font-mono text-zinc-200 bg-black/75 rounded px-1.5 py-0.5 tabular-nums">
                                <span>{item.mediaType.toUpperCase()}</span>
                                <span>
                                  {item.width}×{item.height}
                                  {item.duration ? ` · ${item.duration}s` : ""}
                                </span>
                              </div>
                            </div>

                            <div className="p-3 space-y-2 flex-1 flex flex-col justify-between">
                              <div>
                                <p className="text-xs font-medium text-white truncate">
                                  {item.title}
                                </p>
                                <p className="text-[11px] text-zinc-400 truncate">
                                  By {item.creatorName} · Pexels
                                </p>
                              </div>

                              <button
                                type="button"
                                disabled={Boolean(importingStockId)}
                                onClick={() => void handlePickStockItem(item)}
                                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 hover:border-violet-500 transition-colors disabled:opacity-50"
                              >
                                {isImporting ? (
                                  <span>Downloading to IndexedDB...</span>
                                ) : (
                                  <>
                                    <Download className="h-3.5 w-3.5" />
                                    <span>Import &amp; Assign</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between text-[11px] text-zinc-500 shrink-0">
          <span>
            Selected files are stored locally inside IndexedDB across refreshes (no permanent blob URLs saved).
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
