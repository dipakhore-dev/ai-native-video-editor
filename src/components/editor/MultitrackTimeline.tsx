import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { cloneKeyframes, formatKeyframeValueDisplay, KEYFRAME_PROPERTY_SPECS } from "../../utils/keyframes";
import { trimClipEnd, trimClipStart } from "../../utils/timeline";
import { usePlaybackTime, type TimelinePlaybackClock } from "../../utils/timelineClock";
import { WaveformCanvas } from "./WaveformCanvas";

interface MultitrackTimelineProps {
  project: Project;
  playheadTime?: number;
  playbackClock?: TimelinePlaybackClock;
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
    // Keep immutable waveformPeaks array by reference
    waveformPeaks: c.waveformPeaks,
    keyframes: cloneKeyframes(c.keyframes),
    textStyle: c.textStyle ? { ...c.textStyle } : undefined,
    transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
    transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
    effects: c.effects ? normalizeEffects(c.effects) : undefined,
    overlayTransform: c.overlayTransform ? { ...c.overlayTransform } : undefined,
  };
}

const TimelinePlayheadNeedle = React.memo(function TimelinePlayheadNeedle({
  playbackClock,
  playheadTime = 0,
  zoomPxPerSec,
  tracksAreaRef,
}: {
  playbackClock?: TimelinePlaybackClock;
  playheadTime?: number;
  zoomPxPerSec: number;
  tracksAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const needleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncDom = (timeSec: number) => {
      const px = timeSec * zoomPxPerSec;
      if (needleRef.current) {
        needleRef.current.style.transform = `translate3d(${px}px, 0, 0)`;
      }
      const container = tracksAreaRef.current;
      if (container) {
        const viewLeft = container.scrollLeft;
        const viewRight = viewLeft + container.clientWidth;
        if (px > viewRight - 24 || px < viewLeft) {
          container.scrollLeft = Math.max(0, px - container.clientWidth * 0.25);
        }
      }
    };

    syncDom(playbackClock ? playbackClock.getTime() : playheadTime);
    if (!playbackClock) return;
    return playbackClock.subscribe(syncDom);
  }, [playbackClock, playheadTime, zoomPxPerSec, tracksAreaRef]);

  const initialPx = (playbackClock ? playbackClock.getTime() : playheadTime) * zoomPxPerSec;

  return (
    <div
      ref={needleRef}
      style={{ transform: `translate3d(${initialPx}px, 0, 0)` }}
      className="absolute top-0 bottom-0 left-0 w-px bg-violet-400 pointer-events-none z-20 will-change-transform"
    >
      <div className="-translate-x-1/2 w-2.5 h-3 bg-violet-400 rounded-b-sm" />
    </div>
  );
});

const SplitPlayheadButton = React.memo(function SplitPlayheadButton({
  clips,
  selectedClipId,
  playbackClock,
  fallbackTime = 0,
  onSplit,
}: {
  clips: TimelineClip[];
  selectedClipId: string | null;
  playbackClock?: TimelinePlaybackClock;
  fallbackTime?: number;
  onSplit: (clipId: string, timeSec: number) => boolean;
}) {
  const currentTime = usePlaybackTime(playbackClock, {
    fallbackTime,
    throttleMs: 120,
  });

  const splittableClip = useMemo(() => {
    if (selectedClipId) {
      const sel = clips.find((c) => c.id === selectedClipId);
      if (sel && currentTime > sel.startTime + 0.2 && currentTime < sel.startTime + sel.duration - 0.2) {
        return sel;
      }
    }
    return (
      clips.find(
        (c) => currentTime > c.startTime + 0.2 && currentTime < c.startTime + c.duration - 0.2
      ) ?? null
    );
  }, [clips, selectedClipId, currentTime]);

  return (
    <button
      type="button"
      disabled={!splittableClip}
      onClick={() => {
        if (!splittableClip) return;
        const exactTime = playbackClock ? playbackClock.getTime() : currentTime;
        onSplit(splittableClip.id, exactTime);
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35 transition-colors"
      title="Split clip at playhead (S)"
    >
      <Scissors className="h-3.5 w-3.5 text-blue-400" />
      <span>Split</span>
    </button>
  );
});

interface TimelineClipItemProps {
  clip: TimelineClip;
  trackLocked: boolean;
  trackMuted: boolean;
  trackType: TrackType;
  zoomPxPerSec: number;
  isSelected: boolean;
  isDragging: boolean;
  activeTool: "select" | "razor";
  onSelectClip: (clipId: string | null) => void;
  onSeek: (time: number) => void;
  onClipMouseDown: (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => void;
  onTrimLeftMouseDown: (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => void;
  onTrimRightMouseDown: (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => void;
}

const TimelineClipItem = React.memo(function TimelineClipItem({
  clip,
  trackLocked,
  trackMuted,
  trackType,
  zoomPxPerSec,
  isSelected,
  isDragging,
  activeTool,
  onSelectClip,
  onSeek,
  onClipMouseDown,
  onTrimLeftMouseDown,
  onTrimRightMouseDown,
}: TimelineClipItemProps) {
  const leftPx = clip.startTime * zoomPxPerSec;
  const widthPx = Math.max(28, clip.duration * zoomPxPerSec);
  const hasVolumeKf = Boolean(clip.keyframes?.some((k) => k.property === "volume"));
  const isClipMuted = Boolean(clip.muted || trackMuted || (!hasVolumeKf && clip.volume <= 0.001));
  const targetBars = Math.max(14, Math.min(140, Math.round(widthPx / 3.5)));

  const waveformBars = useMemo(
    () =>
      clip.waveformPeaks?.length
        ? sliceWaveformPeaksForClip(clip.waveformPeaks, clip, targetBars, clip.assetId)
        : [],
    [
      clip.waveformPeaks,
      clip.assetId,
      clip.inPoint,
      clip.duration,
      clip.sourceDuration,
      clip.speed,
      targetBars,
    ]
  );

  const { fadeIn, fadeOut } = computeEffectiveFadeDurations(
    clip.duration,
    clip.fadeInSec,
    clip.fadeOutSec
  );
  const fadeInPct = clip.duration > 0 ? Math.min(100, (fadeIn / clip.duration) * 100) : 0;
  const fadeOutPct = clip.duration > 0 ? Math.min(100, (fadeOut / clip.duration) * 100) : 0;
  const gainScale = isClipMuted ? 0.14 : Math.max(0.18, Math.min(1.65, clip.volume));

  const trIn =
    clip.kind !== "audio" ? normalizeTransition(clip.transitionIn, clip.duration) : null;
  const trOut =
    clip.kind !== "audio" ? normalizeTransition(clip.transitionOut, clip.duration) : null;
  const trInPct =
    trIn && trIn.type !== "none" && clip.duration > 0
      ? Math.min(45, (trIn.durationSec / clip.duration) * 100)
      : 0;
  const trOutPct =
    trOut && trOut.type !== "none" && clip.duration > 0
      ? Math.min(45, (trOut.durationSec / clip.duration) * 100)
      : 0;

  const effCustomized =
    (clip.kind === "video" || clip.kind === "image") && hasCustomEffects(clip.effects);
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
        : trackType === "overlay"
          ? "bg-indigo-600/25 border-indigo-400/50 text-indigo-100"
          : "bg-violet-600/25 border-violet-500/50 text-violet-100";

  return (
    <div
      onMouseDown={(e) => onClipMouseDown(e, clip, trackLocked)}
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
      {/* Real Audio PCM Waveform Canvas */}
      {waveformBars.length > 0 && (
        <WaveformCanvas
          bars={waveformBars}
          widthPx={widthPx}
          kind={clip.kind}
          gainScale={gainScale}
          isMuted={isClipMuted}
        />
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
          <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(125,211,252,0.75)" strokeWidth="2" />
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
          <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(125,211,252,0.75)" strokeWidth="2" />
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
          <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(251,191,36,0.85)" strokeWidth="2" />
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
          <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(251,191,36,0.85)" strokeWidth="2" />
        </svg>
      )}

      {/* Left Trim Handle */}
      {!trackLocked && (
        <div
          onMouseDown={(e) => onTrimLeftMouseDown(e, clip, trackLocked)}
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
          {clip.needsRelink && <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />}
          {isClipMuted && (clip.kind === "audio" || clip.kind === "video") && (
            <VolumeX className="h-3 w-3 text-rose-300 shrink-0" />
          )}
          <p className="text-[11px] font-medium truncate drop-shadow-sm">
            {clip.kind === "text" ? clip.textStyle?.text || clip.name : clip.name}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono opacity-85 tabular-nums truncate">
          <span>{formatTimecode(clip.duration)}</span>
          {Math.abs(clip.speed - 1) > 0.01 && (
            <span className="text-cyan-200">{Number(clip.speed.toFixed(2))}x</span>
          )}
          {(clip.kind === "audio" || clip.kind === "video") &&
            !isClipMuted &&
            Math.abs(clip.volume - 1) > 0.02 && (
              <span className="text-sky-200">{Math.round(clip.volume * 100)}%</span>
            )}
          {clip.kind === "audio" && clip.duckingEnabled && widthPx > 96 && (
            <span className="text-amber-200">Duck</span>
          )}
          {effCustomized && widthPx > 88 && <span className="text-amber-300">{effPresetLabel}</span>}
          {clip.kind !== "audio" && clip.opacity < 0.99 && widthPx > 96 && (
            <span className="text-zinc-300">{Math.round(clip.opacity * 100)}%</span>
          )}
        </div>
      </div>

      {/* Keyframe Diamond Markers */}
      {clip.keyframes && clip.keyframes.length > 0 && clip.duration > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0.5 h-3 z-[2]">
          {clip.keyframes.map((kf) => {
            const pct = Math.max(2, Math.min(98, (kf.timeSec / clip.duration) * 100));
            return (
              <button
                key={kf.id}
                type="button"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelectClip(clip.id);
                  onSeek(Number((clip.startTime + kf.timeSec).toFixed(2)));
                }}
                onClick={(e) => e.stopPropagation()}
                style={{ left: `${pct}%` }}
                className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rotate-45 bg-amber-400 border border-zinc-950 hover:scale-125 transition-transform"
                title={`${KEYFRAME_PROPERTY_SPECS[kf.property].shortLabel} @ ${kf.timeSec.toFixed(2)}s = ${formatKeyframeValueDisplay(kf.property, kf.value)} (${kf.easing})`}
                aria-label={`Jump to ${kf.property} keyframe at ${kf.timeSec.toFixed(2)}s`}
              />
            );
          })}
        </div>
      )}

      {/* Right Trim Handle */}
      {!trackLocked && (
        <div
          onMouseDown={(e) => onTrimRightMouseDown(e, clip, trackLocked)}
          className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40 z-10"
          title="Drag to trim clip end"
        />
      )}
    </div>
  );
});

export const MultitrackTimeline = React.memo(function MultitrackTimeline({
  project,
  playheadTime = 0,
  playbackClock,
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
  const projectRef = useRef(project);
  projectRef.current = project;

  const timelineSeconds = Math.max(30, Math.ceil(totalDuration + 10));
  const timelineWidth = timelineSeconds * zoomPxPerSec;

  const clipsByTrack = useMemo(() => {
    const grouped = new Map<string, TimelineClip[]>();
    for (const clip of project.clips) {
      const list = grouped.get(clip.trackId);
      if (list) {
        list.push(clip);
      } else {
        grouped.set(clip.trackId, [clip]);
      }
    }
    return grouped;
  }, [project.clips]);

  const snapTime = useCallback(
    (t: number): number => {
      if (!snapEnabled) return Math.max(0, Number(t.toFixed(2)));
      const grid = 0.25;
      return Math.max(0, Number((Math.round(t / grid) * grid).toFixed(2)));
    },
    [snapEnabled]
  );

  const clientXToTime = useCallback(
    (clientX: number): number => {
      if (!tracksAreaRef.current) return 0;
      const rect = tracksAreaRef.current.getBoundingClientRect();
      const x = clientX - rect.left + tracksAreaRef.current.scrollLeft;
      return Math.max(0, Number((x / zoomPxPerSec).toFixed(2)));
    },
    [zoomPxPerSec]
  );

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

  const resolveCompatibleTrackAtY = useCallback(
    (clientY: number, clipKind: MediaKind, fallbackTrackId: string): string => {
      for (const track of projectRef.current.tracks) {
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
    },
    []
  );

  const handleClipMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => {
      e.stopPropagation();
      onSelectClip(clip.id);

      if (trackLocked) return;

      if (activeTool === "razor") {
        const clickTime = clientXToTime(e.clientX);
        splitClipAtTime(clip.id, clickTime);
        return;
      }

      const curProj = projectRef.current;
      const initialClips = curProj.clips.map(cloneClipForSnapshot);
      const initialSubtitles = (curProj.subtitles ?? []).map((s) => ({ ...s }));
      const beforeSnapshot: Project = {
        ...curProj,
        tracks: curProj.tracks.map((t) => ({ ...t })),
        clips: initialClips.map(cloneClipForSnapshot),
        subtitles: initialSubtitles.map((s) => ({ ...s })),
        subtitleStyle: curProj.subtitleStyle ? { ...curProj.subtitleStyle } : undefined,
        subtitleMeta: curProj.subtitleMeta ? { ...curProj.subtitleMeta } : undefined,
      };

      const initialX = e.clientX;
      const initialStart = clip.startTime;
      let moved = false;
      let pendingClientX = e.clientX;
      let pendingClientY = e.clientY;
      let dragFrameId = 0;
      setDraggingClipId(clip.id);

      const applyMove = (clientX: number, clientY: number) => {
        const deltaPx = clientX - initialX;
        const targetTrackId = resolveCompatibleTrackAtY(clientY, clip.kind, clip.trackId);
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

      const onMove = (moveEv: MouseEvent) => {
        pendingClientX = moveEv.clientX;
        pendingClientY = moveEv.clientY;
        if (!dragFrameId) {
          dragFrameId = requestAnimationFrame(() => {
            dragFrameId = 0;
            applyMove(pendingClientX, pendingClientY);
          });
        }
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (dragFrameId) {
          cancelAnimationFrame(dragFrameId);
          dragFrameId = 0;
          applyMove(pendingClientX, pendingClientY);
        }
        setDraggingClipId(null);
        if (moved) {
          commitProjectSnapshot(beforeSnapshot);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      activeTool,
      clientXToTime,
      commitProjectSnapshot,
      moveClipOnTimeline,
      onSelectClip,
      resolveCompatibleTrackAtY,
      snapTime,
      splitClipAtTime,
      zoomPxPerSec,
    ]
  );

  const handleTrimLeftMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => {
      e.stopPropagation();
      onSelectClip(clip.id);
      if (trackLocked) return;

      const curProj = projectRef.current;
      const initialClip = cloneClipForSnapshot(clip);
      const initialTrackClips = curProj.clips.filter((c) => c.trackId === clip.trackId);
      const initialSubtitles = (curProj.subtitles ?? []).map((s) => ({ ...s }));
      const beforeSnapshot: Project = {
        ...curProj,
        tracks: curProj.tracks.map((t) => ({ ...t })),
        clips: curProj.clips.map(cloneClipForSnapshot),
        subtitles: initialSubtitles.map((s) => ({ ...s })),
        subtitleStyle: curProj.subtitleStyle ? { ...curProj.subtitleStyle } : undefined,
        subtitleMeta: curProj.subtitleMeta ? { ...curProj.subtitleMeta } : undefined,
      };

      const initialX = e.clientX;
      let moved = false;
      let pendingClientX = e.clientX;
      let trimFrameId = 0;

      const applyTrim = (clientX: number) => {
        const deltaPx = clientX - initialX;
        if (Math.abs(deltaPx) > 1) moved = true;
        const deltaSec = deltaPx / zoomPxPerSec;
        const desiredStart = snapTime(initialClip.startTime + deltaSec);
        const patch = trimClipStart(initialClip, desiredStart, initialTrackClips);
        updateClip(clip.id, patch, false, {
          clip: initialClip,
          subtitles: initialSubtitles,
        });
      };

      const onMove = (moveEv: MouseEvent) => {
        pendingClientX = moveEv.clientX;
        if (!trimFrameId) {
          trimFrameId = requestAnimationFrame(() => {
            trimFrameId = 0;
            applyTrim(pendingClientX);
          });
        }
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (trimFrameId) {
          cancelAnimationFrame(trimFrameId);
          trimFrameId = 0;
          applyTrim(pendingClientX);
        }
        if (moved) {
          commitProjectSnapshot(beforeSnapshot);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [commitProjectSnapshot, onSelectClip, snapTime, updateClip, zoomPxPerSec]
  );

  const handleTrimRightMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip, trackLocked: boolean) => {
      e.stopPropagation();
      onSelectClip(clip.id);
      if (trackLocked) return;

      const curProj = projectRef.current;
      const initialClip = cloneClipForSnapshot(clip);
      const initialTrackClips = curProj.clips.filter((c) => c.trackId === clip.trackId);
      const initialSubtitles = (curProj.subtitles ?? []).map((s) => ({ ...s }));
      const beforeSnapshot: Project = {
        ...curProj,
        tracks: curProj.tracks.map((t) => ({ ...t })),
        clips: curProj.clips.map(cloneClipForSnapshot),
        subtitles: initialSubtitles.map((s) => ({ ...s })),
        subtitleStyle: curProj.subtitleStyle ? { ...curProj.subtitleStyle } : undefined,
        subtitleMeta: curProj.subtitleMeta ? { ...curProj.subtitleMeta } : undefined,
      };

      const initialX = e.clientX;
      const initialDur = clip.duration;
      let moved = false;
      let pendingClientX = e.clientX;
      let trimFrameId = 0;

      const applyTrim = (clientX: number) => {
        const deltaPx = clientX - initialX;
        if (Math.abs(deltaPx) > 1) moved = true;
        const deltaSec = deltaPx / zoomPxPerSec;
        const desiredDur = snapTime(initialDur + deltaSec);
        const patch = trimClipEnd(initialClip, desiredDur, initialTrackClips);
        updateClip(clip.id, patch, false, {
          clip: initialClip,
          subtitles: initialSubtitles,
        });
      };

      const onMove = (moveEv: MouseEvent) => {
        pendingClientX = moveEv.clientX;
        if (!trimFrameId) {
          trimFrameId = requestAnimationFrame(() => {
            trimFrameId = 0;
            applyTrim(pendingClientX);
          });
        }
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (trimFrameId) {
          cancelAnimationFrame(trimFrameId);
          trimFrameId = 0;
          applyTrim(pendingClientX);
        }
        if (moved) {
          commitProjectSnapshot(beforeSnapshot);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [commitProjectSnapshot, onSelectClip, snapTime, updateClip, zoomPxPerSec]
  );

  const handleAddText = () => {
    const time = playbackClock ? playbackClock.getTime() : playheadTime;
    const created = addTextOverlay("Title Overlay", time);
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
  const markers = useMemo(() => {
    const list: number[] = [];
    for (let s = 0; s <= timelineSeconds; s += rulerStep) {
      list.push(s);
    }
    return list;
  }, [timelineSeconds, rulerStep]);

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

          <SplitPlayheadButton
            clips={project.clips}
            selectedClipId={selectedClipId}
            playbackClock={playbackClock}
            fallbackTime={playheadTime}
            onSplit={splitClipAtTime}
          />

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
              const trackClips = clipsByTrack.get(track.id) ?? [];
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

                  {trackClips.map((clip) => (
                    <TimelineClipItem
                      key={clip.id}
                      clip={clip}
                      trackLocked={track.locked}
                      trackMuted={track.muted}
                      trackType={track.type}
                      zoomPxPerSec={zoomPxPerSec}
                      isSelected={clip.id === selectedClipId}
                      isDragging={clip.id === draggingClipId}
                      activeTool={activeTool}
                      onSelectClip={onSelectClip}
                      onSeek={onSeek}
                      onClipMouseDown={handleClipMouseDown}
                      onTrimLeftMouseDown={handleTrimLeftMouseDown}
                      onTrimRightMouseDown={handleTrimRightMouseDown}
                    />
                  ))}
                </div>
              );
            })}

            {/* Playhead Needle (GPU-composited direct clock subscriber) */}
            <TimelinePlayheadNeedle
              playbackClock={playbackClock}
              playheadTime={playheadTime}
              zoomPxPerSec={zoomPxPerSec}
              tracksAreaRef={tracksAreaRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
