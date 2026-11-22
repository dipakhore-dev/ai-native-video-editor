/// <reference types="node" />
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Project, TimelineClip } from "../src/types/studio.ts";
import {
  buildSpeechIntervals,
  computeEffectiveClipGain,
} from "../src/utils/audio.ts";
import {
  hydrateAssetFromStoredRecord,
  reconcileProjectsWithMediaAssets,
  type StoredMediaRecord,
} from "../src/utils/mediaStorage.ts";
import {
  applyClipSpeedOnTimeline,
  createDefaultTracks,
  splitClipAtTimestamp,
  trimClipEnd,
  trimClipStart,
} from "../src/utils/timeline.ts";
import { TimelinePlaybackClock } from "../src/utils/timelineClock.ts";

interface RecordedAudioEvents {
  srcAssignments: string[];
  removeSrcCount: number;
  loadCount: number;
  playCount: number;
  pauseCount: number;
  seeks: number[];
}

class MockNode {
  nodeType = 1;
  tagName: string;
  nodeName: string;
  childNodes: MockNode[] = [];
  parentNode: MockNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(ev: unknown) => void>>();
  style: Record<string, string> = {};
  ownerDocument: MockDocument;
  className = "";
  textContent = "";
  value = "";
  defaultValue = "";
  type = "";
  checked = false;
  defaultChecked = false;
  selected = false;
  disabled = false;
  multiple = false;

  constructor(tagName: string, doc: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = doc;
  }

  get options() {
    return this.children;
  }
  get selectedIndex() {
    return 0;
  }
  set selectedIndex(_idx: number) {}
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] ?? null : null;
  }
  appendChild(child: MockNode) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MockNode, ref: MockNode | null) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild(child: MockNode) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(ev: { type: string; [k: string]: unknown }) {
    const evt = { ...ev, target: this, currentTarget: this };
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of Array.from(set)) fn(evt);
    }
    return true;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
  }
  focus() {}
}

class MockMediaElement extends MockNode {
  private _src = "";
  private _currentTime = 0;
  paused = true;
  muted = false;
  volume = 1;
  playbackRate = 1;
  preservesPitch = false;
  webkitPreservesPitch = false;
  mozPreservesPitch = false;
  readyState = 0;
  duration = 30;
  seeking = false;
  preload = "auto";
  playsInline = true;
  readonly events: RecordedAudioEvents = {
    srcAssignments: [],
    removeSrcCount: 0,
    loadCount: 0,
    playCount: 0,
    pauseCount: 0,
    seeks: [],
  };
  rejectNextPlayWith: Error | null = null;

  get src() {
    return this._src;
  }
  set src(val: string) {
    this._src = val || "";
    this.attributes.set("src", this._src);
    this.events.srcAssignments.push(this._src);
    if (this._src) {
      this.readyState = 4;
    }
  }
  override setAttribute(k: string, v: string) {
    super.setAttribute(k, v);
    if (k === "src") {
      this._src = String(v);
      this.events.srcAssignments.push(this._src);
      if (this._src) {
        this.readyState = 4;
      }
    }
  }
  override removeAttribute(k: string) {
    super.removeAttribute(k);
    if (k === "src") {
      this._src = "";
      this.events.removeSrcCount++;
    }
  }
  get currentTime() {
    return this._currentTime;
  }
  set currentTime(val: number) {
    this._currentTime = val;
    this.events.seeks.push(Number(val.toFixed(3)));
  }
  load() {
    this.events.loadCount++;
    if (!this._src) {
      this.readyState = 0;
    }
  }
  play() {
    this.events.playCount++;
    if (this.rejectNextPlayWith) {
      const err = this.rejectNextPlayWith;
      this.rejectNextPlayWith = null;
      return Promise.reject(err);
    }
    if (!this._src) {
      return Promise.reject(new Error("DOMException: Failed to load because no supported source was found."));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
    }
    this.events.pauseCount++;
  }
}

class MockDocument {
  nodeType = 9;
  documentElement: MockNode;
  body: MockNode;
  activeElement: MockNode | null = null;
  defaultView: unknown = null;
  createdAudios: MockMediaElement[] = [];

  constructor() {
    this.documentElement = new MockNode("html", this);
    this.body = new MockNode("body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    const lower = tag.toLowerCase();
    if (lower === "audio" || lower === "video") {
      const el = new MockMediaElement(lower, this);
      if (lower === "audio") this.createdAudios.push(el);
      return el;
    }
    return new MockNode(lower, this);
  }
  createElementNS(_ns: string, tag: string) {
    return this.createElement(tag);
  }
  createTextNode(text: string) {
    const n = new MockNode("#text", this);
    n.nodeType = 3;
    n.textContent = text;
    return n;
  }
  createComment(text: string) {
    const n = new MockNode("#comment", this);
    n.nodeType = 8;
    n.textContent = text;
    return n;
  }
  addEventListener() {}
  removeEventListener() {}
}

class MockGainNode {
  value = 1;
  lastTargetTime: number | null = null;
  connectedTo: unknown = null;
  gain = {
    setTargetAtTime: (val: number, time: number) => {
      this.value = val;
      this.lastTargetTime = time;
    },
    setValueAtTime: (val: number, time: number) => {
      this.value = val;
      this.lastTargetTime = time;
    },
    get value() {
      return 0;
    },
    set value(_v: number) {},
  };
  constructor() {
    const self = this;
    this.gain = {
      setTargetAtTime(val: number, time: number) {
        self.value = val;
        self.lastTargetTime = time;
      },
      setValueAtTime(val: number, time: number) {
        self.value = val;
        self.lastTargetTime = time;
      },
      get value() {
        return self.value;
      },
      set value(v: number) {
        self.value = v;
      },
    };
  }
  connect(dest: unknown) {
    this.connectedTo = dest;
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  destination = { kind: "destination" };
  resumeCalls = 0;
  closedCalls = 0;
  gainNodesByElement = new WeakMap<object, MockGainNode>();

  constructor(createdDuringGesture = false) {
    if (createdDuringGesture) {
      this.state = "running";
    }
    MockAudioContext.instances.push(this);
  }
  resume() {
    this.resumeCalls++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closedCalls++;
    this.state = "closed";
    return Promise.resolve();
  }
  createMediaElementSource(el: object) {
    return {
      el,
      connect: (_dest: unknown) => {},
    };
  }
  createGain() {
    return new MockGainNode();
  }
}

function findElementsByTag(root: MockNode, tag: string): MockNode[] {
  const out: MockNode[] = [];
  const target = tag.toUpperCase();
  const walk = (n: MockNode) => {
    if (n.tagName === target) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

function makeAudioProject(): Project {
  return {
    id: "proj_audio_test",
    name: "Audio Regression Sequence",
    description: "Tests A1 audio playback, sync, trim, split, fades, ducking, and speed",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 24,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tracks: createDefaultTracks(),
    clips: [
      {
        id: "v1_base",
        assetId: "asset_v1",
        trackId: "track_v1",
        name: "MainVideo.mp4",
        kind: "video",
        startTime: 0,
        duration: 16,
        inPoint: 0,
        sourceDuration: 20,
        volume: 1,
        muted: false,
        speed: 1,
        opacity: 1,
        objectUrl: "blob:v1-main",
      },
      {
        id: "a1_music",
        assetId: "asset_a1",
        trackId: "track_a1",
        name: "BackgroundMusic.mp3",
        kind: "audio",
        startTime: 0,
        duration: 14,
        inPoint: 0,
        sourceDuration: 30,
        volume: 1.5, // 150% Web Audio amplification
        muted: false,
        fadeInSec: 0,
        fadeOutSec: 1,
        duckingEnabled: true,
        duckingAmount: 0.6,
        speed: 1,
        opacity: 1,
        objectUrl: "blob:a1-music",
      },
    ],
    subtitles: [
      {
        id: "sub_speech_1",
        start: 4,
        end: 6,
        text: "বাংলা ভয়েস ওভার",
        clipId: "v1_base",
      },
    ],
  };
}

async function testEditorPreviewStageAudioLifecycle() {
  const doc = new MockDocument();
  const winListeners = new Map<string, Set<(ev: unknown) => void>>();
  let inUserGesture = false;

  class GestureAwareAudioContext extends MockAudioContext {
    constructor() {
      super(inUserGesture);
    }
  }

  const origWindow = (globalThis as Record<string, unknown>).window;
  const origDocument = (globalThis as Record<string, unknown>).document;

  const mockWindow = {
    document: doc,
    AudioContext: GestureAwareAudioContext,
    HTMLElement: MockNode,
    HTMLIFrameElement: MockNode,
    Element: MockNode,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      winListeners.get(type)?.delete(fn);
    },
    setTimeout,
    clearTimeout,
  };
  doc.defaultView = mockWindow;

  (globalThis as Record<string, unknown>).window = mockWindow;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).Element = MockNode;
  (globalThis as Record<string, unknown>).HTMLElement = MockNode;
  (globalThis as Record<string, unknown>).HTMLIFrameElement = MockNode;
  (globalThis as Record<string, unknown>).HTMLMediaElement = MockMediaElement;
  (globalThis as Record<string, unknown>).HTMLAudioElement = MockMediaElement;
  (globalThis as Record<string, unknown>).HTMLVideoElement = MockMediaElement;

  MockAudioContext.instances = [];
  const { EditorPreviewStage } = await import("../src/components/editor/EditorPreviewStage.tsx");

  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  let project = makeAudioProject();
  const clock = new TimelinePlaybackClock(0);
  let isPlaying = false;
  let masterVolume = 0.9;
  let masterMuted = false;
  let playbackRate = 1;

  const renderStage = () => {
    flushSync(() => {
      root.render(
        React.createElement(EditorPreviewStage, {
          project,
          playbackClock: clock,
          totalDuration: 16,
          isPlaying,
          onSetIsPlaying: (next: React.SetStateAction<boolean>) => {
            isPlaying = typeof next === "function" ? next(isPlaying) : next;
          },
          masterVolume,
          onMasterVolumeChange: (v: number) => {
            masterVolume = v;
          },
          masterMuted,
          onToggleMasterMuted: () => {
            masterMuted = !masterMuted;
          },
          playbackRate,
          onPlaybackRateChange: (r: number) => {
            playbackRate = r;
          },
          selectedClipId: null,
          onSelectClip: () => undefined,
          onUpdateClip: () => undefined,
          onUpdateTextStyle: () => undefined,
          onCommitProjectSnapshot: () => undefined,
          onTriggerRelink: () => undefined,
          isRestoringProjectMedia: false,
          onMediaError: () => undefined,
          onSeek: (t: number) => clock.setTime(t, true),
          onTogglePlay: () => {
            isPlaying = !isPlaying;
          },
          onStepFrame: () => undefined,
        })
      );
    });
  };

  try {
    // 1. Initial mount (paused): AudioContext should NOT be prematurely created while paused
    renderStage();
    assert.equal(doc.createdAudios.length, 1, "Expected 1 <audio> element for A1 clip");
    const audioEl = doc.createdAudios[0];
    assert.equal(audioEl.src, "blob:a1-music", "<audio> must keep its src after mount");
    assert.equal(audioEl.events.removeSrcCount, 0, "Mount must not strip src");
    assert.equal(MockAudioContext.instances.length, 0, "AudioContext should stay uncreated while paused");

    // 2. Click Play button synchronously (simulating user gesture)
    const buttons = findElementsByTag(container, "button");
    const playButton = buttons.find((b) => b.getAttribute("aria-label") === "Play");
    assert.ok(playButton, "Play button must exist");
    const onClickProp = Object.keys(playButton).find((k) => k.startsWith("__reactProps$"));
    assert.ok(onClickProp);

    inUserGesture = true;
    (playButton as unknown as Record<string, { onClick: () => void }>)[onClickProp].onClick();
    inUserGesture = false;
    assert.equal(isPlaying, true);
    assert.equal(MockAudioContext.instances.length, 1, "Play click gesture must initialize AudioContext");
    assert.equal(MockAudioContext.instances[0].state, "running", "AudioContext created inside Play click must be running");

    renderStage();
    await Promise.resolve();
    assert.equal(audioEl.events.removeSrcCount, 0, "Playing transition must NOT strip audio src");
    assert.equal(audioEl.events.loadCount, 0, "Playing transition must NOT call load()");
    assert.equal(audioEl.src, "blob:a1-music");
    assert.equal(audioEl.paused, false, "A1 audio element must be playing");
    assert.equal(audioEl.muted, false, "A1 audio element must not be muted");
    assert.ok(audioEl.events.playCount >= 1, "audio.play() must be called");

    // 3. Advance 60 playback frames (~1.0s) via TimelinePlaybackClock
    const seeksBeforePlaybackLoop = audioEl.events.seeks.length;
    for (let f = 1; f <= 60; f++) {
      const t = Number((f * 0.016).toFixed(3));
      // Simulate real media clock advancing alongside timeline clock
      audioEl.currentTime = t;
      // Clear seek record caused by our test simulating audio clock advance
      audioEl.events.seeks.pop();
      flushSync(() => {
        clock.setTime(t);
      });
    }
    assert.equal(
      audioEl.events.removeSrcCount,
      0,
      "60Hz playback re-renders MUST NOT strip <audio> src via inline callback ref detach"
    );
    assert.equal(audioEl.events.loadCount, 0, "60Hz playback MUST NOT call load() on <audio>");
    assert.equal(audioEl.paused, false, "A1 audio must stay playing across 60 frames");
    assert.equal(
      audioEl.events.seeks.length,
      seeksBeforePlaybackLoop,
      "Steady playback must not seek-thrash <audio>"
    );

    // 4. Seek to speech interval (t=5.0s) and verify ducking gain, then jump past clip end (t=14.5s)
    flushSync(() => {
      clock.setTime(5.0, true);
    });
    assert.ok(
      audioEl.events.seeks.some((s) => Math.abs(s - 5.0) < 0.05),
      "Jumping timeline to 5.0s must seek A1 audio to 5.0s"
    );

    const expectedDuckGain = computeEffectiveClipGain({
      clip: project.clips[1],
      timelineTimeSec: 5.0,
      trackMuted: false,
      masterVolume,
      masterMuted,
      speechIntervals: buildSpeechIntervals(project.subtitles),
      v1AudibleAtTime: true,
    });
    assert.ok(expectedDuckGain.effectiveGain < 1.0, "Ducking at speech interval must attenuate gain");
    assert.equal(expectedDuckGain.isMuted, false);

    flushSync(() => {
      clock.setTime(14.5, true);
    });
    assert.equal(audioEl.paused, true, "A1 audio must pause once playhead passes clip end");

    // 5. Seek back to 2.0s, test trim & split & speed & mutes
    isPlaying = false;
    renderStage();
    flushSync(() => {
      clock.setTime(2.0, true);
    });

    // Trim start of A1 clip -> shifts startTime to 1.0 and inPoint to 1.0
    const trimPatch = trimClipStart(project.clips[1], 1.0, [project.clips[1]]);
    project = {
      ...project,
      clips: project.clips.map((c) => (c.id === "a1_music" ? { ...c, ...trimPatch } : c)),
    };
    isPlaying = true;
    renderStage();
    await Promise.resolve();
    assert.equal(audioEl.paused, false);
    assert.ok(
      audioEl.events.seeks.some((s) => Math.abs(s - 2.0) < 0.05),
      "Trimmed clip must map timeline t=2.0 to source inPoint + (2 - 1) = 2.0s"
    );

    // Change speed of A1 clip to 1.5x + global rate 1.5x -> audio.playbackRate = 2.25 & preservesPitch = true
    const speedRes = applyClipSpeedOnTimeline(project.clips, "a1_music", 1.5);
    playbackRate = 1.5;
    project = { ...project, clips: speedRes.clips };
    renderStage();
    assert.equal(audioEl.preservesPitch, true);
    assert.ok(Math.abs(audioEl.playbackRate - 2.25) < 0.01);

    // Split A1 clip cleanly at t=4.0 -> mounts 2nd audio element for right split half
    playbackRate = 1;
    const splitRes = splitClipAtTimestamp(project.clips, "a1_music", 4.0);
    assert.equal(splitRes.didSplit, true);
    project = { ...project, clips: splitRes.clips };
    renderStage();
    assert.equal(doc.createdAudios.length, 2, "Split A1 clip must mount right-half <audio> element");
    flushSync(() => {
      clock.setTime(4.5, true);
    });
    await Promise.resolve();
    const rightAudioEl = doc.createdAudios[1];
    assert.equal(audioEl.paused, true, "Left split A1 half must pause at t=4.5");
    assert.equal(rightAudioEl.paused, false, "Right split A1 half must play at t=4.5");
    assert.equal(rightAudioEl.events.removeSrcCount, 0);

    // Track mute & master mute calculations
    project = {
      ...project,
      tracks: project.tracks.map((t) => (t.id === "track_a1" ? { ...t, muted: true } : t)),
    };
    renderStage();
    assert.equal(rightAudioEl.muted, true, "Track A1 mute must mute active audio element");

    project = {
      ...project,
      tracks: project.tracks.map((t) => (t.id === "track_a1" ? { ...t, muted: false } : t)),
    };
    renderStage();
    assert.equal(rightAudioEl.muted, false, "Unmuting Track A1 must unmute active audio element");

    masterMuted = true;
    renderStage();
    assert.equal(rightAudioEl.muted, true, "Master mute must mute active audio element");

    masterMuted = false;
    renderStage();
    assert.equal(rightAudioEl.muted, false, "Unmuting master must restore active audio element");

    // 6. Unmount / delete clip cleanup DOES remove src cleanly when actually unmounted
    project = { ...project, clips: [project.clips[0]] };
    renderStage();
    assert.ok(audioEl.events.removeSrcCount >= 1, "Unmounting deleted audio clip must clean up src");
    assert.ok(rightAudioEl.events.removeSrcCount >= 1, "Unmounting deleted split audio clip must clean up src");

    flushSync(() => {
      root.unmount();
    });
    assert.equal(MockAudioContext.instances[0].closedCalls, 1, "Unmounting stage must close AudioContext");
  } finally {
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).document = origDocument;
  }

  console.log("PASS: EditorPreviewStage A1 audio lifecycle, ref stability, sync, trim, split, speed, ducking & cleanup");
}

function testIndexedDbAudioRestorationAndGainMath() {
  const origCreateObjectURL = URL.createObjectURL;
  let counter = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:restored-idb-${++counter}`;

  try {
    const rec: StoredMediaRecord = {
      id: "asset_idb_audio",
      name: "Theme.m4a",
      kind: "audio",
      mimeType: "audio/mp4",
      sizeBytes: 512000,
      duration: 18.5,
      waveformPeaks: [0.2, 0.8, 0.5],
      blob: new Blob([new Uint8Array(64)], { type: "audio/mp4" }),
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const hydratedAsset = hydrateAssetFromStoredRecord(rec);
    assert.equal(hydratedAsset.objectUrl, "blob:restored-idb-1");

    const proj: Project = {
      ...makeAudioProject(),
      clips: [
        {
          id: "clip_idb_a1",
          assetId: "asset_idb_audio",
          trackId: "track_a1",
          name: "Theme.m4a",
          kind: "audio",
          startTime: 2,
          duration: 10,
          inPoint: 3,
          sourceDuration: 18.5,
          volume: 1.4,
          muted: false,
          fadeInSec: 2,
          fadeOutSec: 2,
          duckingEnabled: true,
          duckingAmount: 0.5,
          speed: 1,
          opacity: 1,
          objectUrl: "",
          needsRelink: false,
        },
      ],
    };

    const reconciled = reconcileProjectsWithMediaAssets([proj], [hydratedAsset], true);
    const restoredClip: TimelineClip = reconciled[0].clips[0];
    assert.equal(restoredClip.objectUrl, "blob:restored-idb-1");
    assert.equal(restoredClip.needsRelink, false);
    assert.deepEqual(restoredClip.waveformPeaks, [0.2, 0.8, 0.5]);

    // Trim end check preserves fades cleanly
    const trimEndPatch = trimClipEnd(restoredClip, 3, [restoredClip]);
    assert.equal(trimEndPatch.duration, 3);
    assert.equal(trimEndPatch.fadeInSec, 2);

    // Fade-in at start = 0 -> muted at t=start, ramps smoothly by mid-clip, amplified >100%
    const gStart = computeEffectiveClipGain({
      clip: restoredClip,
      timelineTimeSec: 2.0,
      trackMuted: false,
      masterVolume: 1,
      masterMuted: false,
    });
    assert.equal(gStart.effectiveGain, 0);
    assert.equal(gStart.isMuted, true);

    const gMid = computeEffectiveClipGain({
      clip: restoredClip,
      timelineTimeSec: 7.0,
      trackMuted: false,
      masterVolume: 1,
      masterMuted: false,
    });
    assert.equal(gMid.effectiveGain, 1.4);
    assert.equal(gMid.isMuted, false);
  } finally {
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = origCreateObjectURL;
  }

  console.log("PASS: IndexedDB audio objectUrl restoration, trim, fades, and >100% gain calculation");
}

(async () => {
  await testEditorPreviewStageAudioLifecycle();
  testIndexedDbAudioRestorationAndGainMath();
  console.log("\nALL_AUDIO_PLAYBACK_REGRESSIONS_PASSED");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
