import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import React from "react";
import { renderToString } from "react-dom/server";

import { StudioProvider } from "../src/context/StudioContext.tsx";
import { AiGeneratorPage } from "../src/pages/AiGeneratorPage.tsx";
import { MediaLibraryPage } from "../src/pages/MediaLibraryPage.tsx";
import { StoryboardReviewPanel } from "../src/components/generator/StoryboardReviewPanel.tsx";
import type { MediaAsset, VideoStoryboard } from "../src/types/studio.ts";
import {
  SaveStoryboardDraftSchema,
} from "../server/validators/aiAndExport.validators.ts";
import { CreateMediaMetadataSchema } from "../server/validators/media.validators.ts";
import {
  StoryboardSceneMediaAssignmentSchema,
  VideoStoryboardSchema,
  recalculateStoryboardTiming,
  reorderStoryboardScenes,
  sanitizeStoryboardForPersistence,
} from "../src/utils/storyboard.ts";
import {
  autoMatchStoryboardScenes,
  clampVideoSourceStartTime,
  computeStoryboardMediaSummary,
  createAssignmentFromAsset,
  detectAspectRatioMismatch,
  evaluateSceneMediaReadiness,
  findDuplicateMediaAsset,
  findStoryboardsUsingAsset,
  normalizeMediaKeywords,
  scoreAssetForScene,
} from "../src/utils/storyboardMedia.ts";
import {
  ASPECT_RATIO_SLIDE_DIMENSIONS,
  GeneratedSlideConfigSchema,
  checkLanguageFontSupport,
  getSlideFontFamily,
  wrapCanvasTextLines,
} from "../src/utils/generatedSlides.ts";
import {
  PexelsStockMediaProvider,
  getStockMediaStatus,
  importStockMediaAsset,
  isPrivateOrLoopbackIp,
  searchStockMedia,
  validateStockRemoteUrl,
} from "../server/services/stockMedia.service.ts";
import {
  csrfProtectionMiddleware,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
} from "../server/middleware/security.middleware.ts";
import { apiRouter } from "../server/routes/index.ts";
import { UserModel } from "../server/models/User.ts";
import { StoryboardDraftModel } from "../server/models/StoryboardDraft.ts";

function makeBaseStoryboard(overrides?: Partial<VideoStoryboard>): VideoStoryboard {
  const now = "2026-11-25T10:00:00.000Z";
  return {
    id: "sb_phase552_test",
    title: "Morning Coding & Focus",
    description: "Three short scenes about deep coding workflow and hydration.",
    targetAudience: "Developers and students",
    language: "English",
    totalDuration: 15,
    aspectRatio: "16:9",
    style: "Educational",
    fullNarrationScript:
      "Start at a quiet sunrise desk. Write focused code without distractions. Keep water nearby to stay energized.",
    backgroundMusicMood: "Minimal ambient lo-fi",
    captionText: "Quiet sunrise desk\nFocused coding block\nHydrate often",
    sourceMode: "prompt-to-video",
    model: "gemini-3.5-flash",
    compositionReady: false,
    createdAt: now,
    updatedAt: now,
    settings: {
      mode: "prompt-to-video",
      targetDurationSec: 15,
      aspectRatio: "16:9",
      style: "Educational",
      language: "English",
      voiceoverEnabled: true,
      voiceoverPreference: "natural_narrator",
      captionsEnabled: true,
      captionStyle: "clean_subtitles",
      targetAudience: "Developers",
      additionalInstructions: "",
    },
    scenes: [
      {
        id: "scene_1",
        title: "Quiet Sunrise Desk",
        startTime: 0,
        duration: 5,
        narration: "Start at a quiet sunrise desk.",
        onScreenText: "Start with a quiet desk",
        visualDescription: "Sunlight over minimalist laptop desk.",
        mediaKeywords: ["sunrise", "desk", "laptop"],
        mediaType: "video",
        transition: "fade",
        effect: "cinematic",
        cameraMotion: "slow-dolly-in",
      },
      {
        id: "scene_2",
        title: "Deep Coding Focus",
        startTime: 5,
        duration: 5,
        narration: "Write focused code without distractions.",
        onScreenText: "40 minutes of deep code",
        visualDescription: "Developer typing code on screen at night lamp.",
        mediaKeywords: ["coding", "developer", "keyboard"],
        mediaType: "video",
        transition: "dissolve",
        effect: "none",
        cameraMotion: "pan-right",
      },
      {
        id: "scene_3",
        title: "Hydrate & Reset",
        startTime: 10,
        duration: 5,
        narration: "Keep water nearby to stay energized.",
        onScreenText: "Stay hydrated",
        visualDescription: "Clean glass of water next to notebook.",
        mediaKeywords: ["water", "glass", "notebook"],
        mediaType: "image",
        transition: "none",
        effect: "none",
        cameraMotion: "static",
      },
    ],
    ...(overrides ?? {}),
  };
}

function makeAsset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    id: `asset_${Math.random().toString(36).slice(2, 8)}`,
    name: "sample_clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 1_024_000,
    duration: 8,
    width: 1920,
    height: 1080,
    objectUrl: "blob:http://localhost:3000/temporary-object-url",
    sourceOrigin: "uploaded",
    addedAt: "2026-11-25T10:00:00.000Z",
    ...overrides,
  };
}

async function startTempServer(
  app: express.Express
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function runTests(): Promise<void> {
  // 1. Phase 5.5.1 draft backward compatibility (without mediaAssignment)
  {
    const legacyStoryboard = makeBaseStoryboard();
    const parsedSb = VideoStoryboardSchema.safeParse(legacyStoryboard);
    assert.equal(parsedSb.success, true, "Phase 5.5.1 storyboard without mediaAssignment must remain valid");
    const parsedDraft = SaveStoryboardDraftSchema.safeParse({
      title: legacyStoryboard.title,
      status: "validated",
      storyboard: legacyStoryboard,
    });
    assert.equal(parsedDraft.success, true, "Phase 5.5.1 SaveStoryboardDraftSchema must accept drafts without assignments");
    console.log("[PASS] 1. Phase 5.5.1 draft backward compatibility");
  }

  // 2. Phase 5.5.2 draft schema validation (mediaAssignment, mediaReadinessSummary, compositionReady: false)
  {
    const asset = makeAsset({ id: "asset_sunrise_1", name: "sunrise_desk_laptop.mp4", width: 1920, height: 1080, duration: 10 });
    const sb = makeBaseStoryboard();
    const assignment = createAssignmentFromAsset(sb.scenes[0], asset, sb.aspectRatio, {
      matchScore: 86,
      matchExplanation: "Matched keywords (sunrise, desk, laptop)",
    });
    sb.scenes[0] = { ...sb.scenes[0], mediaAssignment: assignment };
    sb.mediaReadinessSummary = computeStoryboardMediaSummary(sb, [asset], true);

    const parsed = VideoStoryboardSchema.safeParse(sb);
    assert.equal(parsed.success, true, "Phase 5.5.2 storyboard with mediaAssignment + summary must validate");
    assert.equal(parsed.data?.compositionReady, false, "compositionReady must remain false until Phase 5.5.3");
    console.log("[PASS] 2. Phase 5.5.2 draft schema validation & compositionReady guard");
  }

  // 3. Rejection of blob: URLs in schemas and stripping via sanitizeStoryboardForPersistence
  {
    const badAssignment = {
      sceneId: "scene_1",
      mediaAssetId: "asset_1",
      mediaType: "image",
      mediaSource: "uploaded",
      assetTitle: "desk.png",
      mimeType: "image/png",
      thumbnailRef: "blob:http://localhost:3000/1234",
      sourceUrl: "blob:http://localhost:3000/5678",
      attributionUrl: "blob:http://localhost:3000/9999",
      assignmentStatus: "assigned",
      sourceStartTime: 0,
      aspectRatioHandling: "fit",
      assignedAt: "2026-11-25T10:00:00.000Z",
    };

    assert.equal(
      StoryboardSceneMediaAssignmentSchema.safeParse(badAssignment).success,
      false,
      "Assignment schema must reject blob: URLs"
    );

    const sbWithBlob = makeBaseStoryboard();
    sbWithBlob.scenes[0] = {
      ...sbWithBlob.scenes[0],
      mediaAssignment: badAssignment as unknown as NonNullable<VideoStoryboard["scenes"][0]["mediaAssignment"]>,
    };
    assert.equal(VideoStoryboardSchema.safeParse(sbWithBlob).success, false);
    assert.equal(
      SaveStoryboardDraftSchema.safeParse({ title: "Bad Blob", storyboard: sbWithBlob }).success,
      false
    );
    assert.equal(
      CreateMediaMetadataSchema.safeParse({
        name: "bad.png",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 1200,
        duration: 0,
        sourceUrl: "blob:http://localhost:3000/abc",
      }).success,
      false
    );

    const sanitized = sanitizeStoryboardForPersistence(sbWithBlob);
    assert.equal(sanitized.scenes[0].mediaAssignment?.thumbnailRef, undefined);
    assert.equal(sanitized.scenes[0].mediaAssignment?.sourceUrl, undefined);
    assert.equal(sanitized.scenes[0].mediaAssignment?.attributionUrl, undefined);
    assert.equal(VideoStoryboardSchema.safeParse(sanitized).success, true);
    console.log("[PASS] 3. Rejection and sanitization of temporary blob: URLs");
  }

  // 4. Deterministic keyword normalization (camelCase, filenames, punctuation, Hindi Devanagari, Bengali Unicode)
  {
    const engTokens = normalizeMediaKeywords("sunriseDesk-LaptopClip_02.mp4");
    assert.deepEqual(engTokens, ["sunrise", "desk", "laptop"]);

    const hiTokens = normalizeMediaKeywords("सूर्योदय_सुबह-डेस्क.mp4");
    assert.ok(hiTokens.includes("सूर्योदय"));
    assert.ok(hiTokens.includes("सुबह"));
    assert.ok(hiTokens.includes("डेस्क"));

    const bnTokens = normalizeMediaKeywords("সকালের-সূর্যোদয়_ভিডিও.mp4");
    assert.ok(bnTokens.includes("সকালের"));
    assert.ok(bnTokens.includes("সূর্যোদয়"));
    assert.ok(bnTokens.includes("ভিডিও"));
    console.log("[PASS] 4. Deterministic keyword normalization (EN / Hindi / Bengali)");
  }

  // 5. Deterministic scoring (bounded 0..100, audio assets excluded at score 0, honest explanation)
  {
    const sb = makeBaseStoryboard();
    const audioAsset = makeAsset({ id: "aud_1", name: "sunrise_desk_laptop.mp3", kind: "audio", mimeType: "audio/mpeg", duration: 30 });
    const audioScore = scoreAssetForScene(sb.scenes[0], sb.aspectRatio, audioAsset);
    assert.equal(audioScore.score, 0);
    assert.ok(audioScore.explanation.toLowerCase().includes("audio-only"));

    const strongVideo = makeAsset({
      id: "vid_1",
      name: "sunriseDeskLaptop.mp4",
      kind: "video",
      tags: ["sunrise", "desk"],
      width: 1920,
      height: 1080,
      duration: 12,
    });
    const strongScore = scoreAssetForScene(sb.scenes[0], sb.aspectRatio, strongVideo);
    assert.ok(strongScore.score >= 70 && strongScore.score <= 100);
    assert.ok(strongScore.explanation.includes("Matched metadata/filename tokens"));

    const weakImage = makeAsset({
      id: "img_weak",
      name: "random_mountain_snow.png",
      kind: "image",
      width: 1080,
      height: 1920,
      duration: 0,
    });
    const weakScore = scoreAssetForScene(sb.scenes[0], sb.aspectRatio, weakImage);
    assert.ok(weakScore.score < strongScore.score);
    assert.ok(weakScore.explanation.includes("No keyword/tag overlap"));
    console.log("[PASS] 5. Deterministic scoring & honest explanation");
  }

  // 6. autoMatchStoryboardScenes with overwriteManual: false preserves manually assigned scenes
  {
    const sb = makeBaseStoryboard();
    const manualAsset = makeAsset({ id: "manual_1", name: "custom_manual_intro.mp4", width: 1920, height: 1080, duration: 10 });
    const autoCandidate = makeAsset({ id: "auto_1", name: "sunrise_desk_laptop.mp4", width: 1920, height: 1080, duration: 10 });
    const codingCandidate = makeAsset({ id: "auto_2", name: "coding_developer_keyboard.mp4", width: 1920, height: 1080, duration: 10 });
    const waterCandidate = makeAsset({ id: "auto_3", name: "water_glass_notebook.jpg", kind: "image", mimeType: "image/jpeg", width: 1920, height: 1080, duration: 0 });

    sb.scenes[0] = {
      ...sb.scenes[0],
      mediaAssignment: createAssignmentFromAsset(sb.scenes[0], manualAsset, sb.aspectRatio, {
        mediaSource: "uploaded",
        matchExplanation: "Manually uploaded",
      }),
    };

    const result = autoMatchStoryboardScenes(sb, [manualAsset, autoCandidate, codingCandidate, waterCandidate], {
      overwriteManual: false,
      avoidDuplicates: true,
    });

    assert.equal(result.skippedCount, 1);
    assert.equal(result.matchedCount, 2);
    assert.equal(result.storyboard.scenes[0].mediaAssignment?.mediaAssetId, "manual_1");
    assert.equal(result.storyboard.scenes[1].mediaAssignment?.mediaAssetId, "auto_2");
    assert.equal(result.storyboard.scenes[2].mediaAssignment?.mediaAssetId, "auto_3");
    console.log("[PASS] 6. Auto-match preserves manual assignments when overwriteManual=false");
  }

  // 7. autoMatchStoryboardScenes with overwriteManual: true replaces existing assignments
  {
    const sb = makeBaseStoryboard();
    const manualAsset = makeAsset({ id: "manual_old", name: "unrelated_clip.mp4", width: 1920, height: 1080, duration: 10 });
    const betterAsset = makeAsset({ id: "better_1", name: "sunrise_desk_laptop.mp4", width: 1920, height: 1080, duration: 10 });
    const codingAsset = makeAsset({ id: "better_2", name: "coding_developer_keyboard.mp4", width: 1920, height: 1080, duration: 10 });
    const waterAsset = makeAsset({ id: "better_3", name: "water_glass_notebook.png", kind: "image", mimeType: "image/png", width: 1920, height: 1080, duration: 0 });

    sb.scenes[0] = {
      ...sb.scenes[0],
      mediaAssignment: createAssignmentFromAsset(sb.scenes[0], manualAsset, sb.aspectRatio),
    };

    const result = autoMatchStoryboardScenes(sb, [manualAsset, betterAsset, codingAsset, waterAsset], {
      overwriteManual: true,
      avoidDuplicates: true,
    });
    assert.equal(result.matchedCount, 3);
    assert.equal(result.storyboard.scenes[0].mediaAssignment?.mediaAssetId, "better_1");
    console.log("[PASS] 7. Auto-match replaces assignments when overwriteManual=true");
  }

  // 8. Duplicate avoidance (avoidDuplicates: true assigns distinct assets to separate scenes)
  {
    const sb = makeBaseStoryboard();
    const assetA = makeAsset({ id: "dup_a", name: "sunrise_desk_laptop_coding.mp4", width: 1920, height: 1080, duration: 10 });
    const assetB = makeAsset({ id: "dup_b", name: "developer_keyboard.mp4", width: 1920, height: 1080, duration: 10 });
    const assetC = makeAsset({ id: "dup_c", name: "water_glass_notebook.jpg", kind: "image", mimeType: "image/jpeg", width: 1920, height: 1080, duration: 0 });

    const res = autoMatchStoryboardScenes(sb, [assetA, assetB, assetC], { avoidDuplicates: true });
    const assignedIds = res.storyboard.scenes.map((s) => s.mediaAssignment?.mediaAssetId).filter(Boolean);
    assert.equal(assignedIds.length, 3);
    assert.equal(new Set(assignedIds).size, 3, "Each scene should receive a distinct asset when avoidDuplicates=true");
    console.log("[PASS] 8. Auto-match avoids duplicate assets across scenes");
  }

  // 9. minScore threshold leaves weak matches unassigned instead of forcing bad matches
  {
    const sb = makeBaseStoryboard();
    const completelyUnrelated = makeAsset({
      id: "unrel_1",
      name: "abstract_purple_space.png",
      kind: "image",
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      duration: 0,
    });
    const res = autoMatchStoryboardScenes(sb, [completelyUnrelated], { minScore: 60 });
    assert.equal(res.matchedCount, 0);
    assert.equal(res.unmatchedSceneIds.length, 3);
    assert.equal(res.storyboard.scenes[0].mediaAssignment, undefined);
    console.log("[PASS] 9. minScore threshold leaves weak matches unassigned");
  }

  // 10. AbortSignal cancellation stops auto-matching cleanly (cancelled: true)
  {
    const sb = makeBaseStoryboard();
    const assetA = makeAsset({ id: "a1", name: "sunrise_desk.mp4" });
    const controller = new AbortController();
    controller.abort();
    const res = autoMatchStoryboardScenes(sb, [assetA], { signal: controller.signal });
    assert.equal(res.cancelled, true);
    assert.equal(res.matchedCount, 0);
    console.log("[PASS] 10. AbortSignal stops auto-matching cleanly");
  }

  // 11. Scene reordering preserves mediaAssignment attached to moved scene IDs and recalculates startTime
  {
    const sb = makeBaseStoryboard();
    const a1 = makeAsset({ id: "a1", name: "sunrise_desk.mp4" });
    const a3 = makeAsset({ id: "a3", name: "water_glass.png", kind: "image", mimeType: "image/png", duration: 0 });
    sb.scenes[0] = { ...sb.scenes[0], mediaAssignment: createAssignmentFromAsset(sb.scenes[0], a1, sb.aspectRatio) };
    sb.scenes[2] = { ...sb.scenes[2], mediaAssignment: createAssignmentFromAsset(sb.scenes[2], a3, sb.aspectRatio) };

    const reordered = reorderStoryboardScenes(sb.scenes, 0, 2);
    assert.equal(reordered[0].id, "scene_2");
    assert.equal(reordered[0].startTime, 0);
    assert.equal(reordered[1].id, "scene_3");
    assert.equal(reordered[1].startTime, 5);
    assert.equal(reordered[1].mediaAssignment?.mediaAssetId, "a3");
    assert.equal(reordered[2].id, "scene_1");
    assert.equal(reordered[2].startTime, 10);
    assert.equal(reordered[2].mediaAssignment?.mediaAssetId, "a1");
    console.log("[PASS] 11. Scene reordering preserves media assignments and recalculates start times");
  }

  // 12. Clearing single slot / deleting scene preserves remaining assignments & shared asset pool
  {
    const sb = makeBaseStoryboard();
    const sharedPool = [
      makeAsset({ id: "shared_1", name: "sunrise.mp4" }),
      makeAsset({ id: "shared_2", name: "coding.mp4" }),
    ];
    sb.scenes[0] = { ...sb.scenes[0], mediaAssignment: createAssignmentFromAsset(sb.scenes[0], sharedPool[0], sb.aspectRatio) };
    sb.scenes[1] = { ...sb.scenes[1], mediaAssignment: createAssignmentFromAsset(sb.scenes[1], sharedPool[1], sb.aspectRatio) };

    // Clear scene 1 slot only
    const clearedScenes = sb.scenes.map((s) => (s.id === "scene_1" ? { ...s, mediaAssignment: undefined } : s));
    assert.equal(clearedScenes[0].mediaAssignment, undefined);
    assert.equal(clearedScenes[1].mediaAssignment?.mediaAssetId, "shared_2");
    assert.equal(sharedPool.length, 2, "Shared asset pool stays intact");

    // Delete scene 1
    const afterDelete = recalculateStoryboardTiming(clearedScenes.filter((s) => s.id !== "scene_1"));
    assert.equal(afterDelete.length, 2);
    assert.equal(afterDelete[0].id, "scene_2");
    assert.equal(afterDelete[0].startTime, 0);
    assert.equal(afterDelete[0].mediaAssignment?.mediaAssetId, "shared_2");
    console.log("[PASS] 12. Clearing slot or deleting scene keeps remaining assignments & shared assets intact");
  }

  // 13. Video duration validation (clampVideoSourceStartTime + warning when shorter without auto-mutating scene.duration)
  {
    const clampedShort = clampVideoSourceStartTime(4, 5, 3);
    assert.equal(clampedShort, 0, "Clip shorter than scene must clamp start time to 0");
    const clampedNormal = clampVideoSourceStartTime(12, 5, 10);
    assert.equal(clampedNormal, 5, "Start time must clamp to videoDuration - sceneDuration");

    const sb = makeBaseStoryboard();
    const shortVideo = makeAsset({ id: "short_v", name: "short.mp4", kind: "video", duration: 2.5, width: 1920, height: 1080 });
    sb.scenes[0] = {
      ...sb.scenes[0],
      duration: 5,
      mediaAssignment: createAssignmentFromAsset(sb.scenes[0], shortVideo, sb.aspectRatio),
    };
    const evalRes = evaluateSceneMediaReadiness(sb.scenes[0], sb, new Map([[shortVideo.id, shortVideo]]), true);
    assert.equal(evalRes.shorterThanScene, true);
    assert.equal(evalRes.effectivePlayableDuration, 2.5);
    assert.equal(sb.scenes[0].duration, 5, "scene.duration must never be auto-mutated");
    assert.ok(evalRes.warnings.some((w) => w.includes("shorter than scene duration")));
    console.log("[PASS] 13. Video sourceStartTime clamping & shorter-than-scene warning");
  }

  // 14. Aspect ratio mismatch detection (16:9 inside 9:16 / 1:1 recommends fit; matched recommends preserve)
  {
    const mismatchVertical = detectAspectRatioMismatch("9:16", 1920, 1080);
    assert.equal(mismatchVertical.isMismatch, true);
    assert.equal(mismatchVertical.recommendedHandling, "fit");

    const mismatchSquare = detectAspectRatioMismatch("1:1", 1920, 1080);
    assert.equal(mismatchSquare.isMismatch, true);
    assert.equal(mismatchSquare.recommendedHandling, "fit");

    const matched = detectAspectRatioMismatch("16:9", 1920, 1080);
    assert.equal(matched.isMismatch, false);
    assert.equal(matched.recommendedHandling, "preserve");
    console.log("[PASS] 14. Aspect ratio mismatch detection & framing recommendation");
  }

  // 15. Missing/invalid asset readiness evaluation & computeStoryboardMediaSummary
  {
    const sb = makeBaseStoryboard();
    const validImg = makeAsset({ id: "ok_img", name: "water.png", kind: "image", mimeType: "image/png", width: 1280, height: 720, duration: 0 });
    const zeroDimImg = makeAsset({ id: "bad_dim", name: "corrupt.png", kind: "image", mimeType: "image/png", width: 0, height: 720, duration: 0 });
    const audioOnly = makeAsset({ id: "aud_only", name: "voice.mp3", kind: "audio", mimeType: "audio/mpeg", duration: 6 });

    sb.scenes[0] = {
      ...sb.scenes[0],
      mediaAssignment: createAssignmentFromAsset(sb.scenes[0], validImg, sb.aspectRatio),
    };
    sb.scenes[1] = {
      ...sb.scenes[1],
      mediaAssignment: {
        sceneId: "scene_2",
        mediaAssetId: "missing_idb_id",
        mediaType: "video",
        mediaSource: "uploaded",
        assetTitle: "gone_from_idb.mp4",
        mimeType: "video/mp4",
        assignmentStatus: "assigned",
        sourceStartTime: 0,
        aspectRatioHandling: "fit",
        assignedAt: "2026-11-25T10:00:00.000Z",
      },
    };
    sb.scenes[2] = {
      ...sb.scenes[2],
      mediaAssignment: {
        sceneId: "scene_3",
        mediaAssetId: "aud_only",
        mediaType: "image",
        mediaSource: "uploaded",
        assetTitle: "voice.mp3",
        mimeType: "audio/mpeg",
        assignmentStatus: "assigned",
        sourceStartTime: 0,
        aspectRatioHandling: "fit",
        assignedAt: "2026-11-25T10:00:00.000Z",
      },
    };

    const map = new Map<string, MediaAsset>([
      [validImg.id, validImg],
      [zeroDimImg.id, zeroDimImg],
      [audioOnly.id, audioOnly],
    ]);

    // While IndexedDB is hydrating (isStorageReady=false), missing asset reports matching
    const hydratingEval = evaluateSceneMediaReadiness(sb.scenes[1], sb, map, false);
    assert.equal(hydratingEval.status, "matching");

    // After IndexedDB finishes hydrating (isStorageReady=true), missing asset reports missing
    const missingEval = evaluateSceneMediaReadiness(sb.scenes[1], sb, map, true);
    assert.equal(missingEval.status, "missing");
    assert.equal(missingEval.isMissing, true);

    // Audio asset & zero-dim asset report invalid
    assert.equal(evaluateSceneMediaReadiness(sb.scenes[2], sb, map, true).status, "invalid");
    const zeroEval = evaluateSceneMediaReadiness(
      {
        ...sb.scenes[0],
        mediaAssignment: { ...sb.scenes[0].mediaAssignment!, mediaAssetId: "bad_dim" },
      },
      sb,
      map,
      true
    );
    assert.equal(zeroEval.status, "invalid");

    const summary = computeStoryboardMediaSummary(sb, [validImg, zeroDimImg, audioOnly], true);
    assert.equal(summary.readyCount, 1);
    assert.equal(summary.missingOrInvalidCount, 2);
    assert.equal(summary.overallStatus, "missing");
    assert.equal(summary.isMediaReady, false);

    // When all 3 scenes have valid assignments + valid timing -> isMediaReady: true
    const readySb = makeBaseStoryboard();
    const v1 = makeAsset({ id: "r1", name: "r1.mp4", duration: 6, width: 1280, height: 720 });
    const v2 = makeAsset({ id: "r2", name: "r2.mp4", duration: 6, width: 1280, height: 720 });
    readySb.scenes[0] = { ...readySb.scenes[0], mediaAssignment: createAssignmentFromAsset(readySb.scenes[0], v1, "16:9") };
    readySb.scenes[1] = { ...readySb.scenes[1], mediaAssignment: createAssignmentFromAsset(readySb.scenes[1], v2, "16:9") };
    readySb.scenes[2] = { ...readySb.scenes[2], mediaAssignment: createAssignmentFromAsset(readySb.scenes[2], validImg, "16:9") };
    const readySummary = computeStoryboardMediaSummary(readySb, [v1, v2, validImg], true);
    assert.equal(readySummary.isMediaReady, true);
    assert.equal(readySummary.progressPercent, 100);
    console.log("[PASS] 15. Missing/invalid/hydrating readiness checks & summary computation");
  }

  // 16. Duplicate file detection & storyboard asset reference lookup
  {
    const existing = [
      makeAsset({ id: "dup_target", name: "HeroClip.mp4", sizeBytes: 4096 }),
      makeAsset({ id: "other_asset", name: "Logo.png", kind: "image", mimeType: "image/png", sizeBytes: 512, duration: 0 }),
    ];
    const foundDup = findDuplicateMediaAsset({ name: "heroclip.mp4", size: 4096, type: "video/mp4" }, existing);
    assert.equal(foundDup?.id, "dup_target");
    const notDup = findDuplicateMediaAsset({ name: "heroclip.mp4", size: 8192, type: "video/mp4" }, existing);
    assert.equal(notDup, null);

    const sb1 = makeBaseStoryboard({ id: "sb_ref_1" });
    sb1.scenes[0] = { ...sb1.scenes[0], mediaAssignment: createAssignmentFromAsset(sb1.scenes[0], existing[0], "16:9") };
    const sb2 = makeBaseStoryboard({ id: "sb_ref_2" });
    const refs = findStoryboardsUsingAsset("dup_target", [sb1, sb2]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, "sb_ref_1");
    console.log("[PASS] 16. Duplicate file detection & storyboard asset usage lookup");
  }

  // 17. GeneratedSlideConfigSchema & slide helpers (English, Hindi, Bengali + dimensions + text wrap)
  {
    assert.deepEqual(ASPECT_RATIO_SLIDE_DIMENSIONS["16:9"], { width: 1280, height: 720 });
    assert.deepEqual(ASPECT_RATIO_SLIDE_DIMENSIONS["9:16"], { width: 720, height: 1280 });
    assert.deepEqual(ASPECT_RATIO_SLIDE_DIMENSIONS["1:1"], { width: 1080, height: 1080 });

    const hiSlide = GeneratedSlideConfigSchema.safeParse({
      template: "educational",
      headingText: "सुबह की उत्पादकता",
      bodyText: "हर दिन ४० मिनट गहन कार्य करें।",
      footerText: "अध्याय 1",
      backgroundColor: "#0F0C1D",
      gradientColor: "#1E1638",
      useGradient: true,
      textColor: "#F8FAFC",
      textAlign: "center",
      fontSize: 56,
      aspectRatio: "16:9",
      language: "Hindi",
    });
    assert.equal(hiSlide.success, true);

    const bnSlide = GeneratedSlideConfigSchema.safeParse({
      template: "title",
      headingText: "বাংলা স্লাইড শিরোনাম",
      bodyText: "সহজ ও স্পষ্ট উপস্থাপনা।",
      backgroundColor: "#081C15",
      textColor: "#ECFDF5",
      textAlign: "center",
      fontSize: 52,
      aspectRatio: "9:16",
      language: "Bengali",
    });
    assert.equal(bnSlide.success, true);

    assert.equal(
      GeneratedSlideConfigSchema.safeParse({
        template: "title",
        headingText: "   ",
        backgroundColor: "#0F0C1D",
        textColor: "#F8FAFC",
        textAlign: "center",
        fontSize: 56,
        aspectRatio: "16:9",
        language: "English",
      }).success,
      false,
      "Empty slide heading must be rejected"
    );
    assert.equal(
      GeneratedSlideConfigSchema.safeParse({
        template: "title",
        headingText: "Valid",
        backgroundColor: "red",
        textColor: "#F8FAFC",
        textAlign: "center",
        fontSize: 56,
        aspectRatio: "16:9",
        language: "English",
      }).success,
      false,
      "Non-hex color must be rejected"
    );

    assert.ok(getSlideFontFamily("Hindi").includes("Noto Sans Devanagari"));
    assert.ok(getSlideFontFamily("Bengali").includes("Noto Sans Bengali"));
    // In Node (no browser DOM), checkLanguageFontSupport honestly reports non-English browser verification note
    const nodeFontCheck = checkLanguageFontSupport("Bengali");
    assert.equal(nodeFontCheck.supported, false);
    assert.ok(nodeFontCheck.warning?.includes("browser runtime"));

    const wrapped = wrapCanvasTextLines((s) => s.length * 10, "One two three four five", 90);
    assert.ok(wrapped.length >= 2);
    console.log("[PASS] 17. Generated slide schema, EN/HI/BN fonts & wrap helpers (Node canvas boundary noted)");
  }

  // 18. Stock media disabled by default (STOCK_MEDIA_PROVIDER=none)
  {
    const status = getStockMediaStatus({ STOCK_MEDIA_PROVIDER: "none" } as unknown as NodeJS.ProcessEnv);
    assert.equal(status.enabled, false);
    assert.equal(status.provider, "none");

    await assert.rejects(
      () =>
        searchStockMedia(
          { query: "ocean", mediaType: "video" },
          { env: { STOCK_MEDIA_PROVIDER: "none" } as unknown as NodeJS.ProcessEnv }
        ),
      (err: { statusCode?: number }) => err.statusCode === 503
    );
    console.log("[PASS] 18. Stock media disabled by default with honest 503");
  }

  // 19. Stock media pexels without PEXELS_API_KEY returns enabled=false & 503
  {
    const status = getStockMediaStatus({
      STOCK_MEDIA_PROVIDER: "pexels",
      PEXELS_API_KEY: "",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(status.enabled, false);
    assert.equal(status.provider, "pexels");

    await assert.rejects(
      () =>
        searchStockMedia(
          { query: "sunrise", mediaType: "image" },
          { env: { STOCK_MEDIA_PROVIDER: "pexels", PEXELS_API_KEY: "" } as unknown as NodeJS.ProcessEnv }
        ),
      (err: { statusCode?: number }) => err.statusCode === 503
    );
    console.log("[PASS] 19. Pexels without PEXELS_API_KEY stays disabled (503)");
  }

  // 20. Mocked Pexels search response normalization (photos + videos, creator attribution & URLs)
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const mockFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1/search")) {
        return new Response(
          JSON.stringify({
            photos: [
              {
                id: 101,
                width: 1920,
                height: 1280,
                url: "https://www.pexels.com/photo/morning-coffee-101/",
                photographer: "Aarav Sen",
                alt: "Morning Coffee Desk",
                src: { medium: "https://images.pexels.com/photos/101/medium.jpg" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          videos: [
            {
              id: 202,
              width: 1280,
              height: 720,
              duration: 9,
              url: "https://www.pexels.com/video/coding-desk-202/",
              image: "https://images.pexels.com/videos/202/thumb.jpg",
              user: { name: "Riya Das" },
              video_files: [{ quality: "hd", file_type: "video/mp4", width: 1280, height: 720, link: "https://videos.pexels.com/202.mp4" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const env = { STOCK_MEDIA_PROVIDER: "pexels", PEXELS_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;
    const provider = new PexelsStockMediaProvider("test-key", { fetchImpl: mockFetch, dnsLookup: publicDns, env });
    const photosRes = await searchStockMedia({ query: "coffee", mediaType: "image", aspectRatio: "16:9" }, { provider, env });
    assert.equal(photosRes.items.length, 1);
    assert.equal(photosRes.items[0].creatorName, "Aarav Sen");
    assert.equal(photosRes.items[0].attributionUrl, "https://www.pexels.com/photo/morning-coffee-101/");

    const videosRes = await searchStockMedia({ query: "coding", mediaType: "video", aspectRatio: "16:9" }, { provider, env });
    assert.equal(videosRes.items.length, 1);
    assert.equal(videosRes.items[0].creatorName, "Riya Das");
    assert.equal(videosRes.items[0].duration, 9);
    console.log("[PASS] 20. Mocked Pexels photo + video search normalization");
  }

  // 21. Mocked Pexels import parsing + magic-byte validation (JPEG FF D8 FF & MP4 ftypmp42)
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

    const mockFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1/photos/101")) {
        return new Response(
          JSON.stringify({
            id: 101,
            width: 1280,
            height: 720,
            url: "https://www.pexels.com/photo/101/",
            photographer: "Aarav",
            alt: "Sunrise Desk",
            src: { large: "https://images.pexels.com/photos/101/large.jpg" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/videos/videos/202")) {
        return new Response(
          JSON.stringify({
            id: 202,
            width: 1280,
            height: 720,
            duration: 7,
            url: "https://www.pexels.com/video/202/",
            user: { name: "Riya" },
            video_files: [{ file_type: "video/mp4", width: 1280, height: 720, link: "https://videos.pexels.com/202.mp4" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("large.jpg")) {
        return new Response(jpegBytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      return new Response(mp4Bytes, { status: 200, headers: { "Content-Type": "video/mp4" } });
    }) as typeof fetch;

    const env = { STOCK_MEDIA_PROVIDER: "pexels", PEXELS_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;
    const imgImport = await importStockMediaAsset(
      { provider: "pexels", providerAssetId: "101", mediaType: "image" },
      { fetchImpl: mockFetch, dnsLookup: publicDns, env }
    );
    assert.equal(imgImport.mimeType, "image/jpeg");
    assert.equal(imgImport.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), true);

    const vidImport = await importStockMediaAsset(
      { provider: "pexels", providerAssetId: "202", mediaType: "video" },
      { fetchImpl: mockFetch, dnsLookup: publicDns, env }
    );
    assert.equal(vidImport.mimeType, "video/mp4");
    assert.equal(vidImport.creatorName, "Riya");
    console.log("[PASS] 21. Mocked Pexels JPEG & MP4 import with magic-byte validation");
  }

  // 22. SSRF URL & DNS blocklist verification
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const blockedUrls = [
      "http://api.pexels.com/v1/search",
      "file:///etc/passwd",
      "https://user:pass@api.pexels.com/v1/search",
      "https://localhost/v1/search",
      "https://127.0.0.1/v1/search",
      "https://10.0.0.5/photo.jpg",
      "https://172.16.0.1/photo.jpg",
      "https://192.168.1.10/photo.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/photo.jpg",
      "https://[fe80::1]/photo.jpg",
      "https://evil.example.com/photo.jpg",
    ];
    for (const url of blockedUrls) {
      await assert.rejects(
        () => validateStockRemoteUrl(url, { dnsLookup: publicDns }),
        (err: { statusCode?: number }) => err.statusCode === 403 || err.statusCode === 400,
        `Must block SSRF URL: ${url}`
      );
    }

    const privateResolvedIps = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.5",
      "192.168.0.10",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ];
    for (const ip of privateResolvedIps) {
      assert.equal(isPrivateOrLoopbackIp(ip), true, `IP ${ip} must be classified private/loopback`);
      await assert.rejects(
        () =>
          validateStockRemoteUrl("https://api.pexels.com/v1/search", {
            dnsLookup: async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }],
          }),
        (err: { statusCode?: number }) => err.statusCode === 403
      );
    }
    console.log("[PASS] 22. SSRF URL, IP literal, and DNS private-IP resolution blocking");
  }

  // 23. SSRF redirect protection (disallowed target 403 & redirect loop 502)
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const env = { STOCK_MEDIA_PROVIDER: "pexels", PEXELS_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

    const redirectToInternalFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        searchStockMedia(
          { query: "test", mediaType: "image" },
          { fetchImpl: redirectToInternalFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 403
    );

    const redirectLoopFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://api.pexels.com/v1/search?hop=1" },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        searchStockMedia(
          { query: "test", mediaType: "image" },
          { fetchImpl: redirectLoopFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 502
    );
    console.log("[PASS] 23. SSRF redirect target blocking (403) and redirect loop cap (502)");
  }

  // 24. Bounded streaming byte limit (STOCK_MEDIA_MAX_IMPORT_MB=5 -> rejects oversized Content-Length and chunked stream with 413)
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const env = {
      STOCK_MEDIA_PROVIDER: "pexels",
      PEXELS_API_KEY: "test-key",
      STOCK_MEDIA_MAX_IMPORT_MB: "5",
    } as unknown as NodeJS.ProcessEnv;

    const mockMetadataFetch = (url: string) => {
      if (url.includes("/v1/photos/303")) {
        return new Response(
          JSON.stringify({
            id: 303,
            width: 1280,
            height: 720,
            url: "https://www.pexels.com/photo/303/",
            src: { large: "https://images.pexels.com/photos/303/huge.jpg" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return null;
    };

    // 24a: Declared Content-Length > 5 MB
    const oversizedHeaderFetch = (async (input: string | URL) => {
      const meta = mockMetadataFetch(String(input));
      if (meta) return meta;
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Content-Length": String(6 * 1024 * 1024) },
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        importStockMediaAsset(
          { provider: "pexels", providerAssetId: "303", mediaType: "image" },
          { fetchImpl: oversizedHeaderFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 413
    );

    // 24b: Chunked stream without Content-Length exceeding 5 MB
    const chunkedOversizedFetch = (async (input: string | URL) => {
      const meta = mockMetadataFetch(String(input));
      if (meta) return meta;
      const chunk = new Uint8Array(1024 * 1024);
      chunk[0] = 0xff;
      chunk[1] = 0xd8;
      chunk[2] = 0xff;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 6) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        importStockMediaAsset(
          { provider: "pexels", providerAssetId: "303", mediaType: "image" },
          { fetchImpl: chunkedOversizedFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 413
    );
    console.log("[PASS] 24. Bounded streaming byte limit (Content-Length & chunked stream -> 413)");
  }

  // 25. Magic-byte spoofing rejection (HTML/text claiming image/jpeg or video/mp4 -> 422)
  {
    const publicDns = async () => [{ address: "104.16.1.1", family: 4 }];
    const env = { STOCK_MEDIA_PROVIDER: "pexels", PEXELS_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

    const spoofFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1/photos/404")) {
        return new Response(
          JSON.stringify({
            id: 404,
            width: 1280,
            height: 720,
            url: "https://www.pexels.com/photo/404/",
            src: { large: "https://images.pexels.com/photos/404/spoof.jpg" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/videos/videos/505")) {
        return new Response(
          JSON.stringify({
            id: 505,
            width: 1280,
            height: 720,
            duration: 5,
            url: "https://www.pexels.com/video/505/",
            video_files: [{ file_type: "video/mp4", width: 1280, height: 720, link: "https://videos.pexels.com/505/spoof.mp4" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("<html><body>Not a real media file</body></html>", {
        status: 200,
        headers: {
          "Content-Type": url.includes(".mp4") ? "video/mp4" : "image/jpeg",
        },
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        importStockMediaAsset(
          { provider: "pexels", providerAssetId: "404", mediaType: "image" },
          { fetchImpl: spoofFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 422
    );

    await assert.rejects(
      () =>
        importStockMediaAsset(
          { provider: "pexels", providerAssetId: "505", mediaType: "video" },
          { fetchImpl: spoofFetch, dnsLookup: publicDns, env }
        ),
      (err: { statusCode?: number }) => err.statusCode === 422
    );
    console.log("[PASS] 25. Magic-byte spoofing rejection (422)");
  }

  // 26. HTTP route & SSR verification (auth 401, /integrations/status, CSRF/validation, StoryboardReviewPanel & MediaLibraryPage SSR)
  {
    const userId = new mongoose.Types.ObjectId().toString();
    const jwtSecret = "test-phase552-jwt-secret-key-32-chars";
    const prevJwt = process.env.JWT_SECRET;
    const prevMongo = process.env.MONGODB_URI;
    const prevProvider = process.env.STOCK_MEDIA_PROVIDER;
    const prevPexels = process.env.PEXELS_API_KEY;
    const connObj = mongoose.connection as unknown as { readyState: number };
    const prevReadyState = connObj.readyState;
    const origFindById = UserModel.findById;
    const origDraftFind = StoryboardDraftModel.find;
    const origFetch = globalThis.fetch;
    const origDnsLookup = dns.lookup;

    process.env.JWT_SECRET = jwtSecret;
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/verify_phase552";
    process.env.STOCK_MEDIA_PROVIDER = "none";
    delete process.env.PEXELS_API_KEY;
    connObj.readyState = 1;

    UserModel.findById = ((id: string) => {
      if (String(id) === userId) {
        return Promise.resolve({
          _id: new mongoose.Types.ObjectId(userId),
          fullName: "Phase 5.5.2 Tester",
          email: "tester552@example.com",
        });
      }
      return Promise.resolve(null);
    }) as unknown as typeof UserModel.findById;

    StoryboardDraftModel.find = (() => ({
      sort: () => ({ limit: async () => [] }),
    })) as unknown as typeof StoryboardDraftModel.find;

    const app = express();
    app.use(cookieParser());
    app.use(express.json({ limit: "2mb" }));
    app.use(sanitizeRequestInputMiddleware);
    app.use("/api", csrfProtectionMiddleware, apiRouter);
    app.use(sanitizedErrorHandler);

    const token = jwt.sign(
      { sub: userId, email: "tester552@example.com" },
      jwtSecret,
      { expiresIn: "1h" }
    );
    const cookieName = (process.env.AUTH_COOKIE_NAME || "ai_studio_token").trim() || "ai_studio_token";
    const cookie = `${cookieName}=${token}`;
    const { server, baseUrl } = await startTempServer(app);

    try {
      // Unauthenticated requests to all 3 stock endpoints must return 401
      const unauthStatus = await origFetch(`${baseUrl}/api/stock-media/status`);
      assert.equal(unauthStatus.status, 401);

      const unauthSearch = await origFetch(`${baseUrl}/api/stock-media/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "city", mediaType: "video" }),
      });
      assert.equal(unauthSearch.status, 401);

      const unauthImport = await origFetch(`${baseUrl}/api/stock-media/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "pexels", providerAssetId: "123", mediaType: "image" }),
      });
      assert.equal(unauthImport.status, 401);

      // /api/integrations/status exposes stockMedia key
      const intRes = await origFetch(`${baseUrl}/api/integrations/status`);
      assert.equal(intRes.status, 200);
      const intBody = (await intRes.json()) as {
        integrations: { stockMedia?: { id: string; connected: boolean } };
      };
      assert.equal(intBody.integrations.stockMedia?.id, "stockMedia");
      assert.equal(intBody.integrations.stockMedia?.connected, false);

      // Authenticated status + disabled 503 search + invalid Zod payload 400
      const authStatus = await origFetch(`${baseUrl}/api/stock-media/status`, {
        headers: { Cookie: cookie },
      });
      assert.equal(authStatus.status, 200);

      const badPayload = await origFetch(`${baseUrl}/api/stock-media/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
        body: JSON.stringify({ provider: "pexels", providerAssetId: "../bad!", mediaType: "image" }),
      });
      assert.equal(badPayload.status, 400);

      const disabledSearch = await origFetch(`${baseUrl}/api/stock-media/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
        body: JSON.stringify({ query: "sunrise", mediaType: "video" }),
      });
      assert.equal(disabledSearch.status, 503);

      // SSR smoke checks for AiGeneratorPage, MediaLibraryPage, and StoryboardReviewPanel
      const aiHtml = renderToString(
        React.createElement(StudioProvider, null, React.createElement(AiGeneratorPage))
      );
      assert.ok(aiHtml.includes("AI Script &amp; Storyboard Generator"));

      const mediaHtml = renderToString(
        React.createElement(StudioProvider, null, React.createElement(MediaLibraryPage))
      );
      assert.ok(mediaHtml.includes("Media Library"));

      const sb = makeBaseStoryboard();
      const asset = makeAsset({ id: "ssr_asset", name: "sunrise.mp4", duration: 8, width: 1280, height: 720 });
      sb.scenes[0] = {
        ...sb.scenes[0],
        mediaAssignment: createAssignmentFromAsset(sb.scenes[0], asset, "16:9", { matchScore: 90 }),
      };

      const panelHtml = renderToString(
        React.createElement(StoryboardReviewPanel, {
          storyboard: sb,
          mediaAssets: [asset],
          idbHydrating: false,
          onChange: () => undefined,
          onSaveDraft: () => undefined,
          onRegenerate: () => undefined,
          savingDraft: false,
          saveStatusMessage: null,
          saveError: null,
          regenerating: false,
          isAuthenticated: true,
        })
      );
      const normPanel = panelHtml.replace(/<!--\s*-->/g, "");
      assert.ok(normPanel.includes("Scene Media Preparation"));
      assert.ok(normPanel.includes("Auto Match Media"));
      assert.ok(normPanel.includes("Scene Breakdown (3)"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      connObj.readyState = prevReadyState;
      UserModel.findById = origFindById;
      StoryboardDraftModel.find = origDraftFind;
      globalThis.fetch = origFetch;
      void origDnsLookup;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
      if (prevMongo === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = prevMongo;
      if (prevProvider === undefined) delete process.env.STOCK_MEDIA_PROVIDER;
      else process.env.STOCK_MEDIA_PROVIDER = prevProvider;
      if (prevPexels === undefined) delete process.env.PEXELS_API_KEY;
      else process.env.PEXELS_API_KEY = prevPexels;
    }

    console.log("[PASS] 26. HTTP stock media routes (401/400/503/status) & SSR page/panel verification");
  }

  console.log("ALL_PHASE_552_VERIFICATIONS_PASSED");
}

runTests().catch((err) => {
  console.error("Phase 5.5.2 verification failed:", err);
  process.exit(1);
});
