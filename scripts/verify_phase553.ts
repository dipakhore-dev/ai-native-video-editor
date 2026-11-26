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
import { MediaLibraryPage } from "../src/pages/MediaLibraryPage.tsx";
import { StoryboardReviewPanel } from "../src/components/generator/StoryboardReviewPanel.tsx";
import { SceneVoiceoverCard } from "../src/components/generator/SceneVoiceoverCard.tsx";
import { StoryboardVoiceoverPrepSection } from "../src/components/generator/StoryboardVoiceoverPrepSection.tsx";
import { VoiceSelector } from "../src/components/generator/VoiceSelector.tsx";
import { VoiceoverAudioPreview } from "../src/components/generator/VoiceoverAudioPreview.tsx";
import type {
  MediaAsset,
  StoryboardSceneVoiceover,
  TtsStatusInfo,
  TtsVoiceOption,
  VideoStoryboard,
} from "../src/types/studio.ts";
import { SaveStoryboardDraftSchema } from "../server/validators/aiAndExport.validators.ts";
import { CreateMediaMetadataSchema } from "../server/validators/media.validators.ts";
import {
  TtsGenerateRequestSchema,
  normalizeTtsLanguageInput,
} from "../server/validators/tts.validators.ts";
import { sanitizeTtsErrorMessage } from "../server/services/tts.service.ts";
import {
  StoryboardSceneVoiceoverSchema,
  StoryboardVoiceoverSettingsSchema,
  StoryboardVoiceoverSummarySchema,
  VideoStoryboardSchema,
  sanitizeStoryboardForPersistence,
} from "../src/utils/storyboard.ts";
import {
  autoMatchStoryboardScenes,
  createAssignmentFromAsset,
  findStoryboardsUsingAsset,
  scoreAssetForScene,
} from "../src/utils/storyboardMedia.ts";
import {
  DURATION_OVERFLOW_TOLERANCE_SEC,
  computeNarrationFingerprint,
  computeStoryboardVoiceoverSummary,
  createSceneVoiceoverRecord,
  evaluateSceneVoiceoverReadiness,
  isSceneVoiceoverStale,
  normalizeTtsLanguage,
  pickDefaultVoiceForLanguage,
  resolveEffectiveSceneVoiceParams,
} from "../src/utils/storyboardVoiceover.ts";
import {
  corsAllowlistMiddleware,
  csrfProtectionMiddleware,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
} from "../server/middleware/security.middleware.ts";
import { apiRouter } from "../server/routes/index.ts";
import { UserModel } from "../server/models/User.ts";
import { StoryboardDraftModel } from "../server/models/StoryboardDraft.ts";

function buildTestWavBuffer(durationSec = 1.0, sampleRate = 22050): Buffer {
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
  const now = "2026-11-26T08:00:00.000Z";
  return {
    id: "sb_phase553_test",
    title: "Offline Voiceover Storyboard",
    description: "Three short scenes testing offline TTS voiceovers across languages.",
    targetAudience: "Creators",
    language: "English",
    totalDuration: 15,
    aspectRatio: "16:9",
    style: "Educational",
    fullNarrationScript:
      "Start with clean studio audio. Keep every scene well paced. Preview before composing.",
    backgroundMusicMood: "Calm lo-fi",
    captionText: "Clean audio\nWell paced\nPreview ready",
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
        title: "Clean Studio Audio",
        startTime: 0,
        duration: 5,
        narration: "Start with clean studio audio.",
        onScreenText: "Clean audio",
        visualDescription: "Microphone on minimalist desk.",
        mediaKeywords: ["microphone", "desk", "studio"],
        mediaType: "video",
        transition: "fade",
        effect: "none",
        cameraMotion: "static",
      },
      {
        id: "scene_2",
        title: "Well Paced Narration",
        startTime: 5,
        duration: 5,
        narration: "Keep every scene well paced.",
        onScreenText: "Pacing check",
        visualDescription: "Editor timeline wave bars.",
        mediaKeywords: ["timeline", "editor", "wave"],
        mediaType: "video",
        transition: "dissolve",
        effect: "cinematic",
        cameraMotion: "slow-dolly-in",
      },
      {
        id: "scene_3",
        title: "Silent Break",
        startTime: 10,
        duration: 5,
        narration: "   ",
        onScreenText: "Breathe",
        visualDescription: "Quiet transition card.",
        mediaKeywords: ["calm", "minimal"],
        mediaType: "image",
        transition: "none",
        effect: "none",
        cameraMotion: "static",
      },
    ],
    ...(overrides ?? {}),
  };
}

function makeAudioAsset(overrides?: Partial<MediaAsset>): MediaAsset {
  return {
    id: `vo_asset_${Math.random().toString(36).slice(2, 8)}`,
    name: "voiceover_en_scene1.wav",
    kind: "audio",
    mimeType: "audio/wav",
    sizeBytes: 98348,
    duration: 2.85,
    objectUrl: "blob:http://localhost:3000/temporary-audio-blob",
    sourceOrigin: "generated_voiceover",
    providerName: "piper",
    addedAt: "2026-11-26T08:00:00.000Z",
    ...overrides,
  };
}

function makeVisualAsset(overrides?: Partial<MediaAsset>): MediaAsset {
  return {
    id: `vis_asset_${Math.random().toString(36).slice(2, 8)}`,
    name: "studio_desk_microphone.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 2_000_000,
    duration: 8,
    width: 1920,
    height: 1080,
    objectUrl: "blob:http://localhost:3000/temporary-video-blob",
    sourceOrigin: "uploaded",
    addedAt: "2026-11-26T08:00:00.000Z",
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
  // 1. Backward compatibility of Phase 5.5.1/5.5.2 storyboards without voiceover fields
  {
    const sb = makeBaseStoryboard();
    const parsed = VideoStoryboardSchema.safeParse(sb);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.compositionReady, false);
    const draftParsed = SaveStoryboardDraftSchema.safeParse({
      title: sb.title,
      status: "draft",
      storyboard: sb,
    });
    assert.equal(draftParsed.success, true);
    console.log("[PASS] 1. Phase 5.5.1/5.5.2 draft backward compatibility & compositionReady=false");
  }

  // 2. StoryboardSceneVoiceoverSchema, Settings, Summary & MediaAsset schema checks
  {
    const sb = makeBaseStoryboard();
    const audioAsset = makeAudioAsset({ id: "vo_1", duration: 3.1 });
    const vo = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: audioAsset.id,
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      voiceLabel: "Lessac (US English)",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 3.1,
      sizeBytes: 98348,
      sampleRateHz: 22050,
      channels: 1,
    });
    assert.equal(StoryboardSceneVoiceoverSchema.safeParse(vo).success, true);

    const settingsRes = StoryboardVoiceoverSettingsSchema.safeParse({
      provider: "auto",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.15,
      pitch: 2,
      format: "wav",
      volume: 1.2,
    });
    assert.equal(settingsRes.success, true);

    sb.scenes[0].voiceover = vo;
    sb.voiceoverSummary = computeStoryboardVoiceoverSummary(sb, [audioAsset], true);
    assert.equal(StoryboardVoiceoverSummarySchema.safeParse(sb.voiceoverSummary).success, true);
    assert.equal(VideoStoryboardSchema.safeParse(sb).success, true);

    assert.equal(
      CreateMediaMetadataSchema.safeParse({
        name: "voiceover_en_scene1.wav",
        kind: "audio",
        mimeType: "audio/wav",
        sizeBytes: 98348,
        duration: 3.1,
        sourceOrigin: "generated_voiceover",
        providerName: "piper",
        providerAssetId: "vo_job_1",
      }).success,
      true
    );
    console.log("[PASS] 2. Phase 5.5.3 Zod schemas & generated_voiceover media metadata validation");
  }

  // 3. Rejection of blob: URLs / unsafe characters & persistence sanitization
  {
    const badVo = {
      sceneId: "scene_1",
      mediaAssetId: "blob:http://localhost:3000/abc",
      provider: "espeak_ng",
      voiceId: "en-us",
      voiceLabel: "English",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 2.5,
      sizeBytes: 44000,
      sampleRateHz: 22050,
      channels: 1,
      narrationFingerprint: "vo_1234",
      generatedAt: "2026-11-26T08:00:00.000Z",
      status: "ready",
    };
    assert.equal(StoryboardSceneVoiceoverSchema.safeParse(badVo).success, false);

    const dirtySb = makeBaseStoryboard();
    dirtySb.scenes[0].voiceover = {
      ...createSceneVoiceoverRecord({
        scene: dirtySb.scenes[0],
        mediaAssetId: "blob:http://localhost:3000/999",
        provider: "espeak_ng",
        voiceId: "en-us",
        voiceLabel: "English",
        language: "en",
        speakingRate: 1.0,
        pitch: 0,
        volume: 1.0,
        format: "wav",
        mimeType: "audio/wav",
        durationSeconds: 2.5,
        sizeBytes: 44000,
        sampleRateHz: 22050,
        channels: 1,
      }),
      status: "generating",
      errorMessage: "blob:http://localhost:3000/err",
    };

    const cleaned = sanitizeStoryboardForPersistence(dirtySb);
    assert.equal(cleaned.scenes[0].voiceover?.mediaAssetId, undefined);
    assert.equal(cleaned.scenes[0].voiceover?.status, "failed");
    assert.equal(cleaned.scenes[0].voiceover?.errorMessage, undefined);
    assert.equal(cleaned.compositionReady, false);
    console.log("[PASS] 3. Rejection of blob: URLs and persistence sanitization");
  }

  // 4. Express TTS validator bounds & normalization (en/hi/bn + rejection of control chars/bad rates)
  {
    assert.equal(normalizeTtsLanguageInput("Hindi"), "hi");
    assert.equal(normalizeTtsLanguageInput("hi-IN"), "hi");
    assert.equal(normalizeTtsLanguageInput("Bengali"), "bn");
    assert.equal(normalizeTtsLanguageInput("Bangla"), "bn");
    assert.equal(normalizeTtsLanguageInput("en-US"), "en");
    assert.throws(() => normalizeTtsLanguageInput("fr"), { statusCode: 400 });

    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "नमस्ते दोस्तों",
        language: "hi",
        speakingRate: 1.0,
        pitch: 0,
        format: "wav",
      }).success,
      true
    );
    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "   ",
        language: "en",
      }).success,
      false
    );
    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "Hello\x00world",
        language: "en",
      }).success,
      false
    );
    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "Hello",
        language: "en",
        speakingRate: 1.8,
      }).success,
      false
    );
    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "Hello",
        language: "en",
        pitch: 30,
      }).success,
      false
    );
    assert.equal(
      TtsGenerateRequestSchema.safeParse({
        text: "Hello",
        language: "en",
        voiceId: "../etc/passwd",
      }).success,
      false
    );
    console.log("[PASS] 4. TTS request validation (rate/pitch bounds, Unicode, control chars, traversal)");
  }

  // 5. Narration fingerprinting & stale detection edge cases
  {
    const fp1 = computeNarrationFingerprint({
      text: "  Line one\r\nLine two  ",
      language: "English",
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.0,
      pitch: 0,
    });
    const fp2 = computeNarrationFingerprint({
      text: "Line one\nLine two",
      language: "en",
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.0,
      pitch: 0,
    });
    assert.equal(fp1, fp2, "Whitespace trimming & CRLF normalization must keep fingerprint stable");

    const fpChangedText = computeNarrationFingerprint({
      text: "Line one\nLine three",
      language: "en",
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.0,
      pitch: 0,
    });
    assert.notEqual(fp1, fpChangedText);

    const fpChangedRate = computeNarrationFingerprint({
      text: "Line one\nLine two",
      language: "en",
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.15,
      pitch: 0,
    });
    assert.notEqual(fp1, fpChangedRate);

    const sb = makeBaseStoryboard();
    const audio = makeAudioAsset({ id: "vo_stale_check", duration: 2.5 });
    const vis = makeVisualAsset({ id: "vis_1" });
    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: audio.id,
      provider: "espeak_ng",
      voiceId: "en-us",
      voiceLabel: "English (US)",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 2.5,
      sizeBytes: 98348,
      sampleRateHz: 22050,
      channels: 1,
    });

    // Visual edits & volume tweaks MUST NOT trigger stale!
    sb.scenes[0].title = "Updated Scene Heading";
    sb.scenes[0].startTime = 2.5;
    sb.scenes[0].mediaAssignment = createAssignmentFromAsset(sb.scenes[0], vis, "16:9");
    sb.scenes[0].voiceover.volume = 1.4;
    assert.equal(isSceneVoiceoverStale(sb.scenes[0], sb.language, sb.voiceoverSettings), false);

    // Narration edit MUST trigger stale!
    sb.scenes[0].narration = "Updated spoken narration line.";
    assert.equal(isSceneVoiceoverStale(sb.scenes[0], sb.language, sb.voiceoverSettings), true);

    // Language switch MUST trigger stale!
    sb.scenes[0].narration = "Start with clean studio audio.";
    assert.equal(isSceneVoiceoverStale(sb.scenes[0], "Hindi", sb.voiceoverSettings), true);
    console.log("[PASS] 5. Narration fingerprinting & stale detection (non-triggers vs triggers)");
  }

  // 6. Duration overflow analysis, fit-rate recommendation, and summary metrics
  {
    const sb = makeBaseStoryboard();
    const fitAudio = makeAudioAsset({ id: "vo_fit", duration: 5.1 }); // +0.1s <= 0.15s tolerance
    const mildOverflowAudio = makeAudioAsset({ id: "vo_mild", duration: 6.2 }); // +1.2s in 5s scene -> 1.24x
    const extremeOverflowAudio = makeAudioAsset({ id: "vo_huge", duration: 10.0 }); // needs 2.0x > 1.5x

    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: fitAudio.id,
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      voiceLabel: "Lessac",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 5.1,
      sizeBytes: 120000,
      sampleRateHz: 22050,
      channels: 1,
    });
    sb.scenes[1].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[1],
      mediaAssetId: mildOverflowAudio.id,
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      voiceLabel: "Lessac",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 6.2,
      sizeBytes: 140000,
      sampleRateHz: 22050,
      channels: 1,
    });

    const map = new Map<string, MediaAsset>([
      [fitAudio.id, fitAudio],
      [mildOverflowAudio.id, mildOverflowAudio],
      [extremeOverflowAudio.id, extremeOverflowAudio],
    ]);

    const eval0 = evaluateSceneVoiceoverReadiness(sb.scenes[0], sb, map, true);
    assert.equal(eval0.status, "ready");
    assert.equal(eval0.isOverflowing, false);
    assert.equal(DURATION_OVERFLOW_TOLERANCE_SEC, 0.15);

    const eval1 = evaluateSceneVoiceoverReadiness(sb.scenes[1], sb, map, true);
    assert.equal(eval1.status, "ready");
    assert.equal(eval1.isOverflowing, true);
    assert.equal(eval1.overflowSeconds, 1.2);
    assert.equal(eval1.recommendedRateForFit, 1.24);

    // Extreme overflow (> 1.5x needed rate) returns null recommendation
    sb.scenes[1].voiceover.mediaAssetId = extremeOverflowAudio.id;
    const evalExtreme = evaluateSceneVoiceoverReadiness(sb.scenes[1], sb, map, true);
    assert.equal(evalExtreme.isOverflowing, true);
    assert.equal(evalExtreme.recommendedRateForFit, null);

    // Scene 3 has whitespace narration -> skipped_empty, not counted as spoken scene
    const evalEmpty = evaluateSceneVoiceoverReadiness(sb.scenes[2], sb, map, true);
    assert.equal(evalEmpty.status, "skipped_empty");
    assert.equal(evalEmpty.hasNarration, false);

    // Missing audio in IndexedDB
    const missingMap = new Map<string, MediaAsset>();
    const evalMissing = evaluateSceneVoiceoverReadiness(sb.scenes[0], sb, missingMap, true);
    assert.equal(evalMissing.status, "missing");
    assert.equal(evalMissing.isMissing, true);

    const summary = computeStoryboardVoiceoverSummary(sb, [fitAudio, mildOverflowAudio, extremeOverflowAudio], true);
    assert.equal(summary.spokenScenes, 2);
    assert.equal(summary.readyCount, 2);
    assert.equal(summary.overflowCount, 1);
    assert.equal(summary.progressPercent, 100);
    assert.equal(summary.isVoiceoverReady, true);
    console.log("[PASS] 6. Overflow tolerance, recommended speed cap (<=1.5x), missing/empty handling & summary");
  }

  // 7. Visual matching exclusion & orphan cleanup protection for generated_voiceover
  {
    const sb = makeBaseStoryboard();
    const voiceoverAudio = makeAudioAsset({
      id: "vo_protected_1",
      name: "clean_studio_audio_microphone.wav",
      tags: ["microphone", "desk", "studio"],
      sourceOrigin: "generated_voiceover",
    });
    const visualClip = makeVisualAsset({
      id: "vis_clip_1",
      name: "studio_desk_microphone.mp4",
    });

    assert.equal(scoreAssetForScene(sb.scenes[0], sb.aspectRatio, voiceoverAudio).score, 0);
    const matched = autoMatchStoryboardScenes(sb, [voiceoverAudio, visualClip]);
    assert.equal(matched.storyboard.scenes[0].mediaAssignment?.mediaAssetId, "vis_clip_1");
    assert.notEqual(matched.storyboard.scenes[1].mediaAssignment?.mediaAssetId, "vo_protected_1");

    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: "vo_protected_1",
      provider: "espeak_ng",
      voiceId: "en-us",
      voiceLabel: "English",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 2.2,
      sizeBytes: 80000,
      sampleRateHz: 22050,
      channels: 1,
    });
    const refs = findStoryboardsUsingAsset("vo_protected_1", [sb]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, sb.id);
    console.log("[PASS] 7. generated_voiceover excluded from visual auto-match & protected in orphan cleanup");
  }

  // 8. Language voice filtering never substitutes English for Hindi/Bengali
  {
    const voices: TtsVoiceOption[] = [
      {
        voiceId: "en_US-lessac-medium",
        provider: "piper",
        label: "Lessac (US)",
        language: "en",
        languageTag: "en-US",
        quality: "neural",
      },
      {
        voiceId: "en",
        provider: "espeak_ng",
        label: "English (eSpeak)",
        language: "en",
        languageTag: "en",
        quality: "standard",
      },
      {
        voiceId: "hi",
        provider: "espeak_ng",
        label: "Hindi (eSpeak)",
        language: "hi",
        languageTag: "hi",
        quality: "standard",
      },
    ];

    assert.equal(normalizeTtsLanguage("Bengali"), "bn");
    assert.equal(pickDefaultVoiceForLanguage(voices, "en", "auto")?.voiceId, "en_US-lessac-medium");
    assert.equal(pickDefaultVoiceForLanguage(voices, "hi", "auto")?.voiceId, "hi");
    assert.equal(
      pickDefaultVoiceForLanguage(voices, "bn", "auto"),
      null,
      "Must NEVER fall back to English voice when Bengali voice is missing"
    );

    const sbHindi = makeBaseStoryboard({ language: "Hindi" });
    sbHindi.voiceoverSettings = {
      provider: "auto",
      voiceId: "en_US-lessac-medium",
      speakingRate: 1.0,
      pitch: 0,
      format: "wav",
      volume: 1.0,
    };
    const resolved = resolveEffectiveSceneVoiceParams(sbHindi.scenes[0], sbHindi);
    assert.equal(resolved.language, "hi");
    console.log("[PASS] 8. Language filtering & zero English voice substitution for missing bn/hi");
  }

  // 9. Error message sanitization strips host OS paths & internal endpoints
  {
    const winLeak = sanitizeTtsErrorMessage(
      "Spawn failed at C:\\Users\\developer\\video-processor\\piper.exe calling http://127.0.0.1:8001/api/v1/tts/generate"
    );
    assert.equal(winLeak.includes("C:\\Users"), false);
    assert.equal(winLeak.includes("127.0.0.1"), false);
    assert.ok(winLeak.includes("[server-path]"));
    assert.ok(winLeak.includes("[service-endpoint]"));

    const nixLeak = sanitizeTtsErrorMessage("Error reading /home/app/models/voice.onnx");
    assert.equal(nixLeak.includes("/home/app"), false);
    assert.ok(nixLeak.includes("[server-path]"));
    console.log("[PASS] 9. Error sanitization strips host paths & internal URLs");
  }

  // 10. Full Express /api/tts/* HTTP integration against mock Python TTS processor
  //     (Auth 401, CSRF, /api/integrations/status, /status, /voices, UTF-8 en/hi/bn /generate,
  //      headers + CORS expose, concurrency 429, error path redaction, cancellation 499, disabled 503)
  {
    const userId = new mongoose.Types.ObjectId().toString();
    const jwtSecret = "test-phase553-jwt-secret-key-32-chars";
    const processorKey = "test-phase553-proc-key-16";

    const receivedTexts: Array<{ text: string; language: string; jobId: string }> = [];
    const cancelledJobIds: string[] = [];
    let forceSlowDelayMs = 0;
    let forceErrorLeak = false;
    let holdJobGateResolve: (() => void) | null = null;
    let mockProcUrl = "";

    const mockPython = await startTempServer(async (req, res) => {
      const incomingKey = req.headers["x-processor-key"];
      if (incomingKey !== processorKey) {
        res.statusCode = 403;
        res.end(JSON.stringify({ detail: "Invalid processor key" }));
        return;
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v1/tts/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            enabled: true,
            available: true,
            configured_provider: "auto",
            active_provider: "espeak_ng",
            default_language: "en",
            supported_languages: ["en", "hi", "bn"],
            mp3_supported: false,
            max_text_chars: 5000,
            max_audio_mb: 20,
            providers: [
              {
                provider: "piper",
                label: "Piper Neural TTS",
                available: false,
                installed: false,
                license: "MIT runtime / model-specific ONNX licenses",
                supported_languages: [],
                voice_count: 0,
                message: "Piper binary not installed.",
              },
              {
                provider: "espeak_ng",
                label: "eSpeak NG",
                available: true,
                installed: true,
                license: "GPL-3.0-or-later",
                supported_languages: ["en", "hi", "bn"],
                voice_count: 3,
                message: "eSpeak NG CLI ready (en, hi, bn).",
              },
            ],
            message: "Local offline TTS ready via eSpeak NG.",
          })
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/tts/voices") {
        const langFilter = url.searchParams.get("language");
        const allVoices = [
          {
            voice_id: "en-us",
            provider: "espeak_ng",
            label: "English (America)",
            language: "en",
            language_tag: "en-us",
            gender: "neutral",
            quality: "standard",
            sample_rate_hz: 22050,
            description: "eSpeak NG English",
          },
          {
            voice_id: "hi",
            provider: "espeak_ng",
            label: "Hindi (India)",
            language: "hi",
            language_tag: "hi",
            gender: "neutral",
            quality: "standard",
            sample_rate_hz: 22050,
            description: "eSpeak NG Hindi",
          },
          {
            voice_id: "bn",
            provider: "espeak_ng",
            label: "Bengali",
            language: "bn",
            language_tag: "bn",
            gender: "neutral",
            quality: "standard",
            sample_rate_hz: 22050,
            description: "eSpeak NG Bengali",
          },
        ];
        const filtered = langFilter
          ? allVoices.filter((v) => v.language === langFilter)
          : allVoices;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            available: true,
            provider: "espeak_ng",
            language: langFilter,
            voices: filtered,
            supported_languages: ["en", "hi", "bn"],
            message: `Found ${filtered.length} voice(s).`,
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/v1/tts/jobs/") && url.pathname.endsWith("/cancel")) {
        const parts = url.pathname.split("/");
        const jobId = parts[parts.length - 2];
        cancelledJobIds.push(jobId);
        if (holdJobGateResolve) {
          holdJobGateResolve();
          holdJobGateResolve = null;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ job_id: jobId, status: "cancelled", cancelled: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/tts/generate") {
        const chunks: Buffer[] = [];
        for await (const ch of req) {
          chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          text: string;
          language: string;
          voice_id?: string;
          client_job_id?: string;
        };
        const jobId = body.client_job_id || "py_job_1";
        receivedTexts.push({ text: body.text, language: body.language, jobId });

        if (forceErrorLeak) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              detail: "Execution crashed at C:\\secret\\bin\\espeak-ng.exe on /home/admin/models",
            })
          );
          return;
        }

        if (forceSlowDelayMs > 0) {
          await new Promise<void>((resolve) => {
            holdJobGateResolve = resolve;
            setTimeout(resolve, forceSlowDelayMs);
          });
        }

        const wav = buildTestWavBuffer(2.4, 22050);
        res.statusCode = 200;
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Disposition", `inline; filename="vo_${jobId}.wav"`);
        res.setHeader("X-TTS-Job-Id", jobId);
        res.setHeader("X-TTS-Provider", "espeak_ng");
        res.setHeader("X-TTS-Voice-Id", encodeURIComponent(body.voice_id || body.language));
        res.setHeader(
          "X-TTS-Voice-Label",
          encodeURIComponent(
            body.language === "hi"
              ? "Hindi (हिन्दी)"
              : body.language === "bn"
                ? "Bengali (বাংলা)"
                : "English (US)"
          )
        );
        res.setHeader("X-TTS-Language", body.language);
        res.setHeader("X-TTS-Duration", "2.400");
        res.setHeader("X-TTS-Sample-Rate", "22050");
        res.setHeader("X-TTS-Channels", "1");
        res.setHeader("X-TTS-Format", "wav");
        res.end(wav);
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    });

    mockProcUrl = mockPython.baseUrl;

    const prevEnv = {
      JWT_SECRET: process.env.JWT_SECRET,
      MONGODB_URI: process.env.MONGODB_URI,
      VIDEO_PROCESSOR_URL: process.env.VIDEO_PROCESSOR_URL,
      VIDEO_PROCESSOR_API_KEY: process.env.VIDEO_PROCESSOR_API_KEY,
      TTS_ENABLED: process.env.TTS_ENABLED,
      TTS_PROVIDER: process.env.TTS_PROVIDER,
      TTS_MAX_CONCURRENT_JOBS: process.env.TTS_MAX_CONCURRENT_JOBS,
      TTS_MAX_AUDIO_MB: process.env.TTS_MAX_AUDIO_MB,
    };

    const connObj = mongoose.connection as unknown as { readyState: number };
    const prevReadyState = connObj.readyState;
    const origFindById = UserModel.findById;

    process.env.JWT_SECRET = jwtSecret;
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/verify_phase553";
    process.env.VIDEO_PROCESSOR_URL = mockProcUrl;
    process.env.VIDEO_PROCESSOR_API_KEY = processorKey;
    process.env.TTS_ENABLED = "true";
    process.env.TTS_PROVIDER = "auto";
    process.env.TTS_MAX_CONCURRENT_JOBS = "1";
    process.env.TTS_MAX_AUDIO_MB = "1";
    connObj.readyState = 1;

    UserModel.findById = ((id: string) => {
      if (String(id) === userId) {
        return Promise.resolve({
          _id: new mongoose.Types.ObjectId(userId),
          fullName: "Phase 5.5.3 Tester",
          email: "tester553@example.com",
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

    const token = jwt.sign({ sub: userId, email: "tester553@example.com" }, jwtSecret, {
      expiresIn: "1h",
    });
    const cookieName = (process.env.AUTH_COOKIE_NAME || "ai_studio_token").trim() || "ai_studio_token";
    const cookie = `${cookieName}=${token}`;
    const expressSrv = await startTempServer(app);
    const baseUrl = expressSrv.baseUrl;

    try {
      // 10a. Unauthenticated requests return 401
      const unauthStatus = await fetch(`${baseUrl}/api/tts/status`);
      assert.equal(unauthStatus.status, 401);
      const unauthGen = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hi", language: "en" }),
      });
      assert.equal(unauthGen.status, 401);

      // 10b. Cross-site CSRF attempt rejected (403)
      const csrfFail = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ text: "Hello", language: "en" }),
      });
      assert.equal(csrfFail.status, 403);

      // 10c. /api/integrations/status includes tts
      const intRes = await fetch(`${baseUrl}/api/integrations/status`);
      assert.equal(intRes.status, 200);
      const intJson = (await intRes.json()) as {
        integrations: Record<string, { id: string; connected: boolean }>;
      };
      assert.equal(intJson.integrations.tts?.id, "tts");
      assert.equal(intJson.integrations.tts?.connected, true);

      // 10d. Authenticated /api/tts/status & /api/tts/voices?language=hi
      const statusRes = await fetch(`${baseUrl}/api/tts/status`, {
        headers: { Cookie: cookie, Origin: baseUrl },
      });
      assert.equal(statusRes.status, 200);
      const statusBody = (await statusRes.json()) as TtsStatusInfo;
      assert.equal(statusBody.available, true);
      assert.equal(statusBody.activeProvider, "espeak_ng");
      assert.ok(statusBody.supportedLanguages.includes("hi"));
      assert.ok(statusBody.supportedLanguages.includes("bn"));
      const exposeHeader = statusRes.headers.get("access-control-expose-headers") || "";
      assert.ok(exposeHeader.includes("X-TTS-Duration"));
      assert.ok(exposeHeader.includes("X-TTS-Job-Id"));

      const voicesRes = await fetch(`${baseUrl}/api/tts/voices?language=hi`, {
        headers: { Cookie: cookie },
      });
      assert.equal(voicesRes.status, 200);
      const voicesBody = (await voicesRes.json()) as { voices: TtsVoiceOption[] };
      assert.equal(voicesBody.voices.length, 1);
      assert.equal(voicesBody.voices[0].language, "hi");

      // 10e. UTF-8 synthesis across English, Hindi (Devanagari), and Bengali (বাংলা)
      const samples = [
        { lang: "en", text: "Hello creator, your studio voiceover is ready.", jobId: "vo_en_utf8_1" },
        { lang: "hi", text: "नमस्ते दोस्तों, आज हम वीडियो एडिटिंग सीखेंगे।", jobId: "vo_hi_utf8_2" },
        { lang: "bn", text: "নমস্কার বন্ধুরা, আজ আমরা বাংলা ভয়েসওভার তৈরি করছি।", jobId: "vo_bn_utf8_3" },
      ];
      for (const s of samples) {
        const res = await fetch(`${baseUrl}/api/tts/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: baseUrl,
            "X-TTS-Job-Id": s.jobId,
          },
          body: JSON.stringify({
            text: s.text,
            language: s.lang,
            speakingRate: 1.0,
            pitch: 0,
            format: "wav",
            clientJobId: s.jobId,
          }),
        });
        assert.equal(res.status, 200, `Expected 200 for ${s.lang}`);
        assert.equal(res.headers.get("x-tts-language"), s.lang);
        assert.equal(res.headers.get("x-tts-job-id"), s.jobId);
        assert.equal(res.headers.get("x-tts-duration"), "2.400");
        assert.equal(res.headers.get("x-tts-sample-rate"), "22050");
        const audioBuf = Buffer.from(await res.arrayBuffer());
        assert.equal(audioBuf.subarray(0, 4).toString("ascii"), "RIFF");
        assert.equal(audioBuf.subarray(8, 12).toString("ascii"), "WAVE");
      }
      assert.equal(receivedTexts[1].text, "नमस्ते दोस्तों, आज हम वीडियो एडिटिंग सीखेंगे।");
      assert.equal(receivedTexts[2].text, "নমস্কার বন্ধুরা, আজ আমরা বাংলা ভয়েসওভার তৈরি করছি।");

      // 10f. Error path sanitization through live Express error handler
      forceErrorLeak = true;
      const errRes = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ text: "Trigger sanitized error", language: "en" }),
      });
      forceErrorLeak = false;
      assert.equal(errRes.status, 500);
      const errJson = (await errRes.json()) as { error?: string };
      assert.equal(errJson.error?.includes("C:\\secret"), false);
      assert.equal(errJson.error?.includes("/home/admin"), false);

      // 10g. Cancellation & concurrency slot protection
      forceSlowDelayMs = 7000;
      const slowJobId = "vo_cancel_race_1";
      const inFlightPromise = fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
          "X-TTS-Job-Id": slowJobId,
        },
        body: JSON.stringify({
          text: "Long narration waiting for cancel.",
          language: "en",
          clientJobId: slowJobId,
        }),
      });

      await new Promise((r) => setTimeout(r, 80));

      // Verify job snapshot is readable by owner
      const snapRes = await fetch(`${baseUrl}/api/tts/jobs/${slowJobId}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(snapRes.status, 200);

      // Second concurrent job hits TTS_MAX_CONCURRENT_JOBS=1 -> 429
      const busyRes = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ text: "Second job while busy.", language: "en" }),
      });
      assert.equal(busyRes.status, 429);

      // Cancel the first job -> Express aborts & forwards cancel to Python
      const cancelRes = await fetch(`${baseUrl}/api/tts/jobs/${slowJobId}/cancel`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: baseUrl },
      });
      assert.equal(cancelRes.status, 200);
      const finishedSlowRes = await inFlightPromise;
      assert.equal(finishedSlowRes.status, 499);
      assert.ok(cancelledJobIds.includes(slowJobId));
      forceSlowDelayMs = 0;

      // 10h. TTS_ENABLED=false returns 503 cleanly
      process.env.TTS_ENABLED = "false";
      const disabledGen = await fetch(`${baseUrl}/api/tts/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: baseUrl,
        },
        body: JSON.stringify({ text: "Should fail 503", language: "en" }),
      });
      assert.equal(disabledGen.status, 503);
      process.env.TTS_ENABLED = "true";
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
    console.log(
      "[PASS] 10. Express /api/tts/* HTTP proxy (401/403/429/499/503, UTF-8 en/hi/bn, X-TTS-* headers, path redaction)"
    );
  }

  // 11. React SSR checks for Voiceover UI components, StoryboardReviewPanel, AiGeneratorPage & MediaLibraryPage
  {
    const sb = makeBaseStoryboard();
    const voAsset = makeAudioAsset({ id: "ssr_vo_1", duration: 6.1 });
    sb.scenes[0].voiceover = createSceneVoiceoverRecord({
      scene: sb.scenes[0],
      mediaAssetId: voAsset.id,
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      voiceLabel: "Lessac (US)",
      language: "en",
      speakingRate: 1.0,
      pitch: 0,
      volume: 1.0,
      format: "wav",
      mimeType: "audio/wav",
      durationSeconds: 6.1,
      sizeBytes: 125000,
      sampleRateHz: 22050,
      channels: 1,
    });

    const ttsStatus: TtsStatusInfo = {
      enabled: true,
      available: true,
      configuredProvider: "auto",
      activeProvider: "piper",
      defaultLanguage: "en",
      supportedLanguages: ["en", "hi"],
      mp3Supported: false,
      maxTextChars: 5000,
      maxAudioMb: 20,
      providers: [
        {
          provider: "piper",
          label: "Piper Neural TTS",
          available: true,
          installed: true,
          license: "MIT runtime",
          supportedLanguages: ["en"],
          voiceCount: 1,
          message: "Ready",
        },
      ],
      message: "Local offline TTS ready.",
    };
    const voices: TtsVoiceOption[] = [
      {
        voiceId: "en_US-lessac-medium",
        provider: "piper",
        label: "Lessac (US)",
        language: "en",
        languageTag: "en-US",
        quality: "neural",
      },
    ];

    const selectorHtml = renderToString(
      React.createElement(VoiceSelector, {
        language: "bn",
        ttsStatus,
        voices,
        provider: "auto",
        speakingRate: 1.0,
        pitch: 0,
        format: "wav",
        volume: 1.0,
        onChange: () => undefined,
      })
    ).replace(/<!--\s*-->/g, "");
    assert.ok(selectorHtml.includes("No installed Bengali (bn) voices"));
    assert.ok(selectorHtml.includes("English voices are never substituted"));

    const previewHtml = renderToString(
      React.createElement(VoiceoverAudioPreview, {
        sceneId: "scene_1",
        src: "blob:http://localhost:3000/vo",
        durationSeconds: 6.1,
        volume: 1.0,
        activeAudioSceneId: null,
        onActivateSceneAudio: () => undefined,
      })
    );
    assert.ok(previewHtml.includes("audio"));

    const evaluation = evaluateSceneVoiceoverReadiness(
      sb.scenes[0],
      sb,
      new Map([[voAsset.id, voAsset]]),
      true
    );
    const cardHtml = renderToString(
      React.createElement(SceneVoiceoverCard, {
        scene: sb.scenes[0],
        sceneIndex: 0,
        storyboard: sb,
        evaluation,
        ttsStatus,
        voices,
        ttsReadyForLang: true,
        isAuthenticated: true,
        activeGenerating: false,
        batchActive: false,
        activeAudioSceneId: null,
        onActivateSceneAudio: () => undefined,
        onGenerateScene: () => undefined,
        onCancelScene: () => undefined,
        onRemoveVoiceover: () => undefined,
        onUpdateVoiceoverVolume: () => undefined,
        onAdjustSceneDuration: () => undefined,
        onFocusSceneNarration: () => undefined,
      })
    ).replace(/<!--\s*-->/g, "");
    assert.ok(cardHtml.includes("Speed Up to 1.22x"));
    assert.ok(cardHtml.includes("Extend Scene to 6.2s"));
    assert.ok(cardHtml.includes("Edit Narration"));

    const prepHtml = renderToString(
      React.createElement(StoryboardVoiceoverPrepSection, {
        storyboard: sb,
        summary: computeStoryboardVoiceoverSummary(sb, [voAsset], true),
        ttsStatus,
        ttsLoading: false,
        ttsError: null,
        voices,
        isAuthenticated: true,
        batchState: {
          active: false,
          currentSceneId: null,
          completedCount: 0,
          totalCount: 0,
          statusMessage: null,
        },
        onRefreshTts: () => undefined,
        onChangeGlobalSettings: () => undefined,
        onGenerateMissingOrStale: () => undefined,
        onRegenerateAll: () => undefined,
        onCancelBatch: () => undefined,
        onClearAllVoiceovers: () => undefined,
      })
    ).replace(/<!--\s*-->/g, "");
    assert.ok(prepHtml.includes("Storyboard Voiceover Generation (Phase 5.5.3"));
    assert.ok(prepHtml.includes("Composition Ready: No (Phase 5.5.4+)"));

    const panelHtml = renderToString(
      React.createElement(StoryboardReviewPanel, {
        storyboard: sb,
        mediaAssets: [voAsset],
        idbHydrating: false,
        ttsStatus,
        ttsVoices: voices,
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
    assert.ok(panelHtml.includes("Storyboard Voiceover Generation"));
    assert.ok(panelHtml.includes("Composition locked until Phase 5.5.4+"));

    const aiPageHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(AiGeneratorPage))
    );
    assert.ok(aiPageHtml.includes("AI Script &amp; Storyboard Generator"));

    const mediaHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(MediaLibraryPage))
    );
    assert.ok(mediaHtml.includes("Media Library"));

    console.log(
      "[PASS] 11. React SSR checks (VoiceSelector, VoiceoverAudioPreview, SceneVoiceoverCard, PrepSection, ReviewPanel, AiGeneratorPage, MediaLibraryPage)"
    );
  }

  console.log("ALL_PHASE_553_VERIFICATIONS_PASSED");
}

runTests().catch((err) => {
  console.error("Phase 5.5.3 verification failed:", err);
  process.exit(1);
});
