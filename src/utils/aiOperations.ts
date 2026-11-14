import { z } from "zod";
import type { Project, TimelineClip } from "../types/studio";
import {
  ensureProjectTracks,
  reorderClipOnTrack,
  splitClipAtTimestamp,
  trimClipStart,
} from "./timeline";

export const TrimStartOpSchema = z.object({
  type: z.literal("trim_start"),
  clipId: z.string().optional(),
  removeSeconds: z.number().positive().max(3600),
  rippleShift: z.boolean().optional().default(true),
  reason: z.string().min(1),
});

export const TrimEndOpSchema = z.object({
  type: z.literal("trim_end"),
  clipId: z.string().optional(),
  removeSeconds: z.number().positive().max(3600),
  reason: z.string().min(1),
});

export const SetAspectRatioOpSchema = z.object({
  type: z.literal("set_aspect_ratio"),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  reason: z.string().min(1),
});

export const AddTextOverlayOpSchema = z.object({
  type: z.literal("add_text_overlay"),
  text: z.string().min(1).max(200),
  startTime: z.number().min(0).max(3600).default(0),
  duration: z.number().min(0.5).max(120).default(4),
  x: z.number().min(10).max(90).optional(),
  y: z.number().min(10).max(90).optional(),
  fontSize: z.number().min(16).max(72).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  reason: z.string().min(1),
});

export const SplitClipOpSchema = z.object({
  type: z.literal("split_clip"),
  clipId: z.string().optional(),
  atTime: z.number().min(0).max(3600),
  reason: z.string().min(1),
});

export const DeleteClipOpSchema = z.object({
  type: z.literal("delete_clip"),
  clipId: z.string().min(1),
  reason: z.string().min(1),
});

export const SetClipSpeedOpSchema = z.object({
  type: z.literal("set_clip_speed"),
  clipId: z.string().optional(),
  speed: z.number().min(0.5).max(2),
  reason: z.string().min(1),
});

export const SetClipVolumeOpSchema = z.object({
  type: z.literal("set_clip_volume"),
  clipId: z.string().optional(),
  volume: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const ReorderClipOpSchema = z.object({
  type: z.literal("reorder_clip"),
  clipId: z.string().min(1),
  direction: z.enum(["earlier", "later"]),
  reason: z.string().min(1),
});

export const UnsupportedOpSchema = z.object({
  type: z.literal("unsupported"),
  requestedAction: z.string().min(1),
  reason: z.string().min(1),
  requiresBackendProcessing: z.boolean().default(true),
});

export const AiEditOperationSchema = z.discriminatedUnion("type", [
  TrimStartOpSchema,
  TrimEndOpSchema,
  SetAspectRatioOpSchema,
  AddTextOverlayOpSchema,
  SplitClipOpSchema,
  DeleteClipOpSchema,
  SetClipSpeedOpSchema,
  SetClipVolumeOpSchema,
  ReorderClipOpSchema,
  UnsupportedOpSchema,
]);

export const AiEditPlanSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(AiEditOperationSchema).min(1).max(12),
});

export type AiEditOperation = z.infer<typeof AiEditOperationSchema>;
export type AiEditPlan = z.infer<typeof AiEditPlanSchema>;

export type SupportedAiEditOperation = Exclude<AiEditOperation, { type: "unsupported" }>;

export interface ApplyOperationsResult {
  project: Project;
  appliedCount: number;
  skippedMessages: string[];
}

function findTargetClip(clips: TimelineClip[], clipId?: string): TimelineClip | null {
  if (clipId) {
    const exact = clips.find((c) => c.id === clipId);
    if (exact) return exact;
  }
  const v1Sorted = clips
    .filter((c) => c.trackId === "track_v1")
    .sort((a, b) => a.startTime - b.startTime);
  if (v1Sorted.length > 0) return v1Sorted[0];
  const anySorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  return anySorted[0] ?? null;
}

export function describeAiOperation(op: AiEditOperation, project: Project): string {
  switch (op.type) {
    case "trim_start": {
      const target = findTargetClip(project.clips, op.clipId);
      const label = target ? `"${target.name}"` : "primary clip";
      return `Trim ${op.removeSeconds}s from the start of ${label}${
        op.rippleShift !== false ? " and shift track earlier" : ""
      }`;
    }
    case "trim_end": {
      const target = findTargetClip(project.clips, op.clipId);
      const label = target ? `"${target.name}"` : "primary clip";
      return `Trim ${op.removeSeconds}s from the end of ${label}`;
    }
    case "set_aspect_ratio":
      return `Change sequence aspect ratio from ${project.aspectRatio} to ${op.aspectRatio}`;
    case "add_text_overlay":
      return `Add text overlay "${op.text}" at ${op.startTime}s (${op.duration}s duration)`;
    case "split_clip": {
      const target = findTargetClip(project.clips, op.clipId);
      return `Split ${target ? `"${target.name}"` : "clip"} at ${op.atTime}s`;
    }
    case "delete_clip": {
      const target = project.clips.find((c) => c.id === op.clipId);
      return `Remove clip ${target ? `"${target.name}"` : op.clipId} from timeline`;
    }
    case "set_clip_speed": {
      const target = findTargetClip(project.clips, op.clipId);
      return `Set playback speed of ${target ? `"${target.name}"` : "clip"} to ${op.speed}x`;
    }
    case "set_clip_volume": {
      const target = findTargetClip(project.clips, op.clipId);
      return `Set volume of ${target ? `"${target.name}"` : "clip"} to ${Math.round(
        op.volume * 100
      )}%`;
    }
    case "reorder_clip": {
      const target = project.clips.find((c) => c.id === op.clipId);
      return `Move ${target ? `"${target.name}"` : op.clipId} ${op.direction} on its track`;
    }
    case "unsupported":
      return `Unsupported: ${op.requestedAction}`;
  }
}

export function applyAiOperationsToProject(
  project: Project,
  operations: AiEditOperation[]
): ApplyOperationsResult {
  let next: Project = {
    ...project,
    tracks: ensureProjectTracks(project.tracks).map((t) => ({ ...t })),
    clips: project.clips.map((c) => ({
      ...c,
      textStyle: c.textStyle ? { ...c.textStyle } : undefined,
    })),
    updatedAt: new Date().toISOString(),
  };

  let appliedCount = 0;
  const skippedMessages: string[] = [];

  for (const op of operations) {
    if (op.type === "unsupported") {
      skippedMessages.push(`${op.requestedAction}: ${op.reason}`);
      continue;
    }

    if (op.type === "set_aspect_ratio") {
      next = { ...next, aspectRatio: op.aspectRatio };
      appliedCount++;
      continue;
    }

    if (op.type === "add_text_overlay") {
      const textTrack = next.tracks.find((t) => t.id === "track_t1");
      if (textTrack?.locked) {
        skippedMessages.push("Text track T1 is locked.");
        continue;
      }
      const clip: TimelineClip = {
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        assetId: "text_overlay",
        trackId: "track_t1",
        name: op.text,
        kind: "text",
        startTime: Number(op.startTime.toFixed(2)),
        duration: Number(op.duration.toFixed(2)),
        inPoint: 0,
        sourceDuration: 60,
        volume: 0,
        speed: 1,
        opacity: 1,
        objectUrl: "",
        sourceName: op.text,
        sourceMimeType: "application/x-text-overlay",
        textStyle: {
          text: op.text,
          fontSize: op.fontSize ?? 34,
          color: op.color ?? "#FFFFFF",
          backgroundColor: "#09090B",
          backgroundOpacity: 0.65,
          x: op.x ?? 50,
          y: op.y ?? 20,
          align: "center",
        },
      };
      next = { ...next, clips: [...next.clips, clip] };
      appliedCount++;
      continue;
    }

    if (op.type === "trim_start") {
      const target = findTargetClip(next.clips, op.clipId);
      if (!target) {
        skippedMessages.push("No timeline clip available to trim.");
        continue;
      }
      if (target.duration - op.removeSeconds < 0.5) {
        skippedMessages.push(
          `Cannot remove ${op.removeSeconds}s from "${target.name}" (${target.duration}s long); minimum clip duration is 0.5s.`
        );
        continue;
      }

      const patch = trimClipStart(target, target.startTime + op.removeSeconds);
      const actualTrim = Number(((patch.startTime ?? target.startTime) - target.startTime).toFixed(2));
      const shouldRipple = op.rippleShift !== false;

      next = {
        ...next,
        clips: next.clips.map((c) => {
          if (c.id === target.id) {
            return {
              ...c,
              ...patch,
              startTime: shouldRipple
                ? Number(Math.max(0, (patch.startTime ?? c.startTime) - actualTrim).toFixed(2))
                : patch.startTime ?? c.startTime,
            };
          }
          if (shouldRipple && c.trackId === target.trackId && c.startTime > target.startTime) {
            return {
              ...c,
              startTime: Number(Math.max(0, c.startTime - actualTrim).toFixed(2)),
            };
          }
          return c;
        }),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "trim_end") {
      const target = findTargetClip(next.clips, op.clipId);
      if (!target) {
        skippedMessages.push("No timeline clip available to trim.");
        continue;
      }
      const nextDuration = Number((target.duration - op.removeSeconds).toFixed(2));
      if (nextDuration < 0.5) {
        skippedMessages.push(
          `Cannot remove ${op.removeSeconds}s from "${target.name}" (${target.duration}s long); minimum clip duration is 0.5s.`
        );
        continue;
      }
      next = {
        ...next,
        clips: next.clips.map((c) => (c.id === target.id ? { ...c, duration: nextDuration } : c)),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "split_clip") {
      const target =
        (op.clipId ? next.clips.find((c) => c.id === op.clipId) : null) ??
        next.clips.find(
          (c) => op.atTime > c.startTime + 0.2 && op.atTime < c.startTime + c.duration - 0.2
        ) ??
        null;
      if (!target) {
        skippedMessages.push(`No clip spans timestamp ${op.atTime}s to split.`);
        continue;
      }
      const splitRes = splitClipAtTimestamp(next.clips, target.id, op.atTime);
      if (!splitRes.didSplit) {
        skippedMessages.push(`Timestamp ${op.atTime}s is too close to the edge of "${target.name}".`);
        continue;
      }
      next = { ...next, clips: splitRes.clips };
      appliedCount++;
      continue;
    }

    if (op.type === "delete_clip") {
      const exists = next.clips.some((c) => c.id === op.clipId);
      if (!exists) {
        skippedMessages.push(`Clip ${op.clipId} was not found.`);
        continue;
      }
      next = { ...next, clips: next.clips.filter((c) => c.id !== op.clipId) };
      appliedCount++;
      continue;
    }

    if (op.type === "set_clip_speed") {
      const target = findTargetClip(next.clips, op.clipId);
      if (!target) {
        skippedMessages.push("No clip found to adjust playback speed.");
        continue;
      }
      next = {
        ...next,
        clips: next.clips.map((c) => (c.id === target.id ? { ...c, speed: op.speed } : c)),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "set_clip_volume") {
      const target = findTargetClip(next.clips, op.clipId);
      if (!target) {
        skippedMessages.push("No clip found to adjust volume.");
        continue;
      }
      next = {
        ...next,
        clips: next.clips.map((c) => (c.id === target.id ? { ...c, volume: op.volume } : c)),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "reorder_clip") {
      const reordered = reorderClipOnTrack(next.clips, op.clipId, op.direction);
      if (!reordered.moved) {
        skippedMessages.push(`Could not move clip ${op.direction} on its track.`);
        continue;
      }
      next = { ...next, clips: reordered.clips };
      appliedCount++;
      continue;
    }
  }

  return {
    project: next,
    appliedCount,
    skippedMessages,
  };
}
