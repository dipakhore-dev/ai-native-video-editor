import type {
  AspectRatioOption,
  Project,
  RenderTimelinePayload,
  ResolutionOption,
  TimelineClip,
  TimelineTrack,
} from "../types/studio";
import {
  buildSpeechIntervals,
  clampDuckingAmount,
  clampFadeSeconds,
  clampVolume,
} from "./audio";
import { hasCustomEffects, normalizeEffects, normalizeTransition } from "./effects";
import { hasCustomOverlayTransform, normalizeOverlayTransform } from "./overlays";

export function createDefaultTracks(): TimelineTrack[] {
  return [
    { id: "track_t1", name: "T1 Text", type: "text", muted: false, locked: false },
    { id: "track_v2", name: "V2 Overlay", type: "overlay", muted: false, locked: false },
    { id: "track_v1", name: "V1 Primary", type: "video", muted: false, locked: false },
    { id: "track_a1", name: "A1 Audio", type: "audio", muted: false, locked: false },
  ];
}

export function ensureProjectTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  const hasTextTrack = tracks.some((t) => t.id === "track_t1");
  if (hasTextTrack) return tracks;
  return [
    { id: "track_t1", name: "T1 Text", type: "text", muted: false, locked: false },
    ...tracks,
  ];
}

export function getSequenceDuration(project: Project): number {
  return project.clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
}

export const SUPPORTED_CLIP_SPEEDS = [0.5, 1, 1.5, 2] as const;

export function clampClipSpeed(speed: number | undefined, fallback = 1): number {
  const num = Number(speed);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(2, Math.max(0.5, Number(num.toFixed(2))));
}

/**
 * Recomputes a clip's timeline duration when changing playback speed (0.5x..2.0x)
 * while preserving the trimmed source span and clamping fades/transitions to the new duration.
 */
export function computeSpeedAdjustedClip(
  clip: TimelineClip,
  nextSpeed: number
): TimelineClip {
  if (clip.kind !== "video" && clip.kind !== "audio") {
    return clip;
  }

  const oldSpeed = clampClipSpeed(clip.speed, 1);
  const safeNextSpeed = clampClipSpeed(nextSpeed, 1);
  if (Math.abs(safeNextSpeed - oldSpeed) < 0.005) {
    return clip;
  }

  let sourceSpan = Math.max(0.1, clip.duration * oldSpeed);
  if (clip.sourceDuration > 0) {
    const maxAvail = Math.max(0.1, clip.sourceDuration - Math.max(0, clip.inPoint));
    sourceSpan = Math.min(sourceSpan, maxAvail);
  }

  const nextDuration = Math.max(0.25, Number((sourceSpan / safeNextSpeed).toFixed(2)));
  const nextTransitionIn = clip.transitionIn
    ? normalizeTransition(clip.transitionIn, nextDuration)
    : undefined;
  const nextTransitionOut = clip.transitionOut
    ? normalizeTransition(clip.transitionOut, nextDuration)
    : undefined;

  return {
    ...clip,
    speed: safeNextSpeed,
    duration: nextDuration,
    ...(clip.fadeInSec !== undefined
      ? { fadeInSec: clampFadeSeconds(clip.fadeInSec, nextDuration) }
      : {}),
    ...(clip.fadeOutSec !== undefined
      ? { fadeOutSec: clampFadeSeconds(clip.fadeOutSec, nextDuration) }
      : {}),
    ...(nextTransitionIn ? { transitionIn: nextTransitionIn } : {}),
    ...(nextTransitionOut ? { transitionOut: nextTransitionOut } : {}),
  };
}

/**
 * Applies a playback speed change to a clip and ripples subsequent clips on track_v1
 * so sequential V1 clips stay gap-free and non-overlapping when duration changes.
 */
export function applyClipSpeedOnTimeline(
  clips: TimelineClip[],
  clipId: string,
  nextSpeed: number
): {
  clips: TimelineClip[];
  updatedClip: TimelineClip | null;
  beforeClip: TimelineClip | null;
} {
  const beforeClip = clips.find((c) => c.id === clipId) ?? null;
  if (!beforeClip) {
    return { clips, updatedClip: null, beforeClip: null };
  }

  const updatedClip = computeSpeedAdjustedClip(beforeClip, nextSpeed);
  const durationDelta = Number((updatedClip.duration - beforeClip.duration).toFixed(2));
  const afterUpdatedEnd = Number((updatedClip.startTime + updatedClip.duration).toFixed(2));
  const beforeEnd = Number((beforeClip.startTime + beforeClip.duration).toFixed(2));

  if (beforeClip.trackId !== "track_v1" || Math.abs(durationDelta) < 0.005) {
    return {
      clips: clips.map((c) => (c.id === clipId ? updatedClip : c)),
      updatedClip,
      beforeClip,
    };
  }

  const v1Sorted = sortTrackClips(clips, "track_v1");
  const targetIdx = v1Sorted.findIndex((c) => c.id === clipId);
  if (targetIdx === -1) {
    return {
      clips: clips.map((c) => (c.id === clipId ? updatedClip : c)),
      updatedClip,
      beforeClip,
    };
  }

  const updatedV1ById = new Map<string, TimelineClip>();
  updatedV1ById.set(updatedClip.id, updatedClip);

  let prevEnd = afterUpdatedEnd;
  let prevOriginalEnd = beforeEnd;
  for (let i = targetIdx + 1; i < v1Sorted.length; i++) {
    const sibling = v1Sorted[i];
    const wasSequential = Math.abs(sibling.startTime - prevOriginalEnd) <= 0.15;
    prevOriginalEnd = Number((sibling.startTime + sibling.duration).toFixed(2));
    const shiftedStart = wasSequential
      ? prevEnd
      : Math.max(prevEnd, Number((sibling.startTime + durationDelta).toFixed(2)));
    const nextSib: TimelineClip = {
      ...sibling,
      startTime: Math.max(0, Number(shiftedStart.toFixed(2))),
    };
    updatedV1ById.set(sibling.id, nextSib);
    prevEnd = Number((nextSib.startTime + nextSib.duration).toFixed(2));
  }

  return {
    clips: clips.map((c) => updatedV1ById.get(c.id) ?? c),
    updatedClip,
    beforeClip,
  };
}

export function splitClipAtTimestamp(
  clips: TimelineClip[],
  clipId: string,
  playheadTime: number
): { clips: TimelineClip[]; didSplit: boolean } {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return { clips, didSplit: false };

  const splitOffset = playheadTime - target.startTime;
  if (splitOffset <= 0.2 || splitOffset >= target.duration - 0.2) {
    return { clips, didSplit: false };
  }

  const leftDuration = Number(splitOffset.toFixed(2));
  const rightDuration = Number((target.duration - leftDuration).toFixed(2));
  const rightInPoint =
    target.kind === "image" || target.kind === "text"
      ? 0
      : Number((target.inPoint + leftDuration * target.speed).toFixed(2));

  const leftTransitionIn = target.transitionIn
    ? normalizeTransition(target.transitionIn, leftDuration)
    : undefined;
  const rightTransitionOut = target.transitionOut
    ? normalizeTransition(target.transitionOut, rightDuration)
    : undefined;

  const leftClip: TimelineClip = {
    ...target,
    duration: leftDuration,
    fadeInSec: clampFadeSeconds(target.fadeInSec, leftDuration),
    fadeOutSec: 0,
    ...(leftTransitionIn ? { transitionIn: leftTransitionIn } : {}),
    transitionOut: undefined,
    effects: target.effects ? { ...target.effects } : undefined,
    overlayTransform: target.overlayTransform ? { ...target.overlayTransform } : undefined,
  };

  const rightClip: TimelineClip = {
    ...target,
    id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startTime: Number((target.startTime + leftDuration).toFixed(2)),
    duration: rightDuration,
    inPoint: rightInPoint,
    fadeInSec: 0,
    fadeOutSec: clampFadeSeconds(target.fadeOutSec, rightDuration),
    transitionIn: undefined,
    ...(rightTransitionOut ? { transitionOut: rightTransitionOut } : {}),
    effects: target.effects ? { ...target.effects } : undefined,
    overlayTransform: target.overlayTransform ? { ...target.overlayTransform } : undefined,
    textStyle: target.textStyle ? { ...target.textStyle } : undefined,
  };

  return {
    didSplit: true,
    clips: clips.flatMap((c) => (c.id === clipId ? [leftClip, rightClip] : [c])),
  };
}

export function sortTrackClips(clips: TimelineClip[], trackId: string): TimelineClip[] {
  return clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function applyOrderedTrackPositions(
  allClips: TimelineClip[],
  trackId: string,
  orderedTrackClips: TimelineClip[],
  startOrigin = 0
): TimelineClip[] {
  let cursor = Math.max(0, Number(startOrigin.toFixed(2)));
  const updatedById = new Map<string, TimelineClip>();

  for (const clip of orderedTrackClips) {
    updatedById.set(clip.id, {
      ...clip,
      trackId,
      startTime: cursor,
    });
    cursor = Number((cursor + clip.duration).toFixed(2));
  }

  return allClips.map((c) => updatedById.get(c.id) ?? c);
}

/**
 * Packs all clips on a track sequentially back-to-back starting from 0s without gaps or overlaps.
 */
export function packTrackClips(
  clips: TimelineClip[],
  trackId: string
): { clips: TimelineClip[]; changed: boolean } {
  const trackClips = sortTrackClips(clips, trackId);
  if (trackClips.length === 0) return { clips, changed: false };

  const nextClips = applyOrderedTrackPositions(clips, trackId, trackClips, 0);
  const changed = nextClips.some((c, i) => c.startTime !== clips[i].startTime);
  return { clips: nextClips, changed };
}

/**
 * Reorders a clip to an explicit 0-based index among clips on its track and packs them without overlap.
 */
export function reorderClipToIndex(
  clips: TimelineClip[],
  clipId: string,
  targetIndex: number
): { clips: TimelineClip[]; moved: boolean } {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return { clips, moved: false };

  const trackClips = sortTrackClips(clips, target.trackId);
  const fromIndex = trackClips.findIndex((c) => c.id === clipId);
  if (fromIndex === -1) return { clips, moved: false };

  const clampedTarget = Math.max(0, Math.min(trackClips.length - 1, targetIndex));
  if (clampedTarget === fromIndex) return { clips, moved: false };

  const reordered = [...trackClips];
  const [removed] = reordered.splice(fromIndex, 1);
  reordered.splice(clampedTarget, 0, removed);

  const origin = trackClips[0]?.startTime ?? 0;
  return {
    moved: true,
    clips: applyOrderedTrackPositions(clips, target.trackId, reordered, origin),
  };
}

/**
 * Reorders a clip relative to its immediate neighbor on the same track,
 * preserving each clip's duration and packing them cleanly without overlap.
 */
export function reorderClipOnTrack(
  clips: TimelineClip[],
  clipId: string,
  direction: "earlier" | "later"
): { clips: TimelineClip[]; moved: boolean } {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return { clips, moved: false };

  const trackClips = sortTrackClips(clips, target.trackId);
  const index = trackClips.findIndex((c) => c.id === clipId);
  if (index === -1) return { clips, moved: false };

  const swapIndex = direction === "earlier" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= trackClips.length) {
    return { clips, moved: false };
  }

  return reorderClipToIndex(clips, clipId, swapIndex);
}

/**
 * Computes where a dragged clip should sit on a target track without overlapping siblings.
 * When dropped over/past sibling midpoints, reorders clips sequentially; when dropped in clear open space,
 * moves cleanly to desiredStartTime.
 */
export function moveClipWithTrackOrdering(
  clips: TimelineClip[],
  clipId: string,
  desiredStartTime: number,
  targetTrackId?: string,
  isNewInsertion = false
): { clips: TimelineClip[]; changed: boolean; insertionTime: number } {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return { clips, changed: false, insertionTime: 0 };

  const destTrackId = targetTrackId || target.trackId;
  const clampedStart = Math.max(0, Number(desiredStartTime.toFixed(2)));
  const siblings = clips
    .filter((c) => c.trackId === destTrackId && c.id !== clipId)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));

  if (siblings.length === 0) {
    const changed = clampedStart !== target.startTime || destTrackId !== target.trackId;
    return {
      changed,
      insertionTime: clampedStart,
      clips: clips.map((c) =>
        c.id === clipId ? { ...c, trackId: destTrackId, startTime: clampedStart } : c
      ),
    };
  }

  const lastSibling = siblings[siblings.length - 1];
  const lastSiblingEnd = Number((lastSibling.startTime + lastSibling.duration).toFixed(2));

  // If moving freely into open space at or past the end of all siblings
  if (clampedStart >= lastSiblingEnd) {
    const changed = clampedStart !== target.startTime || destTrackId !== target.trackId;
    return {
      changed,
      insertionTime: clampedStart,
      clips: clips.map((c) =>
        c.id === clipId ? { ...c, trackId: destTrackId, startTime: clampedStart } : c
      ),
    };
  }

  // Check if clampedStart fits cleanly inside an existing gap between siblings
  const desiredEnd = Number((clampedStart + target.duration).toFixed(2));
  const overlapsAny = siblings.some(
    (s) => clampedStart < s.startTime + s.duration - 0.01 && desiredEnd > s.startTime + 0.01
  );
  if (!overlapsAny) {
    const changed = clampedStart !== target.startTime || destTrackId !== target.trackId;
    return {
      changed,
      insertionTime: clampedStart,
      clips: clips.map((c) =>
        c.id === clipId ? { ...c, trackId: destTrackId, startTime: clampedStart } : c
      ),
    };
  }

  // Determine slot index using leading edge (moving earlier / dropping new asset) or trailing edge (moving later)
  const movingEarlier = isNewInsertion || destTrackId !== target.trackId || clampedStart < target.startTime;
  let insertIdx = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const sibMid = siblings[i].startTime + siblings[i].duration / 2;
    if (movingEarlier) {
      if (clampedStart < sibMid) {
        insertIdx = i;
        break;
      }
    } else if (desiredEnd <= sibMid) {
      insertIdx = i;
      break;
    }
  }

  const ordered = [...siblings];
  const movedClip: TimelineClip = { ...target, trackId: destTrackId };
  ordered.splice(insertIdx, 0, movedClip);

  const isContiguousLeadSwap =
    !isNewInsertion &&
    destTrackId === target.trackId &&
    target.startTime < siblings[0].startTime &&
    target.startTime + target.duration >= siblings[0].startTime - 0.05;

  const origin =
    insertIdx === 0
      ? Math.min(clampedStart, siblings[0].startTime === 0 ? 0 : clampedStart)
      : isContiguousLeadSwap
        ? target.startTime
        : siblings[0].startTime;

  const packed = applyOrderedTrackPositions(
    clips.map((c) => (c.id === clipId ? movedClip : c)),
    destTrackId,
    ordered,
    Math.max(0, origin)
  );
  const finalClip = packed.find((c) => c.id === clipId);
  return {
    changed: true,
    insertionTime: finalClip?.startTime ?? clampedStart,
    clips: packed,
  };
}

/**
 * Inserts a new clip onto a track at an optional time without overlapping existing clips on that track.
 */
export function insertClipOnTrack(
  clips: TimelineClip[],
  newClip: TimelineClip,
  desiredStartTime?: number
): TimelineClip[] {
  const withNew = [...clips, { ...newClip, startTime: desiredStartTime ?? newClip.startTime }];
  if (desiredStartTime === undefined) {
    return withNew;
  }
  return moveClipWithTrackOrdering(withNew, newClip.id, desiredStartTime, newClip.trackId, true).clips;
}

/**
 * Duplicates a clip directly after itself and shifts colliding/subsequent clips on the same track
 * forward so no overlaps are created.
 */
export function duplicateClipWithoutOverlap(
  clips: TimelineClip[],
  clipId: string,
  newId?: string
): { clips: TimelineClip[]; duplicated: TimelineClip | null } {
  const target = clips.find((c) => c.id === clipId);
  if (!target) return { clips, duplicated: null };

  const copyId = newId || `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const copyStart = Number((target.startTime + target.duration).toFixed(2));
  const copy: TimelineClip = {
    ...target,
    id: copyId,
    startTime: copyStart,
    transitionIn: target.transitionIn ? { ...target.transitionIn } : undefined,
    transitionOut: target.transitionOut ? { ...target.transitionOut } : undefined,
    effects: target.effects ? { ...target.effects } : undefined,
    overlayTransform: target.overlayTransform ? { ...target.overlayTransform } : undefined,
    textStyle: target.textStyle ? { ...target.textStyle } : undefined,
  };

  const shifted = clips.map((c) => {
    if (c.trackId !== target.trackId || c.id === target.id) return c;
    if (c.startTime >= target.startTime + target.duration - 0.01) {
      return {
        ...c,
        startTime: Number((c.startTime + target.duration).toFixed(2)),
      };
    }
    return c;
  });

  return {
    clips: [...shifted, copy],
    duplicated: copy,
  };
}

export function trimClipStart(
  clip: TimelineClip,
  desiredStartTime: number,
  trackClips: TimelineClip[] = []
): Partial<TimelineClip> {
  const prevNeighborEnd = trackClips
    .filter((c) => c.id !== clip.id && c.startTime + c.duration <= clip.startTime + 0.05)
    .reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);

  const maxStart = clip.startTime + clip.duration - 0.5;
  let clampedStart = Math.min(maxStart, Math.max(prevNeighborEnd, desiredStartTime));

  if (clip.kind === "video" || clip.kind === "audio") {
    const minStartFromSource = clip.startTime - clip.inPoint / clip.speed;
    clampedStart = Math.max(minStartFromSource, clampedStart);
  }

  clampedStart = Number(clampedStart.toFixed(2));
  const delta = Number((clampedStart - clip.startTime).toFixed(2));
  const nextDuration = Number((clip.duration - delta).toFixed(2));
  const nextInPoint =
    clip.kind === "image" || clip.kind === "text"
      ? 0
      : Math.max(0, Number((clip.inPoint + delta * clip.speed).toFixed(2)));

  const resolvedDuration = Math.max(0.5, nextDuration);
  return {
    startTime: clampedStart,
    duration: resolvedDuration,
    inPoint: nextInPoint,
    ...(clip.fadeInSec !== undefined
      ? { fadeInSec: clampFadeSeconds(clip.fadeInSec, resolvedDuration) }
      : {}),
    ...(clip.fadeOutSec !== undefined
      ? { fadeOutSec: clampFadeSeconds(clip.fadeOutSec, resolvedDuration) }
      : {}),
  };
}

export function trimClipEnd(
  clip: TimelineClip,
  desiredDuration: number,
  trackClips: TimelineClip[] = []
): Partial<TimelineClip> {
  const sourceMaxDur =
    clip.kind === "image" || clip.kind === "text"
      ? 60
      : Math.max(0.5, (clip.sourceDuration - clip.inPoint) / clip.speed);

  const nextNeighborStart = trackClips
    .filter((c) => c.id !== clip.id && c.startTime >= clip.startTime + clip.duration - 0.05)
    .reduce((min, c) => Math.min(min, c.startTime), Number.POSITIVE_INFINITY);

  const neighborMaxDur = Number.isFinite(nextNeighborStart)
    ? Math.max(0.5, Number((nextNeighborStart - clip.startTime).toFixed(2)))
    : Number.POSITIVE_INFINITY;

  const maxDur = Math.min(sourceMaxDur, neighborMaxDur);
  const clamped = Number(Math.min(maxDur, Math.max(0.5, Number(desiredDuration.toFixed(2)))).toFixed(2));

  return {
    duration: clamped,
    ...(clip.fadeInSec !== undefined
      ? { fadeInSec: clampFadeSeconds(clip.fadeInSec, clamped) }
      : {}),
    ...(clip.fadeOutSec !== undefined
      ? { fadeOutSec: clampFadeSeconds(clip.fadeOutSec, clamped) }
      : {}),
  };
}

export function resolveDimensions(
  aspectRatio: AspectRatioOption,
  resolution: ResolutionOption
): { width: number; height: number } {
  const base = resolution === "4K" ? 2160 : resolution === "720p" ? 720 : 1080;
  if (aspectRatio === "9:16") {
    return { width: base, height: Math.round((base * 16) / 9) };
  }
  if (aspectRatio === "1:1") {
    return { width: base, height: base };
  }
  return { width: Math.round((base * 16) / 9), height: base };
}

export function buildStructuredTimelineSpec(
  project: Project,
  overrideResolution?: string,
  overrideFps?: number
): RenderTimelinePayload {
  const dims = resolveDimensions(project.aspectRatio, project.resolution);
  let width = dims.width;
  let height = dims.height;

  if (overrideResolution && overrideResolution.includes("x")) {
    const [w, h] = overrideResolution.split("x").map(Number);
    if (w > 0 && h > 0) {
      width = w;
      height = h;
    }
  }

  const fps = (overrideFps === 24 || overrideFps === 30 || overrideFps === 60
    ? overrideFps
    : project.fps) as 24 | 30 | 60;

  const sortedClips = [...project.clips].sort((a, b) => a.startTime - b.startTime);
  const speechIntervals = buildSpeechIntervals(project.subtitles);

  return {
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      aspectRatio: project.aspectRatio,
      resolution: project.resolution,
      width,
      height,
      fps,
      durationSeconds: Number(getSequenceDuration(project).toFixed(2)),
    },
    tracks: project.tracks.map((t) => ({ ...t })),
    clips: sortedClips.map((c) => {
      const dur = Number(c.duration.toFixed(2));
      const tIn = normalizeTransition(c.transitionIn, dur);
      const tOut = normalizeTransition(c.transitionOut, dur);
      const normEffects = normalizeEffects(c.effects);
      const normOverlay = c.overlayTransform
        ? normalizeOverlayTransform(c.overlayTransform)
        : undefined;
      return {
        id: c.id,
        trackId: c.trackId,
        kind: c.kind,
        sourceName: c.sourceName || c.name,
        sourceMimeType:
          c.sourceMimeType ||
          (c.kind === "text" ? "application/x-text-overlay" : "application/octet-stream"),
        timelineStartSec: Number(c.startTime.toFixed(2)),
        timelineEndSec: Number((c.startTime + c.duration).toFixed(2)),
        durationSec: dur,
        sourceInSec: Number(c.inPoint.toFixed(2)),
        sourceOutSec: Number((c.inPoint + c.duration * c.speed).toFixed(2)),
        speed: c.speed,
        volume: clampVolume(c.volume, 1),
        muted: Boolean(c.muted),
        fadeInSec: clampFadeSeconds(c.fadeInSec, dur),
        fadeOutSec: clampFadeSeconds(c.fadeOutSec, dur),
        ...(c.kind === "audio"
          ? {
              duckingEnabled: Boolean(c.duckingEnabled),
              duckingAmount: clampDuckingAmount(c.duckingAmount),
            }
          : {}),
        opacity: c.opacity,
        ...(tIn.type !== "none" ? { transitionIn: tIn } : {}),
        ...(tOut.type !== "none" ? { transitionOut: tOut } : {}),
        ...(hasCustomEffects(normEffects) ? { effects: normEffects } : {}),
        ...(normOverlay && (c.trackId === "track_v2" || hasCustomOverlayTransform(normOverlay))
          ? { overlayTransform: normOverlay }
          : {}),
        ...(c.sourceWidth ? { sourceWidth: c.sourceWidth } : {}),
        ...(c.sourceHeight ? { sourceHeight: c.sourceHeight } : {}),
        ...(c.textStyle ? { textStyle: { ...c.textStyle } } : {}),
      };
    }),
    ...(speechIntervals.length > 0 ? { speechIntervals } : {}),
  };
}
