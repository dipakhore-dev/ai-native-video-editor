import React, { useEffect, useRef, useState } from "react";
import {
  MousePointer2,
  Scissors,
  Trash2,
  Copy,
  Volume2,
  VolumeX,
  Lock,
  Unlock,
  ZoomIn,
  ZoomOut,
  Magnet,
  Undo2,
  Redo2,
  Type,
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Maximize2,
  AlignHorizontalJustifyStart,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { MediaKind, Project, TimelineClip, TrackType } from "../../types/studio";
import { computeEffectiveFadeDurations, sliceWaveformPeaksForClip } from "../../utils/audio";
import {
  EFFECT_PRESETS,
  hasCustomEffects,
  normalizeEffects,
  normalizeTransition,
} from "../../utils/effects";
import { formatTimecode } from "../../utils/media";
import { trimClipEnd, trimClipStart } from "../../utils/timeline";

interface MultitrackTimelineProps {
  project: Project;
  playheadTime: number;
  onSeek: (time: number) => void;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  activeTool: "select" | "razor";
  onToolChange: (tool: "select" | "razor") => void;
  totalDuration: number;
}

function isAssetKindCompatibleWithTrack(kind: MediaKind, trackType: TrackType): boolean {
  if (kind === "audio") return trackType === "audio";
  if (kind === "text") return trackType === "text";
  return trackType === "video" || trackType === "overlay";
}

function cloneClipForSnapshot(c: TimelineClip): TimelineClip {
  return {
    ...c,
    waveformPeaks: c.waveformPeaks ? [...c.waveformPeaks] : undefined,
    textStyle: c.textStyle ? { ...c.textStyle } : undefined,
    transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
    transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
    effects: c.effects ? normalizeEffects(c.effects) : undefined,
  };
}

export function MultitrackTimeline({
  project,
  playheadTime,
  onSeek,
  selectedClipId,
  onSelectClip,
  activeTool,
  onToolChange,
  totalDuration,
}: MultitrackTimelineProps) {
  const {
    mediaAssets,
    addClipToTimeline,
    moveClipOnTimeline,
    packTrackGaps,
    updateClip,
    commitProjectSnapshot,
    splitClipAtTime,
    reorderClip,
    duplicateClip,
    deleteClip,
    addTextOverlay,
    toggleTrackMute,
    toggleTrackLock,
    canUndo,
    canRedo,
    undo,
    redo,
  } = useStudio();

  const [zoomPxPerSec, setZoomPxPerSec] = useState(28);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    trackId: string;
    timeSec: number;
  } | null>(null);
  const tracksAreaRef = useRef<HTMLDivElement | null>(null);
  const trackRowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const timelineSeconds = Math.max(30, Math.ceil(totalDuration + 10));
  const timelineWidth = timelineSeconds * zoomPxPerSec;

  // Keep playhead in view during playback
  useEffect(() => {
    const el = tracksAreaRef.current;
    if (!el) return;
    const playheadPx = playheadTime * zoomPxPerSec;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth;
    if (playheadPx > viewRight - 24 || playheadPx < viewLeft) {
      el.scrollLeft = Math.max(0, playheadPx - el.clientWidth * 0.25);
    }
  }, [playheadTime, zoomPxPerSec]);

  const snapTime = (t: number): number => {
    if (!snapEnabled) return Math.max(0, Number(t.toFixed(2)));
    const grid = 0.25;
    return Math.max(0, Number((Math.round(t / grid) * grid).toFixed(2)));
  };

  const clientXToTime = (clientX: number): number => {
    if (!tracksAreaRef.current) return 0;
    const rect = tracksAreaRef.current.getBoundingClientRect();
    const x = clientX - rect.left + tracksAreaRef.current.scrollLeft;
    return Math.max(0, Number((x / zoomPxPerSec).toFixed(2)));
  };

  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const startT = clientXToTime(e.clientX);
    onSeek(startT);

    const onMove = (moveEv: MouseEvent) => {
      onSeek(clientXToTime(moveEv.clientX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resolveCompatibleTrackAtY = (clientY: number, clipKind: MediaKind, fallbackTrackId: string): string => {
    for (const track of project.tracks) {
      const rowEl = trackRowRefs.current[track.id];
      if (!rowEl) continue;
      const rect = rowEl.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        if (!track.locked && isAssetKindCompatibleWithTrack(clipKind, track.type)) {
          return track.id;
        }
        return fallbackTrackId;
      }
    }
    return fallbackTrackId;
  };

  const handleClipMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: TimelineClip,
    trackLocked: boolean
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);

    if (trackLocked) return;

    if (activeTool === "razor") {
      const clickTime = clientXToTime(e.clientX);
      splitClipAtTime(clip.id, clickTime);
      return;
    }

    const initialClips = project.clips.map(cloneClipForSnapshot);
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: initialClips.map(cloneClipForSnapshot),
      subtitles: initialSubtitles.map((s) => ({ ...s })),
      subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
      subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
    };

    const initialX = e.clientX;
    const initialStart = clip.startTime;
    let moved = false;
    setDraggingClipId(clip.id);

    const onMove = (moveEv: MouseEvent) => {
      const deltaPx = moveEv.clientX - initialX;
      const targetTrackId = resolveCompatibleTrackAtY(
        moveEv.clientY,
        clip.kind,
        clip.trackId
      );
      if (Math.abs(deltaPx) > 2 || targetTrackId !== clip.trackId) {
        moved = true;
      }
      const deltaSec = deltaPx / zoomPxPerSec;
      const nextStart = snapTime(initialStart + deltaSec);
      moveClipOnTimeline(clip.id, nextStart, targetTrackId, false, {
        clips: initialClips,
        subtitles: initialSubtitles,
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDraggingClipId(null);
      if (moved) {
        commitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleTrimLeftMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: TimelineClip,
    trackLocked: boolean
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    if (trackLocked) return;

    const initialClip = cloneClipForSnapshot(clip);
    const initialTrackClips = project.clips.filter((c) => c.trackId === clip.trackId);
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: project.clips.map(cloneClipForSnapshot),
      subtitles: initialSubtitles.map((s) => ({ ...s })),
      subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
      subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
    };

    const initialX = e.clientX;
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      const deltaPx = moveEv.clientX - initialX;
      if (Math.abs(deltaPx) > 1) moved = true;
      const deltaSec = deltaPx / zoomPxPerSec;
      const desiredStart = snapTime(initialClip.startTime + deltaSec);
      const patch = trimClipStart(initialClip, desiredStart, initialTrackClips);
      updateClip(clip.id, patch, false, {
        clip: initialClip,
        subtitles: initialSubtitles,
      });
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

  const handleTrimRightMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: TimelineClip,
    trackLocked: boolean
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    if (trackLocked) return;

    const initialClip = cloneClipForSnapshot(clip);
    const initialTrackClips = project.clips.filter((c) => c.trackId === clip.trackId);
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: project.clips.map(cloneClipForSnapshot),
      subtitles: initialSubtitles.map((s) => ({ ...s })),
      subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
      subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
    };

    const initialX = e.clientX;
    const initialDur = clip.duration;
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      const deltaPx = moveEv.clientX - initialX;
      if (Math.abs(deltaPx) > 1) moved = true;
      const deltaSec = deltaPx / zoomPxPerSec;
      const desiredDur = snapTime(initialDur + deltaSec);
      const patch = trimClipEnd(initialClip, desiredDur, initialTrackClips);
      updateClip(clip.id, patch, false, {
        clip: initialClip,
        subtitles: initialSubtitles,
      });
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

  // Find a clip to split: either the selected clip (if playhead is inside it) or any clip under playhead
  const splittableClip = (() => {
    if (selectedClipId) {
      const sel = project.clips.find((c) => c.id === selectedClipId);
      if (sel && playheadTime > sel.startTime + 0.2 && playheadTime < sel.startTime + sel.duration - 0.2) {
        return sel;
      }
    }
    return (
      project.clips.find(
        (c) => playheadTime > c.startTime + 0.2 && playheadTime < c.startTime + c.duration - 0.2
      ) ?? null
    );
  })();

  const handleSplitAtPlayhead = () => {
    if (!splittableClip) return;
    splitClipAtTime(splittableClip.id, playheadTime);
  };

  const handleAddText = () => {
    const created = addTextOverlay("Title Overlay", playheadTime);
    if (created) {
      onSelectClip(created.id);
    }
  };

  const handleFitZoom = () => {
    const viewport = tracksAreaRef.current?.clientWidth || 720;
    const targetSpan = Math.max(10, totalDuration + 2);
    const computed = Math.floor((viewport - 32) / targetSpan);
    setZoomPxPerSec(Math.min(120, Math.max(10, computed)));
  };

  const rulerStep =
    zoomPxPerSec >= 70 ? 1 : zoomPxPerSec >= 36 ? 2 : zoomPxPerSec >= 20 ? 5 : 10;
  const markers: number[] = [];
  for (let s = 0; s <= timelineSeconds; s += rulerStep) {
    markers.push(s);
  }

  return (
    <div className="border-t border-zinc-800/80 bg-[#0D0D10] flex flex-col select-none">
      {/* Editing Toolbar */}
      <div className="h-11 px-4 border-b border-zinc-800/80 flex items-center justify-between gap-4 overflow-x-auto">
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Undo / Redo */}
          <button
            type="button"
            disabled={!canUndo}
            onClick={undo}
            className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={redo}
            className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <span className="h-4 w-px bg-zinc-800 mx-1" aria-hidden="true" />

          <button
            type="button"
            onClick={() => onToolChange("select")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              activeTool === "select"
                ? "bg-violet-600/20 text-violet-300 border border-violet-500/40"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white border border-transparent"
            }`}
            title="Select, Move & Trim (V)"
          >
            <MousePointer2 className="h-3.5 w-3.5" />
            <span>Select</span>
          </button>
          <button
            type="button"
            onClick={() => onToolChange("razor")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              activeTool === "razor"
                ? "bg-violet-600/20 text-violet-300 border border-violet-500/40"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white border border-transparent"
            }`}
            title="Razor Split (C)"
          >
            <Scissors className="h-3.5 w-3.5" />
            <span>Razor</span>
          </button>

          <span className="h-4 w-px bg-zinc-800 mx-1" aria-hidden="true" />

          <button
            type="button"
            onClick={handleAddText}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors"
            title="Add Text Overlay at playhead"
          >
            <Type className="h-3.5 w-3.5 text-emerald-400" />
            <span>Add Text</span>
          </button>

          <button
            type="button"
            disabled={!splittableClip}
            onClick={handleSplitAtPlayhead}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Split clip at playhead (S)"
          >
            <Scissors className="h-3.5 w-3.5 text-blue-400" />
            <span>Split</span>
          </button>

          <span className="h-4 w-px bg-zinc-800 mx-1" aria-hidden="true" />

          <button
            type="button"
            disabled={!selectedClipId}
            onClick={() => selectedClipId && reorderClip(selectedClipId, "earlier")}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Reorder clip earlier on track"
            aria-label="Move clip earlier"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!selectedClipId}
            onClick={() => selectedClipId && reorderClip(selectedClipId, "later")}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Reorder clip later on track"
            aria-label="Move clip later"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={!selectedClipId}
            onClick={() => {
              if (!selectedClipId) return;
              const copy = duplicateClip(selectedClipId);
              if (copy) onSelectClip(copy.id);
            }}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Duplicate selected clip"
            aria-label="Duplicate selected clip"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={!selectedClipId}
            onClick={() => {
              if (selectedClipId) {
                deleteClip(selectedClipId);
                onSelectClip(null);
              }
            }}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400 disabled:opacity-35 transition-colors"
            title="Delete selected clip (Del)"
            aria-label="Delete selected clip"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            disabled={project.clips.filter((c) => c.trackId === "track_v1").length === 0}
            onClick={() => packTrackGaps("track_v1")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Pack V1 clips back-to-back to close timeline gaps"
          >
            <AlignHorizontalJustifyStart className="h-3.5 w-3.5 text-cyan-400" />
            <span className="hidden md:inline">Close Gaps</span>
          </button>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setSnapEnabled(!snapEnabled)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              snapEnabled
                ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                : "text-zinc-400 hover:text-white border border-transparent"
            }`}
            title="Toggle Grid Snapping"
          >
            <Magnet className="h-3.5 w-3.5" />
            <span>Snap</span>
          </button>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setZoomPxPerSec((z) => Math.max(10, z - 8))}
              className="p-1 text-zinc-400 hover:text-white"
              aria-label="Zoom out timeline"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={10}
              max={120}
              value={zoomPxPerSec}
              onChange={(e) => setZoomPxPerSec(Number(e.target.value))}
              className="w-20 accent-violet-500"
              aria-label="Timeline zoom"
            />
            <button
              type="button"
              onClick={() => setZoomPxPerSec((z) => Math.min(120, z + 8))}
              className="p-1 text-zinc-400 hover:text-white"
              aria-label="Zoom in timeline"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleFitZoom}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Fit sequence to timeline width"
              aria-label="Fit timeline zoom"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Tracks + Scrollable Ruler Grid */}
      <div className="flex min-h-[245px] max-h-[290px] overflow-y-auto overflow-x-hidden">
        {/* Left Track Headers */}
        <div className="w-36 sm:w-44 shrink-0 border-r border-zinc-800/80 bg-[#111114] flex flex-col">
          <div className="h-7 border-b border-zinc-800/80 px-3 flex items-center text-[10px] font-mono text-zinc-500 uppercase">
            Tracks
          </div>
          {project.tracks.map((track) => (
            <div
              key={track.id}
              className="h-14 border-b border-zinc-800/60 px-3 flex items-center justify-between gap-2 shrink-0"
            >
              <span className="text-xs font-medium text-zinc-200 truncate">{track.name}</span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleTrackMute(track.id)}
                  className={`p-1 rounded hover:bg-zinc-800 ${
                    track.muted ? "text-rose-400" : "text-zinc-400"
                  }`}
                  title={track.muted ? "Unmute / Show track" : "Mute / Hide track"}
                >
                  {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => toggleTrackLock(track.id)}
                  className={`p-1 rounded hover:bg-zinc-800 ${
                    track.locked ? "text-amber-400" : "text-zinc-400"
                  }`}
                  title={track.locked ? "Unlock track" : "Lock track"}
                >
                  {track.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Right Scrollable Timeline Canvas */}
        <div
          ref={tracksAreaRef}
          className="flex-1 overflow-x-auto overflow-y-hidden relative bg-[#09090B]"
          onClick={() => onSelectClip(null)}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) {
              e.preventDefault();
              setZoomPxPerSec((z) =>
                Math.min(120, Math.max(10, z + (e.deltaY < 0 ? 6 : -6)))
              );
            }
          }}
        >
          <div style={{ width: `${timelineWidth}px` }} className="relative">
            {/* Time Ruler */}
            <div
              onMouseDown={handleRulerMouseDown}
              className="h-7 border-b border-zinc-800/80 bg-[#111114] relative cursor-ew-resize"
            >
              {markers.map((sec) => (
                <div
                  key={sec}
                  style={{ left: `${sec * zoomPxPerSec}px` }}
                  className="absolute top-0 bottom-0 border-l border-zinc-800 pl-1.5 flex items-center text-[10px] font-mono text-zinc-500 tabular-nums"
                >
                  {formatTimecode(sec)}
                </div>
              ))}
            </div>

            {/* Track Lanes */}
            {project.tracks.map((track) => {
              const trackClips = project.clips.filter((c) => c.trackId === track.id);
              const isDropTarget = dropIndicator?.trackId === track.id;
              return (
                <div
                  key={track.id}
                  ref={(el) => {
                    trackRowRefs.current[track.id] = el;
                  }}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                      onSeek(clientXToTime(e.clientX));
                    }
                  }}
                  onDragOver={(e) => {
                    if (track.locked) return;
                    if (e.dataTransfer.types.includes("application/x-ai-studio-asset-id")) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setDropIndicator({
                        trackId: track.id,
                        timeSec: snapTime(clientXToTime(e.clientX)),
                      });
                    }
                  }}
                  onDragLeave={() => {
                    if (dropIndicator?.trackId === track.id) {
                      setDropIndicator(null);
                    }
                  }}
                  onDrop={(e) => {
                    const assetId = e.dataTransfer.getData("application/x-ai-studio-asset-id");
                    setDropIndicator(null);
                    if (!assetId || track.locked) return;
                    e.preventDefault();
                    const asset = mediaAssets.find((a) => a.id === assetId);
                    if (!asset) return;
                    const dropTime = snapTime(clientXToTime(e.clientX));
                    const targetTrackId = isAssetKindCompatibleWithTrack(asset.kind, track.type)
                      ? track.id
                      : asset.kind === "audio"
                        ? "track_a1"
                        : "track_v1";
                    const created = addClipToTimeline(asset, targetTrackId, dropTime);
                    if (created) {
                      onSelectClip(created.id);
                    }
                  }}
                  className={`h-14 border-b border-zinc-800/60 relative transition-colors ${
                    track.locked
                      ? "bg-zinc-950/80 opacity-75"
                      : isDropTarget
                        ? "bg-violet-500/10"
                        : ""
                  }`}
                >
                  {isDropTarget && dropIndicator && (
                    <div
                      style={{ left: `${dropIndicator.timeSec * zoomPxPerSec}px` }}
                      className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 pointer-events-none z-20"
                    />
                  )}

                  {track.type === "audio" && trackClips.length === 0 && (
                    <div className="absolute inset-0 flex items-center pl-4 pointer-events-none">
                      <span className="text-[11px] text-zinc-600">
                        Drop MP3, WAV, or M4A audio clips onto A1
                      </span>
                    </div>
                  )}

                  {trackClips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const isDragging = clip.id === draggingClipId;
                    const leftPx = clip.startTime * zoomPxPerSec;
                    const widthPx = Math.max(28, clip.duration * zoomPxPerSec);
                    const isClipMuted = Boolean(clip.muted || track.muted || clip.volume <= 0.001);
                    const targetBars = Math.max(14, Math.min(140, Math.round(widthPx / 3.5)));
                    const waveformBars = clip.waveformPeaks?.length
                      ? sliceWaveformPeaksForClip(clip.waveformPeaks, clip, targetBars)
                      : [];
                    const { fadeIn, fadeOut } = computeEffectiveFadeDurations(
                      clip.duration,
                      clip.fadeInSec,
                      clip.fadeOutSec
                    );
                    const fadeInPct = clip.duration > 0 ? Math.min(100, (fadeIn / clip.duration) * 100) : 0;
                    const fadeOutPct = clip.duration > 0 ? Math.min(100, (fadeOut / clip.duration) * 100) : 0;
                    const gainScale = isClipMuted ? 0.14 : Math.max(0.18, Math.min(1.65, clip.volume));

                    const trIn =
                      clip.kind !== "audio"
                        ? normalizeTransition(clip.transitionIn, clip.duration)
                        : null;
                    const trOut =
                      clip.kind !== "audio"
                        ? normalizeTransition(clip.transitionOut, clip.duration)
                        : null;
                    const trInPct =
                      trIn && trIn.type !== "none" && clip.duration > 0
                        ? Math.min(45, (trIn.durationSec / clip.duration) * 100)
                        : 0;
                    const trOutPct =
                      trOut && trOut.type !== "none" && clip.duration > 0
                        ? Math.min(45, (trOut.durationSec / clip.duration) * 100)
                        : 0;

                    const effCustomized =
                      (clip.kind === "video" || clip.kind === "image") &&
                      hasCustomEffects(clip.effects);
                    const effPresetLabel =
                      effCustomized && clip.effects?.preset && clip.effects.preset !== "none"
                        ? EFFECT_PRESETS.find((p) => p.value === clip.effects?.preset)?.label ?? "FX"
                        : "FX";

                    const colorClasses =
                      clip.kind === "text"
                        ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-100"
                        : clip.kind === "audio"
                        ? isClipMuted
                          ? "bg-zinc-800/50 border-zinc-600/60 text-zinc-400"
                          : "bg-blue-600/25 border-blue-500/50 text-blue-100"
                        : track.type === "overlay"
                        ? "bg-indigo-600/25 border-indigo-400/50 text-indigo-100"
                        : "bg-violet-600/25 border-violet-500/50 text-violet-100";

                    return (
                      <div
                        key={clip.id}
                        onMouseDown={(e) => handleClipMouseDown(e, clip, track.locked)}
                        style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                        className={`group/clip absolute top-1.5 bottom-1.5 rounded-md border overflow-hidden flex items-center px-2.5 gap-2 ${
                          activeTool === "razor"
                            ? "cursor-crosshair"
                            : "cursor-grab active:cursor-grabbing"
                        } ${colorClasses} ${
                          isDragging
                            ? "ring-2 ring-cyan-400 opacity-90 z-20"
                            : isSelected
                              ? "ring-2 ring-white/90 z-10"
                              : "hover:brightness-110"
                        }`}
                      >
                        {/* Real Audio PCM Waveform Backdrop */}
                        {waveformBars.length > 0 && (
                          <div
                            aria-hidden="true"
                            className={`absolute inset-0 flex pointer-events-none px-0.5 ${
                              clip.kind === "audio"
                                ? "items-center gap-[1px]"
                                : "items-end pb-0.5 gap-[1px] opacity-40"
                            }`}
                          >
                            {waveformBars.map((amp, idx) => {
                              const barHeightPct = Math.max(
                                8,
                                Math.min(92, Math.round(amp * 88 * gainScale))
                              );
                              return (
                                <span
                                  key={idx}
                                  style={{ height: `${clip.kind === "audio" ? barHeightPct : Math.round(barHeightPct * 0.48)}%` }}
                                  className={`flex-1 rounded-[1px] ${
                                    clip.kind === "audio"
                                      ? isClipMuted
                                        ? "bg-zinc-500/45"
                                        : "bg-sky-300/45"
                                      : "bg-violet-200/45"
                                  }`}
                                />
                              );
                            })}
                          </div>
                        )}

                        {/* Visual Fade-In / Fade-Out Envelopes (Audio) */}
                        {fadeInPct > 0.5 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            style={{ width: `${fadeInPct}%` }}
                            className="absolute left-0 top-0 bottom-0 h-full pointer-events-none"
                            aria-hidden="true"
                          >
                            <polygon points="0,0 100,0 0,100" fill="rgba(9,9,11,0.58)" />
                            <line
                              x1="0"
                              y1="100"
                              x2="100"
                              y2="0"
                              stroke="rgba(125,211,252,0.75)"
                              strokeWidth="2"
                            />
                          </svg>
                        )}
                        {fadeOutPct > 0.5 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            style={{ width: `${fadeOutPct}%` }}
                            className="absolute right-0 top-0 bottom-0 h-full pointer-events-none"
                            aria-hidden="true"
                          >
                            <polygon points="0,0 100,0 100,100" fill="rgba(9,9,11,0.58)" />
                            <line
                              x1="0"
                              y1="0"
                              x2="100"
                              y2="100"
                              stroke="rgba(125,211,252,0.75)"
                              strokeWidth="2"
                            />
                          </svg>
                        )}

                        {/* Visual Transition Edge Wedges (V1/V2/T1) */}
                        {trInPct > 0.5 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            style={{ width: `${trInPct}%` }}
                            className="absolute left-0 top-0 bottom-0 h-full pointer-events-none"
                            aria-hidden="true"
                          >
                            <polygon points="0,0 100,0 0,100" fill="rgba(245,158,11,0.34)" />
                            <line
                              x1="0"
                              y1="100"
                              x2="100"
                              y2="0"
                              stroke="rgba(251,191,36,0.85)"
                              strokeWidth="2"
                            />
                          </svg>
                        )}
                        {trOutPct > 0.5 && (
                          <svg
                            viewBox="0 0 100 100"
                            preserveAspectRatio="none"
                            style={{ width: `${trOutPct}%` }}
                            className="absolute right-0 top-0 bottom-0 h-full pointer-events-none"
                            aria-hidden="true"
                          >
                            <polygon points="0,0 100,0 100,100" fill="rgba(245,158,11,0.34)" />
                            <line
                              x1="0"
                              y1="0"
                              x2="100"
                              y2="100"
                              stroke="rgba(251,191,36,0.85)"
                              strokeWidth="2"
                            />
                          </svg>
                        )}

                        {/* Left Trim Handle */}
                        {!track.locked && (
                          <div
                            onMouseDown={(e) => handleTrimLeftMouseDown(e, clip, track.locked)}
                            className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10"
                            title="Drag to trim clip start"
                          />
                        )}

                        {clip.thumbnailUrl && widthPx > 56 && (
                          <img
                            src={clip.thumbnailUrl}
                            alt=""
                            className="relative z-[1] h-7 w-10 rounded object-cover shrink-0 pointer-events-none"
                          />
                        )}
                        <div className="relative z-[1] min-w-0 flex-1 pointer-events-none">
                          <div className="flex items-center gap-1">
                            {clip.needsRelink && (
                              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
                            )}
                            {isClipMuted && (clip.kind === "audio" || clip.kind === "video") && (
                              <VolumeX className="h-3 w-3 text-rose-300 shrink-0" />
                            )}
                            <p className="text-[11px] font-medium truncate drop-shadow-sm">
                              {clip.kind === "text" ? clip.textStyle?.text || clip.name : clip.name}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] font-mono opacity-85 tabular-nums truncate">
                            <span>{formatTimecode(clip.duration)}</span>
                            {(clip.kind === "audio" || clip.kind === "video") &&
                              !isClipMuted &&
                              Math.abs(clip.volume - 1) > 0.02 && (
                                <span className="text-sky-200">
                                  {Math.round(clip.volume * 100)}%
                                </span>
                              )}
                            {clip.kind === "audio" && clip.duckingEnabled && widthPx > 96 && (
                              <span className="text-amber-200">
                                Duck
                              </span>
                            )}
                            {effCustomized && widthPx > 88 && (
                              <span className="text-amber-300">
                                {effPresetLabel}
                              </span>
                            )}
                            {clip.kind !== "audio" && clip.opacity < 0.99 && widthPx > 96 && (
                              <span className="text-zinc-300">
                                {Math.round(clip.opacity * 100)}%
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Right Trim Handle */}
                        {!track.locked && (
                          <div
                            onMouseDown={(e) => handleTrimRightMouseDown(e, clip, track.locked)}
                            className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10"
                            title="Drag to trim clip end"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* Playhead Needle */}
            <div
              style={{ left: `${playheadTime * zoomPxPerSec}px` }}
              className="absolute top-0 bottom-0 w-px bg-violet-400 pointer-events-none z-20"
            >
              <div className="-translate-x-1/2 w-2.5 h-3 bg-violet-400 rounded-b-sm" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
