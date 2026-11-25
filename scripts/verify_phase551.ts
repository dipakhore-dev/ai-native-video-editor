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
import { StoryboardReviewPanel } from "../src/components/generator/StoryboardReviewPanel.tsx";
import { createRateLimiter } from "../server/middleware/rateLimit.middleware.ts";
import { requireAuth, optionalAuth } from "../server/middleware/auth.middleware.ts";
import {
  corsAllowlistMiddleware,
  csrfProtectionMiddleware,
  sanitizeRequestInputMiddleware,
  sanitizedErrorHandler,
} from "../server/middleware/security.middleware.ts";
import { validateBody, validateObjectId } from "../server/middleware/validate.middleware.ts";
import {
  createAiAssistantController,
  createGenerateStoryboardController,
  createStoryboardDraftController,
  deleteStoryboardDraftController,
  getStoryboardDraftController,
  listStoryboardDraftsController,
  updateStoryboardDraftController,
} from "../server/controllers/ai.controller.ts";
import {
  AssistantRequestSchema,
  SaveStoryboardDraftSchema,
  StoryboardGenerationInputSchema,
} from "../server/validators/aiAndExport.validators.ts";
import { StoryboardDraftModel } from "../server/models/StoryboardDraft.ts";
import { UserModel } from "../server/models/User.ts";
import {
  generateVideoStoryboard,
  hasActiveStoryboardGeneration,
  type GeminiJsonInvoker,
  type StoryboardGeminiInvoker,
} from "../server/services/ai.service.ts";
import {
  DEFAULT_GEMINI_MODEL,
  getEnvConfig,
  resolveGeminiModelCandidates,
} from "../server/config/env.ts";
import { AiEditPlanSchema, applyAiOperationsToProject } from "../src/utils/aiOperations.ts";
import {
  buildCaptionsFromScenes,
  buildNarrationFromScenes,
  createBlankStoryboardScene,
  fitSceneDurationsToTarget,
  generateUniqueSceneId,
  loadLocalStoryboardDraft,
  recalculateStoryboardTiming,
  reorderStoryboardScenes,
  saveLocalStoryboardDraft,
  validateStoryboardInvariants,
} from "../src/utils/storyboard.ts";
import type { Project, VideoStoryboard } from "../src/types/studio.ts";

function makeValidRawAiStoryboard(overrides?: Record<string, unknown>) {
  return {
    title: "Deep Focus Morning Routine",
    description: "Three concise science-backed focus habits for deep morning productivity.",
    targetAudience: "Students and creators",
    language: "English",
    totalDuration: 15,
    aspectRatio: "16:9",
    style: "Educational",
    fullNarrationScript:
      "Start your morning without notifications. Block forty minutes for your hardest task. Keep a single glass of water beside your desk.",
    backgroundMusicMood: "Minimal ambient piano, steady 90 BPM",
    captionText:
      "Silence notifications first.\nProtect 40 minutes for deep work.\nHydrate to stay sharp.",
    scenes: [
      {
        id: "scene_1",
        title: "Silence Distractions",
        startTime: 0,
        duration: 5,
        narration: "Start your morning without notifications.",
        onScreenText: "Silence notifications first",
        visualDescription: "Clean desk at sunrise with smartphone placed face down.",
        mediaKeywords: ["morning desk", "sunrise minimal", "phone face down"],
        mediaType: "video",
        transition: "fade",
        effect: "cinematic",
        cameraMotion: "slow-dolly-in",
      },
      {
        id: "scene_2",
        title: "Single Priority Block",
        startTime: 5,
        duration: 5,
        narration: "Block forty minutes for your hardest task.",
        onScreenText: "40-minute deep work block",
        visualDescription: "Focused creator typing cleanly with warm desk lamp lighting.",
        mediaKeywords: ["focused work", "laptop typing", "warm lamp"],
        mediaType: "video",
        transition: "dissolve",
        effect: "warm",
        cameraMotion: "pan-right",
      },
      {
        id: "scene_3",
        title: "Reset & Hydrate",
        startTime: 10,
        duration: 5,
        narration: "Keep a single glass of water beside your desk.",
        onScreenText: "Hydrate & stay consistent",
        visualDescription: "Glass of clear water beside an open notebook on wood surface.",
        mediaKeywords: ["water glass desk", "notebook morning"],
        mediaType: "image",
        transition: "none",
        effect: "none",
        cameraMotion: "static",
      },
    ],
    ...(overrides ?? {}),
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

async function withMockedDbAndAuth(
  fn: (ctx: {
    userAId: string;
    userBId: string;
    cookieA: string;
    cookieB: string;
    createApp: (options?: {
      geminiInvoker?: StoryboardGeminiInvoker;
      timeoutMs?: number;
    }) => express.Express;
  }) => Promise<void>
) {
  const userAId = new mongoose.Types.ObjectId().toString();
  const userBId = new mongoose.Types.ObjectId().toString();
  const jwtSecret = "test-phase551-jwt-secret-key-32-chars";

  const prevJwt = process.env.JWT_SECRET;
  const prevMongo = process.env.MONGODB_URI;
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGeminiModel = process.env.GEMINI_MODEL;
  const prevGeminiFallback = process.env.GEMINI_FALLBACK_MODELS;
  process.env.JWT_SECRET = jwtSecret;
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/verify_phase551";
  process.env.GEMINI_API_KEY = "test-gemini-placeholder-for-mock";
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODELS;

  // Simulate Mongoose connection readyState = 1 cleanly for requireAuth & in-memory draft CRUD
  const connObj = mongoose.connection as unknown as { readyState: number };
  const prevReadyState = connObj.readyState;
  connObj.readyState = 1;

  const origFindById = UserModel.findById;
  const origDraftCreate = StoryboardDraftModel.create;
  const origDraftFind = StoryboardDraftModel.find;
  const origDraftFindOne = StoryboardDraftModel.findOne;
  const origDraftFindOneAndUpdate = StoryboardDraftModel.findOneAndUpdate;
  const origDraftFindOneAndDelete = StoryboardDraftModel.findOneAndDelete;

  const draftStore = new Map<
    string,
    {
      _id: string;
      id: string;
      userId: string;
      title: string;
      sourceMode: string;
      aspectRatio: string;
      totalDuration: number;
      style: string;
      language: string;
      status: string;
      modelName: string;
      storyboard: VideoStoryboard;
      createdAt: string;
      updatedAt: string;
    }
  >();

  UserModel.findById = ((id: string) => {
    const strId = String(id);
    if (strId === userAId || strId === userBId) {
      return Promise.resolve({
        _id: new mongoose.Types.ObjectId(strId),
        fullName: strId === userAId ? "User A" : "User B",
        email: strId === userAId ? "a@example.com" : "b@example.com",
      });
    }
    return Promise.resolve(null);
  }) as unknown as typeof UserModel.findById;

  StoryboardDraftModel.create = (async (doc: Record<string, unknown>) => {
    const id = new mongoose.Types.ObjectId().toString();
    const now = new Date().toISOString();
    const stored = {
      _id: id,
      id,
      userId: String(doc.userId),
      title: String(doc.title),
      sourceMode: String(doc.sourceMode),
      aspectRatio: String(doc.aspectRatio),
      totalDuration: Number(doc.totalDuration),
      style: String(doc.style),
      language: String(doc.language),
      status: String(doc.status || "validated"),
      modelName: String(doc.modelName || DEFAULT_GEMINI_MODEL),
      storyboard: doc.storyboard as VideoStoryboard,
      createdAt: now,
      updatedAt: now,
    };
    draftStore.set(id, stored);
    return stored;
  }) as unknown as typeof StoryboardDraftModel.create;

  StoryboardDraftModel.find = ((filter: Record<string, unknown>) => {
    const uid = String(filter.userId || "");
    const list = Array.from(draftStore.values()).filter((d) => d.userId === uid);
    return {
      sort: () => ({
        limit: async (lim: number) => list.slice(0, lim),
      }),
    };
  }) as unknown as typeof StoryboardDraftModel.find;

  StoryboardDraftModel.findOne = (async (filter: Record<string, unknown>) => {
    const id = String(filter._id || "");
    const uid = String(filter.userId || "");
    const found = draftStore.get(id);
    if (!found || found.userId !== uid) return null;
    return found;
  }) as unknown as typeof StoryboardDraftModel.findOne;

  StoryboardDraftModel.findOneAndUpdate = (async (
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> }
  ) => {
    const id = String(filter._id || "");
    const uid = String(filter.userId || "");
    const found = draftStore.get(id);
    if (!found || found.userId !== uid) return null;
    const next = {
      ...found,
      ...update.$set,
      updatedAt: new Date().toISOString(),
    };
    draftStore.set(id, next as typeof found);
    return next;
  }) as unknown as typeof StoryboardDraftModel.findOneAndUpdate;

  StoryboardDraftModel.findOneAndDelete = (async (filter: Record<string, unknown>) => {
    const id = String(filter._id || "");
    const uid = String(filter.userId || "");
    const found = draftStore.get(id);
    if (!found || found.userId !== uid) return null;
    draftStore.delete(id);
    return found;
  }) as unknown as typeof StoryboardDraftModel.findOneAndDelete;

  const tokenA = jwt.sign({ sub: userAId, email: "a@example.com" }, jwtSecret, {
    algorithm: "HS256",
  });
  const tokenB = jwt.sign({ sub: userBId, email: "b@example.com" }, jwtSecret, {
    algorithm: "HS256",
  });

  const createApp = (options?: {
    geminiInvoker?: StoryboardGeminiInvoker;
    timeoutMs?: number;
  }) => {
    const app = express();
    app.use(corsAllowlistMiddleware);
    app.use(express.json({ limit: "2mb" }));
    app.use(cookieParser());
    app.use("/api", sanitizeRequestInputMiddleware);
    app.use("/api", csrfProtectionMiddleware);

    const limiter = createRateLimiter({
      name: "test-ai",
      windowMs: 60_000,
      maxRequests: 100,
      message: "Rate limited",
    });

    app.post(
      "/api/ai/storyboard",
      requireAuth,
      limiter,
      validateBody(StoryboardGenerationInputSchema),
      createGenerateStoryboardController(options)
    );
    app.get("/api/ai/storyboards", requireAuth, listStoryboardDraftsController);
    app.post(
      "/api/ai/storyboards",
      requireAuth,
      limiter,
      validateBody(SaveStoryboardDraftSchema),
      createStoryboardDraftController
    );
    app.get(
      "/api/ai/storyboards/:id",
      requireAuth,
      validateObjectId("id"),
      getStoryboardDraftController
    );
    app.patch(
      "/api/ai/storyboards/:id",
      requireAuth,
      limiter,
      validateObjectId("id"),
      validateBody(SaveStoryboardDraftSchema),
      updateStoryboardDraftController
    );
    app.delete(
      "/api/ai/storyboards/:id",
      requireAuth,
      validateObjectId("id"),
      deleteStoryboardDraftController
    );
    app.post(
      "/api/ai/assistant",
      limiter,
      optionalAuth,
      validateBody(AssistantRequestSchema),
      createAiAssistantController(
        options as { geminiInvoker?: GeminiJsonInvoker; timeoutMs?: number } | undefined
      )
    );

    app.use(sanitizedErrorHandler);
    return app;
  };

  try {
    await fn({
      userAId,
      userBId,
      cookieA: `ai_studio_token=${tokenA}`,
      cookieB: `ai_studio_token=${tokenB}`,
      createApp,
    });
  } finally {
    connObj.readyState = prevReadyState;
    UserModel.findById = origFindById;
    StoryboardDraftModel.create = origDraftCreate;
    StoryboardDraftModel.find = origDraftFind;
    StoryboardDraftModel.findOne = origDraftFindOne;
    StoryboardDraftModel.findOneAndUpdate = origDraftFindOneAndUpdate;
    StoryboardDraftModel.findOneAndDelete = origDraftFindOneAndDelete;
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
    if (prevMongo === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prevMongo;
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
    if (prevGeminiModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevGeminiModel;
    if (prevGeminiFallback === undefined) delete process.env.GEMINI_FALLBACK_MODELS;
    else process.env.GEMINI_FALLBACK_MODELS = prevGeminiFallback;
  }
}

async function runTests() {
  console.log("Running Phase 5.5.1 AI Script & Storyboard verification suite (mocked Gemini)...");

  await withMockedDbAndAuth(async ({ userAId, cookieA, cookieB, createApp }) => {
    // 1. Valid prompt-to-storyboard request (default gemini-3.5-flash, mocked Gemini)
    {
      const seenModels: string[] = [];
      const app = createApp({
        geminiInvoker: async ({ model }) => {
          seenModels.push(model);
          return { text: JSON.stringify(makeValidRawAiStoryboard()) };
        },
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            title: "Morning Focus Routine",
            prompt: "Create a 15s educational video on deep morning focus habits.",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Educational",
            language: "English",
            voiceoverEnabled: true,
            voiceoverPreference: "natural_narrator",
            captionsEnabled: true,
            captionStyle: "clean_subtitles",
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          status: string;
          model: string;
          storyboard: VideoStoryboard;
        };
        assert.equal(body.status, "ok");
        assert.deepEqual(seenModels, ["gemini-3.5-flash"]);
        assert.equal(body.model, "gemini-3.5-flash");
        assert.equal(body.storyboard.model, "gemini-3.5-flash");
        assert.equal(body.storyboard.title, "Morning Focus Routine");
        assert.equal(body.storyboard.totalDuration, 15);
        assert.equal(body.storyboard.scenes.length, 3);
        assert.equal(body.storyboard.compositionReady, false);
        assert.equal(validateStoryboardInvariants(body.storyboard).valid, true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 1. Valid prompt-to-storyboard request with default gemini-3.5-flash (mocked Gemini)");
    }

    // 2. Valid script-to-storyboard request (mocked Gemini, 30s Bengali)
    {
      const scriptRaw = makeValidRawAiStoryboard({
        title: "সকালের ফোকাস অভ্যাস",
        language: "Bengali",
        totalDuration: 30,
        aspectRatio: "9:16",
        style: "Motivational",
        scenes: [
          {
            id: "scene_1",
            title: "শুরু করুন শান্তভাবে",
            startTime: 0,
            duration: 10,
            narration: "সকালে ঘুম থেকে উঠে ফোন থেকে দূরে থাকুন।",
            onScreenText: "প্রথম ১০ মিনিট ফোন নয়",
            visualDescription: "সকালের রোদে পরিষ্কার পড়ার টেবিল।",
            mediaKeywords: ["morning desk", "sunlight"],
            mediaType: "video",
            transition: "fade",
            effect: "warm",
            cameraMotion: "slow-dolly-in",
          },
          {
            id: "scene_2",
            title: "একটি কাজের লক্ষ্য",
            startTime: 10,
            duration: 20,
            narration: "দিনের সবচেয়ে গুরুত্বপূর্ণ কাজটি আগে শেষ করুন।",
            onScreenText: "একটি কাজ, সম্পূর্ণ মনোযোগ",
            visualDescription: "নোটবুকে কাজের তালিকা লেখা হচ্ছে।",
            mediaKeywords: ["writing notebook", "focus"],
            mediaType: "video",
            transition: "dissolve",
            effect: "cinematic",
            cameraMotion: "static",
          },
        ],
      });
      const app = createApp({
        geminiInvoker: async () => ({ text: JSON.stringify(scriptRaw) }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "script-to-video",
            prompt:
              "সকালে ঘুম থেকে উঠে ফোন থেকে দূরে থাকুন। দিনের সবচেয়ে গুরুত্বপূর্ণ কাজটি আগে শেষ করুন।",
            targetDurationSec: 30,
            aspectRatio: "9:16",
            style: "Motivational",
            language: "Bengali",
            voiceoverEnabled: false,
            voiceoverPreference: "none",
            captionsEnabled: true,
            captionStyle: "bold_social",
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { storyboard: VideoStoryboard };
        assert.equal(body.storyboard.sourceMode, "script-to-video");
        assert.equal(body.storyboard.language, "Bengali");
        assert.equal(body.storyboard.totalDuration, 30);
        assert.equal(body.storyboard.settings.voiceoverPreference, "none");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 2. Valid script-to-storyboard request (mocked Gemini)");
    }

    // 3. Invalid input rejection + 4. Auth requirements
    {
      const app = createApp({
        geminiInvoker: async () => ({ text: JSON.stringify(makeValidRawAiStoryboard()) }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        // Unauthenticated POST rejected with 401
        const unauthRes = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Valid prompt longer than 10 chars",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(unauthRes.status, 401);

        // Unauthenticated draft endpoints rejected with 401
        const unauthDrafts = await fetch(`${baseUrl}/api/ai/storyboards`);
        assert.equal(unauthDrafts.status, 401);

        // Image-animation mode rejected cleanly with 400
        const imgAnimRes = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "image-animation",
            prompt: "Animate still image gently",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(imgAnimRes.status, 400);

        // Invalid duration & short prompt rejected with 400
        const badDurationRes = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Hi",
            targetDurationSec: 45,
            aspectRatio: "21:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(badDurationRes.status, 400);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 3 & 4. Invalid input rejection & authentication requirements");
    }

    // 5. User ownership isolation & 14. Draft persistence and restoration
    {
      const app = createApp({
        geminiInvoker: async () => ({ text: JSON.stringify(makeValidRawAiStoryboard()) }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const genRes = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Deep focus morning routine tutorial",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Educational",
            language: "English",
          }),
        });
        const { storyboard } = (await genRes.json()) as { storyboard: VideoStoryboard };

        // User A saves draft
        const saveRes = await fetch(`${baseUrl}/api/ai/storyboards`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({ status: "validated", storyboard }),
        });
        assert.equal(saveRes.status, 201);
        const savedBody = (await saveRes.json()) as { draft: { _id: string; title: string } };
        const draftId = savedBody.draft._id;
        assert.ok(draftId);

        // User B cannot see, fetch, patch, or delete User A's draft
        const listB = await (
          await fetch(`${baseUrl}/api/ai/storyboards`, { headers: { Cookie: cookieB } })
        ).json();
        assert.equal((listB as { drafts: unknown[] }).drafts.length, 0);

        const getB = await fetch(`${baseUrl}/api/ai/storyboards/${draftId}`, {
          headers: { Cookie: cookieB },
        });
        assert.equal(getB.status, 404);

        const patchB = await fetch(`${baseUrl}/api/ai/storyboards/${draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: cookieB },
          body: JSON.stringify({ status: "validated", storyboard }),
        });
        assert.equal(patchB.status, 404);

        const delB = await fetch(`${baseUrl}/api/ai/storyboards/${draftId}`, {
          method: "DELETE",
          headers: { Cookie: cookieB },
        });
        assert.equal(delB.status, 404);

        // User A restores & updates draft cleanly
        const updatedStoryboard: VideoStoryboard = {
          ...storyboard,
          title: "Deep Focus Morning Routine v2",
        };
        const patchA = await fetch(`${baseUrl}/api/ai/storyboards/${draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({ status: "validated", storyboard: updatedStoryboard }),
        });
        assert.equal(patchA.status, 200);

        const getA = await fetch(`${baseUrl}/api/ai/storyboards/${draftId}`, {
          headers: { Cookie: cookieA },
        });
        assert.equal(getA.status, 200);
        const restoredA = (await getA.json()) as { draft: { storyboard: VideoStoryboard } };
        assert.equal(restoredA.draft.storyboard.title, "Deep Focus Morning Routine v2");

        // Also test isolated localStorage draft helper
        const fakeStorage = new Map<string, string>();
        (globalThis as unknown as { window: unknown }).window = {
          localStorage: {
            getItem: (k: string) => fakeStorage.get(k) ?? null,
            setItem: (k: string, v: string) => {
              fakeStorage.set(k, v);
            },
            removeItem: (k: string) => {
              fakeStorage.delete(k);
            },
          },
        };
        try {
          const savedLocal = saveLocalStoryboardDraft(
            {
              id: updatedStoryboard.id,
              serverDraftId: draftId,
              title: updatedStoryboard.title,
              status: "validated",
              storyboard: updatedStoryboard,
              savedAt: new Date().toISOString(),
            },
            userAId
          );
          assert.equal(savedLocal, true);
          const restoredLocal = loadLocalStoryboardDraft(userAId);
          assert.ok(restoredLocal);
          assert.equal(restoredLocal.storyboard.title, "Deep Focus Morning Routine v2");
          assert.equal(restoredLocal.serverDraftId, draftId);
        } finally {
          delete (globalThis as unknown as { window?: unknown }).window;
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 5 & 14. User ownership isolation & draft persistence/restoration");
    }

    // 6. Invalid AI JSON rejection
    {
      const app = createApp({
        geminiInvoker: async () => ({ text: "{not valid json:::" }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Valid prompt for malformed JSON test",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /JSON/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 6. Invalid AI JSON rejection");
    }

    // 7. Missing required AI response fields
    {
      const missingFields = makeValidRawAiStoryboard();
      delete (missingFields as { backgroundMusicMood?: string }).backgroundMusicMood;
      const app = createApp({
        geminiInvoker: async () => ({ text: JSON.stringify(missingFields) }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Valid prompt for missing fields test",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(res.status, 422);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 7. Missing required AI response fields rejected");
    }

    // 8. Scene duration validation & 9. Sequential scene timing & 10. Duplicate IDs & 11. Unsupported effects/transitions
    {
      const invalidCases: Array<{ label: string; mutate: (raw: ReturnType<typeof makeValidRawAiStoryboard>) => void }> = [
        {
          label: "Negative / invalid duration",
          mutate: (raw) => {
            raw.scenes[0].duration = -2;
          },
        },
        {
          label: "Total duration mismatch",
          mutate: (raw) => {
            raw.scenes[2].duration = 8; // sum 18 != 15
          },
        },
        {
          label: "Overlapping / non-sequential scene startTime",
          mutate: (raw) => {
            raw.scenes[1].startTime = 3; // overlaps scene 1 (0..5)
          },
        },
        {
          label: "Duplicate scene ID",
          mutate: (raw) => {
            raw.scenes[1].id = "scene_1";
          },
        },
        {
          label: "Unsupported transition",
          mutate: (raw) => {
            raw.scenes[0].transition = "glitch_warp" as unknown as "fade";
          },
        },
        {
          label: "Unsupported effect",
          mutate: (raw) => {
            raw.scenes[0].effect = "neon_explosion" as unknown as "cinematic";
          },
        },
      ];

      for (const testCase of invalidCases) {
        const payload = makeValidRawAiStoryboard();
        testCase.mutate(payload);
        const app = createApp({
          geminiInvoker: async () => ({ text: JSON.stringify(payload) }),
        });
        const { server, baseUrl } = await startTempServer(app);
        try {
          const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Prompt for AI invariant check",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Educational",
              language: "English",
            }),
          });
          assert.equal(res.status, 422, `Expected 422 for ${testCase.label}, got ${res.status}`);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
      console.log(
        "[PASS] 8, 9, 10 & 11. Scene duration, sequential timing, duplicate IDs, and unsupported effects/transitions rejected"
      );
    }

    // 12 & 13. Scene reordering and editing helpers + unique ID creation
    {
      const app = createApp({
        geminiInvoker: async () => ({ text: JSON.stringify(makeValidRawAiStoryboard()) }),
      });
      const { server, baseUrl } = await startTempServer(app);
      let sb: VideoStoryboard;
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Deep focus morning routine tutorial",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Educational",
            language: "English",
          }),
        });
        sb = ((await res.json()) as { storyboard: VideoStoryboard }).storyboard;
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // Reorder scene 2 -> index 0 and verify sequential startTime recalculation
      const reordered = reorderStoryboardScenes(sb.scenes, 2, 0);
      assert.equal(reordered[0].id, "scene_3");
      assert.equal(reordered[0].startTime, 0);
      assert.equal(reordered[1].startTime, 5);
      assert.equal(reordered[2].startTime, 10);

      // Edit duration, verify mismatch detected, then fit back to target
      const edited = recalculateStoryboardTiming(
        reordered.map((s, idx) =>
          idx === 0
            ? {
                ...s,
                title: "Edited Hook",
                duration: 8,
                narration: "Updated hook narration",
                onScreenText: "Hook text",
                visualDescription: "Updated close-up shot",
                mediaKeywords: ["close-up", "desk"],
              }
            : s
        )
      );
      assert.equal(edited[1].startTime, 8);
      assert.equal(edited[2].startTime, 13);
      const mismatchCheck = validateStoryboardInvariants({
        totalDuration: sb.totalDuration,
        scenes: edited,
      });
      assert.equal(mismatchCheck.valid, false);
      assert.equal(mismatchCheck.actualDuration, 18);

      const fitted = fitSceneDurationsToTarget(edited, sb.totalDuration);
      assert.equal(
        validateStoryboardInvariants({ totalDuration: sb.totalDuration, scenes: fitted }).valid,
        true
      );

      const uniqueId = generateUniqueSceneId(fitted);
      assert.equal(fitted.some((s) => s.id === uniqueId), false);
      const added = createBlankStoryboardScene(fitted, 3);
      assert.equal(added.startTime, 15);
      assert.ok(buildNarrationFromScenes(fitted).includes("Updated hook narration"));
      assert.ok(buildCaptionsFromScenes(fitted).includes("Hook text"));
      console.log("[PASS] 12 & 13. Scene reordering, editing, timing recalculation & validation");
    }

    // 15. Missing Gemini configuration
    {
      const savedKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      try {
        await assert.rejects(
          () =>
            generateVideoStoryboard({
              userId: userAId,
              request: {
                mode: "prompt-to-video",
                title: "",
                prompt: "Test missing key error handling cleanly",
                targetDurationSec: 15,
                aspectRatio: "16:9",
                style: "Cinematic",
                language: "English",
                voiceoverEnabled: true,
                voiceoverPreference: "natural_narrator",
                captionsEnabled: true,
                captionStyle: "clean_subtitles",
                targetAudience: "",
                additionalInstructions: "",
              },
            }),
          (err: unknown) => (err as { statusCode?: number }).statusCode === 503
        );
      } finally {
        process.env.GEMINI_API_KEY = savedKey;
      }
      console.log("[PASS] 15. Missing Gemini configuration returns 503 integration error");
    }

    // 16. Gemini timeout
    {
      const app = createApp({
        timeoutMs: 80,
        geminiInvoker: async ({ abortSignal }) =>
          new Promise<{ text?: string }>((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => reject(new Error("Aborted")));
          }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Timeout test prompt",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(res.status, 504);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 16. Gemini timeout returns 504");
    }

    // 17. Gemini quota exhaustion (no wasteful retries)
    {
      let callCount = 0;
      const app = createApp({
        geminiInvoker: async () => {
          callCount += 1;
          throw new Error("429 RESOURCE_EXHAUSTED: Free tier quota exceeded");
        },
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Quota exhaustion test prompt",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(res.status, 429);
        assert.equal(callCount, 1, "Must fail fast without wasting quota on repeated retries");
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /quota/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 17. Gemini quota exhaustion returns 429 cleanly without retries");
    }

    // 18. Duplicate submission protection & 19. Cancellation behavior
    {
      let releaseFirst: (() => void) | null = null;
      let abortedObserved = false;
      const app = createApp({
        geminiInvoker: async ({ abortSignal }) =>
          new Promise<{ text?: string }>((resolve, reject) => {
            releaseFirst = () => resolve({ text: JSON.stringify(makeValidRawAiStoryboard()) });
            abortSignal.addEventListener("abort", () => {
              abortedObserved = true;
              reject(new Error("Aborted"));
            });
          }),
      });
      const { server, baseUrl } = await startTempServer(app);
      try {
        const clientAbort = new AbortController();
        const firstPromise = fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "First active storyboard generation request",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
          signal: clientAbort.signal,
        });

        // Wait briefly until first request holds the per-user lock
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(hasActiveStoryboardGeneration(userAId), true);

        // Concurrent duplicate submission from same user must receive 409 Conflict
        const dupRes = await fetch(`${baseUrl}/api/ai/storyboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({
            mode: "prompt-to-video",
            prompt: "Concurrent duplicate submission",
            targetDurationSec: 15,
            aspectRatio: "16:9",
            style: "Cinematic",
            language: "English",
          }),
        });
        assert.equal(dupRes.status, 409);

        // Cancel first request via AbortController
        clientAbort.abort();
        await assert.rejects(firstPromise);
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(abortedObserved, true);
        assert.equal(
          hasActiveStoryboardGeneration(userAId),
          false,
          "Cancellation must release active user lock cleanly"
        );
        void releaseFirst;
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log("[PASS] 18 & 19. Duplicate submission protection (409) & cancellation cleanup");
    }

    // 20. Existing AI Editing Assistant compatibility + SSR smoke check of AiGeneratorPage & StoryboardReviewPanel
    {
      const sampleProject: Project = {
        id: "proj_compat",
        name: "Compat Project",
        description: "",
        aspectRatio: "16:9",
        resolution: "1080p",
        fps: 24,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracks: [
          { id: "track_v1", name: "V1", type: "video", muted: false, locked: false },
          { id: "track_v2", name: "V2", type: "overlay", muted: false, locked: false },
          { id: "track_t1", name: "T1", type: "text", muted: false, locked: false },
          { id: "track_a1", name: "A1", type: "audio", muted: false, locked: false },
        ],
        clips: [
          {
            id: "clip_1",
            assetId: "asset_1",
            trackId: "track_v1",
            name: "Intro.mp4",
            kind: "video",
            startTime: 0,
            duration: 10,
            inPoint: 0,
            sourceDuration: 10,
            volume: 1,
            speed: 1,
            opacity: 1,
            objectUrl: "",
          },
        ],
      };

      const plan = AiEditPlanSchema.parse({
        summary: "Apply cinematic look",
        operations: [
          {
            type: "set_clip_effects",
            clipId: "clip_1",
            preset: "cinematic",
            reason: "Style test",
          },
        ],
      });
      const applied = applyAiOperationsToProject(sampleProject, plan.operations);
      assert.equal(applied.appliedCount, 1);
      assert.equal(applied.project.clips[0].effects?.preset, "cinematic");

      const htmlPage = renderToString(
        React.createElement(StudioProvider, null, React.createElement(AiGeneratorPage))
      );
      assert.ok(htmlPage.includes("AI Script &amp; Storyboard Generator"));
      assert.ok(htmlPage.includes("Prompt to Video"));
      assert.ok(htmlPage.includes("Script to Video"));
      assert.ok(htmlPage.includes("Image Animation"));

      const validStoryboard: VideoStoryboard = {
        id: "sb_ssr",
        title: "SSR Storyboard",
        description: "Test storyboard",
        targetAudience: "Creators",
        language: "English",
        totalDuration: 15,
        aspectRatio: "16:9",
        style: "Cinematic",
        fullNarrationScript: "Hello world.",
        backgroundMusicMood: "Calm",
        captionText: "Hello world.",
        sourceMode: "prompt-to-video",
        compositionReady: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settings: {
          mode: "prompt-to-video",
          targetDurationSec: 15,
          aspectRatio: "16:9",
          style: "Cinematic",
          language: "English",
          voiceoverEnabled: true,
          voiceoverPreference: "natural_narrator",
          captionsEnabled: true,
          captionStyle: "clean_subtitles",
          targetAudience: "Creators",
          additionalInstructions: "",
        },
        scenes: makeValidRawAiStoryboard().scenes as VideoStoryboard["scenes"],
      };

      const panelHtml = renderToString(
        React.createElement(StoryboardReviewPanel, {
          storyboard: validStoryboard,
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
      const normalizedPanelHtml = panelHtml.replace(/<!--\s*-->/g, "");
      assert.ok(normalizedPanelHtml.includes("Scene Breakdown (3)"));
      assert.ok(normalizedPanelHtml.includes("Save Storyboard Draft"));
      console.log("[PASS] 20. Existing AI Editing Assistant compatibility & SSR UI verification");
    }

    // 21. Configurable primary model & deduplication
    {
      process.env.GEMINI_MODEL = "models/gemini-custom-flash";
      process.env.GEMINI_FALLBACK_MODELS =
        "gemini-custom-flash, gemini-backup-a, gemini-backup-a, gemini-backup-b, gemini-backup-c";
      try {
        const cfg = getEnvConfig();
        assert.equal(cfg.geminiModel, "gemini-custom-flash");
        assert.deepEqual(resolveGeminiModelCandidates(), [
          "gemini-custom-flash",
          "gemini-backup-a",
          "gemini-backup-b",
        ]);

        const seen: string[] = [];
        const app = createApp({
          geminiInvoker: async ({ model }) => {
            seen.push(model);
            return { text: JSON.stringify(makeValidRawAiStoryboard()) };
          },
        });
        const { server, baseUrl } = await startTempServer(app);
        try {
          const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Test custom configured primary Gemini model",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Cinematic",
              language: "English",
            }),
          });
          assert.equal(res.status, 200);
          const body = (await res.json()) as { model: string; storyboard: VideoStoryboard };
          assert.deepEqual(seen, ["gemini-custom-flash"]);
          assert.equal(body.model, "gemini-custom-flash");
          assert.equal(body.storyboard.model, "gemini-custom-flash");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        delete process.env.GEMINI_MODEL;
        delete process.env.GEMINI_FALLBACK_MODELS;
      }
      console.log("[PASS] 21. Configurable primary model & duplicate candidate deduplication");
    }

    // 22. Optional fallback after 503 UNAVAILABLE & empty fallback handling
    {
      // 22a: Empty fallback fails immediately on 503 after 1 call
      process.env.GEMINI_MODEL = "gemini-3.5-flash";
      process.env.GEMINI_FALLBACK_MODELS = "";
      {
        const attempts: string[] = [];
        const app = createApp({
          geminiInvoker: async ({ model }) => {
            attempts.push(model);
            throw Object.assign(new Error("503 UNAVAILABLE: Model overloaded"), { status: 503 });
          },
        });
        const { server, baseUrl } = await startTempServer(app);
        try {
          const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Test empty fallback on 503",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Cinematic",
              language: "English",
            }),
          });
          assert.equal(res.status, 503);
          assert.deepEqual(attempts, ["gemini-3.5-flash"]);
          const body = (await res.json()) as { errorCategory?: string };
          assert.equal(body.errorCategory, "UNAVAILABLE");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }

      // 22b: Configured fallback succeeds after primary 503 and records fallback model metadata
      process.env.GEMINI_MODEL = "gemini-3.5-flash";
      process.env.GEMINI_FALLBACK_MODELS = "gemini-fallback-ok";
      {
        const attempts: string[] = [];
        const app = createApp({
          geminiInvoker: async ({ model }) => {
            attempts.push(model);
            if (model === "gemini-3.5-flash") {
              throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
            }
            return { text: JSON.stringify(makeValidRawAiStoryboard()) };
          },
        });
        const { server, baseUrl } = await startTempServer(app);
        try {
          const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Test fallback after 503",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Cinematic",
              language: "English",
            }),
          });
          assert.equal(res.status, 200);
          assert.deepEqual(attempts, ["gemini-3.5-flash", "gemini-fallback-ok"]);
          const body = (await res.json()) as { model: string; storyboard: VideoStoryboard };
          assert.equal(body.model, "gemini-fallback-ok");
          assert.equal(body.storyboard.model, "gemini-fallback-ok");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }

      // 22c: All configured models unavailable (capped at max 3 attempts)
      process.env.GEMINI_MODEL = "m1";
      process.env.GEMINI_FALLBACK_MODELS = "m2,m3,m4";
      {
        const attempts: string[] = [];
        const app = createApp({
          geminiInvoker: async ({ model }) => {
            attempts.push(model);
            throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
          },
        });
        const { server, baseUrl } = await startTempServer(app);
        try {
          const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Test all models unavailable",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Cinematic",
              language: "English",
            }),
          });
          assert.equal(res.status, 503);
          assert.deepEqual(attempts, ["m1", "m2", "m3"]);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }

      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
      console.log("[PASS] 22. Empty fallback, 503 fallback recovery, and max-attempt limit");
    }

    // 23. No fallback on auth errors (401/403), invalid arguments (400), not found (404), safety blocks, or quota (429)
    {
      process.env.GEMINI_MODEL = "gemini-3.5-flash";
      process.env.GEMINI_FALLBACK_MODELS = "gemini-fallback-should-not-run";
      try {
        const nonRetryCases = [
          {
            label: "401 UNAUTHENTICATED",
            err: Object.assign(new Error("401 UNAUTHENTICATED"), { status: 401 }),
            expectedHttp: 503,
            expectedCategory: "UNAUTHENTICATED",
          },
          {
            label: "403 PERMISSION_DENIED",
            err: Object.assign(new Error("403 PERMISSION_DENIED"), { status: 403 }),
            expectedHttp: 403,
            expectedCategory: "PERMISSION_DENIED",
          },
          {
            label: "400 INVALID_ARGUMENT",
            err: Object.assign(new Error("400 INVALID_ARGUMENT"), { status: 400 }),
            expectedHttp: 400,
            expectedCategory: "INVALID_ARGUMENT",
          },
          {
            label: "404 NOT_FOUND",
            err: Object.assign(new Error("404 NOT_FOUND"), { status: 404 }),
            expectedHttp: 404,
            expectedCategory: "NOT_FOUND",
          },
          {
            label: "429 RESOURCE_EXHAUSTED",
            err: Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 }),
            expectedHttp: 429,
            expectedCategory: "RESOURCE_EXHAUSTED",
          },
          {
            label: "SAFETY_BLOCK",
            err: new Error("SAFETY: blocked by filter"),
            expectedHttp: 422,
            expectedCategory: "SAFETY_BLOCK",
          },
        ];

        for (const c of nonRetryCases) {
          const attempts: string[] = [];
          const app = createApp({
            geminiInvoker: async ({ model }) => {
              attempts.push(model);
              throw c.err;
            },
          });
          const { server, baseUrl } = await startTempServer(app);
          try {
            const res = await fetch(`${baseUrl}/api/ai/storyboard`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Cookie: cookieA },
              body: JSON.stringify({
                mode: "prompt-to-video",
                prompt: `Test non-retryable ${c.label}`,
                targetDurationSec: 15,
                aspectRatio: "16:9",
                style: "Cinematic",
                language: "English",
              }),
            });
            assert.equal(res.status, c.expectedHttp, `${c.label} status mismatch`);
            assert.deepEqual(
              attempts,
              ["gemini-3.5-flash"],
              `${c.label} must NOT invoke fallback model`
            );
            const body = (await res.json()) as { errorCategory?: string };
            assert.equal(body.errorCategory, c.expectedCategory);
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      } finally {
        delete process.env.GEMINI_MODEL;
        delete process.env.GEMINI_FALLBACK_MODELS;
      }
      console.log("[PASS] 23. No fallback on 400, 401, 403, 404, 429, or safety blocks");
    }

    // 24. Cancellation stops fallback immediately & AI Editing Assistant end-to-end compatibility
    {
      process.env.GEMINI_MODEL = "gemini-3.5-flash";
      process.env.GEMINI_FALLBACK_MODELS = "gemini-assistant-fallback";
      try {
        // 24a: Cancellation during primary 503 / hang must not invoke fallback
        const cancelAttempts: string[] = [];
        const abortApp = createApp({
          geminiInvoker: async ({ model, abortSignal }) => {
            cancelAttempts.push(model);
            return new Promise<{ text?: string }>((_resolve, reject) => {
              abortSignal.addEventListener("abort", () => reject(new Error("Aborted")), {
                once: true,
              });
            });
          },
        });
        const abortSrv = await startTempServer(abortApp);
        try {
          const clientAbort = new AbortController();
          const reqPromise = fetch(`${abortSrv.baseUrl}/api/ai/storyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieA },
            body: JSON.stringify({
              mode: "prompt-to-video",
              prompt: "Cancel before fallback",
              targetDurationSec: 15,
              aspectRatio: "16:9",
              style: "Cinematic",
              language: "English",
            }),
            signal: clientAbort.signal,
          });
          await new Promise((r) => setTimeout(r, 30));
          clientAbort.abort();
          await assert.rejects(reqPromise);
          await new Promise((r) => setTimeout(r, 40));
          assert.deepEqual(cancelAttempts, ["gemini-3.5-flash"]);
          assert.equal(hasActiveStoryboardGeneration(userAId), false);
        } finally {
          await new Promise<void>((resolve) => abortSrv.server.close(() => resolve()));
        }

        // 24b: POST /api/ai/assistant uses shared model selection + fallback and returns actual model
        const assistantAttempts: string[] = [];
        const assistantApp = createApp({
          geminiInvoker: async ({ model }) => {
            assistantAttempts.push(model);
            if (model === "gemini-3.5-flash") {
              throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
            }
            return {
              text: JSON.stringify({
                summary: "Applied cinematic preset to first clip.",
                operations: [
                  {
                    type: "set_clip_effects",
                    clipId: "clip_1",
                    preset: "cinematic",
                    reason: "Requested cinematic look",
                  },
                ],
              }),
            };
          },
        });
        const assistantSrv = await startTempServer(assistantApp);
        try {
          const res = await fetch(`${assistantSrv.baseUrl}/api/ai/assistant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: "Apply cinematic filter to clip 1",
              timelineMetadata: {
                projectId: "local_proj",
                projectName: "Test Cut",
                aspectRatio: "16:9",
                resolution: "1080p",
                fps: 24,
                durationSeconds: 10,
                selectedClipId: "clip_1",
                playheadTime: 0,
                clips: [
                  {
                    id: "clip_1",
                    name: "Intro.mp4",
                    kind: "video",
                    trackId: "track_v1",
                    startTime: 0,
                    duration: 10,
                    inPoint: 0,
                    sourceDuration: 10,
                    speed: 1,
                    volume: 1,
                  },
                ],
              },
            }),
          });
          assert.equal(res.status, 200);
          const body = (await res.json()) as {
            status: string;
            model: string;
            plan: { summary: string; operations: unknown[] };
          };
          assert.equal(body.status, "ok");
          assert.deepEqual(assistantAttempts, ["gemini-3.5-flash", "gemini-assistant-fallback"]);
          assert.equal(body.model, "gemini-assistant-fallback");
          assert.equal(body.plan.operations.length, 1);
        } finally {
          await new Promise<void>((resolve) => assistantSrv.server.close(() => resolve()));
        }
      } finally {
        delete process.env.GEMINI_MODEL;
        delete process.env.GEMINI_FALLBACK_MODELS;
      }
      console.log("[PASS] 24. Cancellation prevents fallback & AI Editing Assistant uses shared model selection");
    }
  });

  console.log("ALL_PHASE_551_VERIFICATIONS_PASSED");
}

runTests().catch((err) => {
  console.error("Phase 5.5.1 verification failed:", err);
  process.exit(1);
});
