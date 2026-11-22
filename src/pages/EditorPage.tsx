import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Plus,
  Download,
  Film,
  Music,
  Image as ImageIcon,
  Search,
  Save,
  Check,
  AlertTriangle,
  Type,
  Captions,
  HardDrive,
  RefreshCw,
  X,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { MultitrackTimeline } from "../components/editor/MultitrackTimeline";
import { AiAssistantPanel, type EditorPanelTab } from "../components/editor/AiAssistantPanel";
import { EditorPreviewStage } from "../components/editor/EditorPreviewStage";
import { ExportModal } from "../components/editor/ExportModal";
import { useStudio } from "../context/StudioContext";
import type { MediaAsset, MediaKind } from "../types/studio";
import { formatBytes, formatTimecode } from "../utils/media";
import { TimelinePlaybackClock } from "../utils/timelineClock";

export function EditorPage() {
  const {
    projects,
    activeProject,
    setActiveProjectId,
    createProject,
    mediaAssets,
    uploadLocalFiles,
    uploadingMedia,
    idbHydrating,
    storageEstimate,
    mediaError,
    clearMediaError,
    relinkMissingClipAsset,
    addClipToTimeline,
    addTextOverlay,
    updateClip,
    updateTextStyle,
    commitProjectSnapshot,
    splitClipAtTime,
    deleteClip,
    undo,
    redo,
    lastLocalSaveAt,
    saveTimelineLocally,
    isAuthenticated,
    mongoSaveStatus,
    lastMongoSaveAt,
    mongoSaveError,
    saveTimelineToMongo,
    sessionUser,
  } = useStudio();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const relinkTargetAssetIdRef = useRef<string | null>(null);

  const playbackClock = useMemo(() => new TimelinePlaybackClock(0), []);
  const [isPlaying, setIsPlaying] = useState(false);
  const [masterVolume, setMasterVolume] = useState(0.9);
  const [masterMuted, setMasterMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<"select" | "razor">("select");
  const [binSearch, setBinSearch] = useState("");
  const [binDragOver, setBinDragOver] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<EditorPanelTab>("assistant");
  const [previewMediaError, setPreviewMediaError] = useState<string | null>(null);

  const totalDuration = useMemo(() => {
    if (!activeProject || activeProject.clips.length === 0) return 0;
    return activeProject.clips.reduce(
      (max, c) => Math.max(max, c.startTime + c.duration),
      0
    );
  }, [activeProject]);

  const selectedClip = useMemo(
    () => activeProject?.clips.find((c) => c.id === selectedClipId) ?? null,
    [activeProject, selectedClipId]
  );

  const missingMediaItems = useMemo(() => {
    if (!activeProject) return [];
    const seen = new Map<
      string,
      { assetId: string; name: string; sizeBytes?: number; kind: MediaKind }
    >();
    for (const clip of activeProject.clips) {
      if (clip.needsRelink && clip.assetId && !seen.has(clip.assetId)) {
        seen.set(clip.assetId, {
          assetId: clip.assetId,
          name: clip.sourceName || clip.name,
          sizeBytes: clip.sourceSizeBytes,
          kind: clip.kind,
        });
      }
    }
    return Array.from(seen.values());
  }, [activeProject]);

  const hasClipsNeedingRelink = !idbHydrating && missingMediaItems.length > 0;
  const isRestoringProjectMedia = Boolean(
    idbHydrating && activeProject?.clips.some((c) => c.kind !== "text" && !c.objectUrl)
  );

  // Playback animation loop updating only external TimelinePlaybackClock (0 parent React re-renders/sec)
  useEffect(() => {
    if (!isPlaying) return;
    if (totalDuration <= 0) {
      setIsPlaying(false);
      return;
    }

    let frameId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dt = ((now - lastTs) / 1000) * playbackRate;
      lastTs = now;

      const next = playbackClock.getTime() + dt;
      if (next >= totalDuration) {
        playbackClock.setTime(totalDuration, true);
        setIsPlaying(false);
        return;
      }
      playbackClock.setTime(next);
      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, totalDuration, playbackRate, playbackClock]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(Math.max(totalDuration, 30), time));
      playbackClock.setTime(clamped, true);
    },
    [playbackClock, totalDuration]
  );

  const handlePauseAndSeek = useCallback(
    (time: number) => {
      setIsPlaying(false);
      handleSeek(time);
    },
    [handleSeek]
  );

  const togglePlay = useCallback(() => {
    if (totalDuration <= 0) return;
    setIsPlaying((prev) => {
      if (!prev && playbackClock.getTime() >= totalDuration) {
        playbackClock.setTime(0, true);
      }
      return !prev;
    });
  }, [playbackClock, totalDuration]);

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const fps = activeProject?.fps ?? 24;
      setIsPlaying(false);
      const next = Math.max(0, Number((playbackClock.getTime() + direction * (1 / fps)).toFixed(3)));
      playbackClock.setTime(next, true);
    },
    [activeProject?.fps, playbackClock]
  );

  const handleMasterVolumeChange = useCallback((vol: number) => {
    setMasterMuted(false);
    setMasterVolume(vol);
  }, []);

  const handleToggleMasterMuted = useCallback(() => {
    setMasterMuted((m) => !m);
  }, []);

  const triggerLocalSave = useCallback(() => {
    saveTimelineLocally();
    if (isAuthenticated) {
      void saveTimelineToMongo();
    }
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1800);
  }, [isAuthenticated, saveTimelineLocally, saveTimelineToMongo]);

  // Keyboard Shortcuts including Undo / Redo / Local Save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        triggerLocalSave();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !inInput) {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !inInput) {
        e.preventDefault();
        redo();
        return;
      }

      if (inInput) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "v" || e.key === "V") {
        setActiveTool("select");
      } else if (e.key === "c" || e.key === "C") {
        setActiveTool("razor");
      } else if ((e.key === "s" || e.key === "S") && activeProject) {
        const curTime = playbackClock.getTime();
        const targetClip =
          (selectedClipId ? activeProject.clips.find((c) => c.id === selectedClipId) : null) ??
          activeProject.clips.find(
            (c) => curTime > c.startTime + 0.2 && curTime < c.startTime + c.duration - 0.2
          );
        if (targetClip) {
          splitClipAtTime(targetClip.id, curTime);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrame(1);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
        deleteClip(selectedClipId);
        setSelectedClipId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    togglePlay,
    selectedClipId,
    activeProject,
    splitClipAtTime,
    playbackClock,
    stepFrame,
    deleteClip,
    undo,
    redo,
    triggerLocalSave,
  ]);

  const handleFilesSelected = async (files: FileList | File[]) => {
    const added = await uploadLocalFiles(files);
    if (added.length > 0 && (!activeProject || activeProject.clips.length === 0)) {
      const clip = addClipToTimeline(added[0]);
      if (clip) setSelectedClipId(clip.id);
    }
  };

  const handleUploadInEditor = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    await handleFilesSelected(e.target.files);
    e.target.value = "";
  };

  const triggerSingleClipRelink = useCallback((assetId: string) => {
    relinkTargetAssetIdRef.current = assetId;
    relinkInputRef.current?.click();
  }, []);

  const handleRelinkFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetAssetId = relinkTargetAssetIdRef.current;
    e.target.value = "";
    relinkTargetAssetIdRef.current = null;
    if (!file || !targetAssetId) return;
    await relinkMissingClipAsset(targetAssetId, file);
  };

  const handleAddAssetToTimeline = (asset: MediaAsset) => {
    const clip = addClipToTimeline(asset);
    if (clip) setSelectedClipId(clip.id);
  };

  const filteredBinAssets = useMemo(() => {
    const q = binSearch.trim().toLowerCase();
    return mediaAssets.filter((a) => a.name.toLowerCase().includes(q));
  }, [mediaAssets, binSearch]);

  return (
    <StudioShell
      fullBleed
      headerAction={
        <div className="flex items-center gap-2.5">
          {projects.length > 0 && (
            <select
              value={activeProject?.id ?? ""}
              onChange={(e) => {
                setIsPlaying(false);
                playbackClock.setTime(0, true);
                setSelectedClipId(null);
                setActiveProjectId(e.target.value);
              }}
              className="hidden sm:block rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-violet-500 focus:outline-none max-w-[180px]"
              aria-label="Switch active project"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={!activeProject}
            onClick={() => setRightPanelTab("subtitles")}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
              rightPanelTab === "subtitles"
                ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                : "border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
            }`}
            title="Open AI-Powered Automatic Subtitles"
          >
            <Captions className="h-3.5 w-3.5 text-violet-400" />
            <span>Generate Subtitles</span>
          </button>
          <button
            type="button"
            disabled={!activeProject || mongoSaveStatus === "saving"}
            onClick={triggerLocalSave}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            title={
              mongoSaveError
                ? `MongoDB sync error: ${mongoSaveError}`
                : isAuthenticated && lastMongoSaveAt
                  ? `Synced to MongoDB at ${new Date(lastMongoSaveAt).toLocaleTimeString()}`
                  : lastLocalSaveAt
                    ? `Last saved locally at ${new Date(lastLocalSaveAt).toLocaleTimeString()}`
                    : "Save timeline state locally and to MongoDB when signed in (Ctrl+S)"
            }
          >
            {mongoSaveStatus === "saving" ? (
              <>
                <Save className="h-3.5 w-3.5 text-blue-400 animate-pulse" />
                <span>Saving...</span>
              </>
            ) : saveFlash || (isAuthenticated && mongoSaveStatus === "saved") ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-300">
                  {isAuthenticated ? "Saved to MongoDB" : "Saved Locally"}
                </span>
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 text-blue-400" />
                <span>{isAuthenticated ? "Save Timeline" : "Save Locally"}</span>
              </>
            )}
          </button>
          <button
            type="button"
            disabled={!activeProject}
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export Video</span>
          </button>
        </div>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.mkv"
        onChange={(e) => void handleUploadInEditor(e)}
        className="hidden"
      />
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,image/*,audio/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.mkv"
        onChange={(e) => void handleRelinkFileSelected(e)}
        className="hidden"
      />

      {!activeProject ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-[#111114] p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-violet-400 mb-4">
              <Film className="h-6 w-6" />
            </div>
            <h1 className="font-display text-lg font-semibold text-white">
              Start a sequence in the Video Editor
            </h1>
            <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
              Create an empty timeline or select a local video file from your computer to begin editing immediately.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() =>
                  createProject({
                    name: "Sequence 01",
                    aspectRatio: "16:9",
                    resolution: sessionUser.defaultResolution,
                    fps: sessionUser.defaultFps,
                  })
                }
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create Sequence 01</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
              >
                <Upload className="h-3.5 w-3.5 text-blue-400" />
                <span>Import Local Video</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {(mediaError || previewMediaError) && (
            <div className="px-4 py-2 border-b border-rose-500/30 bg-rose-500/10 flex items-center justify-between gap-2 text-xs text-rose-200">
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span className="truncate" title={mediaError || previewMediaError || ""}>
                  {mediaError || previewMediaError}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearMediaError();
                  setPreviewMediaError(null);
                }}
                className="rounded p-1 text-rose-200 hover:bg-rose-500/20 hover:text-white shrink-0"
                aria-label="Dismiss media error"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {isRestoringProjectMedia && (
            <div className="px-4 py-1.5 border-b border-blue-500/30 bg-blue-500/10 flex items-center gap-2 text-xs text-blue-200">
              <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0 text-blue-400" />
              <span>Restoring local media files from browser IndexedDB storage...</span>
            </div>
          )}

          {hasClipsNeedingRelink && (
            <div className="px-4 py-2.5 border-b border-amber-500/30 bg-amber-500/10 space-y-2 text-xs text-amber-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    {missingMediaItems.length} local media file{missingMediaItems.length > 1 ? "s were" : " was"} not found in this browser&apos;s IndexedDB storage (browser data cleared or opened on another device).
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md bg-amber-500/20 border border-amber-400/40 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-500/30"
                >
                  Batch Re-link Files
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {missingMediaItems.map((item) => (
                  <div
                    key={item.assetId}
                    className="inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-black/30 px-2.5 py-1 text-[11px]"
                  >
                    <span className="font-medium text-amber-100 truncate max-w-[180px]" title={item.name}>
                      {item.name}
                    </span>
                    {item.sizeBytes !== undefined && item.sizeBytes > 0 && (
                      <span className="font-mono text-[10px] text-amber-300/80">
                        {formatBytes(item.sizeBytes)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => triggerSingleClipRelink(item.assetId)}
                      className="rounded bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-black hover:bg-amber-400 transition-colors"
                    >
                      Re-link File
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upper Editor Split: Media Bin | Video Preview | Inspector & AI Assistant */}
          <div className="flex-1 min-h-0 flex flex-col xl:flex-row">
            {/* Left Media Bin (with Drag & Drop) */}
            <aside
              onDragOver={(e) => {
                e.preventDefault();
                setBinDragOver(true);
              }}
              onDragLeave={() => setBinDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setBinDragOver(false);
                if (e.dataTransfer.files.length > 0) {
                  void handleFilesSelected(e.dataTransfer.files);
                }
              }}
              className={`w-full xl:w-64 shrink-0 border-b xl:border-b-0 xl:border-r border-zinc-800/80 bg-[#0D0D10] flex flex-col max-h-64 xl:max-h-none transition-colors ${
                binDragOver ? "ring-1 ring-inset ring-violet-500 bg-violet-500/5" : ""
              }`}
            >
              <div className="p-3 border-b border-zinc-800/80 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-zinc-200">Project Media</h2>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const created = addTextOverlay("Title Overlay", playbackClock.getTime());
                      if (created) setSelectedClipId(created.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800"
                    title="Add Text Overlay"
                  >
                    <Type className="h-3 w-3 text-emerald-400" />
                    <span>Text</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingMedia}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    <Upload className="h-3 w-3 text-blue-400" />
                    <span>{uploadingMedia ? "..." : "Import"}</span>
                  </button>
                </div>
              </div>

              <div className="p-2.5 border-b border-zinc-800/60">
                <div className="relative">
                  <Search className="h-3 w-3 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={binSearch}
                    onChange={(e) => setBinSearch(e.target.value)}
                    placeholder="Filter bin..."
                    className="w-full rounded-md border border-zinc-800 bg-[#09090B] pl-7 pr-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
                {filteredBinAssets.length === 0 ? (
                  <div className="py-8 px-3 text-center">
                    <p className="text-xs text-zinc-400">Drop or import local media</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-2 text-xs font-medium text-violet-400 hover:text-violet-300"
                    >
                      Select local files
                    </button>
                  </div>
                ) : (
                  filteredBinAssets.map((asset) => (
                    <div
                      key={asset.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-ai-studio-asset-id", asset.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      className="rounded-lg border border-zinc-800/80 bg-[#111114] p-2 flex items-center gap-2.5 group hover:border-zinc-700 cursor-grab active:cursor-grabbing transition-colors"
                      title="Drag onto a timeline track or click + to append"
                    >
                      <div className="relative h-10 w-14 rounded bg-zinc-950 overflow-hidden shrink-0 flex items-center justify-center">
                        {asset.thumbnailUrl ? (
                          <img
                            src={asset.thumbnailUrl}
                            alt={asset.name}
                            className="h-full w-full object-cover pointer-events-none"
                          />
                        ) : asset.kind === "audio" ? (
                          <>
                            {asset.waveformPeaks && asset.waveformPeaks.length > 0 && (
                              <div
                                aria-hidden="true"
                                className="absolute inset-x-1 inset-y-1.5 flex items-center gap-[1px] opacity-45 pointer-events-none"
                              >
                                {asset.waveformPeaks
                                  .filter((_, idx) => idx % 8 === 0)
                                  .slice(0, 16)
                                  .map((amp, idx) => (
                                    <span
                                      key={idx}
                                      style={{ height: `${Math.max(15, Math.round(amp * 90))}%` }}
                                      className="flex-1 rounded-[1px] bg-sky-400"
                                    />
                                  ))}
                              </div>
                            )}
                            <Music className="relative z-[1] h-4 w-4 text-blue-400" />
                          </>
                        ) : (
                          <ImageIcon className="h-4 w-4 text-zinc-500" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium text-zinc-100 truncate" title={asset.name}>
                          {asset.name}
                        </p>
                        <p className="text-[10px] font-mono text-zinc-500 tabular-nums">
                          {formatTimecode(asset.duration)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddAssetToTimeline(asset)}
                        className="rounded-md bg-zinc-800 p-1.5 text-zinc-300 hover:bg-violet-600 hover:text-white transition-colors shrink-0"
                        title="Append to timeline"
                        aria-label={`Add ${asset.name} to timeline`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="px-3 py-2 border-t border-zinc-800/80 bg-[#09090B]/70 space-y-1">
                <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="h-3 w-3 text-blue-400" />
                    <span>IndexedDB Local</span>
                  </span>
                  {storageEstimate?.supported ? (
                    <span>
                      {formatBytes(storageEstimate.usageBytes)}
                      {storageEstimate.quotaBytes > 0
                        ? ` / ${formatBytes(storageEstimate.quotaBytes)}`
                        : ""}
                    </span>
                  ) : (
                    <span>{mediaAssets.length} files</span>
                  )}
                </div>
                <p className="text-[10px] leading-snug text-zinc-500">
                  Saved on this browser/device only. Clearing browser site data removes local media.
                </p>
              </div>
            </aside>

            {/* Center Preview Monitor & Transport Controls (Clock-Isolated Leaf Stage) */}
            <EditorPreviewStage
              project={activeProject}
              playbackClock={playbackClock}
              totalDuration={totalDuration}
              isPlaying={isPlaying}
              onSetIsPlaying={setIsPlaying}
              masterVolume={masterVolume}
              onMasterVolumeChange={handleMasterVolumeChange}
              masterMuted={masterMuted}
              onToggleMasterMuted={handleToggleMasterMuted}
              playbackRate={playbackRate}
              onPlaybackRateChange={setPlaybackRate}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onUpdateClip={updateClip}
              onUpdateTextStyle={updateTextStyle}
              onCommitProjectSnapshot={commitProjectSnapshot}
              onTriggerRelink={triggerSingleClipRelink}
              isRestoringProjectMedia={isRestoringProjectMedia}
              onMediaError={setPreviewMediaError}
              onSeek={handleSeek}
              onTogglePlay={togglePlay}
              onStepFrame={stepFrame}
            />

            {/* Right Inspector, AI Assistant & Subtitles */}
            <AiAssistantPanel
              project={activeProject}
              selectedClip={selectedClip}
              totalDuration={totalDuration}
              playbackClock={playbackClock}
              onSeek={handlePauseAndSeek}
              activeTab={rightPanelTab}
              onTabChange={setRightPanelTab}
            />
          </div>

          {/* Lower Multitrack Timeline */}
          <MultitrackTimeline
            project={activeProject}
            playbackClock={playbackClock}
            onSeek={handlePauseAndSeek}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            activeTool={activeTool}
            onToolChange={setActiveTool}
            totalDuration={totalDuration}
          />
        </div>
      )}

      {exportOpen && activeProject && (
        <ExportModal
          project={activeProject}
          totalDuration={totalDuration}
          onClose={() => setExportOpen(false)}
        />
      )}
    </StudioShell>
  );
}
