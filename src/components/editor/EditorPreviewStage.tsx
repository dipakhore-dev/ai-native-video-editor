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
  Film,
} from "lucide-react";
import type { Project, TimelineClip, TimelineTrack } from "../../types/studio";
import { buildSpeechIntervals, computeEffectiveClipGain } from "../../utils/audio";
import {
  buildPreviewCssFilter,
  computeClipTransitionStyle,
  normalizeEffects,
  normalizeTransition,
} from "../../utils/effects";
import { formatTimecode } from "../../utils/media";
import {
  clampKeyframeTime,
  cloneKeyframes,
  evaluateClipKeyframes,
  evaluateClipProperty,
  hasVolumeKeyframesWithSound,
  upsertClipKeyframe,
} from "../../utils/keyframes";
import { computeEffectiveOverlayBox, normalizeOverlayTransform } from "../../utils/overlays";
import { getSubtitleStyle, hexToRgba } from "../../utils/subtitles";
import { usePlaybackTime, type TimelinePlaybackClock } from "../../utils/timelineClock";

interface EditorPreviewStageProps {
  project: Project;
  playbackClock: TimelinePlaybackClock;
  totalDuration: number;
  isPlaying: boolean;
  onSetIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  masterVolume: number;
  onMasterVolumeChange: (vol: number) => void;
  masterMuted: boolean;
  onToggleMasterMuted: () => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  onUpdateClip: (clipId: string, patch: Partial<TimelineClip>, recordHistory?: boolean) => void;
  onUpdateTextStyle: (clipId: string, patch: Partial<NonNullable<TimelineClip["textStyle"]>>, recordHistory?: boolean) => void;
  onCommitProjectSnapshot: (beforeSnapshot: Project) => void;
  onTriggerRelink: (assetId: string) => void;
  isRestoringProjectMedia: boolean;
  onMediaError: (msg: string | null) => void;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onStepFrame: (direction: -1 | 1) => void;
}

const TransportScrubber = React.memo(function TransportScrubber({
  playbackClock,
  totalDuration,
  onSeek,
}: {
  playbackClock: TimelinePlaybackClock;
  totalDuration: number;
  onSeek: (time: number) => void;
}) {
  const playheadTime = usePlaybackTime(playbackClock);
  const maxDur = Math.max(totalDuration, 1);

  return (
    <input
      type="range"
      min={0}
      max={maxDur}
      step={0.02}
      value={Math.min(playheadTime, maxDur)}
      onChange={(e) => onSeek(Number(e.target.value))}
      className="w-full accent-violet-500 h-1.5 cursor-pointer"
      aria-label="Sequence scrubber"
    />
  );
});

const TransportTimecode = React.memo(function TransportTimecode({
  playbackClock,
  totalDuration,
  fps,
}: {
  playbackClock: TimelinePlaybackClock;
  totalDuration: number;
  fps: number;
}) {
  const playheadTime = usePlaybackTime(playbackClock);

  return (
    <div className="font-mono text-xs text-zinc-200 tabular-nums min-w-[140px]">
      <span>{formatTimecode(playheadTime, true, fps)}</span>
      <span className="text-zinc-500"> / {formatTimecode(totalDuration, true, fps)}</span>
    </div>
  );
});

interface A1AudioTrackElementProps {
  clipId: string;
  objectUrl: string;
  clipName: string;
  onRegister: (clipId: string, el: HTMLAudioElement) => void;
  onUnregister: (clipId: string, el: HTMLAudioElement | null) => void;
  onLoadedMetadata: (clipId: string, el: HTMLAudioElement) => void;
  onCanPlay: (clipId: string, el: HTMLAudioElement) => void;
  onSeeked: (el: HTMLAudioElement) => void;
  onError: (clipName: string) => void;
}

export const A1AudioTrackElement = React.memo(function A1AudioTrackElement({
  clipId,
  objectUrl,
  clipName,
  onRegister,
  onUnregister,
  onLoadedMetadata,
  onCanPlay,
  onSeeked,
  onError,
}: A1AudioTrackElementProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Use a stable useRef object and unmount-only cleanup so 60Hz parent re-renders
  // never detach the callback ref and strip src/abort playback.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    onRegister(clipId, el);
    return () => {
      onUnregister(clipId, el);
    };
  }, [clipId, onRegister, onUnregister]);

  return (
    <audio
      ref={audioRef}
      src={objectUrl}
      preload="auto"
      onLoadedMetadata={(e) => onLoadedMetadata(clipId, e.currentTarget)}
      onCanPlay={(e) => onCanPlay(clipId, e.currentTarget)}
      onSeeked={(e) => onSeeked(e.currentTarget)}
      onError={() => onError(clipName)}
      className="hidden"
    />
  );
});

export const EditorPreviewStage = React.memo(function EditorPreviewStage({
  project,
  playbackClock,
  totalDuration,
  isPlaying,
  onSetIsPlaying,
  masterVolume,
  onMasterVolumeChange,
  masterMuted,
  onToggleMasterMuted,
  playbackRate,
  onPlaybackRateChange,
  selectedClipId,
  onSelectClip,
  onUpdateClip,
  onUpdateTextStyle,
  onCommitProjectSnapshot,
  onTriggerRelink,
  isRestoringProjectMedia,
  onMediaError,
  onSeek,
  onTogglePlay,
  onStepFrame,
}: EditorPreviewStageProps) {
  const playheadTime = usePlaybackTime(playbackClock);

  // 2-slot V1 video element pool for preloading/pre-seeking upcoming clips across cuts
  const v1SlotARef = useRef<HTMLVideoElement | null>(null);
  const v1SlotBRef = useRef<HTMLVideoElement | null>(null);
  const [slotUrls, setSlotUrls] = useState<[string | null, string | null]>([null, null]);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);

  const v2VideoRef = useRef<HTMLVideoElement | null>(null);
  const v2StandbyRef = useRef<HTMLVideoElement | null>(null);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaGainMapRef = useRef<
    WeakMap<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode }>
  >(new WeakMap());
  const previewFrameRef = useRef<HTMLDivElement | null>(null);

  const lastSyncedVideoClipIdRef = useRef<string | null>(null);
  const lastSyncedV2ClipIdRef = useRef<string | null>(null);
  const lastSyncedAudioMapRef = useRef<
    Map<
      string,
      { active: boolean; objectUrl: string; inPoint: number; startTime: number; speed: number }
    >
  >(new Map());
  const lastGainMapRef = useRef<
    WeakMap<HTMLMediaElement, { gain: number; muted: boolean; ctxRunning: boolean }>
  >(new WeakMap());
  const pendingSeekMapRef = useRef<WeakMap<HTMLMediaElement, number>>(new WeakMap());
  const playInFlightRef = useRef<WeakSet<HTMLMediaElement>>(new WeakSet());
  const lastPlayOrSeekAtRef = useRef<WeakMap<HTMLMediaElement, number>>(new WeakMap());
  const prevPlayheadTimeRef = useRef<number>(playheadTime);
  const projectRef = useRef(project);
  projectRef.current = project;
  const a1AudioClipsRef = useRef<TimelineClip[]>([]);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const masterVolumeRef = useRef(masterVolume);
  masterVolumeRef.current = masterVolume;
  const masterMutedRef = useRef(masterMuted);
  masterMutedRef.current = masterMuted;
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const trackById = useMemo(() => {
    const map = new Map<string, TimelineTrack>();
    for (const t of project.tracks) {
      map.set(t.id, t);
    }
    return map;
  }, [project.tracks]);

  const v1Track = trackById.get("track_v1");
  const v2Track = trackById.get("track_v2");
  const t1Track = trackById.get("track_t1");
  const a1Track = trackById.get("track_a1");

  const sortedV1Clips = useMemo(
    () =>
      project.clips
        .filter((c) => c.trackId === "track_v1")
        .sort((a, b) => a.startTime - b.startTime),
    [project.clips]
  );

  const sortedV2Clips = useMemo(
    () =>
      project.clips
        .filter((c) => c.trackId === "track_v2")
        .sort((a, b) => a.startTime - b.startTime),
    [project.clips]
  );

  const activeV1Clip = useMemo<TimelineClip | null>(
    () =>
      sortedV1Clips.find(
        (c) => playheadTime >= c.startTime && playheadTime < c.startTime + c.duration
      ) ?? null,
    [sortedV1Clips, playheadTime]
  );

  const activeV2Clip = useMemo<TimelineClip | null>(
    () =>
      sortedV2Clips.find(
        (c) => playheadTime >= c.startTime && playheadTime < c.startTime + c.duration
      ) ?? null,
    [sortedV2Clips, playheadTime]
  );

  const activeTextClips = useMemo<TimelineClip[]>(() => {
    if (t1Track?.muted) return [];
    return project.clips.filter(
      (c) =>
        c.trackId === "track_t1" &&
        c.kind === "text" &&
        playheadTime >= c.startTime &&
        playheadTime < c.startTime + c.duration
    );
  }, [project.clips, playheadTime, t1Track?.muted]);

  const a1AudioClips = useMemo<TimelineClip[]>(
    () =>
      project.clips.filter(
        (c) =>
          c.trackId === "track_a1" &&
          c.kind === "audio" &&
          !c.needsRelink &&
          Boolean(c.objectUrl)
      ),
    [project.clips]
  );
  a1AudioClipsRef.current = a1AudioClips;

  const speechIntervals = useMemo(
    () => buildSpeechIntervals(project.subtitles),
    [project.subtitles]
  );

  const v1AudibleAtTime = Boolean(
    activeV1Clip &&
      activeV1Clip.kind === "video" &&
      !v1Track?.muted &&
      !activeV1Clip.muted &&
      (hasVolumeKeyframesWithSound(activeV1Clip)
        ? evaluateClipProperty(
            activeV1Clip,
            "volume",
            Math.max(0, playheadTime - activeV1Clip.startTime)
          ) > 0.01
        : activeV1Clip.volume > 0.01)
  );

  const a1TrackMutedRef = useRef(Boolean(a1Track?.muted));
  a1TrackMutedRef.current = Boolean(a1Track?.muted);
  const speechIntervalsRef = useRef(speechIntervals);
  speechIntervalsRef.current = speechIntervals;
  const v1AudibleAtTimeRef = useRef(v1AudibleAtTime);
  v1AudibleAtTimeRef.current = v1AudibleAtTime;

  const subtitleStyle = useMemo(() => getSubtitleStyle(project), [project]);

  const activeSubtitles = useMemo(() => {
    if (!subtitleStyle.enabled) return [];
    return (project.subtitles ?? []).filter(
      (s) =>
        s.text.trim().length > 0 &&
        playheadTime >= s.start &&
        playheadTime < s.end
    );
  }, [project.subtitles, playheadTime, subtitleStyle.enabled]);

  const primaryVisualClip = activeV1Clip ?? activeV2Clip;
  const primaryTrackMuted =
    primaryVisualClip?.trackId === "track_v2" ? Boolean(v2Track?.muted) : Boolean(v1Track?.muted);

  // Upcoming V1 & V2 video clips for look-ahead preloading / pre-seeking
  const upcomingV1VideoClip = useMemo<TimelineClip | null>(() => {
    const refTime = activeV1Clip ? activeV1Clip.startTime + activeV1Clip.duration : playheadTime;
    return (
      sortedV1Clips.find(
        (c) =>
          c.kind === "video" &&
          !c.needsRelink &&
          Boolean(c.objectUrl) &&
          c.id !== primaryVisualClip?.id &&
          c.startTime >= refTime - 0.05 &&
          c.objectUrl !== primaryVisualClip?.objectUrl
      ) ?? null
    );
  }, [sortedV1Clips, activeV1Clip, playheadTime, primaryVisualClip?.id, primaryVisualClip?.objectUrl]);

  const upcomingV2VideoClip = useMemo<TimelineClip | null>(() => {
    const refTime = activeV2Clip ? activeV2Clip.startTime + activeV2Clip.duration : playheadTime;
    return (
      sortedV2Clips.find(
        (c) =>
          c.kind === "video" &&
          !c.needsRelink &&
          Boolean(c.objectUrl) &&
          c.id !== activeV2Clip?.id &&
          c.startTime >= refTime - 0.05 &&
          c.startTime - playheadTime <= 3.5
      ) ?? null
    );
  }, [sortedV2Clips, activeV2Clip, playheadTime]);

  // Manage 2-slot V1 video URLs so switching clips swaps active slot instead of destroying decoder
  useEffect(() => {
    const targetUrl =
      primaryVisualClip &&
      primaryVisualClip.kind === "video" &&
      !primaryVisualClip.needsRelink &&
      primaryVisualClip.objectUrl
        ? primaryVisualClip.objectUrl
        : null;
    const standbyUrl = upcomingV1VideoClip?.objectUrl ?? null;

    if (!targetUrl) {
      if (slotUrls[0] !== null || slotUrls[1] !== standbyUrl) {
        setSlotUrls([null, standbyUrl]);
      }
      return;
    }

    if (slotUrls[activeSlot] === targetUrl) {
      const otherSlot: 0 | 1 = activeSlot === 0 ? 1 : 0;
      if (slotUrls[otherSlot] !== standbyUrl) {
        setSlotUrls(activeSlot === 0 ? [targetUrl, standbyUrl] : [standbyUrl, targetUrl]);
      }
      return;
    }

    const otherSlot: 0 | 1 = activeSlot === 0 ? 1 : 0;
    if (slotUrls[otherSlot] === targetUrl) {
      // Preloaded hit! Swap active slot cleanly
      setActiveSlot(otherSlot);
      if (slotUrls[activeSlot] !== standbyUrl) {
        setSlotUrls(otherSlot === 0 ? [targetUrl, standbyUrl] : [standbyUrl, targetUrl]);
      }
      return;
    }

    setSlotUrls(activeSlot === 0 ? [targetUrl, standbyUrl] : [standbyUrl, targetUrl]);
  }, [primaryVisualClip, upcomingV1VideoClip, activeSlot, slotUrls]);

  const activeVideoRef = activeSlot === 0 ? v1SlotARef : v1SlotBRef;
  const standbyVideoRef = activeSlot === 0 ? v1SlotBRef : v1SlotARef;

  // Pre-seek standby V1 slot to upcoming clip inPoint when buffered
  useEffect(() => {
    const standbyEl = standbyVideoRef.current;
    if (!standbyEl) return;
    if (!standbyEl.paused) standbyEl.pause();
    if (!standbyEl.muted) standbyEl.muted = true;
    if (upcomingV1VideoClip && standbyEl.readyState >= 1) {
      if (Math.abs(standbyEl.currentTime - upcomingV1VideoClip.inPoint) > 0.05) {
        try {
          standbyEl.currentTime = upcomingV1VideoClip.inPoint;
        } catch {
          // Ignore seek errors while metadata loads
        }
      }
    }
  }, [standbyVideoRef, upcomingV1VideoClip, activeSlot, slotUrls]);

  const resumeAudioContext = useCallback((createIfMissing = false) => {
    if (typeof window === "undefined") return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      if (!audioCtxRef.current && createIfMissing) {
        audioCtxRef.current = new AudioCtx();
      }
      if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => undefined);
      }
    } catch {
      // Ignore AudioContext initialization failures in restricted environments
    }
  }, []);

  // Unlock suspended AudioContext synchronously on transport/Space user gestures
  useEffect(() => {
    const handleUserGesture = (ev: Event) => {
      if (ev.type === "keydown") {
        const kev = ev as KeyboardEvent;
        const target = kev.target as HTMLElement | null;
        const inInput =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT");
        if (inInput || kev.code !== "Space") return;
        resumeAudioContext(true);
        return;
      }
      if (audioCtxRef.current?.state === "suspended") {
        resumeAudioContext(false);
      }
    };

    window.addEventListener("pointerdown", handleUserGesture, { capture: true, passive: true });
    window.addEventListener("keydown", handleUserGesture, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handleUserGesture, { capture: true });
      window.removeEventListener("keydown", handleUserGesture, { capture: true });
    };
  }, [resumeAudioContext]);

  const ensureMediaGainNode = useCallback((el: HTMLMediaElement): GainNode | null => {
    const existing = mediaGainMapRef.current.get(el);
    if (existing) return existing.gain;
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
    const safeRate = Number.isFinite(rate) && rate > 0 ? Math.min(4, Math.max(0.25, rate)) : 1;
    const pitchEl = el as HTMLMediaElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
      mozPreservesPitch?: boolean;
    };
    if (pitchEl.preservesPitch !== true) pitchEl.preservesPitch = true;
    if (pitchEl.webkitPreservesPitch !== true) pitchEl.webkitPreservesPitch = true;
    if (pitchEl.mozPreservesPitch !== true) pitchEl.mozPreservesPitch = true;
    if (Math.abs(el.playbackRate - safeRate) > 0.005) {
      el.playbackRate = safeRate;
    }
  }, []);

  const seekMediaSafely = useCallback((el: HTMLMediaElement, targetTime: number) => {
    if (!Number.isFinite(targetTime)) return;
    const durationLimit = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : targetTime;
    const clamped = Math.max(0, Math.min(durationLimit, targetTime));
    lastPlayOrSeekAtRef.current.set(
      el,
      typeof performance !== "undefined" ? performance.now() : Date.now()
    );
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
    if (Math.abs(el.currentTime - pending) > 0.025 && el.readyState >= 1) {
      try {
        lastPlayOrSeekAtRef.current.set(
          el,
          typeof performance !== "undefined" ? performance.now() : Date.now()
        );
        el.currentTime = pending;
      } catch {
        // Ignore queued seek errors
      }
    }
  }, []);

  const applyClipAudioGain = useCallback(
    (
      el: HTMLMediaElement,
      effectiveGain: number,
      isMuted: boolean,
      allowCreateGainNode = true
    ) => {
      const targetVal = isMuted ? 0 : Math.max(0, Math.min(2, effectiveGain));
      const existingNode = mediaGainMapRef.current.get(el)?.gain ?? null;
      const ctx = audioCtxRef.current;
      const ctxRunning = Boolean(ctx && ctx.state === "running");

      const prev = lastGainMapRef.current.get(el);
      if (
        prev &&
        prev.muted === isMuted &&
        prev.ctxRunning === ctxRunning &&
        Math.abs(prev.gain - targetVal) < 0.002
      ) {
        return;
      }
      lastGainMapRef.current.set(el, { gain: targetVal, muted: isMuted, ctxRunning });

      const gainNode = existingNode ?? (allowCreateGainNode ? ensureMediaGainNode(el) : null);
      if (el.muted !== isMuted) {
        el.muted = isMuted;
      }
      if (gainNode && audioCtxRef.current) {
        const activeCtx = audioCtxRef.current;
        if (el.volume !== 1) el.volume = 1;
        if (activeCtx.state === "running") {
          gainNode.gain.setTargetAtTime(targetVal, activeCtx.currentTime, 0.015);
        } else {
          // While suspended (frozen currentTime), assign value directly so unmuting/resuming has zero lag
          gainNode.gain.setValueAtTime(targetVal, activeCtx.currentTime);
          gainNode.gain.value = targetVal;
        }
      } else {
        el.volume = isMuted ? 0 : Math.min(1, Math.max(0, targetVal));
      }
    },
    [ensureMediaGainNode]
  );

  const startMediaPlaybackSafely = useCallback(
    (el: HTMLMediaElement) => {
      if (!el.paused || playInFlightRef.current.has(el)) return;
      resumeAudioContext(false);
      lastPlayOrSeekAtRef.current.set(
        el,
        typeof performance !== "undefined" ? performance.now() : Date.now()
      );
      try {
        const playResult = el.play();
        if (playResult && typeof playResult.then === "function") {
          playInFlightRef.current.add(el);
          void playResult
            .catch(() => {
              // Ignore transient AbortError / autoplay rejections; next gesture or sync retries cleanly
            })
            .finally(() => {
              playInFlightRef.current.delete(el);
            });
        }
      } catch {
        playInFlightRef.current.delete(el);
      }
    },
    [resumeAudioContext]
  );

  // Release AudioContext & cached media elements cleanly on unmount
  useEffect(() => {
    return () => {
      for (const aud of audioElsRef.current.values()) {
        try {
          aud.pause();
          aud.removeAttribute("src");
          aud.load();
        } catch {
          // Ignore cleanup errors
        }
      }
      audioElsRef.current.clear();

      for (const vid of [v1SlotARef.current, v1SlotBRef.current, v2VideoRef.current, v2StandbyRef.current]) {
        if (!vid) continue;
        try {
          vid.pause();
          vid.removeAttribute("src");
          vid.load();
        } catch {
          // Ignore cleanup errors
        }
      }

      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close().catch(() => undefined);
      }
      audioCtxRef.current = null;
    };
  }, []);

  // Sync primary V1 video element with tightened drift tolerance (0.12s playing, 0.025s paused/cut)
  const syncVideoElement = useCallback(() => {
    const vid = activeVideoRef.current;
    if (!vid || !primaryVisualClip || primaryVisualClip.kind !== "video" || primaryVisualClip.needsRelink) {
      lastSyncedVideoClipIdRef.current = null;
      if (v1SlotARef.current && !v1SlotARef.current.paused) v1SlotARef.current.pause();
      if (v1SlotBRef.current && !v1SlotBRef.current.paused) v1SlotBRef.current.pause();
      return;
    }

    const clipChanged = lastSyncedVideoClipIdRef.current !== primaryVisualClip.id;
    const safeSpeed = Number.isFinite(primaryVisualClip.speed) && primaryVisualClip.speed > 0 ? primaryVisualClip.speed : 1;
    const safeInPoint = Number.isFinite(primaryVisualClip.inPoint) ? primaryVisualClip.inPoint : 0;
    const targetSourceTime =
      safeInPoint + (playheadTime - primaryVisualClip.startTime) * safeSpeed;

    applyPitchPreservation(vid, playbackRate * safeSpeed);
    const { effectiveGain, isMuted } = computeEffectiveClipGain({
      clip: primaryVisualClip,
      timelineTimeSec: playheadTime,
      trackMuted: primaryTrackMuted,
      masterVolume,
      masterMuted,
    });
    applyClipAudioGain(vid, effectiveGain, isMuted, isPlaying);

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const recentlyStarted = now - (lastPlayOrSeekAtRef.current.get(vid) ?? 0) < 220;
    const tolerance = clipChanged || !isPlaying ? 0.025 : 0.14;
    if (
      vid.readyState >= 1 &&
      (clipChanged || !isPlaying || !recentlyStarted) &&
      Math.abs(vid.currentTime - targetSourceTime) > tolerance
    ) {
      seekMediaSafely(vid, targetSourceTime);
      lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
    } else if (vid.readyState >= 1 && clipChanged) {
      lastSyncedVideoClipIdRef.current = primaryVisualClip.id;
    }

    if (isPlaying && vid.paused) {
      startMediaPlaybackSafely(vid);
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [
    activeVideoRef,
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
    startMediaPlaybackSafely,
  ]);

  useEffect(() => {
    syncVideoElement();
  }, [syncVideoElement]);

  // Sync V2 PiP/overlay video element
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
      if (vid && !vid.paused) vid.pause();
      return;
    }

    const clipChanged = lastSyncedV2ClipIdRef.current !== activeV2Clip.id;
    const safeSpeed = Number.isFinite(activeV2Clip.speed) && activeV2Clip.speed > 0 ? activeV2Clip.speed : 1;
    const safeInPoint = Number.isFinite(activeV2Clip.inPoint) ? activeV2Clip.inPoint : 0;
    const targetSourceTime =
      safeInPoint + (playheadTime - activeV2Clip.startTime) * safeSpeed;

    applyPitchPreservation(vid, playbackRate * safeSpeed);
    const { effectiveGain, isMuted } = computeEffectiveClipGain({
      clip: activeV2Clip,
      timelineTimeSec: playheadTime,
      trackMuted: Boolean(v2Track?.muted),
      masterVolume,
      masterMuted,
    });
    applyClipAudioGain(vid, effectiveGain, isMuted, isPlaying);

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const recentlyStarted = now - (lastPlayOrSeekAtRef.current.get(vid) ?? 0) < 220;
    const tolerance = clipChanged || !isPlaying ? 0.025 : 0.14;
    if (
      vid.readyState >= 1 &&
      (clipChanged || !isPlaying || !recentlyStarted) &&
      Math.abs(vid.currentTime - targetSourceTime) > tolerance
    ) {
      seekMediaSafely(vid, targetSourceTime);
      lastSyncedV2ClipIdRef.current = activeV2Clip.id;
    } else if (vid.readyState >= 1 && clipChanged) {
      lastSyncedV2ClipIdRef.current = activeV2Clip.id;
    }

    if (isPlaying && vid.paused) {
      startMediaPlaybackSafely(vid);
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
    startMediaPlaybackSafely,
  ]);

  useEffect(() => {
    syncV2VideoElement();
  }, [syncV2VideoElement]);

  // Synchronize a single A1 audio element cleanly (used by both RAF sync & loadedmetadata/canplay)
  const syncSingleAudioClip = useCallback(
    (
      audioClip: TimelineClip,
      aud: HTMLAudioElement,
      currentTimelineTime: number,
      isTimelineJump: boolean
    ) => {
      const safeInPoint = Number.isFinite(audioClip.inPoint) ? Math.max(0, audioClip.inPoint) : 0;
      const safeSpeed = Number.isFinite(audioClip.speed) && audioClip.speed > 0 ? audioClip.speed : 1;
      const playing = isPlayingRef.current;

      const isActiveAtPlayhead =
        currentTimelineTime >= audioClip.startTime &&
        currentTimelineTime < audioClip.startTime + audioClip.duration;
      const prevSync = lastSyncedAudioMapRef.current.get(audioClip.id);
      const urlChanged = Boolean(prevSync && prevSync.objectUrl !== audioClip.objectUrl);

      if (urlChanged) {
        lastGainMapRef.current.delete(aud);
      }

      if (!isActiveAtPlayhead) {
        lastSyncedAudioMapRef.current.set(audioClip.id, {
          active: false,
          objectUrl: audioClip.objectUrl,
          inPoint: safeInPoint,
          startTime: audioClip.startTime,
          speed: safeSpeed,
        });
        if (!aud.paused) aud.pause();
        applyClipAudioGain(aud, 0, true, false);
        // Pre-seek upcoming audio clip right before it enters the playhead window
        if (
          audioClip.startTime > currentTimelineTime &&
          audioClip.startTime - currentTimelineTime <= 2.5 &&
          aud.readyState >= 1
        ) {
          if (Math.abs(aud.currentTime - safeInPoint) > 0.05) {
            seekMediaSafely(aud, safeInPoint);
          }
        }
        return;
      }

      const wasActive = Boolean(prevSync?.active) && !urlChanged;
      const clipTimingChanged = Boolean(
        prevSync &&
          (Math.abs(prevSync.inPoint - safeInPoint) > 0.005 ||
            Math.abs(prevSync.startTime - audioClip.startTime) > 0.005 ||
            Math.abs(prevSync.speed - safeSpeed) > 0.005)
      );

      const targetSourceTime =
        safeInPoint + (currentTimelineTime - audioClip.startTime) * safeSpeed;
      applyPitchPreservation(aud, playbackRateRef.current * safeSpeed);

      const { effectiveGain, isMuted } = computeEffectiveClipGain({
        clip: audioClip,
        timelineTimeSec: currentTimelineTime,
        trackMuted: a1TrackMutedRef.current,
        masterVolume: masterVolumeRef.current,
        masterMuted: masterMutedRef.current,
        speechIntervals: speechIntervalsRef.current,
        v1AudibleAtTime: v1AudibleAtTimeRef.current,
      });
      applyClipAudioGain(aud, effectiveGain, isMuted, playing);

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const recentlyStartedOrSeeked = now - (lastPlayOrSeekAtRef.current.get(aud) ?? 0) < 250;
      const needsExactSeek = !wasActive || !playing || isTimelineJump || clipTimingChanged || urlChanged;
      const tolerance = needsExactSeek ? 0.025 : 0.28;

      if (
        aud.readyState >= 1 &&
        (needsExactSeek || !recentlyStartedOrSeeked) &&
        Math.abs(aud.currentTime - targetSourceTime) > tolerance
      ) {
        seekMediaSafely(aud, targetSourceTime);
      }

      lastSyncedAudioMapRef.current.set(audioClip.id, {
        active: true,
        objectUrl: audioClip.objectUrl,
        inPoint: safeInPoint,
        startTime: audioClip.startTime,
        speed: safeSpeed,
      });

      if (playing && aud.paused) {
        startMediaPlaybackSafely(aud);
      } else if (!playing && !aud.paused) {
        aud.pause();
      }
    },
    [applyClipAudioGain, applyPitchPreservation, seekMediaSafely, startMediaPlaybackSafely]
  );

  // Synchronize A1 Audio clips via Web Audio GainNodes
  useEffect(() => {
    const activeIds = new Set(a1AudioClips.map((c) => c.id));
    for (const prevId of Array.from(lastSyncedAudioMapRef.current.keys())) {
      if (!activeIds.has(prevId)) {
        lastSyncedAudioMapRef.current.delete(prevId);
      }
    }

    const isTimelineJump = Math.abs(playheadTime - prevPlayheadTimeRef.current) > 0.25;
    prevPlayheadTimeRef.current = playheadTime;

    for (const audioClip of a1AudioClips) {
      const aud = audioElsRef.current.get(audioClip.id);
      if (!aud) continue;
      syncSingleAudioClip(audioClip, aud, playheadTime, isTimelineJump);
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
    syncSingleAudioClip,
  ]);

  const handleRegisterAudioElement = useCallback((clipId: string, el: HTMLAudioElement) => {
    audioElsRef.current.set(clipId, el);
    const clip = a1AudioClipsRef.current.find((c) => c.id === clipId);
    if (clip) {
      syncSingleAudioClip(clip, el, playbackClock.getTime(), true);
    }
  }, [playbackClock, syncSingleAudioClip]);

  const handleUnregisterAudioElement = useCallback((clipId: string, el: HTMLAudioElement | null) => {
    const target = el ?? audioElsRef.current.get(clipId) ?? null;
    if (target) {
      try {
        target.pause();
        target.removeAttribute("src");
        target.load();
      } catch {
        // Ignore cleanup errors
      }
      pendingSeekMapRef.current.delete(target);
      playInFlightRef.current.delete(target);
      lastGainMapRef.current.delete(target);
    }
    audioElsRef.current.delete(clipId);
    lastSyncedAudioMapRef.current.delete(clipId);
  }, []);

  const handleAudioMediaReady = useCallback(
    (clipId: string, el: HTMLAudioElement) => {
      const clip = a1AudioClipsRef.current.find((c) => c.id === clipId);
      if (clip) {
        syncSingleAudioClip(clip, el, playbackClock.getTime(), true);
      }
    },
    [playbackClock, syncSingleAudioClip]
  );

  const handleAudioMediaError = useCallback(
    (clipName: string) => {
      onMediaError(
        `Browser could not decode audio clip "${clipName}". Use MP3, WAV, or AAC M4A.`
      );
    },
    [onMediaError]
  );

  const prevAdjacentV1Clip = useMemo<TimelineClip | null>(() => {
    if (!primaryVisualClip || primaryVisualClip.trackId !== "track_v1") {
      return null;
    }
    const candidates = sortedV1Clips
      .filter(
        (c) =>
          c.id !== primaryVisualClip.id &&
          c.startTime + c.duration <= primaryVisualClip.startTime + 0.15 &&
          Math.abs(primaryVisualClip.startTime - (c.startTime + c.duration)) <= 0.15
      )
      .sort((a, b) => b.startTime + b.duration - (a.startTime + a.duration));
    return candidates[0] ?? null;
  }, [sortedV1Clips, primaryVisualClip]);

  const primaryPreviewStyle = useMemo(() => {
    if (!primaryVisualClip) return {};
    const filter = buildPreviewCssFilter(primaryVisualClip.effects);
    const transStyle = computeClipTransitionStyle(
      primaryVisualClip,
      playheadTime,
      prevAdjacentV1Clip
    );
    const localTime = Math.max(0, playheadTime - primaryVisualClip.startTime);
    const kfVals = evaluateClipKeyframes(primaryVisualClip, localTime);
    const hasCustomMotion =
      Math.abs(kfVals.x - 50) > 0.05 ||
      Math.abs(kfVals.y - 50) > 0.05 ||
      Math.abs(kfVals.scale - 1) > 0.005 ||
      Math.abs(kfVals.rotation) > 0.05;

    const kfTransformParts: string[] = [];
    if (Math.abs(kfVals.x - 50) > 0.05 || Math.abs(kfVals.y - 50) > 0.05) {
      kfTransformParts.push(`translate(${(kfVals.x - 50).toFixed(2)}%, ${(kfVals.y - 50).toFixed(2)}%)`);
    }
    if (Math.abs(kfVals.scale - 1) > 0.005) {
      kfTransformParts.push(`scale(${kfVals.scale.toFixed(3)})`);
    }
    if (Math.abs(kfVals.rotation) > 0.05) {
      kfTransformParts.push(`rotate(${kfVals.rotation.toFixed(2)}deg)`);
    }
    const kfTransform = kfTransformParts.join(" ");
    const combinedTransform = [transStyle.transform, hasCustomMotion ? kfTransform : ""]
      .filter(Boolean)
      .join(" ");

    const transFactor =
      typeof transStyle.opacity === "number" && primaryVisualClip.opacity > 0.001
        ? transStyle.opacity / primaryVisualClip.opacity
        : 1;
    const effectiveOpacity = Number(Math.max(0, Math.min(1, kfVals.opacity * transFactor)).toFixed(3));

    return {
      ...transStyle,
      opacity: effectiveOpacity,
      ...(combinedTransform ? { transform: combinedTransform } : {}),
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

  const handleTextOverlayDrag = (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    const curProj = projectRef.current;
    if (!previewFrameRef.current || !clip.textStyle) return;

    const beforeSnapshot: Project = {
      ...curProj,
      tracks: curProj.tracks.map((t) => ({ ...t })),
      clips: curProj.clips.map((c) => ({
        ...c,
        waveformPeaks: c.waveformPeaks,
        keyframes: cloneKeyframes(c.keyframes),
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
        transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
        effects: c.effects ? normalizeEffects(c.effects) : undefined,
        overlayTransform: c.overlayTransform ? { ...c.overlayTransform } : undefined,
      })),
    };

    const hasPosKeyframes = Boolean(
      clip.keyframes?.some((kf) => kf.property === "x" || kf.property === "y")
    );
    const localTimeAtDrag = clampKeyframeTime(playbackClock.getTime() - clip.startTime, clip.duration);

    const rect = previewFrameRef.current.getBoundingClientRect();
    let moved = false;
    let pendingX = e.clientX;
    let pendingY = e.clientY;
    let dragRaf = 0;

    const commitCoords = (cx: number, cy: number) => {
      const xPct = Number(Math.min(90, Math.max(10, ((cx - rect.left) / rect.width) * 100)).toFixed(1));
      const yPct = Number(Math.min(90, Math.max(10, ((cy - rect.top) / rect.height) * 100)).toFixed(1));
      if (hasPosKeyframes) {
        const latest = projectRef.current.clips.find((c) => c.id === clip.id);
        let nextKfs = upsertClipKeyframe(
          latest?.keyframes ?? clip.keyframes,
          { property: "x", timeSec: localTimeAtDrag, value: xPct },
          clip.duration
        ).keyframes;
        nextKfs = upsertClipKeyframe(
          nextKfs,
          { property: "y", timeSec: localTimeAtDrag, value: yPct },
          clip.duration
        ).keyframes;
        onUpdateClip(clip.id, { keyframes: nextKfs }, false);
      } else {
        onUpdateTextStyle(clip.id, { x: xPct, y: yPct }, false);
      }
    };

    const onMove = (moveEv: MouseEvent) => {
      moved = true;
      pendingX = moveEv.clientX;
      pendingY = moveEv.clientY;
      if (!dragRaf) {
        dragRaf = requestAnimationFrame(() => {
          dragRaf = 0;
          commitCoords(pendingX, pendingY);
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = 0;
        commitCoords(pendingX, pendingY);
      }
      if (moved) {
        onCommitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleV2OverlayDrag = (e: React.MouseEvent<HTMLDivElement>, clip: TimelineClip) => {
    e.stopPropagation();
    onSelectClip(clip.id);
    const curProj = projectRef.current;
    if (!previewFrameRef.current) return;

    const beforeTransform = normalizeOverlayTransform(clip.overlayTransform);
    const beforeSnapshot: Project = {
      ...curProj,
      tracks: curProj.tracks.map((t) => ({ ...t })),
      clips: curProj.clips.map((c) => ({
        ...c,
        waveformPeaks: c.waveformPeaks,
        keyframes: cloneKeyframes(c.keyframes),
        textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
        transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
        effects: c.effects ? normalizeEffects(c.effects) : undefined,
        overlayTransform: c.overlayTransform ? { ...c.overlayTransform } : undefined,
      })),
    };

    const hasPosKeyframes = Boolean(
      clip.keyframes?.some((kf) => kf.property === "x" || kf.property === "y")
    );
    const localTimeAtDrag = clampKeyframeTime(playbackClock.getTime() - clip.startTime, clip.duration);
    const evaluatedAtDrag = evaluateClipKeyframes(clip, localTimeAtDrag);

    const rect = previewFrameRef.current.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = hasPosKeyframes ? evaluatedAtDrag.x : beforeTransform.x;
    const startY = hasPosKeyframes ? evaluatedAtDrag.y : beforeTransform.y;
    let moved = false;
    let pendingX = e.clientX;
    let pendingY = e.clientY;
    let dragRaf = 0;

    const commitTransform = (cx: number, cy: number) => {
      const dxPct = ((cx - startMouseX) / Math.max(1, rect.width)) * 100;
      const dyPct = ((cy - startMouseY) / Math.max(1, rect.height)) * 100;
      if (Math.abs(dxPct) > 0.2 || Math.abs(dyPct) > 0.2) {
        moved = true;
      }
      const nextX = Number(Math.min(100, Math.max(0, startX + dxPct)).toFixed(1));
      const nextY = Number(Math.min(100, Math.max(0, startY + dyPct)).toFixed(1));

      if (hasPosKeyframes) {
        const latest = projectRef.current.clips.find((c) => c.id === clip.id);
        let nextKfs = upsertClipKeyframe(
          latest?.keyframes ?? clip.keyframes,
          { property: "x", timeSec: localTimeAtDrag, value: nextX },
          clip.duration
        ).keyframes;
        nextKfs = upsertClipKeyframe(
          nextKfs,
          { property: "y", timeSec: localTimeAtDrag, value: nextY },
          clip.duration
        ).keyframes;
        onUpdateClip(clip.id, { keyframes: nextKfs }, false);
      } else {
        onUpdateClip(
          clip.id,
          {
            overlayTransform: normalizeOverlayTransform({
              ...beforeTransform,
              x: nextX,
              y: nextY,
            }),
          },
          false
        );
      }
    };

    const onMove = (moveEv: MouseEvent) => {
      pendingX = moveEv.clientX;
      pendingY = moveEv.clientY;
      if (!dragRaf) {
        dragRaf = requestAnimationFrame(() => {
          dragRaf = 0;
          commitTransform(pendingX, pendingY);
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = 0;
        commitTransform(pendingX, pendingY);
      }
      if (moved) {
        onCommitProjectSnapshot(beforeSnapshot);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const frameAspectClass =
    project.aspectRatio === "9:16"
      ? "aspect-[9/16] h-full max-h-[340px]"
      : project.aspectRatio === "1:1"
      ? "aspect-square h-full max-h-[340px]"
      : "aspect-video w-full max-w-3xl";

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-[#09090B]">
      <div className="flex-1 p-4 flex items-center justify-center min-h-[260px]">
        <div
          ref={previewFrameRef}
          className={`${frameAspectClass} relative rounded-xl border border-zinc-800 bg-black overflow-hidden flex items-center justify-center shadow-xl`}
        >
          {/* Preloading 2-slot V1 Video Element Pool */}
          {([0, 1] as const).map((slotIdx) => {
            const ref = slotIdx === 0 ? v1SlotARef : v1SlotBRef;
            const slotSrc = slotUrls[slotIdx];
            const isSlotActive =
              activeSlot === slotIdx &&
              primaryVisualClip?.kind === "video" &&
              !primaryVisualClip.needsRelink &&
              Boolean(primaryVisualClip.objectUrl);

            if (!slotSrc) {
              return <video key={slotIdx} ref={ref} className="hidden" muted playsInline />;
            }

            return (
              <video
                key={slotIdx}
                ref={ref}
                src={slotSrc}
                preload="auto"
                muted={!isSlotActive}
                onLoadedMetadata={() => {
                  if (isSlotActive) {
                    onMediaError(null);
                    syncVideoElement();
                  } else if (upcomingV1VideoClip && ref.current) {
                    try {
                      ref.current.currentTime = upcomingV1VideoClip.inPoint;
                    } catch {
                      // Ignore standby seek failure
                    }
                  }
                }}
                onCanPlay={() => {
                  if (isSlotActive) syncVideoElement();
                }}
                onSeeked={(e) => {
                  if (isSlotActive) flushPendingSeek(e.currentTarget);
                }}
                onError={() => {
                  if (isSlotActive && primaryVisualClip) {
                    onMediaError(
                      `Browser could not decode "${primaryVisualClip.name}". Convert to H.264/AAC MP4 or re-link a valid media file.`
                    );
                  }
                }}
                playsInline
                style={isSlotActive ? primaryPreviewStyle : undefined}
                className={
                  isSlotActive
                    ? "relative h-full w-full object-contain"
                    : "absolute inset-0 h-full w-full object-contain opacity-0 pointer-events-none"
                }
              />
            );
          })}

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
              {primaryVisualClip.kind !== "video" && (
                <img
                  src={primaryVisualClip.objectUrl}
                  alt={primaryVisualClip.name}
                  style={primaryPreviewStyle}
                  className="relative h-full w-full object-contain"
                />
              )}
            </>
          ) : (
            <div className="relative z-[2] text-center p-6 space-y-2.5">
              <Film className="h-8 w-8 text-zinc-700 mx-auto" />
              <p className="text-xs text-zinc-400">
                {primaryVisualClip?.needsRelink
                  ? `Missing local media for "${primaryVisualClip.sourceName || primaryVisualClip.name}"`
                  : isRestoringProjectMedia
                    ? "Restoring media from IndexedDB..."
                    : project.clips.length === 0
                      ? "Import a local video or image to start previewing"
                      : "Playhead is in an empty timeline gap"}
              </p>
              {primaryVisualClip?.needsRelink && (
                <button
                  type="button"
                  onClick={() => onTriggerRelink(primaryVisualClip.assetId)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Re-link File</span>
                </button>
              )}
            </div>
          )}

          {/* Standby V2 preloader */}
          {upcomingV2VideoClip?.objectUrl && (
            <video
              ref={v2StandbyRef}
              src={upcomingV2VideoClip.objectUrl}
              preload="auto"
              muted
              playsInline
              onLoadedMetadata={(e) => {
                try {
                  e.currentTarget.currentTime = upcomingV2VideoClip.inPoint;
                } catch {
                  // Ignore pre-seek error
                }
              }}
              className="hidden"
            />
          )}

          {/* Optional V2 Overlay Image / PiP Video Layer when V1 is also active */}
          {activeV1Clip &&
            activeV2Clip &&
            (activeV2Clip.kind === "image" || activeV2Clip.kind === "video") &&
            !v2Track?.muted &&
            !activeV2Clip.needsRelink &&
            activeV2Clip.objectUrl &&
            (() => {
              const v2LocalTime = Math.max(0, playheadTime - activeV2Clip.startTime);
              const v2Kf = evaluateClipKeyframes(activeV2Clip, v2LocalTime);
              const ovBox = computeEffectiveOverlayBox(
                normalizeOverlayTransform({
                  ...(activeV2Clip.overlayTransform ?? {}),
                  x: v2Kf.x,
                  y: v2Kf.y,
                  scale: v2Kf.scale,
                })
              );
              const v2TransStyle = computeClipTransitionStyle(activeV2Clip, playheadTime);
              const v2TransFactor =
                typeof v2TransStyle.opacity === "number" && activeV2Clip.opacity > 0.001
                  ? v2TransStyle.opacity / activeV2Clip.opacity
                  : 1;
              const v2EffectiveOpacity = Number(
                Math.max(0, Math.min(1, v2Kf.opacity * v2TransFactor)).toFixed(3)
              );
              const v2Filter = buildPreviewCssFilter(activeV2Clip.effects);
              const isV2Selected = activeV2Clip.id === selectedClipId;
              const v2Rotate = Math.abs(v2Kf.rotation) > 0.05 ? ` rotate(${v2Kf.rotation.toFixed(2)}deg)` : "";
              return (
                <div
                  onMouseDown={(e) => handleV2OverlayDrag(e, activeV2Clip)}
                  style={{
                    left: `${ovBox.x}%`,
                    top: `${ovBox.y}%`,
                    width: `${ovBox.widthPct}%`,
                    height: `${ovBox.heightPct}%`,
                    transform: `translate(-50%, -50%)${v2Rotate}`,
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
                      preload="auto"
                      onLoadedMetadata={() => {
                        onMediaError(null);
                        syncV2VideoElement();
                      }}
                      onCanPlay={syncV2VideoElement}
                      onSeeked={(e) => flushPendingSeek(e.currentTarget)}
                      onError={() =>
                        onMediaError(
                          `Browser could not decode overlay video "${activeV2Clip.name}".`
                        )
                      }
                      playsInline
                      style={{
                        ...v2TransStyle,
                        opacity: v2EffectiveOpacity,
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
                        opacity: v2EffectiveOpacity,
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
            const tLocalTime = Math.max(0, playheadTime - textClip.startTime);
            const tKf = evaluateClipKeyframes(textClip, tLocalTime);
            const transStyle = computeClipTransitionStyle(textClip, playheadTime);
            const tTransFactor =
              typeof transStyle.opacity === "number" && textClip.opacity > 0.001
                ? transStyle.opacity / textClip.opacity
                : 1;
            const tEffectiveOpacity = Number(
              Math.max(0, Math.min(1, tKf.opacity * tTransFactor)).toFixed(3)
            );
            const kfMotion = [
              Math.abs(tKf.scale - 1) > 0.005 ? `scale(${tKf.scale.toFixed(3)})` : "",
              Math.abs(tKf.rotation) > 0.05 ? `rotate(${tKf.rotation.toFixed(2)}deg)` : "",
            ]
              .filter(Boolean)
              .join(" ");
            const fullTransform = [
              "translate(-50%, -50%)",
              kfMotion,
              transStyle.transform || "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                key={textClip.id}
                onMouseDown={(e) => handleTextOverlayDrag(e, textClip)}
                style={{
                  left: `${tKf.x}%`,
                  top: `${tKf.y}%`,
                  transform: fullTransform,
                  fontSize: `${Math.max(12, Math.round(style.fontSize * 0.65))}px`,
                  color: style.color,
                  backgroundColor: `rgba(9, 9, 11, ${style.backgroundOpacity})`,
                  opacity: tEffectiveOpacity,
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
            <A1AudioTrackElement
              key={audioClip.id}
              clipId={audioClip.id}
              objectUrl={audioClip.objectUrl}
              clipName={audioClip.name}
              onRegister={handleRegisterAudioElement}
              onUnregister={handleUnregisterAudioElement}
              onLoadedMetadata={handleAudioMediaReady}
              onCanPlay={handleAudioMediaReady}
              onSeeked={flushPendingSeek}
              onError={handleAudioMediaError}
            />
          ))}

          <div className="absolute top-3 left-3 rounded bg-black/70 px-2 py-1 text-[11px] font-mono text-zinc-300 tabular-nums pointer-events-none">
            {project.resolution} · {project.fps}fps
          </div>
        </div>
      </div>

      {/* Scrubber & Transport Bar */}
      <div className="px-4 pb-3 pt-2 border-t border-zinc-800/70 bg-[#0D0D10]/70 space-y-2">
        <TransportScrubber
          playbackClock={playbackClock}
          totalDuration={totalDuration}
          onSeek={(t) => {
            resumeAudioContext(false);
            onSetIsPlaying(false);
            onSeek(t);
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <TransportTimecode
            playbackClock={playbackClock}
            totalDuration={totalDuration}
            fps={project.fps}
          />

          {/* Transport Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                resumeAudioContext(false);
                onSetIsPlaying(false);
                onSeek(0);
              }}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Jump to start"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                resumeAudioContext(false);
                onStepFrame(-1);
              }}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Step back 1 frame"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                resumeAudioContext(true);
                onTogglePlay();
              }}
              disabled={totalDuration <= 0}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 transition-colors"
              title="Play / Pause (Space)"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </button>
            <button
              type="button"
              onClick={() => {
                resumeAudioContext(false);
                onStepFrame(1);
              }}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Step forward 1 frame"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                resumeAudioContext(false);
                onSetIsPlaying(false);
                onSeek(totalDuration);
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
                onClick={() => {
                  resumeAudioContext(false);
                  onToggleMasterMuted();
                }}
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
                onChange={(e) => onMasterVolumeChange(Number(e.target.value))}
                className="w-16 accent-blue-500"
                aria-label="Master volume"
              />
            </div>

            <select
              value={playbackRate}
              onChange={(e) => onPlaybackRateChange(Number(e.target.value))}
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
  );
});
