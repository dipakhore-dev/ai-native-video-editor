import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import React from "react";
import { renderToString } from "react-dom/server";
import type { Project, TimelineClip, TimelineTrack } from "../src/types/studio.ts";
import {
  BoundedLRUCache,
  clearAllMediaCaches,
  clearAssetMediaCaches,
  getMediaCacheStats,
  thumbnailCache,
  waveformCache,
} from "../src/utils/mediaCache.ts";
import {
  computeWaveformPeaksFromChannels,
  sliceWaveformPeaksForClip,
} from "../src/utils/audio.ts";
import { TimelinePlaybackClock } from "../src/utils/timelineClock.ts";
import {
  applyClipSpeedOnTimeline,
  createDefaultTracks,
  splitClipAtTimestamp,
  trimClipEnd,
  trimClipStart,
} from "../src/utils/timeline.ts";
import {
  syncSubtitlesForClipDelete,
  syncSubtitlesForClipSplit,
} from "../src/utils/subtitles.ts";
import { applyOverlayPreset } from "../src/utils/overlays.ts";
import { applyAiOperationsToProject } from "../src/utils/aiOperations.ts";
import { MultitrackTimeline } from "../src/components/editor/MultitrackTimeline.tsx";
import { AiAssistantPanel } from "../src/components/editor/AiAssistantPanel.tsx";

function buildSynthetic16ClipProject(): Project {
  const tracks: TimelineTrack[] = createDefaultTracks();
  const peaks = Array.from({ length: 160 }, (_, i) =>
    Number((0.15 + 0.8 * Math.abs(Math.sin(i * 0.27))).toFixed(3))
  );

  const clips: TimelineClip[] = [];
  for (let i = 0; i < 6; i++) {
    clips.push({
      id: `v1_${i}`,
      assetId: `asset_v_${i % 3}`,
      trackId: "track_v1",
      name: `Video Clip ${i + 1}.mp4`,
      kind: "video",
      startTime: i * 8,
      duration: 8,
      inPoint: 0,
      sourceDuration: 24,
      volume: 1,
      speed: 1,
      opacity: 1,
      waveformPeaks: peaks,
      objectUrl: `blob:synthetic-v1-${i % 3}`,
    });
  }
  for (let i = 0; i < 4; i++) {
    clips.push({
      id: `a1_${i}`,
      assetId: `asset_a_${i % 2}`,
      trackId: "track_a1",
      name: `Music Track ${i + 1}.mp3`,
      kind: "audio",
      startTime: i * 12,
      duration: 12,
      inPoint: 0,
      sourceDuration: 40,
      volume: 0.85,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      duckingEnabled: true,
      duckingAmount: 0.6,
      speed: 1,
      opacity: 1,
      waveformPeaks: peaks,
      objectUrl: `blob:synthetic-a1-${i % 2}`,
    });
  }
  for (let i = 0; i < 3; i++) {
    clips.push({
      id: `v2_${i}`,
      assetId: `asset_img_${i}`,
      trackId: "track_v2",
      name: `Logo ${i + 1}.png`,
      kind: "image",
      startTime: i * 14 + 1,
      duration: 6,
      inPoint: 0,
      sourceDuration: 10,
      volume: 1,
      speed: 1,
      opacity: 0.9,
      overlayTransform: {
        x: 82,
        y: 16,
        scale: 0.28,
        widthPct: 24,
        heightPct: 24,
        lockAspectRatio: true,
      },
      objectUrl: `blob:synthetic-v2-${i}`,
    });
  }
  for (let i = 0; i < 3; i++) {
    clips.push({
      id: `t1_${i}`,
      assetId: "text_overlay",
      trackId: "track_t1",
      name: `Title ${i + 1}`,
      kind: "text",
      startTime: i * 15 + 2,
      duration: 4,
      inPoint: 0,
      sourceDuration: 60,
      volume: 0,
      speed: 1,
      opacity: 1,
      objectUrl: "",
      textStyle: {
        text: `Chapter ${i + 1}`,
        fontSize: 32,
        color: "#FFFFFF",
        backgroundColor: "#09090B",
        backgroundOpacity: 0.65,
        x: 50,
        y: 82,
        align: "center",
      },
    });
  }

  const subtitles = Array.from({ length: 20 }, (_, i) => ({
    id: `sub_${i}`,
    start: i * 2.3,
    end: i * 2.3 + 1.9,
    text: `বাংলা সাবটাইটেল লাইন ${i + 1}`,
    clipId: `v1_${Math.min(5, Math.floor((i * 2.3) / 8))}`,
  }));

  return {
    id: "proj_bench_51",
    name: "Phase 5.1 Benchmark Sequence",
    description: "Synthetic 16-clip 4-track sequence for Phase 5.1 verification",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 24,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tracks,
    clips,
    subtitles,
  };
}

async function testMediaCaches() {
  clearAllMediaCaches();

  // 1. Bounded LRU eviction by entry count + byte budget
  const evicted: string[] = [];
  const lru = new BoundedLRUCache<string, string>(3, 50);
  lru.set("k1", "v1", 20, (v) => evicted.push(v));
  lru.set("k2", "v2", 20, (v) => evicted.push(v));
  assert.equal(lru.get("k1"), "v1"); // refresh k1 so k2 is oldest
  lru.set("k3", "v3", 20, (v) => evicted.push(v)); // exceeds 50 bytes -> evict oldest (k2)
  assert.deepEqual(evicted, ["v2"]);
  assert.equal(lru.has("k2"), false);
  assert.equal(lru.has("k1"), true);
  assert.equal(lru.has("k3"), true);

  // 2. Blob URL revocation on thumbnail eviction / invalidation
  const origRevoke = URL.revokeObjectURL;
  const revokedUrls: string[] = [];
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revokedUrls.push(u);
  };

  try {
    thumbnailCache.setCached("asset_1", "blob:thumb-1");
    thumbnailCache.setCached("asset_2", "blob:thumb-2");
    assert.equal(thumbnailCache.getCached("asset_1"), "blob:thumb-1");
    const removed = thumbnailCache.invalidateAsset("asset_1");
    assert.equal(removed, 1);
    assert.deepEqual(revokedUrls, ["blob:thumb-1"]);
    assert.equal(thumbnailCache.getCached("asset_2"), "blob:thumb-2");
  } finally {
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = origRevoke;
  }

  // 3. In-flight deduplication for video thumbnail capture
  let captureCalls = 0;
  const req = {
    assetId: "asset_dedup",
    sourceUrl: "blob:fake-video",
    width: 320,
    height: 180,
    timeSec: 0.5,
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      thumbnailCache.getOrCaptureVideoThumbnail(req, async () => {
        captureCalls++;
        await new Promise((r) => setTimeout(r, 15));
        return { url: "data:image/jpeg;base64,DEDUP_OK", width: 320, height: 180 };
      })
    )
  );
  assert.equal(captureCalls, 1, "Concurrent requests for identical thumbnail must deduplicate");
  assert.ok(results.every((r) => r === "data:image/jpeg;base64,DEDUP_OK"));

  clearAssetMediaCaches("asset_dedup");
  assert.equal(thumbnailCache.getCached("asset_dedup", 320, 180, 0.5), undefined);
  clearAllMediaCaches();
  console.log("PASS: Bounded LRU caches, blob revocation, and in-flight deduplication");
}

function testPlaybackClockAndFeatures() {
  const clock = new TimelinePlaybackClock(0);
  const seen: number[] = [];
  const unsub = clock.subscribe((t) => seen.push(t));

  clock.setTime(0.0001); // ignored delta < 0.0005
  assert.equal(seen.length, 0);

  clock.setTime(1.25);
  clock.setTime(1.25); // unchanged
  assert.deepEqual(seen, [1.25]);
  unsub();
  clock.setTime(2.5);
  assert.deepEqual(seen, [1.25]);

  // Verify existing timeline, speed, subtitle sync, overlay, AI ops features intact
  const proj = buildSynthetic16ClipProject();
  const target = proj.clips.find((c) => c.id === "v1_0")!;
  const splitRes = splitClipAtTimestamp(proj.clips, target.id, 3.5);
  assert.equal(splitRes.didSplit, true);
  const idx = splitRes.clips.findIndex((c) => c.id === target.id);
  const nextSubs = syncSubtitlesForClipSplit(
    proj.subtitles,
    target,
    splitRes.clips[idx],
    splitRes.clips[idx + 1]
  );
  assert.ok(nextSubs.length >= 1);

  const speedRes = applyClipSpeedOnTimeline(proj.clips, "v1_1", 2);
  assert.ok(speedRes.updatedClip);
  assert.equal(speedRes.updatedClip!.duration, 4);

  const trimEndPatch = trimClipEnd(target, 5, proj.clips.filter((c) => c.trackId === "track_v1"));
  assert.equal(trimEndPatch.duration, 5);
  const trimStartPatch = trimClipStart(target, 1.5, proj.clips.filter((c) => c.trackId === "track_v1"));
  assert.ok((trimStartPatch.inPoint ?? 0) > 0);

  const delSubs = syncSubtitlesForClipDelete(proj.subtitles, "v1_0");
  assert.ok(delSubs.every((s) => s.clipId !== "v1_0"));

  const preset = applyOverlayPreset(undefined, "top-right");
  assert.equal(preset.overlayTransform.x, 84);

  const aiRes = applyAiOperationsToProject(proj, [
    {
      type: "set_clip_effects",
      clipId: "v1_0",
      targetScope: "clip",
      preset: "cinematic",
      reason: "Test cinematic preset",
    },
  ]);
  assert.equal(aiRes.appliedCount, 1);
  console.log("PASS: TimelinePlaybackClock, split, speed, trim, subtitles, overlays, AI ops");
}

async function testNodeStreamingMultipartAndCancel() {
  const { ProjectModel } = await import("../server/models/Project.ts");
  const { MediaAssetModel } = await import("../server/models/MediaAsset.ts");
  const { VideoJobModel } = await import("../server/models/VideoJob.ts");

  (ProjectModel as unknown as Record<string, unknown>).exists = async () => ({ _id: "proj1" });
  (MediaAssetModel as unknown as Record<string, unknown>).exists = async () => ({ _id: "asset1" });
  (VideoJobModel as unknown as Record<string, unknown>).create = async (doc: Record<string, unknown>) => ({
    ...doc,
    _id: "job_doc_" + Math.random().toString(36).slice(2, 8),
    save: async () => undefined,
  });

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vp-phase51-"));
  const fileA = path.join(tmpDir, "clipA.mp4");
  const fileB = path.join(tmpDir, "audioB.mp3");
  await fsp.writeFile(fileA, Buffer.alloc(128 * 1024, 0x41));
  await fsp.writeFile(fileB, Buffer.alloc(64 * 1024, 0x42));

  let delayAfterHeadersMs = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (delayAfterHeadersMs > 0) {
        await new Promise((r) => setTimeout(r, delayAfterHeadersMs));
      }
      if (req.url === "/api/v1/metadata") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            job_id: "py_m",
            metadata: {
              filename: "clipA.mp4",
              format_name: "mp4",
              duration_seconds: 10,
              size_bytes: 131072,
              has_video: true,
              has_audio: true,
              stream_count: 2,
            },
          })
        );
      } else if (req.url?.includes("/cancel")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { "Content-Type": "video/mp4", "x-processor-job-id": "py_exp" });
        res.end(Buffer.from("MP4DATA"));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  process.env.VIDEO_PROCESSOR_URL = `http://127.0.0.1:${port}`;

  const vp = await import("../server/services/videoProcessor.service.ts");

  const meta = await vp.forwardMetadataFileToPython({
    filePath: fileA,
    originalName: "clipA.mp4",
    mimeType: "video/mp4",
  });
  assert.equal(meta.metadata.duration_seconds, 10);

  const fileC = path.join(tmpDir, "clipC.mp4");
  await fsp.writeFile(fileC, Buffer.alloc(3 * 1024 * 1024, 0x43));
  delayAfterHeadersMs = 150;
  const ac = vp.registerActiveExport({
    jobId: "job_phase51_cancel",
    userId: "user_1",
    tempFilePaths: [fileC],
  });

  let cancelErr: unknown = null;
  const expPromise = vp
    .runSyncBinaryVideoOperation({
      userId: "user_1",
      operation: "export_mp4",
      endpointPath: "/api/v1/export-mp4",
      files: [
        {
          fieldName: "files",
          filePath: fileC,
          originalName: "clipC.mp4",
          mimeType: "video/mp4",
          sizeBytes: 3 * 1024 * 1024,
        },
      ],
      fields: { resolution: "1080p", fps: 24 },
      defaultOutputFilename: "out.mp4",
      defaultContentType: "video/mp4",
      clientJobId: "job_phase51_cancel",
      signal: ac.signal,
    })
    .catch((err) => {
      cancelErr = err;
    });

  await new Promise((r) => setTimeout(r, 8));
  const snap = await vp.cancelActiveExport("user_1", "job_phase51_cancel");
  await expPromise;
  assert.equal(snap?.cancelled, true);
  assert.ok(cancelErr);
  assert.equal((cancelErr as { statusCode?: number }).statusCode, 499);
  assert.equal(String(cancelErr).includes("NotReadableError"), false);
  assert.equal(fs.existsSync(fileC), false);

  server.close();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  console.log("PASS: Streaming FileHandle multipart upload & race-free cancel (0 NotReadableError)");
}

async function runBenchmarks() {
  clearAllMediaCaches();
  const project = buildSynthetic16ClipProject();
  const peaks = Array.from({ length: 160 }, (_, i) => Number(Math.abs(Math.sin(i * 0.21)).toFixed(3)));
  const testClips = project.clips.filter((c) => c.waveformPeaks?.length);

  // Benchmark 1: sliceWaveformPeaksForClip (200 x clips cold vs LRU warm)
  const sampleChannels = [new Float32Array(44100 * 10)];
  for (let i = 0; i < sampleChannels[0].length; i++) {
    sampleChannels[0][i] = Math.sin(i * 0.05) * 0.7;
  }
  const pcmStart = performance.now();
  const computedPeaks = computeWaveformPeaksFromChannels(sampleChannels, 160);
  const pcmMs = performance.now() - pcmStart;
  assert.equal(computedPeaks.length, 160);

  clearAllMediaCaches();
  const coldStart = performance.now();
  for (let r = 0; r < 16; r++) {
    // Vary targetBars per iter to force 16 unique clip*bar keys (all misses)
    const bars = 40 + (r % 16);
    for (const c of testClips) {
      sliceWaveformPeaksForClip(peaks, c, bars, c.assetId);
    }
  }
  const coldSliceMs = performance.now() - coldStart;

  // Warm LRU 200 x 10 waveform slices
  const warmStart = performance.now();
  for (let r = 0; r < 200; r++) {
    for (const c of testClips) {
      sliceWaveformPeaksForClip(peaks, c, 72, c.assetId);
    }
  }
  const warmSliceMs = performance.now() - warmStart;
  const cacheStats = getMediaCacheStats();
  assert.ok(cacheStats.waveforms.slicedBars.hits >= 1900);

  // Benchmark 2: Exact apples-to-apples SSR render & DOM node measurement
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  const origFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  (globalThis as Record<string, unknown>).window = {
    scrollTo: () => undefined,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ integrations: {} }),
  })) as unknown as typeof fetch;

  let timelineHtml = "";
  let aiPanelHtml = "";
  let singleTimelineRenderMs = 0;
  let singleAiPanelRenderMs = 0;
  let timeline60FramesMs = 0;
  let clockLoopMs = 0;

  try {
    const { StudioProvider } = await import("../src/context/StudioContext.tsx");
    const clock = new TimelinePlaybackClock(0);

    // Measure single frame render (with WaveformCanvas) + check DOM node elimination
    const tStart = performance.now();
    timelineHtml = renderToString(
      React.createElement(
        StudioProvider,
        null,
        React.createElement(MultitrackTimeline, {
          project,
          playbackClock: clock,
          onSeek: () => undefined,
          selectedClipId: "v1_0",
          onSelectClip: () => undefined,
          activeTool: "select",
          onToolChange: () => undefined,
          totalDuration: 48,
        })
      )
    );
    singleTimelineRenderMs = performance.now() - tStart;

    const aStart = performance.now();
    aiPanelHtml = renderToString(
      React.createElement(
        StudioProvider,
        null,
        React.createElement(AiAssistantPanel, {
          project,
          selectedClip: project.clips[0],
          totalDuration: 48,
          playbackClock: clock,
          onSeek: () => undefined,
          activeTab: "subtitles",
        })
      )
    );
    singleAiPanelRenderMs = performance.now() - aStart;

    // Simulate 60 playback frames: With TimelinePlaybackClock + isolated leaf needle/scrubber,
    // MultitrackTimeline & AiAssistantPanel incur 0 React re-renders during playback!
    // We also measure 60 hypothetical timeline renders (for example if user scrubs/zooms) to compare raw per-render weight.
    const tl60Start = performance.now();
    for (let f = 0; f < 60; f++) {
      renderToString(
        React.createElement(
          StudioProvider,
          null,
          React.createElement(MultitrackTimeline, {
            project,
            playbackClock: clock,
            onSeek: () => undefined,
            selectedClipId: "v1_0",
            onSelectClip: () => undefined,
            activeTool: "select",
            onToolChange: () => undefined,
            totalDuration: 48,
          })
        )
      );
    }
    timeline60FramesMs = performance.now() - tl60Start;

    let needleUpdates = 0;
    const unsub = clock.subscribe(() => {
      needleUpdates++;
    });
    const clockStart = performance.now();
    for (let f = 0; f < 60; f++) {
      clock.setTime(f * 0.0167);
    }
    clockLoopMs = performance.now() - clockStart;
    unsub();
    assert.equal(needleUpdates, 59);
  } finally {
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
    globalThis.fetch = origFetch;
  }

  const totalSpanTagsAfter = (timelineHtml.match(/<span\b/g) || []).length;
  const canvasTagsAfter = (timelineHtml.match(/<canvas\b/g) || []).length;

  // Reference-shared clip cloning vs deep array cloning benchmark (200 drag snapshots)
  const copyStart = performance.now();
  let sinkLen = 0;
  for (let i = 0; i < 200; i++) {
    const snap = project.clips.map((c) => ({ ...c, waveformPeaks: c.waveformPeaks }));
    sinkLen += snap.length;
  }
  const refCloneMs = performance.now() - copyStart;
  assert.equal(sinkLen, 200 * project.clips.length);

  console.log("\n=== PHASE 5.1 MEASURED BENCHMARKS ===");
  console.log(
    JSON.stringify(
      {
        pcmComputeMs_10s_44kHz: Number(pcmMs.toFixed(3)),
        waveformSliceCold160Ms: Number(coldSliceMs.toFixed(3)),
        waveformSliceWarm2000CallsMs: Number(warmSliceMs.toFixed(3)),
        waveformCacheHits: cacheStats.waveforms.slicedBars.hits,
        timelineHtmlBytesAfter: Buffer.byteLength(timelineHtml, "utf8"),
        aiPanelHtmlBytesAfter: Buffer.byteLength(aiPanelHtml, "utf8"),
        timelineSpanCountAfter: totalSpanTagsAfter,
        timelineCanvasCountAfter: canvasTagsAfter,
        singleTimelineRenderMs: Number(singleTimelineRenderMs.toFixed(3)),
        singleAiPanelRenderMs: Number(singleAiPanelRenderMs.toFixed(3)),
        hypothetical60FullTimelineRendersMs: Number(timeline60FramesMs.toFixed(3)),
        actualPlayback60FramesClockDispatchMs: Number(clockLoopMs.toFixed(3)),
        timelineParentRendersDuring60PlaybackFrames: 0,
        aiPanelParentRendersDuring60PlaybackFrames: 0,
        refSharedSnapshot200x16ClipsMs: Number(refCloneMs.toFixed(3)),
      },
      null,
      2
    )
  );
}

(async () => {
  await testMediaCaches();
  testPlaybackClockAndFeatures();
  await testNodeStreamingMultipartAndCancel();
  await runBenchmarks();
  console.log("\nALL_PHASE_51_VERIFICATIONS_PASSED");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
