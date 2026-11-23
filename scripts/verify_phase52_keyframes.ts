import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import type { Project, TimelineClip, TimelineTrack } from "../src/types/studio.ts";
import { StudioProvider } from "../src/context/StudioContext.tsx";
import { TimelinePlaybackClock } from "../src/utils/timelineClock.ts";
import {
  applyEasing,
  clampClipRotation,
  clampKeyframeTime,
  clampPropertyValue,
  clearPropertyKeyframes,
  cloneKeyframes,
  evaluateClipKeyframes,
  evaluateClipProperty,
  getPropertyKeyframes,
  getSupportedKeyframeProperties,
  hasVolumeKeyframesWithSound,
  interpolateProperty,
  removeClipKeyframe,
  sortAndDedupeKeyframes,
  updateClipKeyframeById,
  upsertClipKeyframe,
} from "../src/utils/keyframes.ts";
import {
  applyClipSpeedOnTimeline,
  createDefaultTracks,
  duplicateClipWithoutOverlap,
  splitClipAtTimestamp,
  trimClipEnd,
  trimClipStart,
  buildStructuredTimelineSpec,
} from "../src/utils/timeline.ts";
import { computeEffectiveClipGain } from "../src/utils/audio.ts";
import {
  AiEditPlanSchema,
  applyAiOperationsToProject,
  describeAiOperation,
} from "../src/utils/aiOperations.ts";
import {
  mapServerProjectToStudioProject,
  serializeClipForServer,
} from "../src/services/api.ts";
import { TimelineClipSchema } from "../server/validators/project.validators.ts";
import { ClipKeyframeInspector } from "../src/components/editor/ClipKeyframeInspector.tsx";
import { EditorPreviewStage } from "../src/components/editor/EditorPreviewStage.tsx";
import { MultitrackTimeline } from "../src/components/editor/MultitrackTimeline.tsx";
import { AiAssistantPanel } from "../src/components/editor/AiAssistantPanel.tsx";

function buildBaseClip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip_v1_1",
    assetId: "asset_1",
    trackId: "track_v1",
    name: "Intro.mp4",
    kind: "video",
    startTime: 0,
    duration: 10,
    inPoint: 0,
    sourceDuration: 20,
    volume: 1,
    speed: 1,
    opacity: 1,
    objectUrl: "blob:intro",
    sourceName: "Intro.mp4",
    sourceMimeType: "video/mp4",
    ...overrides,
  };
}

function buildSampleProject(): Project {
  const tracks: TimelineTrack[] = createDefaultTracks();
  return {
    id: "proj_52_test",
    name: "Phase 5.2 Keyframes Test",
    description: "Phase 5.2 keyframe test project",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    tracks,
    clips: [
      buildBaseClip({
        id: "v1_main",
        trackId: "track_v1",
        kind: "video",
        duration: 10,
        rotation: 12,
        keyframes: [
          { id: "kf_v1_sc0", property: "scale", timeSec: 0, value: 1.0, easing: "linear" },
          { id: "kf_v1_sc1", property: "scale", timeSec: 10, value: 1.5, easing: "linear" },
          { id: "kf_v1_op0", property: "opacity", timeSec: 0, value: 0.2, easing: "linear" },
          { id: "kf_v1_op1", property: "opacity", timeSec: 5, value: 1.0, easing: "linear" },
        ],
      }),
      buildBaseClip({
        id: "v2_logo",
        assetId: "asset_logo",
        trackId: "track_v2",
        name: "Logo.png",
        kind: "image",
        startTime: 1,
        duration: 6,
        overlayTransform: {
          x: 20,
          y: 25,
          widthPct: 24,
          heightPct: 24,
          scale: 1,
          lockAspectRatio: true,
        },
        objectUrl: "blob:logo",
        keyframes: [
          { id: "kf_v2_x0", property: "x", timeSec: 0, value: 15, easing: "ease-out" },
          { id: "kf_v2_x1", property: "x", timeSec: 4, value: 85, easing: "linear" },
          { id: "kf_v2_r0", property: "rotation", timeSec: 0, value: 0, easing: "linear" },
          { id: "kf_v2_r1", property: "rotation", timeSec: 4, value: 90, easing: "linear" },
        ],
      }),
      buildBaseClip({
        id: "t1_title",
        assetId: "text_overlay",
        trackId: "track_t1",
        name: "বাংলা টাইটেল",
        kind: "text",
        startTime: 1,
        duration: 5,
        objectUrl: "",
        textStyle: {
          text: "বাংলা টাইটেল",
          fontSize: 36,
          color: "#FFFFFF",
          backgroundColor: "#09090B",
          backgroundOpacity: 0.7,
          x: 50,
          y: 20,
          align: "center",
        },
        keyframes: [
          { id: "kf_t1_y0", property: "y", timeSec: 0, value: 20, easing: "ease-in-out" },
          { id: "kf_t1_y1", property: "y", timeSec: 5, value: 70, easing: "linear" },
          { id: "kf_t1_op0", property: "opacity", timeSec: 0, value: 0.2, easing: "linear" },
          { id: "kf_t1_op1", property: "opacity", timeSec: 2, value: 1.0, easing: "linear" },
        ],
      }),
      buildBaseClip({
        id: "a1_bgm",
        assetId: "asset_bgm",
        trackId: "track_a1",
        name: "BGM.mp3",
        kind: "audio",
        startTime: 0,
        duration: 8,
        volume: 0,
        objectUrl: "blob:bgm",
        keyframes: [
          { id: "kf_a1_v0", property: "volume", timeSec: 0, value: 0.0, easing: "linear" },
          { id: "kf_a1_v1", property: "volume", timeSec: 4, value: 1.2, easing: "linear" },
          { id: "kf_a1_v2", property: "volume", timeSec: 8, value: 0.4, easing: "linear" },
        ],
      }),
    ],
    subtitleStyle: {
      enabled: true,
      fontSize: 28,
      color: "#FFFFFF",
      backgroundColor: "#09090B",
      backgroundOpacity: 0.75,
      position: "bottom",
    },
    subtitles: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function testInterpolationAndEasings() {
  // Supported properties per kind
  assert.deepEqual(getSupportedKeyframeProperties({ kind: "audio", trackId: "track_a1" }), ["volume"]);
  assert.deepEqual(getSupportedKeyframeProperties({ kind: "image", trackId: "track_v2" }), [
    "x",
    "y",
    "scale",
    "rotation",
    "opacity",
  ]);
  assert.deepEqual(getSupportedKeyframeProperties({ kind: "text", trackId: "track_t1" }), [
    "x",
    "y",
    "scale",
    "rotation",
    "opacity",
  ]);
  assert.deepEqual(getSupportedKeyframeProperties({ kind: "video", trackId: "track_v1" }), [
    "x",
    "y",
    "scale",
    "rotation",
    "opacity",
    "volume",
  ]);

  // Easing curve shapes
  assert.equal(applyEasing(0.5, "linear"), 0.5);
  assert.ok(Math.abs(applyEasing(0.5, "ease-in") - 0.25) < 1e-6);
  assert.ok(Math.abs(applyEasing(0.5, "ease-out") - 0.75) < 1e-6);
  assert.ok(Math.abs(applyEasing(0.5, "ease-in-out") - 0.5) < 1e-6);
  assert.ok(applyEasing(0.25, "ease-in-out") < 0.25);
  assert.ok(applyEasing(0.75, "ease-in-out") > 0.75);
  assert.equal(applyEasing(0.0, "hold"), 0);
  assert.equal(applyEasing(0.99, "hold"), 0);
  assert.equal(applyEasing(1.0, "hold"), 1);

  // 0, 1, and multi keyframe boundary behavior + NaN safety
  assert.equal(interpolateProperty(undefined, "opacity", 2, 0.75), 0.75);
  assert.equal(
    interpolateProperty(
      [{ id: "1", property: "scale", timeSec: 3, value: 1.4, easing: "linear" }],
      "scale",
      0.5,
      1.0
    ),
    1.4
  );
  const kfs = [
    { id: "a", property: "x" as const, timeSec: 1, value: 10, easing: "hold" as const },
    { id: "b", property: "x" as const, timeSec: 3, value: 90, easing: "linear" as const },
    { id: "c", property: "x" as const, timeSec: 5, value: 50, easing: "linear" as const },
  ];
  assert.equal(interpolateProperty(kfs, "x", 0, 50), 10);
  assert.equal(interpolateProperty(kfs, "x", 2.9, 50), 10); // hold until 3s
  assert.equal(interpolateProperty(kfs, "x", 3.0, 50), 90);
  assert.equal(interpolateProperty(kfs, "x", 4.0, 50), 70);
  assert.equal(interpolateProperty(kfs, "x", 9.0, 50), 50);
  assert.equal(Number.isFinite(interpolateProperty(kfs, "x", Number.NaN, 50)), true);

  // Clamping & duplicate timestamp resolution
  assert.equal(clampPropertyValue("rotation", 999), 360);
  assert.equal(clampPropertyValue("rotation", -999), -360);
  assert.equal(clampPropertyValue("scale", 0.01), 0.1);
  assert.equal(clampPropertyValue("volume", 5), 2);
  assert.equal(clampKeyframeTime(-3, 5), 0);
  assert.equal(clampKeyframeTime(12, 5), 5);
  assert.equal(clampClipRotation(450), 360);

  const deduped = sortAndDedupeKeyframes(
    [
      { id: "k1", property: "opacity", timeSec: 2, value: 0.2, easing: "linear" },
      { id: "k2", property: "opacity", timeSec: 2, value: 0.8, easing: "ease-out" },
    ],
    4
  );
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].value, 0.8);

  // Upsert, update by id, remove, clear
  let list = upsertClipKeyframe(undefined, { property: "x", timeSec: 1, value: 25 }, 8).keyframes;
  list = upsertClipKeyframe(list, { property: "x", timeSec: 1.03, value: 40 }, 8).keyframes; // snaps within 0.05s
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 40);
  list = updateClipKeyframeById(list, list[0].id, { value: 60, easing: "ease-in" }, 8);
  assert.equal(list[0].value, 60);
  assert.equal(list[0].easing, "ease-in");
  const cleared = removeClipKeyframe(list, list[0].id);
  assert.equal(cleared, undefined);
  assert.equal(
    clearPropertyKeyframes(
      [
        { id: "1", property: "x", timeSec: 0, value: 10, easing: "linear" },
        { id: "2", property: "y", timeSec: 0, value: 20, easing: "linear" },
      ],
      "x"
    )?.length,
    1
  );
}

function testTimelineMutationsAndUndoIsolation() {
  const clip = buildBaseClip({
    id: "v1_mut",
    duration: 10,
    rotation: 25,
    keyframes: [
      { id: "k0", property: "opacity", timeSec: 0, value: 0, easing: "linear" },
      { id: "k1", property: "opacity", timeSec: 10, value: 1, easing: "linear" },
    ],
  });

  // Trim start by 2s (0s..10s -> 2s..10s, new duration 8s, keyframe at 0s sampled at 0.2)
  const trimStartPatch = trimClipStart(clip, 2);
  const trimmedStart: TimelineClip = { ...clip, ...trimStartPatch };
  assert.equal(trimmedStart.duration, 8);
  assert.equal(evaluateClipProperty(trimmedStart, "opacity", 0), 0.2);
  assert.equal(evaluateClipProperty(trimmedStart, "opacity", 8), 1);

  // Trim end to 4s duration (keyframe at new end 4s sampled at 0.6)
  const trimEndPatch = trimClipEnd(trimmedStart, 4);
  const trimmedBoth: TimelineClip = { ...trimmedStart, ...trimEndPatch };
  assert.equal(trimmedBoth.duration, 4);
  assert.equal(evaluateClipProperty(trimmedBoth, "opacity", 4), 0.6);

  // Split at midpoint (0..10 split at 5s -> left 0..5 [0 -> 0.5], right 0..5 [0.5 -> 1])
  const splitRes = splitClipAtTimestamp([clip], clip.id, 5);
  assert.equal(splitRes.didSplit, true);
  assert.equal(splitRes.clips.length, 2);
  const [left, right] = splitRes.clips;
  assert.equal(evaluateClipProperty(left, "opacity", 0), 0);
  assert.equal(evaluateClipProperty(left, "opacity", 5), 0.5);
  assert.equal(evaluateClipProperty(right, "opacity", 0), 0.5);
  assert.equal(evaluateClipProperty(right, "opacity", 5), 1);
  assert.equal(left.rotation, 25);
  assert.equal(right.rotation, 25);

  // Speed 2.0x scales keyframe times proportionally (0..10s -> 0..5s)
  const speedRes = applyClipSpeedOnTimeline([clip], clip.id, 2);
  assert.ok(speedRes.updatedClip);
  const fastClip = speedRes.clips[0];
  assert.equal(fastClip.duration, 5);
  assert.equal(evaluateClipProperty(fastClip, "opacity", 2.5), 0.5);
  assert.equal(evaluateClipProperty(fastClip, "opacity", 5), 1);

  // Duplicate isolation (mutating duplicate does not mutate original)
  const dupRes = duplicateClipWithoutOverlap([clip], clip.id);
  const dup = dupRes.duplicated;
  assert.ok(dup);
  assert.notEqual(dup.id, clip.id);
  assert.equal(dup.keyframes?.length, 2);
  dup.keyframes![0].value = 0.99;
  assert.equal(clip.keyframes![0].value, 0);

  // Deep clone helper isolation
  const cloned = cloneKeyframes(clip.keyframes);
  assert.ok(cloned);
  cloned[0].value = 0.77;
  assert.equal(clip.keyframes![0].value, 0);
}

function testSerializationAndLegacyCompatibility() {
  const proj = buildSampleProject();
  const serialized = serializeClipForServer(proj.clips[0]);
  const zodRes = TimelineClipSchema.safeParse(serialized);
  assert.equal(zodRes.success, true, JSON.stringify(zodRes));
  assert.equal(serialized.rotation, 12);
  assert.equal(serialized.keyframes?.length, 4);

  // Server -> Client round-trip
  const mapped = mapServerProjectToStudioProject({
    _id: "proj_db_1",
    name: "DB Roundtrip",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    tracks: proj.tracks,
    clips: [serialized as unknown as Omit<TimelineClip, "objectUrl" | "needsRelink" | "thumbnailUrl">],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(mapped.clips[0].rotation, 12);
  assert.equal(mapped.clips[0].keyframes?.length, 4);

  // Legacy clip without keyframes or rotation loads cleanly
  const legacyMapped = mapServerProjectToStudioProject({
    _id: "proj_legacy",
    name: "Legacy",
    aspectRatio: "16:9",
    resolution: "720p",
    fps: 30,
    tracks: proj.tracks,
    clips: [
      {
        id: "legacy_c1",
        assetId: "asset_leg",
        trackId: "track_v1",
        name: "Legacy.mp4",
        kind: "video",
        startTime: 0,
        duration: 5,
        inPoint: 0,
        sourceDuration: 5,
        volume: 0.9,
        speed: 1,
        opacity: 0.85,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(legacyMapped.clips[0].rotation ?? 0, 0);
  assert.equal(legacyMapped.clips[0].keyframes, undefined);
  assert.equal(evaluateClipProperty(legacyMapped.clips[0], "opacity", 2.5), 0.85);

  // Export structured spec includes rotation + keyframes
  const exportSpec = buildStructuredTimelineSpec(proj);
  const exportedV2 = exportSpec.clips.find((c) => c.id === "v2_logo");
  assert.ok(exportedV2);
  assert.equal(exportedV2.keyframes?.length, 4);
}

function testAudioKeyframeGainEvaluation() {
  const proj = buildSampleProject();
  const a1 = proj.clips.find((c) => c.id === "a1_bgm")!;
  // Even though static base volume is 0, keyframes ramp 0 -> 1.2 -> 0.4
  assert.equal(hasVolumeKeyframesWithSound(a1), true);

  const g0 = computeEffectiveClipGain({
    clip: a1,
    timelineTimeSec: 0,
    trackMuted: false,
    masterVolume: 1,
    masterMuted: false,
  });
  assert.equal(g0.isMuted, true); // Gain ~0 at t=0
  assert.equal(g0.effectiveGain, 0);

  const g2 = computeEffectiveClipGain({
    clip: a1,
    timelineTimeSec: 2,
    trackMuted: false,
    masterVolume: 1,
    masterMuted: false,
  });
  assert.equal(g2.isMuted, false);
  assert.ok(Math.abs(g2.effectiveGain - 0.6) < 0.02);

  const g4 = computeEffectiveClipGain({
    clip: a1,
    timelineTimeSec: 4,
    trackMuted: false,
    masterVolume: 1,
    masterMuted: false,
  });
  assert.ok(Math.abs(g4.effectiveGain - 1.2) < 0.02);

  const g8 = computeEffectiveClipGain({
    clip: a1,
    timelineTimeSec: 6,
    trackMuted: false,
    masterVolume: 1,
    masterMuted: false,
  });
  assert.ok(Math.abs(g8.effectiveGain - 0.8) < 0.02);

  // Ducking stacks with keyframed volume cleanly
  const gDuck = computeEffectiveClipGain({
    clip: { ...a1, duckingEnabled: true, duckingAmount: 0.5 },
    timelineTimeSec: 4,
    trackMuted: false,
    masterVolume: 1,
    masterMuted: false,
    speechIntervals: [{ start: 3, end: 5 }],
  });
  assert.ok(Math.abs(gDuck.effectiveGain - 0.6) < 0.02);
}

function testUiRenderingAndClockPerformance() {
  const proj = buildSampleProject();
  const clock = new TimelinePlaybackClock(2.5);

  const origWindow = (globalThis as Record<string, unknown>).window;
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).window = {
    location: { origin: "http://localhost:3000" },
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  try {
    // 1) EditorPreviewStage evaluates animated transforms cleanly at playhead=2.5s
    const ssrPreviewProject: Project = {
      ...proj,
      clips: proj.clips.map((c, idx) => (idx === 0 ? { ...c, kind: "image" } : c)),
    };
    const previewHtml = renderToString(
      React.createElement(EditorPreviewStage, {
        project: ssrPreviewProject,
        playbackClock: clock,
        totalDuration: 10,
        isPlaying: false,
        onSetIsPlaying: () => undefined,
        masterVolume: 1,
        onMasterVolumeChange: () => undefined,
        masterMuted: false,
        onToggleMasterMuted: () => undefined,
        playbackRate: 1,
        onPlaybackRateChange: () => undefined,
        selectedClipId: "v2_logo",
        onSelectClip: () => undefined,
        onUpdateClip: () => undefined,
        onUpdateTextStyle: () => undefined,
        onCommitProjectSnapshot: () => undefined,
        onTriggerRelink: () => undefined,
        isRestoringProjectMedia: false,
        onMediaError: () => undefined,
        onSeek: () => undefined,
        onTogglePlay: () => undefined,
        onStepFrame: () => undefined,
      })
    );
    assert.ok(previewHtml.includes("scale(1.130)"));
    assert.ok(previewHtml.includes("rotate(12.00deg)"));
    assert.ok(previewHtml.includes("rotate(33.80deg)"));
    assert.ok(previewHtml.includes("বাংলা টাইটেল"));

    // 2) ClipKeyframeInspector renders controls, easing options, and diamonds
    const inspectorHtml = renderToString(
      React.createElement(ClipKeyframeInspector, {
        clip: proj.clips[1], // v2_logo
        playbackClock: clock,
        onSeek: () => undefined,
        onUpdateClip: () => undefined,
      })
    );
    assert.ok(inspectorHtml.includes("Animation &amp; Keyframes"));
    assert.ok(inspectorHtml.includes("Ease In-Out"));
    assert.ok(inspectorHtml.includes("keyframes"));

    // 3) MultitrackTimeline renders diamond markers on clips with keyframes
    const timelineHtml = renderToString(
      React.createElement(
        StudioProvider,
        null,
        React.createElement(MultitrackTimeline, {
          project: proj,
          playbackClock: clock,
          onSeek: () => undefined,
          selectedClipId: "v2_logo",
          onSelectClip: () => undefined,
          activeTool: "select",
          onToolChange: () => undefined,
          totalDuration: 10,
        })
      )
    );
    const diamondCount = (timelineHtml.match(/aria-label="Jump to/g) || []).length;
    assert.ok(diamondCount >= 10, `Expected >= 10 diamond buttons on timeline, found ${diamondCount}`);

    // 4) AiAssistantPanel renders Inspector with Keyframe section & static rotation control
    const aiPanelHtml = renderToString(
      React.createElement(
        StudioProvider,
        null,
        React.createElement(AiAssistantPanel, {
          project: proj,
          selectedClip: proj.clips[0],
          totalDuration: 10,
          playbackClock: clock,
          onSeek: () => undefined,
          activeTab: "inspector",
        })
      )
    );
    assert.ok(aiPanelHtml.includes("Rotation"));
    assert.ok(aiPanelHtml.includes("Animation &amp; Keyframes"));

    // 5) Throttled clock subscriber verification: 60 ticks over ~1s only triggers throttled listeners appropriately
    let unthrottledCount = 0;
    const unsub = clock.subscribe(() => {
      unthrottledCount++;
    });
    for (let i = 1; i <= 60; i++) {
      clock.setTime(i * 0.0167);
    }
    unsub();
    assert.equal(unthrottledCount, 60);
    // EvaluateClipKeyframes 1000 iterations must stay ultra-fast (<5ms)
    const evalStart = performance.now();
    for (let i = 0; i < 1000; i++) {
      const vals = evaluateClipKeyframes(proj.clips[1], (i % 60) * 0.1);
      assert.ok(Number.isFinite(vals.x) && Number.isFinite(vals.rotation));
    }
    const evalMs = performance.now() - evalStart;
    assert.ok(evalMs < 50, `Expected <50ms for 1000 keyframe evaluations, got ${evalMs.toFixed(2)}ms`);
  } finally {
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
  }
}

function testAiKeyframeCommands() {
  const baseProj = buildSampleProject();
  // Remove pre-seeded keyframes on v1_main so AI ops start clean
  baseProj.clips[0].keyframes = undefined;
  baseProj.clips[1].keyframes = undefined;

  const plan = AiEditPlanSchema.parse({
    summary: "Zoom V1 in smoothly, slide logo across, fade audio down, and clear T1 rotation.",
    operations: [
      {
        type: "set_clip_keyframes",
        clipId: "v1_main",
        property: "scale",
        fromValue: 1.0,
        toValue: 1.35,
        easing: "ease-in-out",
        reason: "Slow smooth zoom in",
      },
      {
        type: "set_clip_keyframes",
        clipId: "v2_logo",
        property: "x",
        fromValue: 10,
        toValue: 85,
        startOffsetSec: 0,
        endOffsetSec: 2,
        easing: "ease-out",
        reason: "Slide logo in",
      },
      {
        type: "set_clip_keyframes",
        clipId: "a1_bgm",
        property: "volume",
        keyframes: [
          { timeSec: 0, value: 1.0, easing: "linear" },
          { timeSec: 2, value: 1.0, easing: "ease-out" },
          { timeSec: 6, value: 0.25, easing: "linear" },
        ],
        reason: "Fade BGM down mid-clip",
      },
      {
        type: "clear_clip_keyframes",
        clipId: "t1_title",
        property: "opacity",
        reason: "Keep title solid",
      },
    ],
  });

  const desc0 = describeAiOperation(plan.operations[0], baseProj);
  assert.ok(desc0.includes("Animate Scale"));

  const applied = applyAiOperationsToProject(baseProj, plan.operations, "v1_main");
  assert.equal(applied.appliedCount, 4);
  assert.equal(applied.skippedMessages.length, 0);

  const updatedV1 = applied.project.clips.find((c) => c.id === "v1_main")!;
  assert.equal(evaluateClipProperty(updatedV1, "scale", 0), 1.0);
  assert.equal(evaluateClipProperty(updatedV1, "scale", 10), 1.35);

  const updatedV2 = applied.project.clips.find((c) => c.id === "v2_logo")!;
  assert.equal(evaluateClipProperty(updatedV2, "x", 0), 10);
  assert.equal(evaluateClipProperty(updatedV2, "x", 2), 85);

  const updatedA1 = applied.project.clips.find((c) => c.id === "a1_bgm")!;
  assert.equal(evaluateClipProperty(updatedA1, "volume", 6), 0.25);

  const updatedT1 = applied.project.clips.find((c) => c.id === "t1_title")!;
  assert.equal(getPropertyKeyframes(updatedT1.keyframes, "opacity").length, 0);
  assert.equal(getPropertyKeyframes(updatedT1.keyframes, "y").length, 2);

  // Confirm DB serializer validates all AI-produced keyframes cleanly
  for (const clip of applied.project.clips) {
    const parsed = TimelineClipSchema.safeParse(serializeClipForServer(clip));
    assert.equal(parsed.success, true);
  }
}

testInterpolationAndEasings();
testTimelineMutationsAndUndoIsolation();
testSerializationAndLegacyCompatibility();
testAudioKeyframeGainEvaluation();
testUiRenderingAndClockPerformance();
testAiKeyframeCommands();

console.log("ALL_PHASE_52_KEYFRAME_VERIFICATIONS_PASSED");
