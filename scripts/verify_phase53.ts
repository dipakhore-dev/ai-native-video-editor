import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import React from "react";
import { renderToString } from "react-dom/server";
import type { AuthenticatedRequest } from "../server/middleware/auth.middleware.ts";
import { validateBody, validateObjectId } from "../server/middleware/validate.middleware.ts";
import {
  createProjectController,
  deleteProjectController,
  duplicateProjectController,
  listProjectsController,
  updateProjectController,
} from "../server/controllers/project.controller.ts";
import {
  deleteVideoJobController,
  listVideoJobsController,
} from "../server/controllers/videoProcessing.controller.ts";
import { CreateProjectSchema, UpdateProjectSchema } from "../server/validators/project.validators.ts";
import { ProjectModel } from "../server/models/Project.ts";
import { ExportJobModel } from "../server/models/ExportJob.ts";
import { VideoJobModel } from "../server/models/VideoJob.ts";
import { updateUserExportJobStatus } from "../server/services/export.service.ts";
import { StudioProvider } from "../src/context/StudioContext.tsx";
import { DashboardPage } from "../src/pages/DashboardPage.tsx";
import { ProjectsPage } from "../src/pages/ProjectsPage.tsx";
import { ExportsPage } from "../src/pages/ExportsPage.tsx";
import { CreateProjectModal } from "../src/components/common/CreateProjectModal.tsx";
import { ConfirmDialog } from "../src/components/common/ConfirmDialog.tsx";
import { serializeClipForServer } from "../src/services/api.ts";
import type { ExportAttempt, MediaAsset, Project } from "../src/types/studio.ts";
import {
  canRetryExportAttempt,
  clearInMemoryExportBlobs,
  deleteExportFileBlob,
  getExportFileBlob,
  hasExportFileAvailable,
  listAvailableExportFileIds,
  mapServerVideoJobToExportAttempt,
  MAX_CACHED_EXPORT_FILES,
  saveExportFileBlob,
  upsertExportAttemptSafely,
  type ServerVideoJobDto,
  type StoredExportFileRecord,
} from "../src/utils/exportHistoryStorage.ts";
import { clearAllMediaCaches, projectThumbnailCache } from "../src/utils/mediaCache.ts";
import { findOrphanedAssetIds, reconcileProjectWithMediaAssets } from "../src/utils/mediaStorage.ts";
import {
  computeProjectThumbnailFingerprint,
  getOrCreateProjectThumbnail,
  getProjectMediaHealth,
  renderFallbackProjectThumbnailDataUrl,
} from "../src/utils/projectThumbnails.ts";
import { createProjectFromTemplate, PROJECT_TEMPLATES } from "../src/utils/templates.ts";
import { createDefaultTracks } from "../src/utils/timeline.ts";

function installDomStorageShim() {
  const g = globalThis as Record<string, unknown>;
  const origWindow = g.window;
  const origLocalStorage = g.localStorage;
  const store = new Map<string, string>();
  g.window = { location: { origin: "http://localhost:3000" }, scrollTo: () => undefined };
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return () => {
    g.window = origWindow;
    g.localStorage = origLocalStorage;
  };
}

function createInMemoryIdbFactory(): IDBFactory {
  const stores = new Map<string, Map<string, StoredExportFileRecord>>();

  const makeReq = <T,>(run: () => T) => {
    const req: {
      result: T | undefined;
      error: DOMException | null;
      onsuccess: ((ev: Event) => void) | null;
      onerror: ((ev: Event) => void) | null;
    } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.(new Event("success"));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.(new Event("error"));
      }
    });
    return req;
  };

  const factory = {
    open(name: string) {
      const openReq: {
        result: unknown;
        error: DOMException | null;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        if (!stores.has(name)) {
          stores.set(name, new Map());
        }
        const table = stores.get(name)!;
        const fakeDb = {
          objectStoreNames: {
            contains: (storeName: string) => storeName === "export_files",
          },
          createObjectStore: () => ({}),
          close: () => undefined,
          transaction: (_storeName: string, _mode: IDBTransactionMode) => {
            const tx: {
              error: DOMException | null;
              oncomplete: ((ev: Event) => void) | null;
              onabort: ((ev: Event) => void) | null;
              onerror: ((ev: Event) => void) | null;
              objectStore: () => Record<string, unknown>;
            } = {
              error: null,
              oncomplete: null,
              onabort: null,
              onerror: null,
              objectStore: () => ({
                getAll: () => makeReq(() => Array.from(table.values())),
                get: (id: string) => makeReq(() => table.get(id)),
                put: (record: StoredExportFileRecord) =>
                  makeReq(() => {
                    table.set(record.id, record);
                    return record.id;
                  }),
                delete: (id: string) =>
                  makeReq(() => {
                    table.delete(id);
                    return undefined;
                  }),
              }),
            };
            queueMicrotask(() => {
              queueMicrotask(() => {
                tx.oncomplete?.(new Event("complete"));
              });
            });
            return tx;
          },
        };
        openReq.result = fakeDb;
        openReq.onupgradeneeded?.({} as IDBVersionChangeEvent);
        openReq.onsuccess?.(new Event("success"));
      });

      return openReq as unknown as IDBOpenDBRequest;
    },
  };

  return factory as unknown as IDBFactory;
}

async function testTemplatesAndKeyframePreservation() {
  assert.equal(PROJECT_TEMPLATES.length, 3, "Must define exactly 3 starter templates");
  const expected = [
    { id: "youtube-landscape", aspectRatio: "16:9" },
    { id: "instagram-reels", aspectRatio: "9:16" },
    { id: "square-social", aspectRatio: "1:1" },
  ] as const;

  for (const item of expected) {
    const project = createProjectFromTemplate(item.id);
    assert.equal(project.aspectRatio, item.aspectRatio);
    assert.equal(project.resolution, "1080p");
    assert.equal(project.fps, 30);
    assert.ok(project.clips.length >= 3, `Template ${item.id} must create editable starter clips`);
    assert.ok(
      project.clips.some((c) => (c.keyframes?.length ?? 0) > 0),
      `Template ${item.id} must include animated keyframes`
    );

    const parsed = CreateProjectSchema.safeParse({
      name: project.name,
      description: project.description,
      aspectRatio: project.aspectRatio,
      resolution: project.resolution,
      fps: project.fps,
      tracks: project.tracks,
      clips: project.clips.map(serializeClipForServer),
      subtitles: project.subtitles ?? [],
      subtitleStyle: project.subtitleStyle,
    });
    assert.equal(
      parsed.success,
      true,
      `Template ${item.id} must pass CreateProjectSchema validation: ${parsed.success ? "" : parsed.error.message}`
    );
  }
}

interface StoredProjectRow {
  _id: string;
  userId: string;
  name: string;
  description: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p" | "4K";
  fps: 24 | 30 | 60;
  tracks: Project["tracks"];
  clips: Array<Record<string, unknown>>;
  subtitles: Array<{ id: string; start: number; end: number; text: string; clipId?: string }>;
  subtitleStyle?: Project["subtitleStyle"];
  subtitleMeta?: Project["subtitleMeta"];
  createdAt: Date;
  updatedAt: Date;
}

async function testProjectManagementApiAndOwnership() {
  const rows = new Map<string, StoredProjectRow>();
  let seq = 1;

  const origFind = ProjectModel.find;
  const origFindOne = ProjectModel.findOne;
  const origCreate = ProjectModel.create;
  const origFindOneAndUpdate = ProjectModel.findOneAndUpdate;
  const origFindOneAndDelete = ProjectModel.findOneAndDelete;

  const modelAny = ProjectModel as unknown as Record<string, unknown>;
  modelAny.find = (filter: { userId?: string }) => {
    const matched = Array.from(rows.values()).filter((r) => r.userId === filter.userId);
    return {
      sort: async () =>
        [...matched].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    };
  };
  modelAny.findOne = (filter: { _id?: string; userId?: string }) => {
    const row = filter._id ? rows.get(String(filter._id)) ?? null : null;
    const owned = row && row.userId === filter.userId ? row : null;
    return {
      lean: async () => owned,
      then: (onFulfilled: (val: StoredProjectRow | null) => unknown) =>
        Promise.resolve(owned).then(onFulfilled),
    };
  };
  modelAny.create = async (doc: Partial<StoredProjectRow>) => {
    const id = `65f1111111111111111111${String(seq++).padStart(2, "0")}`;
    const now = new Date();
    const created: StoredProjectRow = {
      _id: id,
      userId: String(doc.userId || ""),
      name: String(doc.name || "Untitled"),
      description: String(doc.description || ""),
      aspectRatio: doc.aspectRatio ?? "16:9",
      resolution: doc.resolution ?? "1080p",
      fps: doc.fps ?? 24,
      tracks: doc.tracks ?? createDefaultTracks(),
      clips: (doc.clips as Array<Record<string, unknown>>) ?? [],
      subtitles: doc.subtitles ?? [],
      subtitleStyle: doc.subtitleStyle,
      subtitleMeta: doc.subtitleMeta,
      createdAt: now,
      updatedAt: now,
    };
    rows.set(id, created);
    return created;
  };
  modelAny.findOneAndUpdate = async (
    filter: { _id?: string; userId?: string },
    update: { $set?: Partial<StoredProjectRow> }
  ) => {
    const row = filter._id ? rows.get(String(filter._id)) ?? null : null;
    if (!row || row.userId !== filter.userId) return null;
    Object.assign(row, update.$set ?? {}, { updatedAt: new Date() });
    return row;
  };
  modelAny.findOneAndDelete = async (filter: { _id?: string; userId?: string }) => {
    const row = filter._id ? rows.get(String(filter._id)) ?? null : null;
    if (!row || row.userId !== filter.userId) return null;
    rows.delete(row._id);
    return row;
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = req.headers["x-test-user"];
    if (typeof uid !== "string" || !uid) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    (req as AuthenticatedRequest).userId = uid;
    next();
  });
  app.get("/api/projects", listProjectsController);
  app.post("/api/projects", validateBody(CreateProjectSchema), createProjectController);
  app.patch(
    "/api/projects/:id",
    validateObjectId("id"),
    validateBody(UpdateProjectSchema),
    updateProjectController
  );
  app.post("/api/projects/:id/duplicate", validateObjectId("id"), duplicateProjectController);
  app.delete("/api/projects/:id", validateObjectId("id"), deleteProjectController);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Unauthenticated blocked
    const unauth = await fetch(`${base}/api/projects`);
    assert.equal(unauth.status, 401);

    // Invalid ObjectId rejected with 400
    const badId = await fetch(`${base}/api/projects/not-an-id/duplicate`, {
      method: "POST",
      headers: { "x-test-user": "user_alpha" },
    });
    assert.equal(badId.status, 400);

    // Create project from Instagram Reels template
    const tpl = createProjectFromTemplate("instagram-reels", { name: "Launch Reel" });
    const createRes = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": "user_alpha" },
      body: JSON.stringify({
        name: tpl.name,
        description: tpl.description,
        aspectRatio: tpl.aspectRatio,
        resolution: tpl.resolution,
        fps: tpl.fps,
        tracks: tpl.tracks,
        clips: [
          ...tpl.clips.map(serializeClipForServer),
          {
            id: "clip_v1_src",
            assetId: "asset_shared_1",
            trackId: "track_v1",
            name: "Main Cam.mp4",
            kind: "video",
            startTime: 0,
            duration: 6,
            inPoint: 1.5,
            sourceDuration: 20,
            volume: 1,
            speed: 1,
            opacity: 1,
            keyframes: [
              { id: "kf_scale_0", timeSec: 0, property: "scale", value: 1, easing: "ease-out" },
              { id: "kf_scale_1", timeSec: 3, property: "scale", value: 1.25, easing: "linear" },
            ],
          },
        ],
        subtitles: [{ id: "sub_1", start: 0.5, end: 2.5, text: "Hello", clipId: "clip_v1_src" }],
      }),
    });
    assert.equal(createRes.status, 201);
    const createdJson = (await createRes.json()) as { project: StoredProjectRow };
    const origId = createdJson.project._id;

    // Cross-user rename blocked
    const crossRename = await fetch(`${base}/api/projects/${origId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user": "user_beta" },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    assert.equal(crossRename.status, 404);

    // Owner rename succeeds
    const ownerRename = await fetch(`${base}/api/projects/${origId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user": "user_alpha" },
      body: JSON.stringify({ name: "Launch Reel v2" }),
    });
    assert.equal(ownerRename.status, 200);
    const renamedJson = (await ownerRename.json()) as { project: StoredProjectRow };
    assert.equal(renamedJson.project.name, "Launch Reel v2");

    // Cross-user duplicate blocked
    const crossDup = await fetch(`${base}/api/projects/${origId}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": "user_beta" },
      body: JSON.stringify({}),
    });
    assert.equal(crossDup.status, 404);

    // Owner duplicate creates independent deep copy with remapped IDs & preserved keyframes/assets
    const dupRes = await fetch(`${base}/api/projects/${origId}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": "user_alpha" },
      body: JSON.stringify({}),
    });
    assert.equal(dupRes.status, 201);
    const dupJson = (await dupRes.json()) as { project: StoredProjectRow };
    const dup = dupJson.project;
    assert.notEqual(dup._id, origId);
    assert.equal(dup.name, "Launch Reel v2 (Copy)");
    assert.equal(dup.aspectRatio, "9:16");
    assert.equal(dup.clips.length, createdJson.project.clips.length);

    const dupVideo = dup.clips.find((c) => c.assetId === "asset_shared_1");
    assert.ok(dupVideo, "Duplicate must preserve shared assetId link");
    assert.notEqual(dupVideo.id, "clip_v1_src", "Duplicate must assign fresh clip IDs");
    const dupKeyframes = dupVideo.keyframes as Array<{ id: string; property: string; value: number }>;
    assert.equal(dupKeyframes.length, 2, "Duplicate must preserve clip keyframes");
    assert.notEqual(dupKeyframes[0].id, "kf_scale_0", "Duplicate must assign fresh keyframe IDs");
    assert.equal(dup.subtitles[0].clipId, dupVideo.id, "Subtitle clipId must remap to cloned clip ID");

    // Cross-user delete blocked
    const crossDel = await fetch(`${base}/api/projects/${dup._id}`, {
      method: "DELETE",
      headers: { "x-test-user": "user_beta" },
    });
    assert.equal(crossDel.status, 404);

    // Owner delete removes copy while original stays intact
    const delRes = await fetch(`${base}/api/projects/${dup._id}`, {
      method: "DELETE",
      headers: { "x-test-user": "user_alpha" },
    });
    assert.equal(delRes.status, 200);
    assert.equal(rows.has(dup._id), false);
    assert.equal(rows.has(origId), true);
  } finally {
    server.close();
    modelAny.find = origFind;
    modelAny.findOne = origFindOne;
    modelAny.create = origCreate;
    modelAny.findOneAndUpdate = origFindOneAndUpdate;
    modelAny.findOneAndDelete = origFindOneAndDelete;
  }
}

async function testSearchSortingMissingMediaRelinkAndThumbnails() {
  clearAllMediaCaches();

  const baseNow = Date.now();
  const sampleProjects: Project[] = [
    {
      id: "p_beta",
      name: "Beta Vlog",
      description: "Travel diary",
      aspectRatio: "16:9",
      resolution: "1080p",
      fps: 24,
      createdAt: new Date(baseNow - 20_000).toISOString(),
      updatedAt: new Date(baseNow - 5_000).toISOString(),
      tracks: createDefaultTracks(),
      clips: [],
    },
    {
      id: "p_alpha",
      name: "Alpha Launch",
      description: "Product teaser",
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      createdAt: new Date(baseNow - 10_000).toISOString(),
      updatedAt: new Date(baseNow - 15_000).toISOString(),
      tracks: createDefaultTracks(),
      clips: [],
    },
    {
      id: "p_gamma",
      name: "Gamma Reel",
      description: "Travel highlights",
      aspectRatio: "1:1",
      resolution: "1080p",
      fps: 30,
      createdAt: new Date(baseNow - 2_000).toISOString(),
      updatedAt: new Date(baseNow - 1_000).toISOString(),
      tracks: createDefaultTracks(),
      clips: [],
    },
  ];

  const searchTravel = sampleProjects.filter(
    (p) =>
      p.name.toLowerCase().includes("travel") ||
      (p.description || "").toLowerCase().includes("travel")
  );
  assert.deepEqual(
    searchTravel.map((p) => p.id),
    ["p_beta", "p_gamma"]
  );

  const sortedByName = [...sampleProjects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  assert.deepEqual(sortedByName.map((p) => p.id), ["p_alpha", "p_beta", "p_gamma"]);

  const sortedByCreated = [...sampleProjects].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  assert.deepEqual(sortedByCreated.map((p) => p.id), ["p_gamma", "p_alpha", "p_beta"]);

  const sortedByUpdated = [...sampleProjects].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  assert.deepEqual(sortedByUpdated.map((p) => p.id), ["p_gamma", "p_beta", "p_alpha"]);

  // Missing-media detection & relink preserving edits, keyframes & subtitles
  const projWithMedia: Project = {
    ...sampleProjects[0],
    clips: [
      {
        id: "clip_1",
        assetId: "asset_missing_1",
        trackId: "track_v1",
        name: "Interview.mp4",
        sourceName: "Interview.mp4",
        sourceSizeBytes: 2048,
        kind: "video",
        startTime: 1.5,
        duration: 6.5,
        inPoint: 2.25,
        sourceDuration: 20,
        volume: 0.9,
        speed: 1.25,
        opacity: 0.95,
        objectUrl: "",
        needsRelink: false,
        keyframes: [
          { id: "kf1", timeSec: 0, property: "opacity", value: 0.5, easing: "linear" },
          { id: "kf2", timeSec: 2, property: "opacity", value: 1, easing: "ease-out" },
        ],
      },
      {
        id: "clip_2",
        assetId: "asset_missing_1",
        trackId: "track_v1",
        name: "Interview Split",
        sourceName: "Interview.mp4",
        sourceSizeBytes: 2048,
        kind: "video",
        startTime: 8.0,
        duration: 3.0,
        inPoint: 10.0,
        sourceDuration: 20,
        volume: 1,
        speed: 1,
        opacity: 1,
        objectUrl: "",
        needsRelink: false,
      },
    ],
    subtitles: [{ id: "sub1", start: 1.8, end: 4.0, text: "Kept across relink", clipId: "clip_1" }],
  };

  // Before storage is ready, must not falsely warn missing media
  const healthBeforeReady = getProjectMediaHealth(projWithMedia, [], false);
  assert.equal(healthBeforeReady.hasMissingMedia, false);

  // After storage ready with empty assets, deduplicates by distinct assetId (count = 1 for 2 clips sharing asset)
  const flaggedProj = reconcileProjectWithMediaAssets(projWithMedia, new Map(), true);
  assert.equal(flaggedProj.clips[0].needsRelink, true);
  const healthMissing = getProjectMediaHealth(flaggedProj, [], true);
  assert.equal(healthMissing.hasMissingMedia, true);
  assert.equal(healthMissing.missingCount, 1);

  // Relink restores objectUrl + clears needsRelink without losing trim/keyframes/subtitles
  const relinkedAsset: MediaAsset = {
    id: "asset_missing_1",
    name: "Interview.mp4",
    kind: "video",
    mimeType: "video/mp4",
    sizeBytes: 2048,
    duration: 20,
    width: 1920,
    height: 1080,
    objectUrl: "blob:restored-interview",
    thumbnailUrl: "data:image/jpeg;base64,abc",
    addedAt: new Date().toISOString(),
  };
  const restoredProj = reconcileProjectWithMediaAssets(
    flaggedProj,
    new Map([[relinkedAsset.id, relinkedAsset]]),
    true
  );
  assert.equal(restoredProj.clips[0].needsRelink, false);
  assert.equal(restoredProj.clips[0].objectUrl, "blob:restored-interview");
  assert.equal(restoredProj.clips[0].inPoint, 2.25);
  assert.equal(restoredProj.clips[0].speed, 1.25);
  assert.equal(restoredProj.clips[0].keyframes?.length, 2);
  assert.equal(restoredProj.subtitles?.[0].text, "Kept across relink");

  // Orphaned asset safety when one duplicate keeps referencing shared asset
  const otherProj: Project = { ...sampleProjects[1], clips: [{ ...restoredProj.clips[0], id: "other_clip" }] };
  assert.deepEqual(findOrphanedAssetIds(["asset_missing_1"], [otherProj]), []);
  assert.deepEqual(findOrphanedAssetIds(["asset_missing_1"], []), ["asset_missing_1"]);

  // Project thumbnail caching & fingerprint invalidation
  const thumb1 = await getOrCreateProjectThumbnail(restoredProj, [relinkedAsset]);
  assert.equal(thumb1.fromCache, false);
  assert.equal(thumb1.url, "data:image/jpeg;base64,abc");

  const thumb1Hit = await getOrCreateProjectThumbnail(restoredProj, [relinkedAsset]);
  assert.equal(thumb1Hit.fromCache, true);
  assert.equal(thumb1Hit.url, thumb1.url);

  const fpBefore = computeProjectThumbnailFingerprint(restoredProj, [relinkedAsset]);
  const editedThumbProj: Project = {
    ...restoredProj,
    clips: restoredProj.clips.map((c, idx) => (idx === 0 ? { ...c, inPoint: 5.5 } : c)),
  };
  const fpAfter = computeProjectThumbnailFingerprint(editedThumbProj, [relinkedAsset]);
  assert.notEqual(fpBefore, fpAfter, "Fingerprint must invalidate cache when representative clip trim changes");

  const fallbackThumb = renderFallbackProjectThumbnailDataUrl(sampleProjects[0]);
  assert.ok(fallbackThumb.startsWith("data:image/svg+xml") || fallbackThumb.startsWith("data:image/jpeg"));

  // Eviction test: BoundedLRUCache honors max 80 entries
  for (let i = 0; i < 95; i++) {
    projectThumbnailCache.set(`bulk_proj_${i}`, `fp_${i}`, `data:image/jpeg;base64,${i}`);
  }
  assert.ok(projectThumbnailCache.getStats().entries <= 80, "Project thumbnail cache must remain bounded");
}

async function testExportJobVsVideoJobAndHistoryConsistency() {
  // 1) ExportJob terminal status protection (TS bugfix preservation check)
  const origExportFindOneAndUpdate = ExportJobModel.findOneAndUpdate;
  let capturedFilter: Record<string, unknown> | null = null;
  (ExportJobModel as unknown as Record<string, unknown>).findOneAndUpdate = async (
    filter: Record<string, unknown>
  ) => {
    capturedFilter = filter;
    return null;
  };
  try {
    await updateUserExportJobStatus("user_1", "65f999999999999999999999", { status: "failed" });
    assert.ok(capturedFilter);
    assert.equal(capturedFilter["userId"], "user_1");
    assert.ok(Array.isArray((capturedFilter["status"] as { $in?: unknown[] })?.$in));
    assert.equal(
      (capturedFilter["status"] as { $in: string[] }).$in.includes("completed"),
      false,
      "ExportJob terminal completed status must remain protected"
    );
  } finally {
    (ExportJobModel as unknown as Record<string, unknown>).findOneAndUpdate = origExportFindOneAndUpdate;
  }

  // 2) Server VideoJob -> ExportAttempt mapping & filtering
  assert.equal(
    mapServerVideoJobToExportAttempt({
      _id: "job_meta",
      operation: "metadata",
      status: "completed",
      sourceFilename: "a.mp4",
    }),
    null,
    "Non-export_mp4 VideoJobs must not appear in export history"
  );
  assert.equal(
    mapServerVideoJobToExportAttempt({
      _id: "job_proc",
      operation: "export_mp4",
      status: "processing",
      sourceFilename: "a.mp4",
    }),
    null,
    "In-flight VideoJobs must not appear as terminal history entries"
  );

  const serverCancelled: ServerVideoJobDto = {
    _id: "65f222222222222222222201",
    projectId: "proj_1",
    operation: "export_mp4",
    status: "cancelled",
    sourceFilename: "clip.mp4",
    inputParams: {
      client_job_id: "client_cancel_abc",
      resolution: "1080p",
      fps: 24,
      export_profile: "balanced",
      timeline_spec: JSON.stringify({ project: { name: "Cut 1", aspectRatio: "16:9", durationSeconds: 12 }, clips: [{ id: "c1" }] }),
    },
    errorMessage: "Export cancelled by user.",
    createdAt: new Date().toISOString(),
  };
  const mappedCancelled = mapServerVideoJobToExportAttempt(serverCancelled);
  assert.ok(mappedCancelled);
  assert.equal(mappedCancelled.status, "cancelled");
  assert.equal(mappedCancelled.clientJobId, "client_cancel_abc");
  assert.equal(canRetryExportAttempt(mappedCancelled), false, "Cancelled exports must never show Retry");

  // 3) Deduplication + terminal cancellation immutability
  const localCompleted: ExportAttempt = {
    id: "client_ok_01",
    clientJobId: "client_ok_01",
    projectId: "proj_1",
    projectName: "Cut 1",
    resolution: "1920x1080",
    exportProfile: "balanced",
    encodingMode: "auto",
    format: "mp4",
    fps: 24,
    clipCount: 2,
    totalDuration: 15,
    status: "completed",
    message: "Exported out.mp4",
    requestedAt: new Date().toISOString(),
    timelineSnapshotJson: "{}",
    outputFilename: "out.mp4",
    outputSizeBytes: 12345,
  };
  const srvCompleted = mapServerVideoJobToExportAttempt({
    _id: "65f222222222222222222202",
    projectId: "proj_1",
    operation: "export_mp4",
    status: "completed",
    sourceFilename: "clip.mp4",
    inputParams: { client_job_id: "client_ok_01", resolution: "1080p", fps: 24 },
    result: { outputFilename: "out.mp4", outputSizeBytes: 12345, exportDurationMs: 4200, encoderUsed: "libx264" },
  });
  assert.ok(srvCompleted);

  let history = upsertExportAttemptSafely([], localCompleted);
  history = upsertExportAttemptSafely(history, srvCompleted);
  assert.equal(history.length, 1, "Matching local + server job must never produce duplicate rows");
  assert.equal(history[0].id, "client_ok_01", "Preserves clientJobId so IndexedDB blob lookup keeps working");
  assert.equal(history[0].serverJobId, "65f222222222222222222202");
  assert.equal(history[0].exportDurationMs, 4200);

  // Cancelled immutability across clientJobId/serverJobId merge
  const localCancelled: ExportAttempt = {
    ...localCompleted,
    id: "client_cancel_abc",
    clientJobId: "client_cancel_abc",
    status: "cancelled",
    message: "Export cancelled by user.",
  };
  history = upsertExportAttemptSafely(history, localCancelled);
  history = upsertExportAttemptSafely(history, {
    ...localCancelled,
    id: "srv_65f222222222222222222201",
    serverJobId: "65f222222222222222222201",
    status: "completed",
    message: "Should be blocked",
  });
  const cancelledEntry = history.find((h) => h.id === "client_cancel_abc");
  assert.equal(cancelledEntry?.status, "cancelled", "Cancelled export must never flip to completed");

  // Retry eligibility: failed & integration_required only
  assert.equal(canRetryExportAttempt({ ...localCompleted, status: "failed" }), true);
  assert.equal(canRetryExportAttempt({ ...localCompleted, status: "integration_required" }), true);
  assert.equal(canRetryExportAttempt(localCompleted), false);

  // 4) Download availability ONLY when actual Blob exists + bounded cache
  clearInMemoryExportBlobs();
  const idb = createInMemoryIdbFactory();
  assert.equal(await hasExportFileAvailable("client_ok_01", idb), false);

  const mp4Blob = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: "video/mp4" });
  await saveExportFileBlob("client_ok_01", mp4Blob, "out.mp4", idb);
  assert.equal(await hasExportFileAvailable("client_ok_01", idb), true);

  // Simulate page reload by clearing in-memory cache; IDB still restores availability
  clearInMemoryExportBlobs();
  const availableSet = await listAvailableExportFileIds(["client_ok_01", "srv_remote_only"], idb);
  assert.equal(availableSet.has("client_ok_01"), true);
  assert.equal(availableSet.has("srv_remote_only"), false, "Server-only row without local MP4 Blob must NOT mark download available");
  const restoredBlob = await getExportFileBlob("client_ok_01", idb);
  assert.equal(restoredBlob?.size, 8);

  // Save > MAX_CACHED_EXPORT_FILES to confirm LRU eviction of oldest blob
  for (let i = 0; i < MAX_CACHED_EXPORT_FILES + 2; i++) {
    await saveExportFileBlob(`evict_${i}`, mp4Blob, `evict_${i}.mp4`, idb);
  }
  clearInMemoryExportBlobs();
  const postEvictSet = await listAvailableExportFileIds(
    ["client_ok_01", "evict_0", "evict_1", "evict_2", "evict_3", "evict_4", "evict_5", "evict_6"],
    idb
  );
  assert.equal(postEvictSet.has("client_ok_01"), false, "Oldest export blob should be evicted beyond cache limit");
  assert.equal(postEvictSet.size, MAX_CACHED_EXPORT_FILES);

  await deleteExportFileBlob("evict_6", idb);
  assert.equal(await hasExportFileAvailable("evict_6", idb), false);

  // 5) Server DELETE /api/video/jobs/:id active-job 409 guard & ownership
  const jobRows = new Map<string, { _id: string; userId: string; operation: string; status: string }>([
    ["65f333333333333333333301", { _id: "65f333333333333333333301", userId: "u1", operation: "export_mp4", status: "processing" }],
    ["65f333333333333333333302", { _id: "65f333333333333333333302", userId: "u1", operation: "export_mp4", status: "failed" }],
    ["65f333333333333333333303", { _id: "65f333333333333333333303", userId: "u2", operation: "export_mp4", status: "completed" }],
  ]);

  const origVFind = VideoJobModel.find;
  const origVFindOne = VideoJobModel.findOne;
  const origVFindOneAndDelete = VideoJobModel.findOneAndDelete;
  const vModelAny = VideoJobModel as unknown as Record<string, unknown>;
  vModelAny.find = (filter: { userId?: string; operation?: string }) => ({
    sort: () => ({
      limit: async () =>
        Array.from(jobRows.values()).filter(
          (r) => r.userId === filter.userId && (!filter.operation || r.operation === filter.operation)
        ),
    }),
  });
  vModelAny.findOne = async (filter: { _id?: string; userId?: string }) => {
    const row = filter._id ? jobRows.get(String(filter._id)) ?? null : null;
    return row && row.userId === filter.userId ? row : null;
  };
  vModelAny.findOneAndDelete = async (filter: { _id?: string; userId?: string }) => {
    const row = filter._id ? jobRows.get(String(filter._id)) ?? null : null;
    if (!row || row.userId !== filter.userId) return null;
    jobRows.delete(row._id);
    return row;
  };

  const vApp = express();
  vApp.use((req, _res, next) => {
    (req as AuthenticatedRequest).userId = "u1";
    next();
  });
  vApp.get("/api/video/jobs", listVideoJobsController);
  vApp.delete("/api/video/jobs/:id", validateObjectId("id"), deleteVideoJobController);
  const vServer = http.createServer(vApp);
  await new Promise<void>((resolve) => vServer.listen(0, "127.0.0.1", resolve));
  const vPort = (vServer.address() as { port: number }).port;

  try {
    const activeDel = await fetch(`http://127.0.0.1:${vPort}/api/video/jobs/65f333333333333333333301`, {
      method: "DELETE",
    });
    assert.equal(activeDel.status, 409, "Active processing VideoJob must be protected from deletion with HTTP 409");

    const foreignDel = await fetch(`http://127.0.0.1:${vPort}/api/video/jobs/65f333333333333333333303`, {
      method: "DELETE",
    });
    assert.equal(foreignDel.status, 404, "Foreign user VideoJob delete must return 404");

    const okDel = await fetch(`http://127.0.0.1:${vPort}/api/video/jobs/65f333333333333333333302`, {
      method: "DELETE",
    });
    assert.equal(okDel.status, 200);
    assert.equal(jobRows.has("65f333333333333333333302"), false);

    const listRes = await fetch(`http://127.0.0.1:${vPort}/api/video/jobs?operation=export_mp4`);
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as { jobs: Array<{ _id: string }> };
    assert.deepEqual(listJson.jobs.map((j) => j._id), ["65f333333333333333333301"]);
  } finally {
    vServer.close();
    vModelAny.find = origVFind;
    vModelAny.findOne = origVFindOne;
    vModelAny.findOneAndDelete = origVFindOneAndDelete;
  }
}

async function testUiPagesRenderCleanly() {
  const cleanup = installDomStorageShim();
  try {
    const projectsHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(ProjectsPage))
    );
    assert.ok(projectsHtml.includes("YouTube Landscape"));
    assert.ok(projectsHtml.includes("Instagram Reels / Shorts"));
    assert.ok(projectsHtml.includes("Square Social Video"));
    assert.ok(projectsHtml.includes("Search projects"));

    const dashboardHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(DashboardPage))
    );
    assert.ok(dashboardHtml.includes("Starter Templates"));
    assert.ok(dashboardHtml.includes("Recent Projects"));

    const exportsHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(ExportsPage))
    );
    assert.ok(exportsHtml.includes("Export History"));

    const confirmHtml = renderToString(
      React.createElement(ConfirmDialog, {
        open: true,
        title: "Delete Project",
        description: "Are you sure?",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      })
    );
    assert.ok(confirmHtml.includes("Delete Project"));

    const modalHtml = renderToString(
      React.createElement(StudioProvider, null, React.createElement(CreateProjectModal))
    );
    assert.equal(modalHtml, "", "CreateProjectModal renders closed by default");
  } finally {
    cleanup();
  }
}

await testTemplatesAndKeyframePreservation();
await testProjectManagementApiAndOwnership();
await testSearchSortingMissingMediaRelinkAndThumbnails();
await testExportJobVsVideoJobAndHistoryConsistency();
await testUiPagesRenderCleanly();

console.log("ALL_PHASE_53_VERIFICATIONS_PASSED");
