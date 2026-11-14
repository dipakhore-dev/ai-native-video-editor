import React, { useRef, useState } from "react";
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
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { Project, TimelineClip } from "../../types/studio";
import { formatTimecode } from "../../utils/media";
import { trimClipStart } from "../../utils/timeline";

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
  const tracksAreaRef = useRef<HTMLDivElement | null>(null);

  const timelineSeconds = Math.max(30, Math.ceil(totalDuration + 10));
  const timelineWidth = timelineSeconds * zoomPxPerSec;

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

    const initialClip = { ...clip };
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: project.clips.map((c) => ({
        ...c,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
      })),
      subtitles: initialSubtitles.map((s) => ({ ...s })),
      subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
      subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
    };

    const initialX = e.clientX;
    const initialStart = clip.startTime;
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      const deltaPx = moveEv.clientX - initialX;
      if (Math.abs(deltaPx) > 2) moved = true;
      const deltaSec = deltaPx / zoomPxPerSec;
      const nextStart = snapTime(initialStart + deltaSec);
      updateClip(clip.id, { startTime: nextStart }, false, {
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

  const handleTrimLeftMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    clip: TimelineClip,
    trackLocked: boolean
  ) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    if (trackLocked) return;

    const initialClip = { ...clip };
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: project.clips.map((c) => ({
        ...c,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
      })),
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
      const patch = trimClipStart(initialClip, desiredStart);
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

    const initialClip = { ...clip };
    const initialSubtitles = (project.subtitles ?? []).map((s) => ({ ...s }));
    const beforeSnapshot: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t })),
      clips: project.clips.map((c) => ({
        ...c,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
      })),
      subtitles: initialSubtitles.map((s) => ({ ...s })),
      subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
      subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
    };

    const initialX = e.clientX;
    const initialDur = clip.duration;
    const maxDur =
      clip.kind === "image" || clip.kind === "text"
        ? 60
        : Math.max(0.5, (clip.sourceDuration - clip.inPoint) / clip.speed);
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      const deltaPx = moveEv.clientX - initialX;
      if (Math.abs(deltaPx) > 1) moved = true;
      const deltaSec = deltaPx / zoomPxPerSec;
      const clamped = Math.min(maxDur, Math.max(0.5, snapTime(initialDur + deltaSec)));
      updateClip(clip.id, { duration: clamped }, false, {
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

  const rulerStep = zoomPxPerSec >= 36 ? 2 : zoomPxPerSec >= 20 ? 5 : 10;
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
            onClick={() => selectedClipId && duplicateClip(selectedClipId)}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
            title="Duplicate selected clip"
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
          >
            <Trash2 className="h-3.5 w-3.5" />
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
              onClick={() => setZoomPxPerSec((z) => Math.max(12, z - 6))}
              className="p-1 text-zinc-400 hover:text-white"
              aria-label="Zoom out timeline"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={12}
              max={64}
              value={zoomPxPerSec}
              onChange={(e) => setZoomPxPerSec(Number(e.target.value))}
              className="w-20 accent-violet-500"
              aria-label="Timeline zoom"
            />
            <button
              type="button"
              onClick={() => setZoomPxPerSec((z) => Math.min(64, z + 6))}
              className="p-1 text-zinc-400 hover:text-white"
              aria-label="Zoom in timeline"
            >
              <ZoomIn className="h-3.5 w-3.5" />
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
              return (
                <div
                  key={track.id}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                      onSeek(clientXToTime(e.clientX));
                    }
                  }}
                  className={`h-14 border-b border-zinc-800/60 relative ${
                    track.locked ? "bg-zinc-950/80 opacity-75" : ""
                  }`}
                >
                  {trackClips.map((clip) => {
                    const isSelected = clip.id === selectedClipId;
                    const leftPx = clip.startTime * zoomPxPerSec;
                    const widthPx = Math.max(28, clip.duration * zoomPxPerSec);
                    const colorClasses =
                      clip.kind === "text"
                        ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-100"
                        : clip.kind === "audio"
                        ? "bg-blue-600/25 border-blue-500/50 text-blue-100"
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
                          isSelected ? "ring-2 ring-white/90 z-10" : "hover:brightness-110"
                        }`}
                      >
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
                            className="h-7 w-10 rounded object-cover shrink-0 pointer-events-none"
                          />
                        )}
                        <div className="min-w-0 flex-1 pointer-events-none">
                          <div className="flex items-center gap-1">
                            {clip.needsRelink && (
                              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
                            )}
                            <p className="text-[11px] font-medium truncate">
                              {clip.kind === "text" ? clip.textStyle?.text || clip.name : clip.name}
                            </p>
                          </div>
                          <p className="text-[10px] font-mono opacity-75 tabular-nums">
                            {formatTimecode(clip.duration)}
                          </p>
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
