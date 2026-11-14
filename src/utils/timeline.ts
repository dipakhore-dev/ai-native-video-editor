import type {
  AspectRatioOption,
  Project,
  RenderTimelinePayload,
  ResolutionOption,
  TimelineClip,
  TimelineTrack,
} from "../types/studio";

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

  const leftClip: TimelineClip = {
    ...target,
    duration: leftDuration,
  };

  const rightClip: TimelineClip = {
    ...target,
    id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startTime: Number((target.startTime + leftDuration).toFixed(2)),
    duration: rightDuration,
    inPoint: rightInPoint,
    textStyle: target.textStyle ? { ...target.textStyle } : undefined,
  };

  return {
    didSplit: true,
    clips: clips.flatMap((c) => (c.id === clipId ? [leftClip, rightClip] : [c])),
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

  const trackClips = clips
    .filter((c) => c.trackId === target.trackId)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));

  const index = trackClips.findIndex((c) => c.id === clipId);
  if (index === -1) return { clips, moved: false };

  const swapIndex = direction === "earlier" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= trackClips.length) {
    return { clips, moved: false };
  }

  const first = direction === "earlier" ? trackClips[swapIndex] : trackClips[index];
  const second = direction === "earlier" ? trackClips[index] : trackClips[swapIndex];

  // Gap between first.end and second.start (if any) is preserved between the swapped pair
  const gap = Math.max(0, Number((second.startTime - (first.startTime + first.duration)).toFixed(2)));
  const pairOrigin = first.startTime;

  const newFirstStart = pairOrigin;
  const newSecondStart = Number((pairOrigin + second.duration + gap).toFixed(2));

  return {
    moved: true,
    clips: clips.map((c) => {
      if (c.id === second.id) return { ...c, startTime: newFirstStart };
      if (c.id === first.id) return { ...c, startTime: newSecondStart };
      return c;
    }),
  };
}

export function trimClipStart(
  clip: TimelineClip,
  desiredStartTime: number
): Partial<TimelineClip> {
  const maxStart = clip.startTime + clip.duration - 0.5;
  let clampedStart = Math.min(maxStart, Math.max(0, desiredStartTime));

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

  return {
    startTime: clampedStart,
    duration: Math.max(0.5, nextDuration),
    inPoint: nextInPoint,
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
    clips: sortedClips.map((c) => ({
      id: c.id,
      trackId: c.trackId,
      kind: c.kind,
      sourceName: c.sourceName || c.name,
      sourceMimeType:
        c.sourceMimeType ||
        (c.kind === "text" ? "application/x-text-overlay" : "application/octet-stream"),
      timelineStartSec: Number(c.startTime.toFixed(2)),
      timelineEndSec: Number((c.startTime + c.duration).toFixed(2)),
      durationSec: Number(c.duration.toFixed(2)),
      sourceInSec: Number(c.inPoint.toFixed(2)),
      sourceOutSec: Number((c.inPoint + c.duration * c.speed).toFixed(2)),
      speed: c.speed,
      volume: c.volume,
      opacity: c.opacity,
      ...(c.textStyle ? { textStyle: { ...c.textStyle } } : {}),
    })),
  };
}
