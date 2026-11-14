import type {
  Project,
  SubtitleSegment,
  SubtitleStyle,
  TimelineClip,
} from "../types/studio";

export interface SubtitleLanguageOption {
  value: string;
  label: string;
}

export const SUBTITLE_LANGUAGE_OPTIONS: SubtitleLanguageOption[] = [
  { value: "", label: "Auto-Detect" },
  { value: "en", label: "English (en)" },
  { value: "hi", label: "Hindi (hi)" },
  { value: "bn", label: "Bengali (বাংলা) (bn)" },
  { value: "es", label: "Spanish (es)" },
  { value: "fr", label: "French (fr)" },
  { value: "de", label: "German (de)" },
  { value: "ja", label: "Japanese (ja)" },
];

export function buildSubtitleFilenameSlug(projectName: string): string {
  const ascii = (projectName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "subtitles";
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: true,
  fontSize: 28,
  color: "#FFFFFF",
  position: "bottom",
  backgroundColor: "#09090B",
  backgroundOpacity: 0.75,
};

export function getSubtitleStyle(project?: Project | null): SubtitleStyle {
  return {
    ...DEFAULT_SUBTITLE_STYLE,
    ...(project?.subtitleStyle ?? {}),
  };
}

export function sortSubtitles(subtitles: SubtitleSegment[]): SubtitleSegment[] {
  return [...subtitles].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)
  );
}

export function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

export function pad3(n: number): string {
  return String(Math.floor(n)).padStart(3, "0");
}

export function formatSrtTimestamp(seconds: number): string {
  const safeMs = Math.max(0, Math.round(seconds * 1000));
  const ms = safeMs % 1000;
  const totalSec = Math.floor(safeMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function formatVttTimestamp(seconds: number): string {
  const safeMs = Math.max(0, Math.round(seconds * 1000));
  const ms = safeMs % 1000;
  const totalSec = Math.floor(safeMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

export function exportSubtitlesToSrt(subtitles: SubtitleSegment[]): string {
  const valid = sortSubtitles(subtitles).filter(
    (cue) => cue.text.trim().length > 0 && cue.end > cue.start
  );
  return valid
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text.trim()}`
    )
    .join("\n\n");
}

export function exportSubtitlesToVtt(subtitles: SubtitleSegment[]): string {
  const valid = sortSubtitles(subtitles).filter(
    (cue) => cue.text.trim().length > 0 && cue.end > cue.start
  );
  const body = valid
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text.trim()}`
    )
    .join("\n\n");
  return body ? `WEBVTT\n\n${body}\n` : "WEBVTT\n\n";
}

function roundSec(val: number): number {
  return Math.max(0, Number(val.toFixed(2)));
}

/**
 * Maps Whisper segments (which are relative to the raw source video file 0..sourceDuration)
 * onto a potentially already-trimmed/positioned TimelineClip on the timeline.
 */
export function mapWhisperSegmentsToClip(
  rawSegments: Array<{ id?: number | string; start: number; end: number; text: string }>,
  clip: TimelineClip
): SubtitleSegment[] {
  const clipSrcIn = Math.max(0, clip.inPoint);
  const clipSrcOut = clipSrcIn + clip.duration * clip.speed;
  const mapped: SubtitleSegment[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    const text = (raw.text || "").trim();
    if (!text) continue;

    const clampedSrcStart = Math.max(clipSrcIn, Number(raw.start));
    const clampedSrcEnd = Math.min(clipSrcOut, Number(raw.end));
    if (clampedSrcEnd - clampedSrcStart < 0.05) {
      continue;
    }

    const tlStart = roundSec(clip.startTime + (clampedSrcStart - clipSrcIn) / clip.speed);
    const rawTlEnd = roundSec(clip.startTime + (clampedSrcEnd - clipSrcIn) / clip.speed);
    const tlEnd = Math.max(roundSec(tlStart + 0.05), rawTlEnd);

    mapped.push({
      id: `sub_${clip.id}_${Date.now()}_${i}`,
      start: tlStart,
      end: tlEnd,
      text,
      clipId: clip.id,
    });
  }

  return sortSubtitles(mapped);
}

function remapSourceRangeToClip(
  srcStart: number,
  srcEnd: number,
  targetClip: TimelineClip,
  id: string,
  text: string
): SubtitleSegment | null {
  const clipSrcIn = Math.max(0, targetClip.inPoint);
  const clipSrcOut = clipSrcIn + targetClip.duration * targetClip.speed;
  const clampedIn = Math.max(clipSrcIn, srcStart);
  const clampedOut = Math.min(clipSrcOut, srcEnd);

  if (clampedOut - clampedIn < 0.05) {
    return null;
  }

  const tlStart = roundSec(targetClip.startTime + (clampedIn - clipSrcIn) / targetClip.speed);
  const tlEnd = Math.max(
    roundSec(tlStart + 0.05),
    roundSec(targetClip.startTime + (clampedOut - clipSrcIn) / targetClip.speed)
  );

  return {
    id,
    start: tlStart,
    end: tlEnd,
    text,
    clipId: targetClip.id,
  };
}

/**
 * Updates subtitle timestamps when a single clip is trimmed, moved, or speed-adjusted.
 */
export function syncSubtitlesForClipUpdate(
  subtitles: SubtitleSegment[] | undefined,
  beforeClip: TimelineClip,
  afterClip: TimelineClip
): SubtitleSegment[] {
  if (!subtitles || subtitles.length === 0) return [];
  const next: SubtitleSegment[] = [];

  for (const cue of subtitles) {
    if (cue.clipId !== beforeClip.id) {
      next.push(cue);
      continue;
    }
    const srcStart = beforeClip.inPoint + (cue.start - beforeClip.startTime) * beforeClip.speed;
    const srcEnd = beforeClip.inPoint + (cue.end - beforeClip.startTime) * beforeClip.speed;
    const remapped = remapSourceRangeToClip(srcStart, srcEnd, afterClip, cue.id, cue.text);
    if (remapped) {
      next.push(remapped);
    }
  }

  return sortSubtitles(next);
}

/**
 * Updates and splits subtitle cues when a clip is split into leftClip and rightClip.
 */
export function syncSubtitlesForClipSplit(
  subtitles: SubtitleSegment[] | undefined,
  beforeClip: TimelineClip,
  leftClip: TimelineClip,
  rightClip: TimelineClip
): SubtitleSegment[] {
  if (!subtitles || subtitles.length === 0) return [];
  const next: SubtitleSegment[] = [];

  for (const cue of subtitles) {
    if (cue.clipId !== beforeClip.id) {
      next.push(cue);
      continue;
    }

    const srcStart = beforeClip.inPoint + (cue.start - beforeClip.startTime) * beforeClip.speed;
    const srcEnd = beforeClip.inPoint + (cue.end - beforeClip.startTime) * beforeClip.speed;

    const leftMapped = remapSourceRangeToClip(srcStart, srcEnd, leftClip, cue.id, cue.text);
    const rightMapped = remapSourceRangeToClip(
      srcStart,
      srcEnd,
      rightClip,
      leftMapped ? `${cue.id}_r` : cue.id,
      cue.text
    );

    if (leftMapped) next.push(leftMapped);
    if (rightMapped) next.push(rightMapped);
  }

  return sortSubtitles(next);
}

/**
 * Removes cues attached to a deleted clip.
 */
export function syncSubtitlesForClipDelete(
  subtitles: SubtitleSegment[] | undefined,
  deletedClipId: string
): SubtitleSegment[] {
  if (!subtitles || subtitles.length === 0) return [];
  return sortSubtitles(subtitles.filter((cue) => cue.clipId !== deletedClipId));
}

/**
 * Synchronizes subtitles across multi-clip operations (e.g. reorder or AI edit plan).
 */
export function syncSubtitlesForProjectClips(
  beforeProject: Project,
  afterProject: Project
): SubtitleSegment[] {
  const existing = beforeProject.subtitles ?? [];
  if (existing.length === 0) return [];

  const beforeMap = new Map(beforeProject.clips.map((c) => [c.id, c]));
  const afterMap = new Map(afterProject.clips.map((c) => [c.id, c]));

  const next: SubtitleSegment[] = [];

  for (const cue of existing) {
    if (!cue.clipId) {
      next.push(cue);
      continue;
    }

    const beforeClip = beforeMap.get(cue.clipId);
    if (!beforeClip) {
      next.push(cue);
      continue;
    }

    const afterClip = afterMap.get(cue.clipId);
    if (!afterClip) {
      // Clip was deleted
      continue;
    }

    const srcStart = beforeClip.inPoint + (cue.start - beforeClip.startTime) * beforeClip.speed;
    const srcEnd = beforeClip.inPoint + (cue.end - beforeClip.startTime) * beforeClip.speed;

    // Check if the clip was split into leftClip (same id) + newly created rightClip(s)
    const splitRightCandidates = afterProject.clips.filter(
      (c) =>
        c.id !== afterClip.id &&
        !beforeMap.has(c.id) &&
        c.assetId === beforeClip.assetId &&
        c.trackId === beforeClip.trackId &&
        c.inPoint >= afterClip.inPoint + afterClip.duration * afterClip.speed - 0.1
    );

    const targets = [afterClip, ...splitRightCandidates];
    let emitted = 0;
    for (const target of targets) {
      const mapped = remapSourceRangeToClip(
        srcStart,
        srcEnd,
        target,
        emitted === 0 ? cue.id : `${cue.id}_s${emitted}`,
        cue.text
      );
      if (mapped) {
        next.push(mapped);
        emitted++;
      }
    }
  }

  return sortSubtitles(next);
}

export function hexToRgba(hex: string, opacity: number): string {
  const clean = (hex || "#09090B").replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 9;
  const g = parseInt(full.slice(2, 4), 16) || 9;
  const b = parseInt(full.slice(4, 6), 16) || 11;
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
