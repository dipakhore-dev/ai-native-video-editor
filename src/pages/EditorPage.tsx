import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Volume2,
  VolumeX,
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
import { ExportModal } from "../components/editor/ExportModal";
import { useStudio } from "../context/StudioContext";
import type { MediaAsset, MediaKind, Project, TimelineClip } from "../types/studio";
import { formatBytes, formatTimecode } from "../utils/media";
import { getSubtitleStyle, hexToRgba } from "../utils/subtitles";

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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedVideoClipIdRef = useRef<string | null>(null);
  const lastSyncedAudioClipIdRef = useRef<string | null>(null);

  const [playheadTime, setPlayheadTime] = useState(0);
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

  const v1Track = activeProject?.tracks.find((t) => t.id === "track_v1");
  const v2Track = activeProject?.tracks.find((t) => t.id === "track_v2");
  const t1Track = activeProject?.tracks.find((t) => t.id === "track_t1");
  const a1Track = activeProject?.tracks.find((t) => t.id === "track_a1");

  const activeV1Clip = useMemo<TimelineClip | null>(() => {
    if (!activeProject) return null;
    return (
      activeProject.clips.find(
        (c) =>
          c.trackId === "track_v1" &&
          playheadTime >= c.startTime &&
          playheadTime < c.startTime + c.duration
      ) ?? null
    );
  }, [activeProject, playheadTime]);

  const activeV2Clip = useMemo<TimelineClip | null>(() => {
    if (!activeProject) return null;
    return (
      activeProject.clips.find(
        (c) =>
          c.trackId === "track_v2" &&
          playheadTime >= c.startTime &&
          playheadTime < c.startTime + c.duration
      ) ?? null
    );
  }, [activeProject, playheadTime]);

  const activeTextClips = useMemo<TimelineClip[]>(() => {
    if (!activeProject || t1Track?.muted) return [];
    return activeProject.clips.filter(
      (c) =>
        c.trackId === "track_t1" &&
        c.kind === "text" &&
        playheadTime >= c.startTime &&
        playheadTime < c.startTime + c.duration
    );
  }, [activeProject, playheadTime, t1Track?.muted]);

  const activeAudioClip = useMemo<TimelineClip | null>(() => {
    if (!activeProject) return null;
    return (
      activeProject.clips.find(
        (c) =>
          c.trackId === "track_a1" &&
          playheadTime >= c.startTime &&
          playheadTime < c.startTime + c.duration
      ) ?? null
    );
  }, [activeProject, playheadTime]);

  const subtitleStyle = useMemo(() => getSubtitleStyle(activeProject), [activeProject]);

  const activeSubtitles = useMemo(() => {
    if (!activeProject || !subtitleStyle.enabled) return [];
    return (activeProject.subtitles ?? []).filter(
      (s) =>
        s.text.trim().length > 0 &&
        playheadTime >= s.start &&
        playheadTime < s.end
    );
  }, [activeProject, playheadTime, subtitleStyle.enabled]);

  const primaryVisualClip = activeV1Clip ?? activeV2Clip;
  const primaryTrackMuted =
    primaryVisualClip?.trackId === "track_v2" ? Boolean(v2Track?.muted) : Boolean(v1Track?.muted);

  const syncVideoElement = useCallback(() => {
    const vid = videoRef.current;
    if (!vid || !primaryVisualClip || primaryVisualClip.kind !== "video" || primaryVisualClip.needsRelink) {
      lastSyncedVideoClipIdRef.current = null;
      return;
    }

    const clipChanged = lastSyncedVideoClipIdRef.current !== primaryVisualClip.id;
    const targetSourceTime =
      primaryVisualClip.inPoint +
      (playheadTime - primaryVisualClip.startTime) * primaryVisualClip.speed;

    vid.playbackRate = playbackRate * primaryVisualClip.speed;
    vid.muted = masterMuted || primaryTrackMuted;
    vid.volume = Math.min(1, Math.max(0, masterVolume * primaryVisualClip.volume));

    const tolerance = clipChanged || !isPlaying ? 0.04 : 0.35;
    if (vid.readyState >= 1 && Math.abs(vid.currentTime - targetSourceTime) > tolerance) {
      try {
        vid.currentTime = Math.max(0, Math.min(vid.duration || targetSourceTime, targetSourceTime));
        lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
      } catch {
        // Ignore seek errors while media decodes
      }
    } else if (vid.readyState >= 1 && clipChanged) {
      lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
    }

    if (isPlaying && vid.paused) {
      void vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [
    primaryVisualClip,
    playheadTime,
    isPlaying,
    playbackRate,
    masterMuted,
    masterVolume,
    primaryTrackMuted,
  ]);

  // Playback animation loop
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

      setPlayheadTime((prev) => {
        const next = prev + dt;
        if (next >= totalDuration) {
          setIsPlaying(false);
          return totalDuration;
        }
        return next;
      });
      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, totalDuration, playbackRate]);

  // Synchronize HTML5 <video> element with timeline playhead
  useEffect(() => {
    syncVideoElement();
  }, [syncVideoElement]);

  // Synchronize HTML5 <audio> track element
  useEffect(() => {
    const aud = audioRef.current;
    if (!aud) return;

    if (!activeAudioClip || activeAudioClip.needsRelink) {
      lastSyncedAudioClipIdRef.current = null;
      aud.pause();
      return;
    }

    const clipChanged = lastSyncedAudioClipIdRef.current !== activeAudioClip.id;
    const targetSourceTime =
      activeAudioClip.inPoint + (playheadTime - activeAudioClip.startTime) * activeAudioClip.speed;
    aud.playbackRate = playbackRate * activeAudioClip.speed;
    aud.muted = masterMuted || Boolean(a1Track?.muted);
    aud.volume = Math.min(1, Math.max(0, masterVolume * activeAudioClip.volume));

    const tolerance = clipChanged || !isPlaying ? 0.04 : 0.35;
    if (aud.readyState >= 1 && Math.abs(aud.currentTime - targetSourceTime) > tolerance) {
      try {
        aud.currentTime = Math.max(0, targetSourceTime);
        lastSyncedAudioClipIdRef.current = activeAudioClip.id;
      } catch {
        // Ignore seek before metadata loaded
      }
    } else if (aud.readyState >= 1 && clipChanged) {
      lastSyncedAudioClipIdRef.current = activeAudioClip.id;
    }

    if (isPlaying && aud.paused) {
      void aud.play().catch(() => {});
    } else if (!isPlaying && !aud.paused) {
      aud.pause();
    }
  }, [activeAudioClip, playheadTime, isPlaying, playbackRate, masterMuted, masterVolume, a1Track?.muted]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(Math.max(totalDuration, 30), time));
      setPlayheadTime(clamped);
    },
    [totalDuration]
  );

  const togglePlay = useCallback(() => {
    if (totalDuration <= 0) return;
    if (!isPlaying && playheadTime >= totalDuration) {
      setPlayheadTime(0);
    }
    setIsPlaying((p) => !p);
  }, [isPlaying, playheadTime, totalDuration]);

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const fps = activeProject?.fps ?? 24;
      setIsPlaying(false);
      setPlayheadTime((t) => Math.max(0, Number((t + direction * (1 / fps)).toFixed(3))));
    },
    [activeProject?.fps]
  );

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
        const targetClip =
          (selectedClipId ? activeProject.clips.find((c) => c.id === selectedClipId) : null) ??
          activeProject.clips.find(
            (c) => playheadTime > c.startTime + 0.2 && playheadTime < c.startTime + c.duration - 0.2
          );
        if (targetClip) {
          splitClipAtTime(targetClip.id, playheadTime);
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
    playheadTime,
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

  const triggerSingleClipRelink = (assetId: string) => {
    relinkTargetAssetIdRef.current = assetId;
    relinkInputRef.current?.click();
  };

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

  const handleTextOverlayDrag = (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    if (!previewFrameRef.current || !activeProject || !clip.textStyle) return;

    const beforeSnapshot: Project = {
      ...activeProject,
      tracks: activeProject.tracks.map((t) => ({ ...t })),
      clips: activeProject.clips.map((c) => ({
        ...c,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
      })),
    };

    const rect = previewFrameRef.current.getBoundingClientRect();
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      moved = true;
      const xPct = Math.min(90, Math.max(10, ((moveEv.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(90, Math.max(10, ((moveEv.clientY - rect.top) / rect.height) * 100));
      updateTextStyle(
        clip.id,
        { x: Number(xPct.toFixed(1)), y: Number(yPct.toFixed(1)) },
        false
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) {
        commitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const filteredBinAssets = useMemo(() => {
    const q = binSearch.trim().toLowerCase();
    return mediaAssets.filter((a) => a.name.toLowerCase().includes(q));
  }, [mediaAssets, binSearch]);

  const frameAspectClass =
    activeProject?.aspectRatio === "9:16"
      ? "aspect-[9/16] h-full max-h-[340px]"
      : activeProject?.aspectRatio === "1:1"
      ? "aspect-square h-full max-h-[340px]"
      : "aspect-video w-full max-w-3xl";

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
                setPlayheadTime(0);
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
        accept="video/*,image/*,audio/*"
        onChange={(e) => void handleUploadInEditor(e)}
        className="hidden"
      />
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,image/*,audio/*"
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
          {mediaError && (
            <div className="px-4 py-2 border-b border-rose-500/30 bg-rose-500/10 flex items-center justify-between gap-2 text-xs text-rose-200">
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span className="truncate" title={mediaError}>{mediaError}</span>
              </div>
              <button
                type="button"
                onClick={clearMediaError}
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
                      const created = addTextOverlay("Title Overlay", playheadTime);
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
                      <div className="h-10 w-14 rounded bg-zinc-950 overflow-hidden shrink-0 flex items-center justify-center">
                        {asset.thumbnailUrl ? (
                          <img
                            src={asset.thumbnailUrl}
                            alt={asset.name}
                            className="h-full w-full object-cover pointer-events-none"
                          />
                        ) : asset.kind === "audio" ? (
                          <Music className="h-4 w-4 text-blue-400" />
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

            {/* Center Preview Monitor & Transport Controls */}
            <section className="flex-1 min-w-0 flex flex-col bg-[#09090B]">
              <div className="flex-1 p-4 flex items-center justify-center min-h-[260px]">
                <div
                  ref={previewFrameRef}
                  className={`${frameAspectClass} relative rounded-xl border border-zinc-800 bg-black overflow-hidden flex items-center justify-center shadow-xl`}
                >
                  {primaryVisualClip && !primaryVisualClip.needsRelink && primaryVisualClip.objectUrl ? (
                    <>
                      {primaryVisualClip.kind === "video" ? (
                        <video
                          ref={videoRef}
                          src={primaryVisualClip.objectUrl}
                          onLoadedMetadata={syncVideoElement}
                          onCanPlay={syncVideoElement}
                          playsInline
                          style={{ opacity: primaryVisualClip.opacity }}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <img
                          src={primaryVisualClip.objectUrl}
                          alt={primaryVisualClip.name}
                          style={{ opacity: primaryVisualClip.opacity }}
                          className="h-full w-full object-contain"
                        />
                      )}
                    </>
                  ) : (
                    <div className="text-center p-6 space-y-2.5">
                      <Film className="h-8 w-8 text-zinc-700 mx-auto" />
                      <p className="text-xs text-zinc-400">
                        {primaryVisualClip?.needsRelink
                          ? `Missing local media for "${primaryVisualClip.sourceName || primaryVisualClip.name}"`
                          : isRestoringProjectMedia
                            ? "Restoring media from IndexedDB..."
                            : activeProject.clips.length === 0
                              ? "Import a local video or image to start previewing"
                              : "Playhead is in an empty timeline gap"}
                      </p>
                      {primaryVisualClip?.needsRelink && (
                        <button
                          type="button"
                          onClick={() => triggerSingleClipRelink(primaryVisualClip.assetId)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          <span>Re-link File</span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Optional V2 Overlay Image Layer when V1 is also active */}
                  {activeV1Clip &&
                    activeV2Clip &&
                    activeV2Clip.kind === "image" &&
                    !activeV2Clip.needsRelink && (
                      <img
                        src={activeV2Clip.objectUrl}
                        alt={activeV2Clip.name}
                        style={{ opacity: activeV2Clip.opacity }}
                        className="absolute inset-0 h-full w-full object-contain pointer-events-none"
                      />
                    )}

                  {/* Active Editable Text Overlays (Draggable on Preview Canvas) */}
                  {activeTextClips.map((textClip) => {
                    const style = textClip.textStyle;
                    if (!style) return null;
                    const isSelected = textClip.id === selectedClipId;
                    return (
                      <div
                        key={textClip.id}
                        onMouseDown={(e) => handleTextOverlayDrag(e, textClip)}
                        style={{
                          left: `${style.x}%`,
                          top: `${style.y}%`,
                          transform: "translate(-50%, -50%)",
                          fontSize: `${Math.max(12, Math.round(style.fontSize * 0.65))}px`,
                          color: style.color,
                          backgroundColor: `rgba(9, 9, 11, ${style.backgroundOpacity})`,
                          opacity: textClip.opacity,
                          textAlign: style.align,
                        }}
                        className={`absolute px-3 py-1.5 rounded-md font-display font-semibold cursor-move select-none max-w-[85%] whitespace-pre-wrap leading-tight ${
                          isSelected ? "ring-1 ring-emerald-400" : ""
                        }`}
                        title="Drag to reposition text overlay"
                      >
                        {style.text}
                      </div>
                    );
                  })}

                  {/* Synchronized Automatic Subtitles */}
                  {activeSubtitles.length > 0 && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-10 w-[88%] flex flex-col items-center gap-1 pointer-events-none ${
                        subtitleStyle.position === "top"
                          ? "top-9"
                          : subtitleStyle.position === "middle"
                            ? "top-1/2 -translate-y-1/2"
                            : "bottom-5"
                      }`}
                    >
                      {activeSubtitles.map((cue) => (
                        <div
                          key={cue.id}
                          dir="auto"
                          style={{
                            fontSize: `${Math.max(12, Math.round(subtitleStyle.fontSize * 0.58))}px`,
                            color: subtitleStyle.color,
                            backgroundColor: hexToRgba(
                              subtitleStyle.backgroundColor,
                              subtitleStyle.backgroundOpacity
                            ),
                            textShadow:
                              subtitleStyle.backgroundOpacity <= 0.05
                                ? "0 1px 3px rgba(0,0,0,0.95)"
                                : undefined,
                          }}
                          className="px-3 py-1 rounded-md font-medium text-center leading-relaxed whitespace-pre-wrap max-w-full"
                        >
                          {cue.text}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Hidden synchronized audio element for A1 Audio track */}
                  <audio
                    ref={audioRef}
                    src={activeAudioClip && !activeAudioClip.needsRelink ? activeAudioClip.objectUrl : undefined}
                    className="hidden"
                  />

                  <div className="absolute top-3 left-3 rounded bg-black/70 px-2 py-1 text-[11px] font-mono text-zinc-300 tabular-nums pointer-events-none">
                    {activeProject.resolution} · {activeProject.fps}fps
                  </div>
                </div>
              </div>

              {/* Scrubber & Transport Bar */}
              <div className="px-4 pb-3 pt-2 border-t border-zinc-800/70 bg-[#0D0D10]/70 space-y-2">
                <input
                  type="range"
                  min={0}
                  max={Math.max(totalDuration, 1)}
                  step={0.02}
                  value={Math.min(playheadTime, Math.max(totalDuration, 1))}
                  onChange={(e) => {
                    setIsPlaying(false);
                    handleSeek(Number(e.target.value));
                  }}
                  className="w-full accent-violet-500 h-1.5 cursor-pointer"
                  aria-label="Sequence scrubber"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* Timecode Readout */}
                  <div className="font-mono text-xs text-zinc-200 tabular-nums min-w-[140px]">
                    <span>{formatTimecode(playheadTime, true, activeProject.fps)}</span>
                    <span className="text-zinc-500">
                      {" "}
                      / {formatTimecode(totalDuration, true, activeProject.fps)}
                    </span>
                  </div>

                  {/* Transport Buttons */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setPlayheadTime(0);
                      }}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Jump to start"
                    >
                      <SkipBack className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFrame(-1)}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Step back 1 frame"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={togglePlay}
                      disabled={totalDuration <= 0}
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 transition-colors"
                      title="Play / Pause (Space)"
                      aria-label={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4 ml-0.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFrame(1)}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Step forward 1 frame"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setPlayheadTime(totalDuration);
                      }}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Jump to end"
                    >
                      <SkipForward className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Audio & Speed Controls */}
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMasterMuted(!masterMuted)}
                        className="p-1 text-zinc-400 hover:text-white"
                        aria-label={masterMuted ? "Unmute" : "Mute"}
                      >
                        {masterMuted || masterVolume === 0 ? (
                          <VolumeX className="h-4 w-4 text-rose-400" />
                        ) : (
                          <Volume2 className="h-4 w-4" />
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={masterMuted ? 0 : masterVolume}
                        onChange={(e) => {
                          setMasterMuted(false);
                          setMasterVolume(Number(e.target.value));
                        }}
                        className="w-16 accent-blue-500"
                        aria-label="Master volume"
                      />
                    </div>

                    <select
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(Number(e.target.value))}
                      className="rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] font-mono text-zinc-200 focus:border-violet-500 focus:outline-none"
                      aria-label="Playback speed"
                    >
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Inspector, AI Assistant & Subtitles */}
            <AiAssistantPanel
              project={activeProject}
              selectedClip={selectedClip}
              totalDuration={totalDuration}
              playheadTime={playheadTime}
              onSeek={(t) => {
                setIsPlaying(false);
                handleSeek(t);
              }}
              activeTab={rightPanelTab}
              onTabChange={setRightPanelTab}
            />
          </div>

          {/* Lower Multitrack Timeline */}
          <MultitrackTimeline
            project={activeProject}
            playheadTime={playheadTime}
            onSeek={(t) => {
              setIsPlaying(false);
              handleSeek(t);
            }}
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
