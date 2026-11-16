import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Volume2,
  VolumeX,
  Upload,
  Plus,
  Download,
  Film,
  Music,
  Image as ImageIcon,
  Search,
  Save,
  Check,
  AlertTriangle,
  Type,
  Captions,
  HardDrive,
  RefreshCw,
  X,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { MultitrackTimeline } from "../components/editor/MultitrackTimeline";
import { AiAssistantPanel, type EditorPanelTab } from "../components/editor/AiAssistantPanel";
import { ExportModal } from "../components/editor/ExportModal";
import { useStudio } from "../context/StudioContext";
import type { MediaAsset, MediaKind, Project, TimelineClip } from "../types/studio";
import { buildSpeechIntervals, computeEffectiveClipGain } from "../utils/audio";
import {
  buildPreviewCssFilter,
  computeClipTransitionStyle,
  normalizeEffects,
  normalizeTransition,
} from "../utils/effects";
import { computeEffectiveOverlayBox, normalizeOverlayTransform } from "../utils/overlays";
import { formatBytes, formatTimecode } from "../utils/media";
import { getSubtitleStyle, hexToRgba } from "../utils/subtitles";

export function EditorPage() {
  const {
    projects,
    activeProject,
    setActiveProjectId,
    createProject,
    mediaAssets,
    uploadLocalFiles,
    uploadingMedia,
    idbHydrating,
    storageEstimate,
    mediaError,
    clearMediaError,
    relinkMissingClipAsset,
    addClipToTimeline,
    addTextOverlay,
    updateClip,
    updateTextStyle,
    commitProjectSnapshot,
    splitClipAtTime,
    deleteClip,
    undo,
    redo,
    lastLocalSaveAt,
    saveTimelineLocally,
    isAuthenticated,
    mongoSaveStatus,
    lastMongoSaveAt,
    mongoSaveError,
    saveTimelineToMongo,
    sessionUser,
  } = useStudio();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const relinkTargetAssetIdRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const v2VideoRef = useRef<HTMLVideoElement | null>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaGainMapRef = useRef<
    WeakMap<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode }>
  >(new WeakMap());
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedVideoClipIdRef = useRef<string | null>(null);
  const lastSyncedV2ClipIdRef = useRef<string | null>(null);
  const lastSyncedAudioMapRef = useRef<Map<string, boolean>>(new Map());
  const lastGainMapRef = useRef<WeakMap<HTMLMediaElement, { gain: number; muted: boolean }>>(
    new WeakMap()
  );
  const pendingSeekMapRef = useRef<WeakMap<HTMLMediaElement, number>>(new WeakMap());

  const [playheadTime, setPlayheadTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [masterVolume, setMasterVolume] = useState(0.9);
  const [masterMuted, setMasterMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<"select" | "razor">("select");
  const [binSearch, setBinSearch] = useState("");
  const [binDragOver, setBinDragOver] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<EditorPanelTab>("assistant");
  const [previewMediaError, setPreviewMediaError] = useState<string | null>(null);

  const totalDuration = useMemo(() => {
    if (!activeProject || activeProject.clips.length === 0) return 0;
    return activeProject.clips.reduce(
      (max, c) => Math.max(max, c.startTime + c.duration),
      0
    );
  }, [activeProject]);

  const selectedClip = useMemo(
    () => activeProject?.clips.find((c) => c.id === selectedClipId) ?? null,
    [activeProject, selectedClipId]
  );

  const missingMediaItems = useMemo(() => {
    if (!activeProject) return [];
    const seen = new Map<
      string,
      { assetId: string; name: string; sizeBytes?: number; kind: MediaKind }
    >();
    for (const clip of activeProject.clips) {
      if (clip.needsRelink && clip.assetId && !seen.has(clip.assetId)) {
        seen.set(clip.assetId, {
          assetId: clip.assetId,
          name: clip.sourceName || clip.name,
          sizeBytes: clip.sourceSizeBytes,
          kind: clip.kind,
        });
      }
    }
    return Array.from(seen.values());
  }, [activeProject]);

  const hasClipsNeedingRelink = !idbHydrating && missingMediaItems.length > 0;
  const isRestoringProjectMedia = Boolean(
    idbHydrating && activeProject?.clips.some((c) => c.kind !== "text" && !c.objectUrl)
  );

  const v1Track = activeProject?.tracks.find((t) => t.id === "track_v1");
  const v2Track = activeProject?.tracks.find((t) => t.id === "track_v2");
  const t1Track = activeProject?.tracks.find((t) => t.id === "track_t1");
  const a1Track = activeProject?.tracks.find((t) => t.id === "track_a1");

  const activeV1Clip = useMemo<TimelineClip | null>(() => {
    if (!activeProject) return null;
    return (
      activeProject.clips.find(
        (c) =>
          c.trackId === "track_v1" &&
          playheadTime >= c.startTime &&
          playheadTime < c.startTime + c.duration
      ) ?? null
    );
  }, [activeProject, playheadTime]);

  const activeV2Clip = useMemo<TimelineClip | null>(() => {
    if (!activeProject) return null;
    return (
      activeProject.clips.find(
        (c) =>
          c.trackId === "track_v2" &&
          playheadTime >= c.startTime &&
          playheadTime < c.startTime + c.duration
      ) ?? null
    );
  }, [activeProject, playheadTime]);

  const activeTextClips = useMemo<TimelineClip[]>(() => {
    if (!activeProject || t1Track?.muted) return [];
    return activeProject.clips.filter(
      (c) =>
        c.trackId === "track_t1" &&
        c.kind === "text" &&
        playheadTime >= c.startTime &&
        playheadTime < c.startTime + c.duration
    );
  }, [activeProject, playheadTime, t1Track?.muted]);

  const a1AudioClips = useMemo<TimelineClip[]>(() => {
    if (!activeProject) return [];
    return activeProject.clips.filter(
      (c) =>
        c.trackId === "track_a1" &&
        c.kind === "audio" &&
        !c.needsRelink &&
        Boolean(c.objectUrl)
    );
  }, [activeProject]);

  const speechIntervals = useMemo(
    () => buildSpeechIntervals(activeProject?.subtitles),
    [activeProject?.subtitles]
  );

  const v1AudibleAtTime = Boolean(
    activeV1Clip &&
      activeV1Clip.kind === "video" &&
      !v1Track?.muted &&
      !activeV1Clip.muted &&
      activeV1Clip.volume > 0.01
  );

  const ensureMediaGainNode = useCallback((el: HTMLMediaElement): GainNode | null => {
    const existing = mediaGainMapRef.current.get(el);
    if (existing) {
      return existing.gain;
    }
    if (typeof window === "undefined") return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      mediaGainMapRef.current.set(el, { source, gain });
      return gain;
    } catch {
      return null;
    }
  }, []);

  const applyPitchPreservation = useCallback((el: HTMLMediaElement, rate: number) => {
    const pitchEl = el as HTMLMediaElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
      mozPreservesPitch?: boolean;
    };
    if (pitchEl.preservesPitch !== true) {
      pitchEl.preservesPitch = true;
    }
    if (pitchEl.webkitPreservesPitch !== true) {
      pitchEl.webkitPreservesPitch = true;
    }
    if (pitchEl.mozPreservesPitch !== true) {
      pitchEl.mozPreservesPitch = true;
    }
    if (Math.abs(el.playbackRate - rate) > 0.005) {
      el.playbackRate = rate;
    }
  }, []);

  const seekMediaSafely = useCallback((el: HTMLMediaElement, targetTime: number) => {
    const durationLimit = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : targetTime;
    const clamped = Math.max(0, Math.min(durationLimit, targetTime));
    if (el.seeking) {
      pendingSeekMapRef.current.set(el, clamped);
      return;
    }
    try {
      pendingSeekMapRef.current.delete(el);
      el.currentTime = clamped;
    } catch {
      // Ignore seek errors while media decodes
    }
  }, []);

  const flushPendingSeek = useCallback((el: HTMLMediaElement) => {
    const pending = pendingSeekMapRef.current.get(el);
    if (pending === undefined) return;
    pendingSeekMapRef.current.delete(el);
    if (Math.abs(el.currentTime - pending) > 0.03 && el.readyState >= 1) {
      try {
        el.currentTime = pending;
      } catch {
        // Ignore queued seek errors
      }
    }
  }, []);

  const applyClipAudioGain = useCallback(
    (el: HTMLMediaElement, effectiveGain: number, isMuted: boolean) => {
      const targetVal = isMuted ? 0 : Math.max(0, Math.min(2, effectiveGain));
      const prev = lastGainMapRef.current.get(el);
      if (prev && prev.muted === isMuted && Math.abs(prev.gain - targetVal) < 0.002) {
        return;
      }
      lastGainMapRef.current.set(el, { gain: targetVal, muted: isMuted });

      const gainNode = ensureMediaGainNode(el);
      if (el.muted !== isMuted) {
        el.muted = isMuted;
      }
      if (gainNode && audioCtxRef.current) {
        if (el.volume !== 1) el.volume = 1;
        gainNode.gain.setTargetAtTime(targetVal, audioCtxRef.current.currentTime, 0.015);
      } else {
        el.volume = isMuted ? 0 : Math.min(1, Math.max(0, targetVal));
      }
    },
    [ensureMediaGainNode]
  );

  useEffect(() => {
    return () => {
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close().catch(() => undefined);
      }
      audioCtxRef.current = null;
    };
  }, []);

  const subtitleStyle = useMemo(() => getSubtitleStyle(activeProject), [activeProject]);

  const activeSubtitles = useMemo(() => {
    if (!activeProject || !subtitleStyle.enabled) return [];
    return (activeProject.subtitles ?? []).filter(
      (s) =>
        s.text.trim().length > 0 &&
        playheadTime >= s.start &&
        playheadTime < s.end
    );
  }, [activeProject, playheadTime, subtitleStyle.enabled]);

  const primaryVisualClip = activeV1Clip ?? activeV2Clip;
  const primaryTrackMuted =
    primaryVisualClip?.trackId === "track_v2" ? Boolean(v2Track?.muted) : Boolean(v1Track?.muted);

  const prevAdjacentV1Clip = useMemo<TimelineClip | null>(() => {
    if (!activeProject || !primaryVisualClip || primaryVisualClip.trackId !== "track_v1") {
      return null;
    }
    const candidates = activeProject.clips
      .filter(
        (c) =>
          c.trackId === "track_v1" &&
          c.id !== primaryVisualClip.id &&
          c.startTime + c.duration <= primaryVisualClip.startTime + 0.15 &&
          Math.abs(primaryVisualClip.startTime - (c.startTime + c.duration)) <= 0.15
      )
      .sort((a, b) => b.startTime + b.duration - (a.startTime + a.duration));
    return candidates[0] ?? null;
  }, [activeProject, primaryVisualClip]);

  const primaryPreviewStyle = useMemo(() => {
    if (!primaryVisualClip) return {};
    const filter = buildPreviewCssFilter(primaryVisualClip.effects);
    const transStyle = computeClipTransitionStyle(
      primaryVisualClip,
      playheadTime,
      prevAdjacentV1Clip
    );
    return {
      ...transStyle,
      ...(filter !== "none" ? { filter } : {}),
    };
  }, [primaryVisualClip, playheadTime, prevAdjacentV1Clip]);

  const activeTransitionBackdropUrl = useMemo(() => {
    if (!primaryVisualClip || !prevAdjacentV1Clip?.thumbnailUrl) return null;
    const elapsed = Math.max(0, playheadTime - primaryVisualClip.startTime);
    const inTrans = normalizeTransition(primaryVisualClip.transitionIn, primaryVisualClip.duration);
    const prevOut = normalizeTransition(
      prevAdjacentV1Clip.transitionOut,
      prevAdjacentV1Clip.duration
    );
    const effective = inTrans.type !== "none" ? inTrans : prevOut;
    if (effective.type === "none" || elapsed >= effective.durationSec) return null;
    return prevAdjacentV1Clip.thumbnailUrl;
  }, [primaryVisualClip, prevAdjacentV1Clip, playheadTime]);

  const syncVideoElement = useCallback(() => {
    const vid = videoRef.current;
    if (!vid || !primaryVisualClip || primaryVisualClip.kind !== "video" || primaryVisualClip.needsRelink) {
      lastSyncedVideoClipIdRef.current = null;
      return;
    }

    const clipChanged = lastSyncedVideoClipIdRef.current !== primaryVisualClip.id;
    const targetSourceTime =
      primaryVisualClip.inPoint +
      (playheadTime - primaryVisualClip.startTime) * primaryVisualClip.speed;

    applyPitchPreservation(vid, playbackRate * primaryVisualClip.speed);
    const { effectiveGain, isMuted } = computeEffectiveClipGain({
      clip: primaryVisualClip,
      timelineTimeSec: playheadTime,
      trackMuted: primaryTrackMuted,
      masterVolume,
      masterMuted,
    });
    applyClipAudioGain(vid, effectiveGain, isMuted);

    const tolerance = clipChanged || !isPlaying ? 0.04 : 0.35;
    if (vid.readyState >= 1 && Math.abs(vid.currentTime - targetSourceTime) > tolerance) {
      seekMediaSafely(vid, targetSourceTime);
      lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
    } else if (vid.readyState >= 1 && clipChanged) {
      lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
    }

    if (isPlaying && vid.paused) {
      if (audioCtxRef.current?.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      void vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [
    primaryVisualClip,
    playheadTime,
    isPlaying,
    playbackRate,
    masterMuted,
    masterVolume,
    primaryTrackMuted,
    applyPitchPreservation,
    applyClipAudioGain,
    seekMediaSafely,
  ]);

  // Playback animation loop
  useEffect(() => {
    if (!isPlaying) return;
    if (totalDuration <= 0) {
      setIsPlaying(false);
      return;
    }

    if (audioCtxRef.current?.state === "suspended") {
      void audioCtxRef.current.resume().catch(() => {});
    }

    let frameId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dt = ((now - lastTs) / 1000) * playbackRate;
      lastTs = now;

      setPlayheadTime((prev) => {
        const next = prev + dt;
        if (next >= totalDuration) {
          setIsPlaying(false);
          return totalDuration;
        }
        return next;
      });
      frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, totalDuration, playbackRate]);

  // Synchronize HTML5 <video> element with timeline playhead
  useEffect(() => {
    syncVideoElement();
  }, [syncVideoElement]);

  const syncV2VideoElement = useCallback(() => {
    const vid = v2VideoRef.current;
    if (
      !vid ||
      !activeV1Clip ||
      !activeV2Clip ||
      activeV2Clip.kind !== "video" ||
      activeV2Clip.needsRelink ||
      v2Track?.muted
    ) {
      lastSyncedV2ClipIdRef.current = null;
      if (vid && !vid.paused) {
        vid.pause();
      }
      return;
    }

    const clipChanged = lastSyncedV2ClipIdRef.current !== activeV2Clip.id;
    const targetSourceTime =
      activeV2Clip.inPoint + (playheadTime - activeV2Clip.startTime) * activeV2Clip.speed;

    applyPitchPreservation(vid, playbackRate * activeV2Clip.speed);
    const { effectiveGain, isMuted } = computeEffectiveClipGain({
      clip: activeV2Clip,
      timelineTimeSec: playheadTime,
      trackMuted: Boolean(v2Track?.muted),
      masterVolume,
      masterMuted,
    });
    applyClipAudioGain(vid, effectiveGain, isMuted);

    const tolerance = clipChanged || !isPlaying ? 0.04 : 0.35;
    if (vid.readyState >= 1 && Math.abs(vid.currentTime - targetSourceTime) > tolerance) {
      seekMediaSafely(vid, targetSourceTime);
      lastSyncedV2ClipIdRef.current = activeV2Clip.id;
    } else if (vid.readyState >= 1 && clipChanged) {
      lastSyncedV2ClipIdRef.current = activeV2Clip.id;
    }

    if (isPlaying && vid.paused) {
      if (audioCtxRef.current?.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      void vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [
    activeV1Clip,
    activeV2Clip,
    playheadTime,
    isPlaying,
    playbackRate,
    masterMuted,
    masterVolume,
    v2Track?.muted,
    applyPitchPreservation,
    applyClipAudioGain,
    seekMediaSafely,
  ]);

  useEffect(() => {
    syncV2VideoElement();
  }, [syncV2VideoElement]);

  // Synchronize all A1 Audio track elements via Web Audio GainNodes (volume 0-200%, fades, ducking, mute)
  useEffect(() => {
    const activeIds = new Set(a1AudioClips.map((c) => c.id));
    for (const prevId of Array.from(lastSyncedAudioMapRef.current.keys())) {
      if (!activeIds.has(prevId)) {
        lastSyncedAudioMapRef.current.delete(prevId);
      }
    }

    for (const audioClip of a1AudioClips) {
      const aud = audioElsRef.current.get(audioClip.id);
      if (!aud) continue;

      const isActiveAtPlayhead =
        playheadTime >= audioClip.startTime &&
        playheadTime < audioClip.startTime + audioClip.duration;
      const wasActive = lastSyncedAudioMapRef.current.get(audioClip.id) ?? false;

      if (!isActiveAtPlayhead) {
        lastSyncedAudioMapRef.current.set(audioClip.id, false);
        if (!aud.paused) {
          aud.pause();
        }
        applyClipAudioGain(aud, 0, true);
        continue;
      }

      const targetSourceTime =
        audioClip.inPoint + (playheadTime - audioClip.startTime) * audioClip.speed;
      applyPitchPreservation(aud, playbackRate * audioClip.speed);

      const { effectiveGain, isMuted } = computeEffectiveClipGain({
        clip: audioClip,
        timelineTimeSec: playheadTime,
        trackMuted: Boolean(a1Track?.muted),
        masterVolume,
        masterMuted,
        speechIntervals,
        v1AudibleAtTime,
      });
      applyClipAudioGain(aud, effectiveGain, isMuted);

      const tolerance = !wasActive || !isPlaying ? 0.04 : 0.32;
      if (aud.readyState >= 1 && Math.abs(aud.currentTime - targetSourceTime) > tolerance) {
        seekMediaSafely(aud, targetSourceTime);
      }
      lastSyncedAudioMapRef.current.set(audioClip.id, true);

      if (isPlaying && aud.paused) {
        if (audioCtxRef.current?.state === "suspended") {
          void audioCtxRef.current.resume().catch(() => {});
        }
        void aud.play().catch(() => {});
      } else if (!isPlaying && !aud.paused) {
        aud.pause();
      }
    }
  }, [
    a1AudioClips,
    playheadTime,
    isPlaying,
    playbackRate,
    masterMuted,
    masterVolume,
    a1Track?.muted,
    speechIntervals,
    v1AudibleAtTime,
    applyPitchPreservation,
    applyClipAudioGain,
    seekMediaSafely,
  ]);

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(Math.max(totalDuration, 30), time));
      setPlayheadTime(clamped);
    },
    [totalDuration]
  );

  const togglePlay = useCallback(() => {
    if (totalDuration <= 0) return;
    if (audioCtxRef.current?.state === "suspended") {
      void audioCtxRef.current.resume().catch(() => {});
    }
    if (!isPlaying && playheadTime >= totalDuration) {
      setPlayheadTime(0);
    }
    setIsPlaying((p) => !p);
  }, [isPlaying, playheadTime, totalDuration]);

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const fps = activeProject?.fps ?? 24;
      setIsPlaying(false);
      setPlayheadTime((t) => Math.max(0, Number((t + direction * (1 / fps)).toFixed(3))));
    },
    [activeProject?.fps]
  );

  const triggerLocalSave = useCallback(() => {
    saveTimelineLocally();
    if (isAuthenticated) {
      void saveTimelineToMongo();
    }
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1800);
  }, [isAuthenticated, saveTimelineLocally, saveTimelineToMongo]);

  // Keyboard Shortcuts including Undo / Redo / Local Save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        triggerLocalSave();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !inInput) {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !inInput) {
        e.preventDefault();
        redo();
        return;
      }

      if (inInput) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "v" || e.key === "V") {
        setActiveTool("select");
      } else if (e.key === "c" || e.key === "C") {
        setActiveTool("razor");
      } else if ((e.key === "s" || e.key === "S") && activeProject) {
        const targetClip =
          (selectedClipId ? activeProject.clips.find((c) => c.id === selectedClipId) : null) ??
          activeProject.clips.find(
            (c) => playheadTime > c.startTime + 0.2 && playheadTime < c.startTime + c.duration - 0.2
          );
        if (targetClip) {
          splitClipAtTime(targetClip.id, playheadTime);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrame(1);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
        deleteClip(selectedClipId);
        setSelectedClipId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    togglePlay,
    selectedClipId,
    activeProject,
    splitClipAtTime,
    playheadTime,
    stepFrame,
    deleteClip,
    undo,
    redo,
    triggerLocalSave,
  ]);

  const handleFilesSelected = async (files: FileList | File[]) => {
    const added = await uploadLocalFiles(files);
    if (added.length > 0 && (!activeProject || activeProject.clips.length === 0)) {
      const clip = addClipToTimeline(added[0]);
      if (clip) setSelectedClipId(clip.id);
    }
  };

  const handleUploadInEditor = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    await handleFilesSelected(e.target.files);
    e.target.value = "";
  };

  const triggerSingleClipRelink = (assetId: string) => {
    relinkTargetAssetIdRef.current = assetId;
    relinkInputRef.current?.click();
  };

  const handleRelinkFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetAssetId = relinkTargetAssetIdRef.current;
    e.target.value = "";
    relinkTargetAssetIdRef.current = null;
    if (!file || !targetAssetId) return;
    await relinkMissingClipAsset(targetAssetId, file);
  };

  const handleAddAssetToTimeline = (asset: MediaAsset) => {
    const clip = addClipToTimeline(asset);
    if (clip) setSelectedClipId(clip.id);
  };

  const handleTextOverlayDrag = (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    if (!previewFrameRef.current || !activeProject || !clip.textStyle) return;

    const beforeSnapshot: Project = {
      ...activeProject,
      tracks: activeProject.tracks.map((t) => ({ ...t })),
      clips: activeProject.clips.map((c) => ({
        ...c,
        waveformPeaks: c.waveformPeaks ? [...c.waveformPeaks] : undefined,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
        transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
        effects: c.effects ? normalizeEffects(c.effects) : undefined,
      })),
    };

    const rect = previewFrameRef.current.getBoundingClientRect();
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      moved = true;
      const xPct = Math.min(90, Math.max(10, ((moveEv.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(90, Math.max(10, ((moveEv.clientY - rect.top) / rect.height) * 100));
      updateTextStyle(
        clip.id,
        { x: Number(xPct.toFixed(1)), y: Number(yPct.toFixed(1)) },
        false
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) {
        commitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleV2OverlayDrag = (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    if (!previewFrameRef.current || !activeProject) return;

    const beforeTransform = normalizeOverlayTransform(clip.overlayTransform);
    const beforeSnapshot: Project = {
      ...activeProject,
      tracks: activeProject.tracks.map((t) => ({ ...t })),
      clips: activeProject.clips.map((c) => ({
        ...c,
        waveformPeaks: c.waveformPeaks ? [...c.waveformPeaks] : undefined,
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
        transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
        effects: c.effects ? normalizeEffects(c.effects) : undefined,
        overlayTransform: c.overlayTransform ? { ...c.overlayTransform } : undefined,
      })),
    };

    const rect = previewFrameRef.current.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = beforeTransform.x;
    const startY = beforeTransform.y;
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      const dxPct = ((moveEv.clientX - startMouseX) / Math.max(1, rect.width)) * 100;
      const dyPct = ((moveEv.clientY - startMouseY) / Math.max(1, rect.height)) * 100;
      if (Math.abs(dxPct) > 0.2 || Math.abs(dyPct) > 0.2) {
        moved = true;
      }
      const nextX = Math.min(100, Math.max(0, startX + dxPct));
      const nextY = Math.min(100, Math.max(0, startY + dyPct));
      updateClip(
        clip.id,
        {
          overlayTransform: normalizeOverlayTransform({
            ...beforeTransform,
            x: Number(nextX.toFixed(1)),
            y: Number(nextY.toFixed(1)),
          }),
        },
        false
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) {
        commitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const filteredBinAssets = useMemo(() => {
    const q = binSearch.trim().toLowerCase();
    return mediaAssets.filter((a) => a.name.toLowerCase().includes(q));
  }, [mediaAssets, binSearch]);

  const frameAspectClass =
    activeProject?.aspectRatio === "9:16"
      ? "aspect-[9/16] h-full max-h-[340px]"
      : activeProject?.aspectRatio === "1:1"
      ? "aspect-square h-full max-h-[340px]"
      : "aspect-video w-full max-w-3xl";

  return (
    <StudioShell
      fullBleed
      headerAction={
        <div className="flex items-center gap-2.5">
          {projects.length > 0 && (
            <select
              value={activeProject?.id ?? ""}
              onChange={(e) => {
                setIsPlaying(false);
                setPlayheadTime(0);
                setSelectedClipId(null);
                setActiveProjectId(e.target.value);
              }}
              className="hidden sm:block rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 focus:border-violet-500 focus:outline-none max-w-[180px]"
              aria-label="Switch active project"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={!activeProject}
            onClick={() => setRightPanelTab("subtitles")}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
              rightPanelTab === "subtitles"
                ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                : "border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
            }`}
            title="Open AI-Powered Automatic Subtitles"
          >
            <Captions className="h-3.5 w-3.5 text-violet-400" />
            <span>Generate Subtitles</span>
          </button>
          <button
            type="button"
            disabled={!activeProject || mongoSaveStatus === "saving"}
            onClick={triggerLocalSave}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            title={
              mongoSaveError
                ? `MongoDB sync error: ${mongoSaveError}`
                : isAuthenticated && lastMongoSaveAt
                  ? `Synced to MongoDB at ${new Date(lastMongoSaveAt).toLocaleTimeString()}`
                  : lastLocalSaveAt
                    ? `Last saved locally at ${new Date(lastLocalSaveAt).toLocaleTimeString()}`
                    : "Save timeline state locally and to MongoDB when signed in (Ctrl+S)"
            }
          >
            {mongoSaveStatus === "saving" ? (
              <>
                <Save className="h-3.5 w-3.5 text-blue-400 animate-pulse" />
                <span>Saving...</span>
              </>
            ) : saveFlash || (isAuthenticated && mongoSaveStatus === "saved") ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-300">
                  {isAuthenticated ? "Saved to MongoDB" : "Saved Locally"}
                </span>
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 text-blue-400" />
                <span>{isAuthenticated ? "Save Timeline" : "Save Locally"}</span>
              </>
            )}
          </button>
          <button
            type="button"
            disabled={!activeProject}
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export Video</span>
          </button>
        </div>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.mkv"
        onChange={(e) => void handleUploadInEditor(e)}
        className="hidden"
      />
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,image/*,audio/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.mkv"
        onChange={(e) => void handleRelinkFileSelected(e)}
        className="hidden"
      />

      {!activeProject ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-[#111114] p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-violet-400 mb-4">
              <Film className="h-6 w-6" />
            </div>
            <h1 className="font-display text-lg font-semibold text-white">
              Start a sequence in the Video Editor
            </h1>
            <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
              Create an empty timeline or select a local video file from your computer to begin editing immediately.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() =>
                  createProject({
                    name: "Sequence 01",
                    aspectRatio: "16:9",
                    resolution: sessionUser.defaultResolution,
                    fps: sessionUser.defaultFps,
                  })
                }
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create Sequence 01</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
              >
                <Upload className="h-3.5 w-3.5 text-blue-400" />
                <span>Import Local Video</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {(mediaError || previewMediaError) && (
            <div className="px-4 py-2 border-b border-rose-500/30 bg-rose-500/10 flex items-center justify-between gap-2 text-xs text-rose-200">
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span className="truncate" title={mediaError || previewMediaError || ""}>
                  {mediaError || previewMediaError}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearMediaError();
                  setPreviewMediaError(null);
                }}
                className="rounded p-1 text-rose-200 hover:bg-rose-500/20 hover:text-white shrink-0"
                aria-label="Dismiss media error"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {isRestoringProjectMedia && (
            <div className="px-4 py-1.5 border-b border-blue-500/30 bg-blue-500/10 flex items-center gap-2 text-xs text-blue-200">
              <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0 text-blue-400" />
              <span>Restoring local media files from browser IndexedDB storage...</span>
            </div>
          )}

          {hasClipsNeedingRelink && (
            <div className="px-4 py-2.5 border-b border-amber-500/30 bg-amber-500/10 space-y-2 text-xs text-amber-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    {missingMediaItems.length} local media file{missingMediaItems.length > 1 ? "s were" : " was"} not found in this browser&apos;s IndexedDB storage (browser data cleared or opened on another device).
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md bg-amber-500/20 border border-amber-400/40 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-500/30"
                >
                  Batch Re-link Files
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {missingMediaItems.map((item) => (
                  <div
                    key={item.assetId}
                    className="inline-flex items-center gap-2 rounded-md border border-amber-400/30 bg-black/30 px-2.5 py-1 text-[11px]"
                  >
                    <span className="font-medium text-amber-100 truncate max-w-[180px]" title={item.name}>
                      {item.name}
                    </span>
                    {item.sizeBytes !== undefined && item.sizeBytes > 0 && (
                      <span className="font-mono text-[10px] text-amber-300/80">
                        {formatBytes(item.sizeBytes)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => triggerSingleClipRelink(item.assetId)}
                      className="rounded bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-black hover:bg-amber-400 transition-colors"
                    >
                      Re-link File
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upper Editor Split: Media Bin | Video Preview | Inspector & AI Assistant */}
          <div className="flex-1 min-h-0 flex flex-col xl:flex-row">
            {/* Left Media Bin (with Drag & Drop) */}
            <aside
              onDragOver={(e) => {
                e.preventDefault();
                setBinDragOver(true);
              }}
              onDragLeave={() => setBinDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setBinDragOver(false);
                if (e.dataTransfer.files.length > 0) {
                  void handleFilesSelected(e.dataTransfer.files);
                }
              }}
              className={`w-full xl:w-64 shrink-0 border-b xl:border-b-0 xl:border-r border-zinc-800/80 bg-[#0D0D10] flex flex-col max-h-64 xl:max-h-none transition-colors ${
                binDragOver ? "ring-1 ring-inset ring-violet-500 bg-violet-500/5" : ""
              }`}
            >
              <div className="p-3 border-b border-zinc-800/80 flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-zinc-200">Project Media</h2>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const created = addTextOverlay("Title Overlay", playheadTime);
                      if (created) setSelectedClipId(created.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800"
                    title="Add Text Overlay"
                  >
                    <Type className="h-3 w-3 text-emerald-400" />
                    <span>Text</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingMedia}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    <Upload className="h-3 w-3 text-blue-400" />
                    <span>{uploadingMedia ? "..." : "Import"}</span>
                  </button>
                </div>
              </div>

              <div className="p-2.5 border-b border-zinc-800/60">
                <div className="relative">
                  <Search className="h-3 w-3 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={binSearch}
                    onChange={(e) => setBinSearch(e.target.value)}
                    placeholder="Filter bin..."
                    className="w-full rounded-md border border-zinc-800 bg-[#09090B] pl-7 pr-2.5 py-1.5 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
                {filteredBinAssets.length === 0 ? (
                  <div className="py-8 px-3 text-center">
                    <p className="text-xs text-zinc-400">Drop or import local media</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-2 text-xs font-medium text-violet-400 hover:text-violet-300"
                    >
                      Select local files
                    </button>
                  </div>
                ) : (
                  filteredBinAssets.map((asset) => (
                    <div
                      key={asset.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-ai-studio-asset-id", asset.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      className="rounded-lg border border-zinc-800/80 bg-[#111114] p-2 flex items-center gap-2.5 group hover:border-zinc-700 cursor-grab active:cursor-grabbing transition-colors"
                      title="Drag onto a timeline track or click + to append"
                    >
                      <div className="relative h-10 w-14 rounded bg-zinc-950 overflow-hidden shrink-0 flex items-center justify-center">
                        {asset.thumbnailUrl ? (
                          <img
                            src={asset.thumbnailUrl}
                            alt={asset.name}
                            className="h-full w-full object-cover pointer-events-none"
                          />
                        ) : asset.kind === "audio" ? (
                          <>
                            {asset.waveformPeaks && asset.waveformPeaks.length > 0 && (
                              <div
                                aria-hidden="true"
                                className="absolute inset-x-1 inset-y-1.5 flex items-center gap-[1px] opacity-45 pointer-events-none"
                              >
                                {asset.waveformPeaks
                                  .filter((_, idx) => idx % 8 === 0)
                                  .slice(0, 16)
                                  .map((amp, idx) => (
                                    <span
                                      key={idx}
                                      style={{ height: `${Math.max(15, Math.round(amp * 90))}%` }}
                                      className="flex-1 rounded-[1px] bg-sky-400"
                                    />
                                  ))}
                              </div>
                            )}
                            <Music className="relative z-[1] h-4 w-4 text-blue-400" />
                          </>
                        ) : (
                          <ImageIcon className="h-4 w-4 text-zinc-500" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium text-zinc-100 truncate" title={asset.name}>
                          {asset.name}
                        </p>
                        <p className="text-[10px] font-mono text-zinc-500 tabular-nums">
                          {formatTimecode(asset.duration)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleAddAssetToTimeline(asset)}
                        className="rounded-md bg-zinc-800 p-1.5 text-zinc-300 hover:bg-violet-600 hover:text-white transition-colors shrink-0"
                        title="Append to timeline"
                        aria-label={`Add ${asset.name} to timeline`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="px-3 py-2 border-t border-zinc-800/80 bg-[#09090B]/70 space-y-1">
                <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="h-3 w-3 text-blue-400" />
                    <span>IndexedDB Local</span>
                  </span>
                  {storageEstimate?.supported ? (
                    <span>
                      {formatBytes(storageEstimate.usageBytes)}
                      {storageEstimate.quotaBytes > 0
                        ? ` / ${formatBytes(storageEstimate.quotaBytes)}`
                        : ""}
                    </span>
                  ) : (
                    <span>{mediaAssets.length} files</span>
                  )}
                </div>
                <p className="text-[10px] leading-snug text-zinc-500">
                  Saved on this browser/device only. Clearing browser site data removes local media.
                </p>
              </div>
            </aside>

            {/* Center Preview Monitor & Transport Controls */}
            <section className="flex-1 min-w-0 flex flex-col bg-[#09090B]">
              <div className="flex-1 p-4 flex items-center justify-center min-h-[260px]">
                <div
                  ref={previewFrameRef}
                  className={`${frameAspectClass} relative rounded-xl border border-zinc-800 bg-black overflow-hidden flex items-center justify-center shadow-xl`}
                >
                  {primaryVisualClip && !primaryVisualClip.needsRelink && primaryVisualClip.objectUrl ? (
                    <>
                      {activeTransitionBackdropUrl && (
                        <img
                          src={activeTransitionBackdropUrl}
                          alt=""
                          aria-hidden="true"
                          style={{
                            ...(prevAdjacentV1Clip?.effects &&
                            buildPreviewCssFilter(prevAdjacentV1Clip.effects) !== "none"
                              ? { filter: buildPreviewCssFilter(prevAdjacentV1Clip.effects) }
                              : {}),
                            opacity: prevAdjacentV1Clip?.opacity ?? 1,
                          }}
                          className="absolute inset-0 h-full w-full object-contain pointer-events-none"
                        />
                      )}
                      {primaryVisualClip.kind === "video" ? (
                        <video
                          ref={videoRef}
                          src={primaryVisualClip.objectUrl}
                          onLoadedMetadata={() => {
                            setPreviewMediaError(null);
                            syncVideoElement();
                          }}
                          onCanPlay={syncVideoElement}
                          onSeeked={(e) => flushPendingSeek(e.currentTarget)}
                          onError={() =>
                            setPreviewMediaError(
                              `Browser could not decode "${primaryVisualClip.name}". Convert to H.264/AAC MP4 or re-link a valid media file.`
                            )
                          }
                          playsInline
                          style={primaryPreviewStyle}
                          className="relative h-full w-full object-contain"
                        />
                      ) : (
                        <img
                          src={primaryVisualClip.objectUrl}
                          alt={primaryVisualClip.name}
                          style={primaryPreviewStyle}
                          className="relative h-full w-full object-contain"
                        />
                      )}
                    </>
                  ) : (
                    <div className="text-center p-6 space-y-2.5">
                      <Film className="h-8 w-8 text-zinc-700 mx-auto" />
                      <p className="text-xs text-zinc-400">
                        {primaryVisualClip?.needsRelink
                          ? `Missing local media for "${primaryVisualClip.sourceName || primaryVisualClip.name}"`
                          : isRestoringProjectMedia
                            ? "Restoring media from IndexedDB..."
                            : activeProject.clips.length === 0
                              ? "Import a local video or image to start previewing"
                              : "Playhead is in an empty timeline gap"}
                      </p>
                      {primaryVisualClip?.needsRelink && (
                        <button
                          type="button"
                          onClick={() => triggerSingleClipRelink(primaryVisualClip.assetId)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          <span>Re-link File</span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Optional V2 Overlay Image / PiP Video Layer when V1 is also active */}
                  {activeV1Clip &&
                    activeV2Clip &&
                    (activeV2Clip.kind === "image" || activeV2Clip.kind === "video") &&
                    !v2Track?.muted &&
                    !activeV2Clip.needsRelink &&
                    activeV2Clip.objectUrl &&
                    (() => {
                      const ovBox = computeEffectiveOverlayBox(activeV2Clip.overlayTransform);
                      const v2TransStyle = computeClipTransitionStyle(activeV2Clip, playheadTime);
                      const v2Filter = buildPreviewCssFilter(activeV2Clip.effects);
                      const isV2Selected = activeV2Clip.id === selectedClipId;
                      return (
                        <div
                          onMouseDown={(e) => handleV2OverlayDrag(e, activeV2Clip)}
                          style={{
                            left: `${ovBox.x}%`,
                            top: `${ovBox.y}%`,
                            width: `${ovBox.widthPct}%`,
                            height: `${ovBox.heightPct}%`,
                            transform: "translate(-50%, -50%)",
                          }}
                          className={`absolute z-[5] cursor-move select-none ${
                            isV2Selected ? "ring-1 ring-blue-400/90" : "hover:ring-1 hover:ring-blue-400/40"
                          }`}
                          title="Drag to reposition V2 overlay"
                        >
                          {activeV2Clip.kind === "video" ? (
                            <video
                              ref={v2VideoRef}
                              src={activeV2Clip.objectUrl}
                              onLoadedMetadata={() => {
                                setPreviewMediaError(null);
                                syncV2VideoElement();
                              }}
                              onCanPlay={syncV2VideoElement}
                              onSeeked={(e) => flushPendingSeek(e.currentTarget)}
                              onError={() =>
                                setPreviewMediaError(
                                  `Browser could not decode overlay video "${activeV2Clip.name}".`
                                )
                              }
                              playsInline
                              style={{
                                ...v2TransStyle,
                                ...(v2Filter !== "none" ? { filter: v2Filter } : {}),
                              }}
                              className={`h-full w-full pointer-events-none ${
                                ovBox.lockAspectRatio ? "object-contain" : "object-fill"
                              }`}
                            />
                          ) : (
                            <img
                              src={activeV2Clip.objectUrl}
                              alt={activeV2Clip.name}
                              style={{
                                ...v2TransStyle,
                                ...(v2Filter !== "none" ? { filter: v2Filter } : {}),
                              }}
                              className={`h-full w-full pointer-events-none ${
                                ovBox.lockAspectRatio ? "object-contain" : "object-fill"
                              }`}
                            />
                          )}
                        </div>
                      );
                    })()}

                  {/* Active Editable Text Overlays (Draggable on Preview Canvas) */}
                  {activeTextClips.map((textClip) => {
                    const style = textClip.textStyle;
                    if (!style) return null;
                    const isSelected = textClip.id === selectedClipId;
                    const transStyle = computeClipTransitionStyle(textClip, playheadTime);
                    return (
                      <div
                        key={textClip.id}
                        onMouseDown={(e) => handleTextOverlayDrag(e, textClip)}
                        style={{
                          left: `${style.x}%`,
                          top: `${style.y}%`,
                          transform: transStyle.transform
                            ? `translate(-50%, -50%) ${transStyle.transform}`
                            : "translate(-50%, -50%)",
                          fontSize: `${Math.max(12, Math.round(style.fontSize * 0.65))}px`,
                          color: style.color,
                          backgroundColor: `rgba(9, 9, 11, ${style.backgroundOpacity})`,
                          opacity: transStyle.opacity ?? textClip.opacity,
                          ...(transStyle.clipPath ? { clipPath: transStyle.clipPath } : {}),
                          textAlign: style.align,
                        }}
                        className={`absolute px-3 py-1.5 rounded-md font-display font-semibold cursor-move select-none max-w-[85%] whitespace-pre-wrap leading-tight ${
                          isSelected ? "ring-1 ring-emerald-400" : ""
                        }`}
                        title="Drag to reposition text overlay"
                      >
                        {style.text}
                      </div>
                    );
                  })}

                  {/* Synchronized Automatic Subtitles */}
                  {activeSubtitles.length > 0 && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-10 w-[88%] flex flex-col items-center gap-1 pointer-events-none ${
                        subtitleStyle.position === "top"
                          ? "top-9"
                          : subtitleStyle.position === "middle"
                            ? "top-1/2 -translate-y-1/2"
                            : "bottom-5"
                      }`}
                    >
                      {activeSubtitles.map((cue) => (
                        <div
                          key={cue.id}
                          dir="auto"
                          style={{
                            fontSize: `${Math.max(12, Math.round(subtitleStyle.fontSize * 0.58))}px`,
                            color: subtitleStyle.color,
                            backgroundColor: hexToRgba(
                              subtitleStyle.backgroundColor,
                              subtitleStyle.backgroundOpacity
                            ),
                            textShadow:
                              subtitleStyle.backgroundOpacity <= 0.05
                                ? "0 1px 3px rgba(0,0,0,0.95)"
                                : undefined,
                          }}
                          className="px-3 py-1 rounded-md font-medium text-center leading-relaxed whitespace-pre-wrap max-w-full"
                        >
                          {cue.text}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Synchronized Web Audio elements for A1 Audio track clips */}
                  {a1AudioClips.map((audioClip) => (
                    <audio
                      key={audioClip.id}
                      ref={(el) => {
                        if (el) {
                          audioElsRef.current.set(audioClip.id, el);
                        } else {
                          audioElsRef.current.delete(audioClip.id);
                        }
                      }}
                      src={audioClip.objectUrl}
                      preload="auto"
                      onSeeked={(e) => flushPendingSeek(e.currentTarget)}
                      onError={() =>
                        setPreviewMediaError(
                          `Browser could not decode audio clip "${audioClip.name}". Use MP3, WAV, or AAC M4A.`
                        )
                      }
                      className="hidden"
                    />
                  ))}

                  <div className="absolute top-3 left-3 rounded bg-black/70 px-2 py-1 text-[11px] font-mono text-zinc-300 tabular-nums pointer-events-none">
                    {activeProject.resolution} · {activeProject.fps}fps
                  </div>
                </div>
              </div>

              {/* Scrubber & Transport Bar */}
              <div className="px-4 pb-3 pt-2 border-t border-zinc-800/70 bg-[#0D0D10]/70 space-y-2">
                <input
                  type="range"
                  min={0}
                  max={Math.max(totalDuration, 1)}
                  step={0.02}
                  value={Math.min(playheadTime, Math.max(totalDuration, 1))}
                  onChange={(e) => {
                    setIsPlaying(false);
                    handleSeek(Number(e.target.value));
                  }}
                  className="w-full accent-violet-500 h-1.5 cursor-pointer"
                  aria-label="Sequence scrubber"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  {/* Timecode Readout */}
                  <div className="font-mono text-xs text-zinc-200 tabular-nums min-w-[140px]">
                    <span>{formatTimecode(playheadTime, true, activeProject.fps)}</span>
                    <span className="text-zinc-500">
                      {" "}
                      / {formatTimecode(totalDuration, true, activeProject.fps)}
                    </span>
                  </div>

                  {/* Transport Buttons */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setPlayheadTime(0);
                      }}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Jump to start"
                    >
                      <SkipBack className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFrame(-1)}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Step back 1 frame"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={togglePlay}
                      disabled={totalDuration <= 0}
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 transition-colors"
                      title="Play / Pause (Space)"
                      aria-label={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4 ml-0.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFrame(1)}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Step forward 1 frame"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsPlaying(false);
                        setPlayheadTime(totalDuration);
                      }}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                      title="Jump to end"
                    >
                      <SkipForward className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Audio & Speed Controls */}
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMasterMuted(!masterMuted)}
                        className="p-1 text-zinc-400 hover:text-white"
                        aria-label={masterMuted ? "Unmute" : "Mute"}
                      >
                        {masterMuted || masterVolume === 0 ? (
                          <VolumeX className="h-4 w-4 text-rose-400" />
                        ) : (
                          <Volume2 className="h-4 w-4" />
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={masterMuted ? 0 : masterVolume}
                        onChange={(e) => {
                          setMasterMuted(false);
                          setMasterVolume(Number(e.target.value));
                        }}
                        className="w-16 accent-blue-500"
                        aria-label="Master volume"
                      />
                    </div>

                    <select
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(Number(e.target.value))}
                      className="rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1 text-[11px] font-mono text-zinc-200 focus:border-violet-500 focus:outline-none"
                      aria-label="Playback speed"
                    >
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1.0x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2.0x</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Inspector, AI Assistant & Subtitles */}
            <AiAssistantPanel
              project={activeProject}
              selectedClip={selectedClip}
              totalDuration={totalDuration}
              playheadTime={playheadTime}
              onSeek={(t) => {
                setIsPlaying(false);
                handleSeek(t);
              }}
              activeTab={rightPanelTab}
              onTabChange={setRightPanelTab}
            />
          </div>

          {/* Lower Multitrack Timeline */}
          <MultitrackTimeline
            project={activeProject}
            playheadTime={playheadTime}
            onSeek={(t) => {
              setIsPlaying(false);
              handleSeek(t);
            }}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            activeTool={activeTool}
            onToolChange={setActiveTool}
            totalDuration={totalDuration}
          />
        </div>
      )}

      {exportOpen && activeProject && (
        <ExportModal
          project={activeProject}
          totalDuration={totalDuration}
          onClose={() => setExportOpen(false)}
        />
      )}
    </StudioShell>
  );
}
