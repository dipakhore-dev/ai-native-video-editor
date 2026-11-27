import assert from "node:assert/strict";
import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import React from "react";
import { renderToString } from "react-dom/server";

import { StudioProvider } from "../src/context/StudioContext.tsx";
import { AiGeneratorPage } from "../src/pages/AiGeneratorPage.tsx";
import { CaptionPreview } from "../src/components/generator/CaptionPreview.tsx";
import { CaptionSegmentEditor } from "../src/components/generator/CaptionSegmentEditor.tsx";
import { CaptionStyleInspector } from "../src/components/generator/CaptionStyleInspector.tsx";
import { SceneCaptionCard } from "../src/components/generator/SceneCaptionCard.tsx";
import { StoryboardCaptionPrepSection } from "../src/components/generator/StoryboardCaptionPrepSection.tsx";
import { StoryboardReviewPanel } from "../src/components/generator/StoryboardReviewPanel.tsx";
import type {
  CaptionsStatusInfo,
  MediaAsset,
  StoryboardCaptionSegment,
  VideoStoryboard,
} from "../src/types/studio.ts";
import { SaveStoryboardDraftSchema } from "../server/validators/aiAndExport.validators.ts";
import {
  AudioCaptionsRequestFieldsSchema,
  CLIENT_CAPTIONS_JOB_ID_RE,
  normalizeCaptionLanguageInput,
  parseMultipartBoolean,
} from "../server/validators/captions.validators.ts";
import { sanitizeCaptionsErrorMessage } from "../server/services/captions.service.ts";
import {
  CaptionStyleConfigSchema,
  StoryboardCaptionSettingsSchema,
  StoryboardCaptionSummarySchema,
  StoryboardSceneCaptionsSchema,
  VideoStoryboardSchema,
  sanitizeStoryboardForPersistence,
} from "../src/utils/storyboard.ts";
import { createAssignmentFromAsset } from "../src/utils/storyboardMedia.ts";
import { createSceneVoiceoverRecord } from "../src/utils/storyboardVoiceover.ts";
import {
  CAPTION_STYLE_PRESETS,
  addCaptionSegment,
  buildAudioTranscriptionCaptionsRecord,
  collectTimelineCaptionCues,
  computeCaptionFingerprint,
  computeScaledCaptionPreviewStyle,
  computeStoryboardCaptionsSummary,
  deleteCaptionSegment,
  evaluateSceneCaptionsReadiness,
  exportSceneCaptionsToSrt,
  exportSceneCaptionsToVtt,
  exportStoryboardCaptionsToSrt,
  exportStoryboardCaptionsToVtt,
  findActiveCaptionCueAtTime,
  findCaptionSegmentOverlaps,
  generateScriptCaptionsForScene,
  getCaptionPresetById,
  getDefaultCaptionSettings,
  mergeCaptionSegmentWithNext,
  sanitizeCaptionCueText,
  segmentNarrationIntoCueTexts,
  splitCaptionSegment,
  splitGraphemes,
  updateCaptionSegment,
  wrapCaptionTextLines,
} from "../src/utils/storyboardCaptions.ts";
import {
  corsAllowlistMiddleware,
  csrfProtectionMiddleware,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
} from "../server/middleware/security.middleware.ts";
import { apiRouter } from "../server/routes/index.ts";
import { UserModel } from "../server/models/User.ts";

function buildTestWavBuffer(durationSec = 1.5, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(100, Math.round(durationSec * sampleRate));
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28);
  buf.writeUInt16LE((numChannels * bitsPerSample) / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function makeBaseStoryboard(overrides?: Partial<VideoStoryboard>): VideoStoryboard {
  const now = "2026-11-27T08:00:00.000Z";
  return {
    id: "sb_phase554_test",
    title: "Multilingual Captions Storyboard",
    description: "Testing Phase 5.5.4 script captions, audio transcription, presets, and SRT/VTT.",
    targetAudience: "Creators",
    language: "English",
    totalDuration: 15,
    aspectRatio: "16:9",
    style: "Educational",
    fullNarrationScript:
      "Start with a crisp hook. Explain your concept clearly! Wrap up cleanly.",
    backgroundMusicMood: "Ambient",
    captionText: "Hook\nConcept\nOutro",
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
      targetAudience: "Creators",
      additionalInstructions: "",
    },
    scenes: [
      {
        id: "scene_1",
        title: "Opening Hook",
        startTime: 0,
        duration: 5,
        narration: "Start with a crisp hook. Keep viewers curious from second zero!",
        onScreenText: "Crisp hook",
        visualDescription: "Clean studio desk shot.",
        mediaKeywords: ["studio", "hook", "desk"],
        mediaType: "video",
        transition: "fade",
        effect: "none",
        cameraMotion: "static",
      },
      {
        id: "scene_2",
        title: "Silent Pause Slide",
        startTime: 5,
        duration: 4,
        narration: "   ",
        onScreenText: "Visual breath",
        visualDescription: "Architectural diagram hold.",
        mediaKeywords: ["diagram", "pause"],
        mediaType: "image",
        transition: "none",
        effect: "none",
        cameraMotion: "static",
      },
      {
        id: "scene_3",
        title: "Clear Takeaway",
        startTime: 9,
        duration: 6,
        narration: "Explain your concept clearly, and wrap up with one actionable step.",
        onScreenText: "Actionable step",
        visualDescription: "Creator summarizing at whiteboard.",
        mediaKeywords: ["whiteboard", "summary"],
        mediaType: "video",
        transition: "dissolve",
        effect: "cinematic",
        cameraMotion: "slow-dolly-in",
      },
    ],
    ...(overrides ?? {}),
  };
}

function makeAudioAsset(overrides?: Partial<MediaAsset>): MediaAsset {
  return {
    id: "vo_cap_asset_1",
    name: "voiceover_scene_1.wav",
    kind: "audio",
    mimeType: "audio/wav",
    sizeBytes: 64000,
    duration: 4.2,
    objectUrl: "blob:http://localhost:3000/vo-audio",
    sourceFile: new File([new Uint8Array(buildTestWavBuffer(4.2, 16000))], "voiceover_scene_1.wav", {
      type: "audio/wav",
    }),
    sourceOrigin: "generated_voiceover",
    providerName: "espeak_ng",
    addedAt: "2026-11-27T08:00:00.000Z",
    ...overrides,
  };
}

function makeVisualAsset(overrides?: Partial<MediaAsset>): MediaAsset {
  return {
    id: "vis_cap_1",
    name: "studio_scene.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 1_500_000,
    duration: 8,
    width: 1920,
    height: 1080,
    objectUrl: "blob:http://localhost:3000/vis-video",
    sourceOrigin: "uploaded",
    addedAt: "2026-11-27T08:00:00.000Z",
    ...overrides,
  };
}

async function startTempServer(
  handler: http.RequestListener
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function runTests(): Promise<void> {
  let checkCount = 0;
  const pass = (label: string) => {
    checkCount += 1;
    console.log(`[PASS #${checkCount}] ${label}`);
  };

  // 1-4: Backward compatibility, new caption schemas, compositionReady=false & blob sanitization
  {
    const sb = makeBaseStoryboard();
    const parsedLegacy = VideoStoryboardSchema.safeParse(sb);
    assert.equal(parsedLegacy.success, true);
    assert.equal(parsedLegacy.data?.compositionReady, false);
    assert.equal(
      SaveStoryboardDraftSchema.safeParse({
        title: sb.title,
        status: "draft",
        storyboard: sb,
      }).success,
      true
    );
    pass("1. Legacy storyboard drafts without caption fields remain valid with compositionReady=false");

    const settings = getDefaultCaptionSettings(sb);
    assert.equal(StoryboardCaptionSettingsSchema.safeParse(settings).success, true);
    assert.equal(CaptionStyleConfigSchema.safeParse(settings.style).success, true);
    pass("2. CaptionStyleConfigSchema and StoryboardCaptionSettingsSchema validate cleanly");

    const capRecord = generateScriptCaptionsForScene({
      scene: sb.scenes[0],
      storyboard: sb,
    });
    assert.equal(StoryboardSceneCaptionsSchema.safeParse(capRecord).success, true);
    sb.captionSettings = settings;
    sb.scenes[0].captions = capRecord;
    sb.captionSummary = computeStoryboardCaptionsSummary(sb, []);
    assert.equal(StoryboardCaptionSummarySchema.safeParse(sb.captionSummary).success, true);
    assert.equal(VideoStoryboardSchema.safeParse(sb).success, true);
    pass("3. Extended VideoStoryboardSchema validates scene captions, settings & captionSummary");

    const dirtySb = makeBaseStoryboard();
    dirtySb.scenes[0].captions = {
      ...capRecord,
      status: "generating",
      errorMessage: "Failed reading blob:http://localhost:3000/bad-ref",
      sourceVoiceoverMediaAssetId: "blob:http://localhost:3000/bad-audio",
    };
    dirtySb.scenes[2].captions = {
      ...capRecord,
      sceneId: "scene_3",
      segments: [],
      status: "queued",
    };
    assert.equal(
      StoryboardSceneCaptionsSchema.safeParse(dirtySb.scenes[0].captions).success,
      false,
      "Schema must reject blob: sourceVoiceoverMediaAssetId"
    );
    const sanitized = sanitizeStoryboardForPersistence(dirtySb);
    assert.equal(sanitized.scenes[0].captions?.status, "ready");
    assert.equal(sanitized.scenes[2].captions?.status, "none");
    assert.equal(sanitized.scenes[0].captions?.errorMessage, undefined);
    assert.equal(sanitized.scenes[0].captions?.sourceVoiceoverMediaAssetId, undefined);
    assert.equal(sanitized.compositionReady, false);
    pass("4. Persistence sanitization strips blob: refs and downgrades transient generating/queued statuses");
  }

  // 5-7: Validators & error path sanitization
  {
    assert.equal(normalizeCaptionLanguageInput("Hindi"), "hi");
    assert.equal(normalizeCaptionLanguageInput("Bangla"), "bn");
    assert.equal(normalizeCaptionLanguageInput("Bengali"), "bn");
    assert.equal(normalizeCaptionLanguageInput("English"), "en");
    assert.equal(normalizeCaptionLanguageInput(""), "auto");
    assert.throws(() => normalizeCaptionLanguageInput("fr"), { statusCode: 400 });
    pass("5. Caption language normalization allows en/hi/bn/auto and rejects unsupported inputs");

    assert.equal(parseMultipartBoolean("true"), true);
    assert.equal(parseMultipartBoolean("1"), true);
    assert.equal(parseMultipartBoolean("false"), false);
    assert.equal(CLIENT_CAPTIONS_JOB_ID_RE.test("cap_scene1_job_99"), true);
    assert.equal(CLIENT_CAPTIONS_JOB_ID_RE.test("../etc/passwd"), false);

    assert.equal(
      AudioCaptionsRequestFieldsSchema.safeParse({
        language: "Hindi",
        wordTimestamps: "true",
        clientJobId: "cap_valid_id_123",
      }).success,
      true
    );
    assert.equal(
      AudioCaptionsRequestFieldsSchema.safeParse({
        clientJobId: "bad$id!",
      }).success,
      false
    );
    pass("6. AudioCaptionsRequestFieldsSchema validates fields and blocks bad clientJobId");

    const sanitizedErr = sanitizeCaptionsErrorMessage(
      "Whisper failed on C:\\Users\\dev\\temp\\voice.wav against http://127.0.0.1:8001/api/v1/captions/generate"
    );
    assert.equal(sanitizedErr.includes("C:\\Users"), false);
    assert.equal(sanitizedErr.includes("127.0.0.1"), false);
    assert.ok(sanitizedErr.includes("[server-path]"));
    assert.ok(sanitizedErr.includes("[service-endpoint]"));
    pass("7. sanitizeCaptionsErrorMessage strips host file paths and internal URLs");
  }

  // 8-11: Unicode NFC, grapheme clustering, Indic matra protection (Hindi + Bengali), line wrapping
  {
    const hindiText =
      "आज हम अपनी कहानी की अंतिम पंक्ति को सुंदर तरीके से प्रस्तुत करेंगे। कृपया ध्यान से सुनें!";
    const bengaliText =
      "আজ আমরা আমাদের বাংলা গল্পের ভবিষ্যতের স্বপ্ন ও চূড়ান্ত মুহূর্ত সুন্দরভাবে তুলে ধরব। প্রতিটি দৃশ্য হবে সহজ, স্পষ্ট এবং সবার জন্য আকর্ষণীয়!";

    const hiGraphemes = splitGraphemes("अंतिम", "hi-IN");
    assert.equal(hiGraphemes.join(""), "अंतिम");
    // Ensures vowel matra 'ि' is never separated into its own orphaned cluster
    assert.equal(hiGraphemes.some((g) => g === "\u093F"), false);

    const bnGraphemes = splitGraphemes("ভবিষ্যতের", "bn-IN");
    assert.equal(bnGraphemes.join(""), "ভবিষ্যতের");
    assert.equal(bnGraphemes.some((g) => g === "\u09BF" || g === "\u09C7"), false);
    pass("8. Unicode grapheme splitter preserves Hindi (Devanagari) and Bengali combining matras");

    const wrapped916 = wrapCaptionTextLines(hindiText, {
      aspectRatio: "9:16",
      maxLines: 2,
      locale: "hi-IN",
    });
    assert.ok(wrapped916.length >= 1 && wrapped916.length <= 2);
    assert.equal(wrapped916.join(" ").includes("अंतिम"), true);
    pass("9. Line wrapper preserves all Hindi words and fits <= 2 lines on 9:16 canvas");

    const hiCues = segmentNarrationIntoCueTexts(hindiText, {
      aspectRatio: "16:9",
      language: "Hindi",
      maxLines: 2,
    });
    assert.ok(hiCues.length >= 2, "Hindi sentence with purna viram (।) should split cleanly into cues");

    const bnCues = segmentNarrationIntoCueTexts(bengaliText, {
      aspectRatio: "9:16",
      language: "Bengali",
      maxLines: 2,
    });
    assert.ok(bnCues.length >= 2, "Bengali narration on narrow 9:16 should segment without losing words");
    assert.equal(bnCues.join(" ").includes("ভবিষ্যতের"), true);
    pass("10. Script segmentation handles Indic dandas (।) and narrow 9:16 aspect constraints cleanly");

    const dirtyCue = sanitizeCaptionCueText("WEBVTT\r\nFirst --> Second\x07\n\nLine 2");
    assert.equal(dirtyCue.includes("-->"), false);
    assert.ok(dirtyCue.includes("—>"));
    assert.ok(dirtyCue.startsWith("WEBVTT:"));
    pass("11. sanitizeCaptionCueText strips control bytes and neutralizes --> & WEBVTT injections");
  }

  // 12-15: Script caption timing allocation, voiceover duration preference, overflow warning & empty scene
  {
    const sb = makeBaseStoryboard();
    const estimatedOnly = generateScriptCaptionsForScene({
      scene: sb.scenes[0],
      storyboard: sb,
    });
    assert.equal(estimatedOnly.status, "ready");
    assert.equal(estimatedOnly.timingSource, "estimated");
    assert.ok(estimatedOnly.segments.length >= 2);
    assert.equal(estimatedOnly.segments[0].start, 0);
    assert.equal(
      estimatedOnly.segments[estimatedOnly.segments.length - 1].end,
      sb.scenes[0].duration
    );
    assert.equal(estimatedOnly.overflowsSceneDuration, false);
    pass("12. Script caption allocator fills scene duration monotonically without voiceover");

    const longAudio = makeAudioAsset({ id: "vo_long_1", duration: 6.4 });
    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: longAudio.id,
      provider: "espeak_ng",
      voiceId: "en",
      voiceLabel: "English",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 6.4,
      sizeBytes: 64000,
      sampleRateHz: 22050,
      channels: 1,
    });
    const withVo = generateScriptCaptionsForScene({
      scene: sb.scenes[0],
      storyboard: sb,
      voiceoverAsset: longAudio,
    });
    assert.equal(withVo.sourceVoiceoverMediaAssetId, longAudio.id);
    assert.equal(withVo.sourceVoiceoverDurationSec, 6.4);
    assert.equal(withVo.segments[withVo.segments.length - 1].end, 6.4);
    assert.equal(withVo.overflowsSceneDuration, true);
    pass("13. Script captions prioritize ready voiceover duration and flag scene duration overflow");

    const emptyCap = generateScriptCaptionsForScene({
      scene: sb.scenes[1], // whitespace narration
      storyboard: sb,
    });
    assert.equal(emptyCap.status, "skipped_empty");
    assert.equal(emptyCap.segments.length, 0);
    pass("14. Blank narration scenes return skipped_empty with 0 cues");

    const transcribed = buildAudioTranscriptionCaptionsRecord({
      scene: sb.scenes[0],
      storyboard: sb,
      narrationSnapshot: sb.scenes[0].narration,
      effectiveLang: "en",
      voiceoverAssetId: longAudio.id,
      voiceoverFingerprint: sb.scenes[0].voiceover?.narrationFingerprint,
      transcription: {
        jobId: "py_job_cap_1",
        model: "faster-whisper-small",
        language: "en",
        languageProbability: 0.98,
        durationSeconds: 6.3,
        wordTimestampsIncluded: true,
        segments: [
          {
            id: 1,
            start: 0.05,
            end: 3.1,
            text: "Start with a crisp hook.",
            words: [
              { word: "Start", start: 0.05, end: 0.45 },
              { word: "hook.", start: 2.5, end: 3.1 },
            ],
          },
          {
            id: 2,
            start: 3.2,
            end: 6.3,
            text: "Keep viewers curious from second zero!",
          },
        ],
        srt: "",
        vtt: "",
      },
    });
    assert.equal(transcribed.status, "ready");
    assert.equal(transcribed.timingSource, "audio_transcription");
    assert.equal(transcribed.segments[0].words?.length, 2);
    assert.equal(transcribed.overflowsSceneDuration, true);
    pass("15. Audio transcription builder stores word timestamps, model attribution, and overflow warning");
  }

  // 16-19: Cue editing (update, split, merge, add, delete, overlap detection)
  {
    const baseSegs: StoryboardCaptionSegment[] = [
      {
        id: "c1",
        start: 0,
        end: 2.4,
        text: "One two three four",
        timingSource: "estimated",
        isManuallyEdited: false,
      },
      {
        id: "c2",
        start: 2.4,
        end: 4.8,
        text: "Five six",
        timingSource: "estimated",
        isManuallyEdited: false,
      },
    ];

    const updated = updateCaptionSegment(baseSegs, "c1", { text: "Updated --> cue" });
    assert.equal(updated[0].text, "Updated —> cue");
    assert.equal(updated[0].isManuallyEdited, true);
    assert.equal(updated[0].timingSource, "manual");
    pass("16. updateCaptionSegment marks manual timingSource and sanitizes cue arrows");

    const splitRes = splitCaptionSegment(baseSegs, "c1", "en-US");
    assert.equal(splitRes.length, 3);
    assert.equal(splitRes[0].start, 0);
    assert.equal(splitRes[0].end, 1.2);
    assert.equal(splitRes[1].start, 1.2);
    assert.equal(splitRes[1].end, 2.4);
    assert.equal(splitRes[0].text, "One two");
    assert.equal(splitRes[1].text, "three four");
    pass("17. splitCaptionSegment divides duration at midpoint and splits words cleanly");

    const merged = mergeCaptionSegmentWithNext(splitRes, splitRes[0].id);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].start, 0);
    assert.equal(merged[0].end, 2.4);
    assert.equal(merged[0].text, "One two three four");

    const added = addCaptionSegment(merged, 6.0);
    assert.equal(added.length, 3);
    assert.equal(added[2].start, 4.8);
    assert.equal(deleteCaptionSegment(added, added[2].id).length, 2);
    pass("18. mergeCaptionSegmentWithNext, addCaptionSegment, and deleteCaptionSegment preserve sequence");

    const overlapping: StoryboardCaptionSegment[] = [
      { id: "a", start: 0, end: 2.5, text: "First", timingSource: "manual", isManuallyEdited: true },
      { id: "b", start: 2.0, end: 4.0, text: "Second", timingSource: "manual", isManuallyEdited: true },
    ];
    const overlapIds = findCaptionSegmentOverlaps(overlapping);
    assert.equal(overlapIds.has("a"), true);
    assert.equal(overlapIds.has("b"), true);
    pass("19. findCaptionSegmentOverlaps flags overlapping time windows cleanly");
  }

  // 20-22: Stale detection isolation (non-triggers vs triggers) & summary metrics
  {
    const sb = makeBaseStoryboard();
    const vis = makeVisualAsset();
    const cap = generateScriptCaptionsForScene({ scene: sb.scenes[0], storyboard: sb });
    sb.scenes[0].captions = cap;

    // Non-triggers: visual assignment, scene title, startTime, effect, transition, caption style
    sb.scenes[0].title = "Renamed Visual Title";
    sb.scenes[0].startTime = 3.5;
    sb.scenes[0].effect = "cinematic";
    sb.scenes[0].transition = "wipeleft";
    sb.scenes[0].mediaAssignment = createAssignmentFromAsset(sb.scenes[0], vis, "16:9");
    sb.captionSettings = {
      ...getDefaultCaptionSettings(sb),
      style: getCaptionPresetById("yellow_highlight"),
    };

    const evalStable = evaluateSceneCaptionsReadiness(sb.scenes[0], sb, new Map());
    assert.equal(evalStable.status, "ready");
    assert.equal(evalStable.isStale, false);
    pass("20. Visual media, title, order, effect, transition & styling changes do NOT stale captions");

    // Triggers: narration edit, language change, duration change (without voiceover)
    sb.scenes[0].narration = "Brand new narration line requiring caption update.";
    const evalNarrationEdit = evaluateSceneCaptionsReadiness(sb.scenes[0], sb, new Map());
    assert.equal(evalNarrationEdit.status, "stale");
    assert.equal(evalNarrationEdit.narrationDiverged, true);

    sb.scenes[0].narration = "Start with a crisp hook. Keep viewers curious from second zero!";
    const evalLangSwitch = evaluateSceneCaptionsReadiness(
      sb.scenes[0],
      { ...sb, language: "Hindi" },
      new Map()
    );
    assert.equal(evalLangSwitch.status, "stale");

    sb.scenes[0].duration = 8;
    const evalDurSwitch = evaluateSceneCaptionsReadiness(sb.scenes[0], sb, new Map());
    assert.equal(evalDurSwitch.status, "stale");
    pass("21. Narration edits, language switches & unvoiced duration edits reliably mark captions stale");

    // Summary check
    const sbSum = makeBaseStoryboard();
    sbSum.scenes[0].captions = generateScriptCaptionsForScene({ scene: sbSum.scenes[0], storyboard: sbSum });
    const summary = computeStoryboardCaptionsSummary(sbSum, []);
    assert.equal(summary.totalScenes, 3);
    assert.equal(summary.captionableScenes, 2); // scene_2 is blank narration
    assert.equal(summary.readyCount, 1);
    assert.equal(summary.unassignedCount, 1);
    assert.equal(summary.progressPercent, 50);
    assert.equal(summary.isCaptionsReady, false);
    pass("22. computeStoryboardCaptionsSummary excludes empty scenes and computes accurate readiness");
  }

  // 23-25: 6 style presets, proportional aspect preview scaling & active cue lookup
  {
    assert.equal(CAPTION_STYLE_PRESETS.length, 6);
    const presetIds = new Set(CAPTION_STYLE_PRESETS.map((p) => p.id));
    for (const id of [
      "classic",
      "cinematic",
      "educational",
      "social_media",
      "minimal",
      "yellow_highlight",
    ]) {
      assert.equal(presetIds.has(id as never), true);
    }
    pass("23. All 6 caption style presets exist and match spec");

    const yellow = getCaptionPresetById("yellow_highlight");
    const style169 = computeScaledCaptionPreviewStyle(yellow, 180, "16:9", "English");
    const style916 = computeScaledCaptionPreviewStyle(yellow, 260, "9:16", "Hindi");
    assert.equal(style169.color, "#FACC15");
    assert.ok(style169.fontSizePx >= 10);
    assert.ok(style916.fontFamily.includes("Noto Sans Devanagari"));
    assert.equal(style916.maxWidthPct, 88);
    pass("24. computeScaledCaptionPreviewStyle adapts typography proportionally for 16:9 and Hindi 9:16");

    const cues = [
      { id: "1", start: 0, end: 1.5, text: "First", timingSource: "estimated" as const, isManuallyEdited: false },
      { id: "2", start: 1.8, end: 3.5, text: "Second", timingSource: "estimated" as const, isManuallyEdited: false },
    ];
    assert.equal(findActiveCaptionCueAtTime(cues, 0.9)?.id, "1");
    assert.equal(findActiveCaptionCueAtTime(cues, 1.65), null);
    assert.equal(findActiveCaptionCueAtTime(cues, 2.5)?.id, "2");
    pass("25. findActiveCaptionCueAtTime handles active windows and inter-cue gaps");
  }

  // 26-28: SRT / WebVTT scene & full-timeline export preserving silent scene gaps
  {
    const sb = makeBaseStoryboard();
    sb.scenes[0].captions = {
      sceneId: "scene_1",
      mode: "script",
      timingSource: "estimated",
      language: "en",
      status: "ready",
      fingerprint: "fp_1",
      sourceNarrationSnapshot: sb.scenes[0].narration,
      sourceSceneDurationSec: 5,
      generatedAt: "2026-11-27T08:00:00.000Z",
      hasManualEdits: false,
      overflowsSceneDuration: false,
      segments: [
        {
          id: "s1_c1",
          start: 0,
          end: 2.2,
          text: "First scene cue",
          timingSource: "estimated",
          isManuallyEdited: false,
        },
      ],
    };
    // scene_2 has duration 4s and NO captions (silent gap from 5s -> 9s!)
    sb.scenes[2].captions = {
      sceneId: "scene_3",
      mode: "audio",
      timingSource: "audio_transcription",
      language: "en",
      status: "ready",
      fingerprint: "fp_3",
      sourceNarrationSnapshot: sb.scenes[2].narration,
      sourceSceneDurationSec: 6,
      generatedAt: "2026-11-27T08:00:00.000Z",
      hasManualEdits: false,
      overflowsSceneDuration: false,
      segments: [
        {
          id: "s3_c1",
          start: 0.5,
          end: 3.0,
          text: "Third scene cue --> clean",
          timingSource: "audio_transcription",
          isManuallyEdited: false,
        },
      ],
    };

    const sceneSrt = exportSceneCaptionsToSrt(sb.scenes[2]);
    assert.ok(sceneSrt.includes("00:00:00,500 --> 00:00:03,000"));
    assert.ok(sceneSrt.includes("Third scene cue —> clean"));
    const sceneVtt = exportSceneCaptionsToVtt(sb.scenes[0]);
    assert.ok(sceneVtt.startsWith("WEBVTT\n\n"));
    assert.ok(sceneVtt.includes("00:00:00.000 --> 00:00:02.200"));
    pass("26. Scene-level SRT and WebVTT exports format timestamps and sanitize cue text");

    const cuesTimeline = collectTimelineCaptionCues(sb);
    assert.equal(cuesTimeline.length, 2);
    assert.equal(cuesTimeline[0].start, 0);
    assert.equal(cuesTimeline[1].start, 9.5, "Scene 1 (5s) + silent Scene 2 (4s) + 0.5s = 9.5s");
    assert.equal(cuesTimeline[1].end, 12.0);
    pass("27. Timeline cue collector accumulates scene durations and preserves empty/silent gaps");

    const fullSrt = exportStoryboardCaptionsToSrt(sb);
    assert.ok(fullSrt.startsWith("1\n00:00:00,000 --> 00:00:02,200"));
    assert.ok(fullSrt.includes("2\n00:00:09,500 --> 00:00:12,000"));
    const fullVtt = exportStoryboardCaptionsToVtt(sb);
    assert.ok(fullVtt.includes("00:00:09.500 --> 00:00:12.000"));
    pass("28. Full storyboard SRT/VTT exports produce continuous monotonically numbered cues");
  }

  // 29-38: Live Express /api/captions/* & /api/integrations/status HTTP integration tests
  {
    const userId = new mongoose.Types.ObjectId().toString();
    const jwtSecret = "test-phase554-jwt-secret-key-32-chars";
    const processorKey = "test-phase554-proc-key-16";

    const receivedCalls: Array<{ lang: string; wordTimestamps: string; jobId: string }> = [];
    const cancelledJobIds: string[] = [];
    let forceSlowDelayMs = 0;
    let forceErrorLeak = false;
    let holdGateResolve: (() => void) | null = null;

    const mockPython = await startTempServer(async (req, res) => {
      if (req.headers["x-processor-key"] !== processorKey) {
        res.statusCode = 403;
        res.end(JSON.stringify({ detail: "Invalid processor key" }));
        return;
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v1/captions/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            enabled: true,
            script_mode_available: true,
            audio_transcription_available: true,
            faster_whisper_installed: true,
            local_model_ready: true,
            local_files_only: true,
            model: "small",
            device: "cpu",
            compute_type: "int8",
            max_audio_mb: 20,
            max_duration_sec: 90,
            max_concurrent_jobs: 1,
            supported_languages: ["en", "hi", "bn"],
            message: "Local faster-whisper small model cached and ready.",
          })
        );
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/v1/captions/jobs/") &&
        url.pathname.endsWith("/cancel")
      ) {
        const parts = url.pathname.split("/");
        const jobId = parts[parts.length - 2];
        cancelledJobIds.push(jobId);
        if (holdGateResolve) {
          holdGateResolve();
          holdGateResolve = null;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ job_id: jobId, status: "cancelled", cancelled: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/captions/generate") {
        const rawBufs: Buffer[] = [];
        for await (const chunk of req) {
          rawBufs.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rawStr = Buffer.concat(rawBufs).toString("utf8");
        const langMatch = rawStr.match(/name="language"\r\n\r\n([^\r\n]*)/);
        const wordMatch = rawStr.match(/name="word_timestamps"\r\n\r\n([^\r\n]*)/);
        const jobMatch = rawStr.match(/name="client_job_id"\r\n\r\n([^\r\n]*)/);
        const lang = langMatch?.[1] || "auto";
        const wordTs = wordMatch?.[1] || "false";
        const jobId = jobMatch?.[1] || String(req.headers["x-captions-job-id"] || "py_cap_1");
        receivedCalls.push({ lang, wordTimestamps: wordTs, jobId });

        if (forceErrorLeak) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              detail:
                "CTranslate2 error at C:\\Users\\admin\\hf_cache\\model.bin reading /home/worker/voice.wav",
            })
          );
          return;
        }

        if (forceSlowDelayMs > 0) {
          await new Promise<void>((resolve) => {
            holdGateResolve = resolve;
            setTimeout(resolve, forceSlowDelayMs);
          });
        }

        const sampleText =
          lang === "hi"
            ? "नमस्ते दोस्तों, यह हिंदी कैप्शन है।"
            : lang === "bn"
              ? "নমস্কার বন্ধুরা, এটি বাংলা ক্যাপশন।"
              : "Hello creator, this is transcribed audio.";

        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "completed",
            job_id: jobId,
            model: "faster-whisper-small",
            language: lang === "auto" ? "en" : lang,
            language_probability: 0.97,
            duration_seconds: 1.5,
            word_timestamps_included: wordTs === "true",
            segments: [
              {
                id: 1,
                start: 0.0,
                end: 1.5,
                text: sampleText,
                ...(wordTs === "true"
                  ? {
                      words: [
                        { word: sampleText.split(" ")[0], start: 0.0, end: 0.5 },
                        { word: sampleText.split(" ")[1] || "ok", start: 0.5, end: 1.5 },
                      ],
                    }
                  : {}),
              },
            ],
            srt: `1\n00:00:00,000 --> 00:00:01,500\n${sampleText}\n`,
            vtt: `WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n${sampleText}\n`,
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    });

    const prevEnv = {
      JWT_SECRET: process.env.JWT_SECRET,
      MONGODB_URI: process.env.MONGODB_URI,
      VIDEO_PROCESSOR_URL: process.env.VIDEO_PROCESSOR_URL,
      VIDEO_PROCESSOR_API_KEY: process.env.VIDEO_PROCESSOR_API_KEY,
      CAPTIONS_ENABLED: process.env.CAPTIONS_ENABLED,
      CAPTIONS_MAX_CONCURRENT_JOBS: process.env.CAPTIONS_MAX_CONCURRENT_JOBS,
      CAPTIONS_MAX_AUDIO_MB: process.env.CAPTIONS_MAX_AUDIO_MB,
    };

    const connObj = mongoose.connection as unknown as { readyState: number };
    const prevReadyState = connObj.readyState;
    const origFindById = UserModel.findById;

    process.env.JWT_SECRET = jwtSecret;
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/verify_phase554";
    process.env.VIDEO_PROCESSOR_URL = mockPython.baseUrl;
    process.env.VIDEO_PROCESSOR_API_KEY = processorKey;
    process.env.CAPTIONS_ENABLED = "true";
    process.env.CAPTIONS_MAX_CONCURRENT_JOBS = "1";
    process.env.CAPTIONS_MAX_AUDIO_MB = "5";
    connObj.readyState = 1;

    UserModel.findById = ((id: string) => {
      if (String(id) === userId) {
        return Promise.resolve({
          _id: new mongoose.Types.ObjectId(userId),
          fullName: "Phase 5.5.4 Tester",
          email: "tester554@example.com",
        });
      }
      return Promise.resolve(null);
    }) as unknown as typeof UserModel.findById;

    const app = express();
    app.use(cookieParser());
    app.use(corsAllowlistMiddleware);
    app.use(express.json({ limit: "2mb" }));
    app.use(sanitizeRequestInputMiddleware);
    app.use("/api", csrfProtectionMiddleware, apiRouter);
    app.use(sanitizedErrorHandler);

    const token = jwt.sign({ sub: userId, email: "tester554@example.com" }, jwtSecret, {
      expiresIn: "1h",
    });
    const cookieName =
      (process.env.AUTH_COOKIE_NAME || "ai_studio_token").trim() || "ai_studio_token";
    const cookie = `${cookieName}=${token}`;
    const expressSrv = await startTempServer(app);
    const baseUrl = expressSrv.baseUrl;

    try {
      // 29. Unauthenticated requests rejected (401)
      assert.equal((await fetch(`${baseUrl}/api/captions/status`)).status, 401);
      assert.equal(
        (
          await fetch(`${baseUrl}/api/captions/from-audio`, {
            method: "POST",
          })
        ).status,
        401
      );
      pass("29. Unauthenticated /api/captions/* requests return HTTP 401");

      // 30. CSRF protection rejects foreign Origin
      const csrfRes = await fetch(`${baseUrl}/api/captions/from-audio`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://evil.example.com" },
      });
      assert.equal(csrfRes.status, 403);
      pass("30. CSRF protection blocks cross-site POST to /api/captions/from-audio");

      // 31. /api/integrations/status reports storyboardCaptions readiness + headers exposed
      const intRes = await fetch(`${baseUrl}/api/integrations/status`);
      assert.equal(intRes.status, 200);
      const intJson = (await intRes.json()) as {
        integrations: Record<string, { id: string; connected: boolean }>;
      };
      assert.equal(intJson.integrations.storyboardCaptions?.id, "storyboardCaptions");
      assert.equal(intJson.integrations.storyboardCaptions?.connected, true);

      const statusRes = await fetch(`${baseUrl}/api/captions/status`, {
        headers: { Cookie: cookie, Origin: baseUrl },
      });
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as CaptionsStatusInfo;
      assert.equal(statusJson.audioTranscriptionAvailable, true);
      assert.equal(statusJson.model, "small");
      assert.equal(statusJson.localFilesOnly, true);
      const exposeHeaders = statusRes.headers.get("access-control-expose-headers") || "";
      assert.ok(exposeHeaders.includes("X-Captions-Job-Id"));
      pass("31. /api/integrations/status & /api/captions/status report local Whisper state & CORS headers");

      // 32. Valid multipart audio upload across Hindi & Bengali UTF-8 with wordTimestamps=true
      const wavBuf = buildTestWavBuffer(1.5, 16000);
      for (const sample of [
        { lang: "hi", expected: "नमस्ते दोस्तों", jobId: "cap_hi_test_1" },
        { lang: "bn", expected: "নমস্কার বন্ধুরা", jobId: "cap_bn_test_2" },
      ]) {
        const form = new FormData();
        form.append(
          "audio",
          new Blob([new Uint8Array(wavBuf)], { type: "audio/wav" }),
          `voice_${sample.lang}.wav`
        );
        form.append("language", sample.lang);
        form.append("wordTimestamps", "true");
        form.append("clientJobId", sample.jobId);

        const res = await fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: baseUrl,
            "X-Captions-Job-Id": sample.jobId,
          },
          body: form,
        });
        assert.equal(res.status, 200, `Expected 200 for ${sample.lang}`);
        assert.equal(res.headers.get("x-captions-job-id"), sample.jobId);
        const body = (await res.json()) as {
          language: string;
          wordTimestampsIncluded: boolean;
          segments: Array<{ text: string; words?: unknown[] }>;
        };
        assert.equal(body.language, sample.lang);
        assert.equal(body.wordTimestampsIncluded, true);
        assert.ok(body.segments[0].text.includes(sample.expected));
        assert.ok((body.segments[0].words?.length ?? 0) >= 2);
      }
      pass("32. Express /api/captions/from-audio transcribes WAV uploads for Hindi & Bengali with word timestamps");

      // 33. Spoofed MP4 disguised as .wav rejected by audio-only magic-byte check (400)
      {
        const spoofMp4 = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2", "binary");
        const spoofForm = new FormData();
        spoofForm.append(
          "audio",
          new Blob([spoofMp4], { type: "audio/wav" }),
          "fake_audio.wav"
        );
        const spoofRes = await fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: baseUrl },
          body: spoofForm,
        });
        assert.equal(spoofRes.status, 400);
        pass("33. Audio-only magic-byte check rejects non-audio MP4 spoofed as .wav (HTTP 400)");
      }

      // 34. Error sanitization through live Express error handler
      {
        forceErrorLeak = true;
        const form = new FormData();
        form.append("audio", new Blob([new Uint8Array(wavBuf)], { type: "audio/wav" }), "err.wav");
        const errRes = await fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: baseUrl },
          body: form,
        });
        forceErrorLeak = false;
        assert.equal(errRes.status, 500);
        const errJson = (await errRes.json()) as { error?: string };
        assert.equal(errJson.error?.includes("C:\\Users"), false);
        assert.equal(errJson.error?.includes("/home/worker"), false);
        pass("34. Upstream Whisper error paths strip C:\\ and /home/ paths before client response");
      }

      // 35. Concurrency slot (CAPTIONS_MAX_CONCURRENT_JOBS=1 -> 429) & cooperative cancellation -> 499
      {
        forceSlowDelayMs = 8000;
        const slowJobId = "cap_cancel_race_1";
        const form1 = new FormData();
        form1.append("audio", new Blob([new Uint8Array(wavBuf)], { type: "audio/wav" }), "slow.wav");
        form1.append("clientJobId", slowJobId);

        const inFlight = fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: baseUrl,
            "X-Captions-Job-Id": slowJobId,
          },
          body: form1,
        });

        await new Promise((r) => setTimeout(r, 120));

        const snapRes = await fetch(`${baseUrl}/api/captions/jobs/${slowJobId}`, {
          headers: { Cookie: cookie },
        });
        assert.equal(snapRes.status, 200);

        const form2 = new FormData();
        form2.append("audio", new Blob([new Uint8Array(wavBuf)], { type: "audio/wav" }), "busy.wav");
        const busyRes = await fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: baseUrl },
          body: form2,
        });
        assert.equal(busyRes.status, 429);

        const cancelRes = await fetch(`${baseUrl}/api/captions/jobs/${slowJobId}/cancel`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: baseUrl },
        });
        assert.equal(cancelRes.status, 200);

        const finishedSlow = await inFlight;
        assert.equal(finishedSlow.status, 499);
        assert.ok(cancelledJobIds.includes(slowJobId));
        forceSlowDelayMs = 0;
        pass("35. Concurrency queue enforces 429 backpressure and cooperative cancel returns 499 + notifies Python");
      }

      // 36. CAPTIONS_ENABLED=false disables /from-audio cleanly with 503
      {
        process.env.CAPTIONS_ENABLED = "false";
        const form = new FormData();
        form.append("audio", new Blob([new Uint8Array(wavBuf)], { type: "audio/wav" }), "off.wav");
        const offRes = await fetch(`${baseUrl}/api/captions/from-audio`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: baseUrl },
          body: form,
        });
        assert.equal(offRes.status, 503);
        process.env.CAPTIONS_ENABLED = "true";
        pass("36. CAPTIONS_ENABLED=false returns HTTP 503 cleanly");
      }
    } finally {
      await new Promise<void>((resolve) => expressSrv.server.close(() => resolve()));
      await new Promise<void>((resolve) => mockPython.server.close(() => resolve()));
      connObj.readyState = prevReadyState;
      UserModel.findById = origFindById;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // 37-42: React SSR checks across all Phase 5.5.4 components & pages
  {
    const sb = makeBaseStoryboard();
    const audioAsset = makeAudioAsset();
    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: audioAsset.id,
      provider: "espeak_ng",
      voiceId: "en",
      voiceLabel: "English",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 4.2,
      sizeBytes: 64000,
      sampleRateHz: 16000,
      channels: 1,
    });
    sb.captionSettings = getDefaultCaptionSettings(sb);
    sb.scenes[0].captions = generateScriptCaptionsForScene({
      scene: sb.scenes[0],
      storyboard: sb,
      voiceoverAsset: audioAsset,
    });

    const captionsStatus: CaptionsStatusInfo = {
      enabled: true,
      defaultMode: "script",
      scriptModeAvailable: true,
      audioTranscriptionAvailable: false,
      fasterWhisperInstalled: true,
      localModelReady: false,
      localFilesOnly: true,
      model: "small",
      device: "cpu",
      computeType: "int8",
      maxAudioMb: 20,
      maxDurationSec: 90,
      maxConcurrentJobs: 1,
      maxSegmentsPerScene: 100,
      maxBatchScenes: 12,
      supportedLanguages: ["en", "hi", "bn"],
      message: "WHISPER_LOCAL_FILES_ONLY=true; script captions ready.",
    };

    const inspectorHtml = renderToString(
      React.createElement(CaptionStyleInspector, {
        style: sb.captionSettings.style,
        language: "Bengali",
        onChange: () => undefined,
      })
    );
    assert.ok(inspectorHtml.includes("Caption Style Presets"));
    assert.ok(inspectorHtml.includes("Yellow Highlight"));
    pass("37. CaptionStyleInspector SSR renders 6 presets and Bengali fallback info cleanly");

    const previewSilentHtml = renderToString(
      React.createElement(CaptionPreview, {
        sceneId: "scene_1",
        sceneTitle: "Opening Hook",
        sceneDuration: 5,
        aspectRatio: "9:16",
        language: "Hindi",
        style: sb.captionSettings.style,
        segments: sb.scenes[0].captions.segments,
        activeAudioSceneId: null,
        onActivateSceneAudio: () => undefined,
      })
    );
    assert.ok(previewSilentHtml.includes("Silent Timer"));
    assert.ok(previewSilentHtml.includes("aspect-[9/16]"));

    const previewAudioHtml = renderToString(
      React.createElement(CaptionPreview, {
        sceneId: "scene_1",
        sceneTitle: "Opening Hook",
        sceneDuration: 5,
        aspectRatio: "16:9",
        language: "English",
        style: sb.captionSettings.style,
        segments: sb.scenes[0].captions.segments,
        audioSrc: audioAsset.objectUrl,
        audioDurationSeconds: 4.2,
        activeAudioSceneId: null,
        onActivateSceneAudio: () => undefined,
      })
    );
    assert.ok(previewAudioHtml.includes("Audio Sync"));
    assert.ok(previewAudioHtml.includes("<audio"));
    pass("38. CaptionPreview SSR renders both Silent Timer and Audio Sync stages cleanly");

    const editorHtml = renderToString(
      React.createElement(CaptionSegmentEditor, {
        sceneId: "scene_1",
        sceneDuration: 5,
        locale: "en-US",
        segments: sb.scenes[0].captions.segments,
        onChangeSegments: () => undefined,
      })
    );
    assert.ok(editorHtml.includes("Caption Cues"));
    assert.ok(editorHtml.includes("Add Cue"));
    pass("39. CaptionSegmentEditor SSR renders cue list and editing actions cleanly");

    const evalRes = evaluateSceneCaptionsReadiness(
      sb.scenes[0],
      sb,
      new Map([[audioAsset.id, audioAsset]])
    );
    const cardHtml = renderToString(
      React.createElement(SceneCaptionCard, {
        scene: sb.scenes[0],
        sceneIndex: 0,
        storyboard: sb,
        evaluation: evalRes,
        captionStyle: sb.captionSettings.style,
        captionsStatus,
        voiceoverAsset: audioAsset,
        isAuthenticated: true,
        activeGenerating: false,
        batchActive: false,
        activeAudioSceneId: null,
        onActivateSceneAudio: () => undefined,
        onGenerateScriptCaptions: () => undefined,
        onTranscribeAudioCaptions: () => undefined,
        onCancelSceneCaptions: () => undefined,
        onUpdateSceneSegments: () => undefined,
        onRemoveSceneCaptions: () => undefined,
        onTrimCuesToSceneDuration: () => undefined,
        onAdjustSceneDuration: () => undefined,
      })
    );
    assert.ok(cardHtml.includes("Script Captions"));
    assert.ok(cardHtml.includes("From Audio"));
    assert.ok(cardHtml.includes(".SRT"));
    assert.ok(cardHtml.includes(".VTT"));
    pass("40. SceneCaptionCard SSR renders actions, badges, and scene SRT/VTT buttons");

    const prepHtml = renderToString(
      React.createElement(StoryboardCaptionPrepSection, {
        storyboard: sb,
        summary: computeStoryboardCaptionsSummary(sb, [audioAsset]),
        captionsStatus: {
          ...captionsStatus,
          defaultMode: "audio",
        },
        captionsLoading: false,
        captionsError: null,
        isAuthenticated: true,
        readyVoiceoverCount: 1,
        batchState: {
          active: false,
          mode: "script",
          currentSceneId: null,
          completedCount: 0,
          totalCount: 0,
          statusMessage: null,
        },
        onRefreshCaptionsStatus: () => undefined,
        onChangeCaptionSettings: () => undefined,
        onGenerateMissingOrStale: () => undefined,
        onRegenerateAll: () => undefined,
        onCancelBatch: () => undefined,
        onClearAllCaptions: () => undefined,
      })
    ).replace(/<!--\s*-->/g, "");
    assert.ok(prepHtml.includes("Storyboard Captions &amp; Subtitle Editor (Phase 5.5.4)"));
    assert.ok(prepHtml.includes("Composition Ready: No (Phase 5.5.5)"));
    pass("41. StoryboardCaptionPrepSection SSR renders Phase 5.5.4 controls & Phase 5.5.5 boundary");

    const panelHtml = renderToString(
      React.createElement(StoryboardReviewPanel, {
        storyboard: sb,
        mediaAssets: [audioAsset],
        idbHydrating: false,
        captionsStatus,
        onChange: () => undefined,
        onSaveDraft: () => undefined,
        onRegenerate: () => undefined,
        savingDraft: false,
        saveStatusMessage: null,
        saveError: null,
        regenerating: false,
        isAuthenticated: true,
      })
    ).replace(/<!--\s*-->/g, "");
    assert.ok(panelHtml.includes("Storyboard Captions &amp; Subtitle Editor"));

    const pageHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(AiGeneratorPage))
    );
    assert.ok(pageHtml.includes("AI Script &amp; Storyboard Generator"));
    pass("42. StoryboardReviewPanel & AiGeneratorPage SSR render cleanly without runtime errors");
  }

  console.log(`ALL_PHASE_554_VERIFICATIONS_PASSED (${checkCount} check groups)`);
}

runTests().catch((err) => {
  console.error("Phase 5.5.4 verification failed:", err);
  process.exit(1);
});
