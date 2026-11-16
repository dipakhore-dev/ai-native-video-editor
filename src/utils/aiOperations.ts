import { z } from "zod";
import type { Project, TimelineClip } from "../types/studio";
import { normalizeEffects, normalizeTransition } from "./effects";
import {
  applyOverlayPreset,
  normalizeOverlayTransform,
  updateOverlayBoxDimensions,
} from "./overlays";
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
  volume: z.number().min(0).max(2),
  reason: z.string().min(1),
});

export const ReorderClipOpSchema = z.object({
  type: z.literal("reorder_clip"),
  clipId: z.string().min(1),
  direction: z.enum(["earlier", "later"]),
  reason: z.string().min(1),
});

export const SetClipEffectsOpSchema = z.object({
  type: z.literal("set_clip_effects"),
  clipId: z.string().optional(),
  targetScope: z.enum(["clip", "all_v1"]).optional().default("clip"),
  preset: z
    .enum(["none", "cinematic", "bw", "vintage", "warm", "cool", "vivid"])
    .optional(),
  brightness: z.number().min(-0.5).max(0.5).optional(),
  brightnessDelta: z.number().min(-0.5).max(0.5).optional(),
  contrast: z.number().min(0.5).max(1.8).optional(),
  saturation: z.number().min(0).max(2).optional(),
  blur: z.number().min(0).max(10).optional(),
  reason: z.string().min(1),
});

export const SetClipTransitionOpSchema = z.object({
  type: z.literal("set_clip_transition"),
  clipId: z.string().optional(),
  targetScope: z.enum(["clip", "between_v1_clips"]).optional().default("clip"),
  edge: z.enum(["in", "out", "both"]).optional().default("out"),
  transitionType: z.enum([
    "none",
    "fade",
    "dissolve",
    "wipeleft",
    "wiperight",
    "slideleft",
    "slideright",
    "zoomin",
  ]),
  durationSec: z.number().min(0.2).max(2).optional().default(0.6),
  reason: z.string().min(1),
});

export const SetClipOpacityOpSchema = z.object({
  type: z.literal("set_clip_opacity"),
  clipId: z.string().optional(),
  opacity: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const SetOverlayTransformOpSchema = z.object({
  type: z.literal("set_overlay_transform"),
  clipId: z.string().optional(),
  preset: z
    .enum([
      "top-left",
      "top-center",
      "top-right",
      "center",
      "bottom-left",
      "bottom-right",
      "pip",
      "watermark",
      "fullscreen",
    ])
    .optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  widthPct: z.number().min(5).max(100).optional(),
  heightPct: z.number().min(5).max(100).optional(),
  scale: z.number().min(0.1).max(2).optional(),
  lockAspectRatio: z.boolean().optional(),
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
  SetClipEffectsOpSchema,
  SetClipTransitionOpSchema,
  SetClipOpacityOpSchema,
  SetOverlayTransformOpSchema,
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

function findTargetClip(
  clips: TimelineClip[],
  clipId?: string,
  fallbackClipId?: string | null
): TimelineClip | null {
  if (clipId) {
    const exact = clips.find((c) => c.id === clipId);
    if (exact) return exact;
  }
  if (fallbackClipId) {
    const selected = clips.find((c) => c.id === fallbackClipId);
    if (selected) return selected;
  }
  const v1Sorted = clips
    .filter((c) => c.trackId === "track_v1")
    .sort((a, b) => a.startTime - b.startTime);
  if (v1Sorted.length > 0) return v1Sorted[0];
  const anySorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  return anySorted[0] ?? null;
}

function findOverlayClip(
  clips: TimelineClip[],
  clipId?: string,
  fallbackClipId?: string | null
): TimelineClip | null {
  if (clipId) {
    const exact = clips.find((c) => c.id === clipId && c.trackId === "track_v2");
    if (exact) return exact;
  }
  if (fallbackClipId) {
    const selected = clips.find((c) => c.id === fallbackClipId && c.trackId === "track_v2");
    if (selected) return selected;
  }
  const v2Sorted = clips
    .filter((c) => c.trackId === "track_v2" && (c.kind === "image" || c.kind === "video"))
    .sort((a, b) => a.startTime - b.startTime);
  return v2Sorted[0] ?? null;
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
    case "set_clip_effects": {
      const target =
        op.targetScope === "all_v1"
          ? null
          : findTargetClip(project.clips, op.clipId);
      const scopeLabel =
        op.targetScope === "all_v1"
          ? "all V1 clips"
          : target
            ? `"${target.name}"`
            : "selected clip";
      const parts: string[] = [];
      if (op.preset) parts.push(`preset "${op.preset}"`);
      if (op.brightnessDelta !== undefined) {
        parts.push(
          `brightness ${op.brightnessDelta >= 0 ? "+" : ""}${Math.round(op.brightnessDelta * 100)}%`
        );
      } else if (op.brightness !== undefined) {
        parts.push(`brightness ${op.brightness >= 0 ? "+" : ""}${op.brightness}`);
      }
      if (op.contrast !== undefined) parts.push(`contrast ${Math.round(op.contrast * 100)}%`);
      if (op.saturation !== undefined) parts.push(`saturation ${Math.round(op.saturation * 100)}%`);
      if (op.blur !== undefined) parts.push(`blur ${op.blur}px`);
      return `Apply ${parts.length > 0 ? parts.join(", ") : "visual effects"} to ${scopeLabel}`;
    }
    case "set_clip_transition": {
      if (op.targetScope === "between_v1_clips") {
        return `Add ${op.durationSec ?? 0.6}s "${op.transitionType}" transition between V1 clips`;
      }
      const target = findTargetClip(project.clips, op.clipId);
      return `Set ${op.edge ?? "out"} transition on ${
        target ? `"${target.name}"` : "clip"
      } to ${op.transitionType} (${op.durationSec ?? 0.6}s)`;
    }
    case "set_clip_opacity": {
      const target = findTargetClip(project.clips, op.clipId);
      return `Set opacity of ${target ? `"${target.name}"` : "clip"} to ${Math.round(
        op.opacity * 100
      )}%`;
    }
    case "set_overlay_transform": {
      const target = findOverlayClip(project.clips, op.clipId);
      const label = target ? `"${target.name}"` : "V2 overlay";
      if (op.preset) {
        return `Position ${label} using "${op.preset}" overlay layout`;
      }
      const details: string[] = [];
      if (op.x !== undefined || op.y !== undefined) {
        details.push(`position (${op.x ?? "keep"}%, ${op.y ?? "keep"}%)`);
      }
      if (op.scale !== undefined) details.push(`scale ${Math.round(op.scale * 100)}%`);
      if (op.widthPct !== undefined) details.push(`width ${op.widthPct}%`);
      if (op.heightPct !== undefined) details.push(`height ${op.heightPct}%`);
      return `Update ${label} transform (${details.join(", ") || "overlay settings"})`;
    }
    case "unsupported":
      return `Unsupported: ${op.requestedAction}`;
  }
}

export function applyAiOperationsToProject(
  project: Project,
  operations: AiEditOperation[],
  selectedClipId?: string | null
): ApplyOperationsResult {
  let next: Project = {
    ...project,
    tracks: ensureProjectTracks(project.tracks).map((t) => ({ ...t })),
    clips: project.clips.map((c) => ({
      ...c,
      transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
      transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
      effects: c.effects ? { ...c.effects } : undefined,
      overlayTransform: c.overlayTransform ? { ...c.overlayTransform } : undefined,
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
      const target = findTargetClip(next.clips, op.clipId, selectedClipId);
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
      const actualTrim = Number(
        ((patch.startTime ?? target.startTime) - target.startTime).toFixed(2)
      );
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
      const target = findTargetClip(next.clips, op.clipId, selectedClipId);
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
        skippedMessages.push(
          `Timestamp ${op.atTime}s is too close to the edge of "${target.name}".`
        );
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
      const target = findTargetClip(next.clips, op.clipId, selectedClipId);
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
      const target = findTargetClip(next.clips, op.clipId, selectedClipId);
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

    if (op.type === "set_clip_effects") {
      let targetIds = new Set<string>();
      if (op.targetScope === "all_v1") {
        for (const c of next.clips) {
          if (c.trackId === "track_v1" && (c.kind === "video" || c.kind === "image")) {
            targetIds.add(c.id);
          }
        }
      } else {
        const candidate = findTargetClip(
          next.clips.filter((c) => c.kind === "video" || c.kind === "image"),
          op.clipId,
          selectedClipId
        );
        if (candidate) {
          targetIds.add(candidate.id);
        }
      }

      if (targetIds.size === 0) {
        skippedMessages.push("No visual video or image clip found to apply effects.");
        continue;
      }

      next = {
        ...next,
        clips: next.clips.map((c) => {
          if (!targetIds.has(c.id)) return c;
          const prevEff = normalizeEffects(c.effects);
          const nextBrightness =
            op.brightnessDelta !== undefined
              ? prevEff.brightness + op.brightnessDelta
              : op.brightness !== undefined
                ? op.brightness
                : prevEff.brightness;
          return {
            ...c,
            effects: normalizeEffects({
              preset: op.preset ?? prevEff.preset,
              brightness: nextBrightness,
              contrast: op.contrast ?? prevEff.contrast,
              saturation: op.saturation ?? prevEff.saturation,
              blur: op.blur ?? prevEff.blur,
            }),
          };
        }),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "set_clip_transition") {
      const dur = op.durationSec ?? 0.6;
      if (op.targetScope === "between_v1_clips") {
        const v1Sorted = next.clips
          .filter((c) => c.trackId === "track_v1" && (c.kind === "video" || c.kind === "image"))
          .sort((a, b) => a.startTime - b.startTime);

        if (v1Sorted.length < 2) {
          if (v1Sorted.length === 1) {
            const single = v1Sorted[0];
            next = {
              ...next,
              clips: next.clips.map((c) =>
                c.id === single.id
                  ? {
                      ...c,
                      transitionIn: normalizeTransition(
                        { type: op.transitionType, durationSec: dur },
                        c.duration
                      ),
                    }
                  : c
              ),
            };
            appliedCount++;
            continue;
          }
          skippedMessages.push("Add at least two clips on track V1 to transition between clips.");
          continue;
        }

        const outIds = new Set(v1Sorted.slice(0, -1).map((c) => c.id));
        next = {
          ...next,
          clips: next.clips.map((c) =>
            outIds.has(c.id)
              ? {
                  ...c,
                  transitionOut: normalizeTransition(
                    { type: op.transitionType, durationSec: dur },
                    c.duration
                  ),
                }
              : c
          ),
        };
        appliedCount++;
        continue;
      }

      const target = findTargetClip(
        next.clips.filter((c) => c.kind !== "audio"),
        op.clipId,
        selectedClipId
      );
      if (!target) {
        skippedMessages.push("No clip found to apply transition.");
        continue;
      }
      const tr = normalizeTransition({ type: op.transitionType, durationSec: dur }, target.duration);
      const edge = op.edge ?? "out";
      next = {
        ...next,
        clips: next.clips.map((c) =>
          c.id === target.id
            ? {
                ...c,
                ...(edge === "in" || edge === "both" ? { transitionIn: tr } : {}),
                ...(edge === "out" || edge === "both" ? { transitionOut: tr } : {}),
              }
            : c
        ),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "set_clip_opacity") {
      const target =
        (op.clipId ? next.clips.find((c) => c.id === op.clipId) : null) ??
        findOverlayClip(next.clips, undefined, selectedClipId) ??
        findTargetClip(
          next.clips.filter((c) => c.kind !== "audio"),
          undefined,
          selectedClipId
        );
      if (!target) {
        skippedMessages.push("No visual clip found to adjust opacity.");
        continue;
      }
      const clampedOpacity = Number(Math.max(0, Math.min(1, op.opacity)).toFixed(2));
      next = {
        ...next,
        clips: next.clips.map((c) => (c.id === target.id ? { ...c, opacity: clampedOpacity } : c)),
      };
      appliedCount++;
      continue;
    }

    if (op.type === "set_overlay_transform") {
      const target = findOverlayClip(next.clips, op.clipId, selectedClipId);
      if (!target) {
        skippedMessages.push("No image or video overlay clip found on track V2.");
        continue;
      }

      let baseTransform = normalizeOverlayTransform(target.overlayTransform);
      let suggestedOpacity: number | undefined;
      if (op.preset) {
        const applied = applyOverlayPreset(baseTransform, op.preset);
        baseTransform = applied.overlayTransform;
        suggestedOpacity = applied.suggestedOpacity;
      }

      const lockAspect =
        op.lockAspectRatio !== undefined ? op.lockAspectRatio : baseTransform.lockAspectRatio;
      const working: typeof baseTransform = {
        ...baseTransform,
        lockAspectRatio: lockAspect,
      };

      const dims =
        op.widthPct !== undefined || op.heightPct !== undefined
          ? updateOverlayBoxDimensions(
              working,
              { widthPct: op.widthPct, heightPct: op.heightPct },
              {
                aspectRatio: next.aspectRatio,
                sourceWidth: target.sourceWidth,
                sourceHeight: target.sourceHeight,
              }
            )
          : { widthPct: working.widthPct, heightPct: working.heightPct };

      const finalTransform = normalizeOverlayTransform({
        x: op.x ?? working.x,
        y: op.y ?? working.y,
        widthPct: dims.widthPct,
        heightPct: dims.heightPct,
        scale: op.scale ?? working.scale,
        lockAspectRatio: lockAspect,
      });

      next = {
        ...next,
        clips: next.clips.map((c) =>
          c.id === target.id
            ? {
                ...c,
                overlayTransform: finalTransform,
                ...(op.preset === "watermark" && suggestedOpacity !== undefined && Math.abs(c.opacity - 1) < 0.01
                  ? { opacity: suggestedOpacity }
                  : {}),
              }
            : c
        ),
      };
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
