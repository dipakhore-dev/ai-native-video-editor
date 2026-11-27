import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type {
  AspectRatioOption,
  CaptionStyleConfig,
  StoryboardCaptionSegment,
  StoryboardLanguage,
} from "../../types/studio";
import {
  computeScaledCaptionPreviewStyle,
  findActiveCaptionCueAtTime,
} from "../../utils/storyboardCaptions";

interface CaptionPreviewProps {
  sceneId: string;
  sceneTitle: string;
  sceneDuration: number;
  aspectRatio: AspectRatioOption;
  language: StoryboardLanguage;
  style: CaptionStyleConfig;
  segments: StoryboardCaptionSegment[];
  thumbnailSrc?: string;
  audioSrc?: string;
  audioDurationSeconds?: number;
  audioVolume?: number;
  seekRequest?: { timeSec: number; nonce: number } | null;
  activeAudioSceneId: string | null;
  onActivateSceneAudio: (token: string | null) => void;
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
}

export function CaptionPreview({
  sceneId,
  sceneTitle,
  sceneDuration,
  aspectRatio,
  language,
  style,
  segments,
  thumbnailSrc,
  audioSrc,
  audioDurationSeconds = 0,
  audioVolume = 1,
  seekRequest,
  activeAudioSceneId,
  onActivateSceneAudio,
}: CaptionPreviewProps) {
  const previewToken = `cap:${sceneId}`;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimerTickRef = useRef<number | null>(null);

  const [stageHeightPx, setStageHeightPx] = useState(aspectRatio === "9:16" ? 260 : 180);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioElemDuration, setAudioElemDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const hasAudio = Boolean(audioSrc);
  const maxSegmentEnd = segments.length > 0 ? Math.max(...segments.map((s) => s.end)) : 0;
  const effectiveDuration = Math.max(
    0.5,
    hasAudio
      ? audioElemDuration > 0
        ? audioElemDuration
        : audioDurationSeconds > 0
          ? audioDurationSeconds
          : Math.max(sceneDuration, maxSegmentEnd)
      : Math.max(sceneDuration, maxSegmentEnd)
  );

  // Measure preview stage height cleanly for resolution-independent caption typography
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const updateHeight = () => {
      const rect = el.getBoundingClientRect();
      if (rect.height > 40) {
        setStageHeightPx(rect.height);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [aspectRatio]);

  // Enforce single active audio / preview across all scenes
  useEffect(() => {
    if (activeAudioSceneId !== previewToken && playing) {
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      setPlaying(false);
    }
  }, [activeAudioSceneId, playing, previewToken]);

  // Sync audio element volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, Number.isFinite(audioVolume) ? audioVolume : 1));
    }
  }, [audioVolume]);

  // Reset when audio source changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setAudioElemDuration(0);
    setPlaybackError(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [audioSrc]);

  // Honor explicit cue seek requests from CaptionSegmentEditor
  useEffect(() => {
    if (!seekRequest) return;
    const targetTime = Math.max(0, Math.min(effectiveDuration, seekRequest.timeSec));
    setCurrentTime(targetTime);
    if (audioRef.current && hasAudio) {
      audioRef.current.currentTime = targetTime;
    }
  }, [effectiveDuration, hasAudio, seekRequest]);

  // Smooth local playhead polling via rAF while playing (audio or silent timer)
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTimerTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (hasAudio && audioRef.current) {
        setCurrentTime(audioRef.current.currentTime || 0);
        if (!audioRef.current.paused && !audioRef.current.ended) {
          rafRef.current = requestAnimationFrame(tick);
        }
        return;
      }

      // Silent scene duration timer when voiceover audio is not present
      if (lastTimerTickRef.current === null) {
        lastTimerTickRef.current = now;
      }
      const deltaSec = (now - lastTimerTickRef.current) / 1000;
      lastTimerTickRef.current = now;

      setCurrentTime((prev) => {
        const next = prev + deltaSec;
        if (next >= effectiveDuration) {
          setPlaying(false);
          onActivateSceneAudio(null);
          return 0;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTimerTickRef.current = null;
    };
  }, [effectiveDuration, hasAudio, onActivateSceneAudio, playing]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
  }, []);

  const togglePlay = async () => {
    setPlaybackError(null);
    if (playing) {
      if (audioRef.current && hasAudio) {
        audioRef.current.pause();
      }
      setPlaying(false);
      if (activeAudioSceneId === previewToken) {
        onActivateSceneAudio(null);
      }
      return;
    }

    onActivateSceneAudio(previewToken);
    if (hasAudio && audioRef.current) {
      try {
        if (currentTime >= effectiveDuration - 0.05) {
          audioRef.current.currentTime = 0;
          setCurrentTime(0);
        }
        await audioRef.current.play();
        setPlaying(true);
      } catch (err) {
        setPlaying(false);
        onActivateSceneAudio(null);
        setPlaybackError(
          err instanceof Error ? err.message : "Could not play audio preview in this browser."
        );
      }
    } else {
      if (currentTime >= effectiveDuration - 0.05) {
        setCurrentTime(0);
      }
      setPlaying(true);
    }
  };

  const handleSeek = (nextSec: number) => {
    const clamped = Math.max(0, Math.min(effectiveDuration, nextSec));
    setCurrentTime(clamped);
    if (audioRef.current && hasAudio) {
      audioRef.current.currentTime = clamped;
    }
  };

  const activeCue = useMemo(() => {
    const match = findActiveCaptionCueAtTime(segments, currentTime);
    if (match) return match;
    if (!playing && currentTime === 0 && segments.length > 0) {
      return segments[0];
    }
    return null;
  }, [currentTime, playing, segments]);

  const computedStyle = useMemo(
    () => computeScaledCaptionPreviewStyle(style, stageHeightPx, aspectRatio, language),
    [aspectRatio, language, stageHeightPx, style]
  );

  const stageWidthClass =
    aspectRatio === "9:16"
      ? "max-w-[200px] aspect-[9/16]"
      : aspectRatio === "1:1"
        ? "max-w-[260px] aspect-square"
        : "max-w-[400px] aspect-video";

  const positionClass =
    style.position === "top"
      ? "items-start"
      : style.position === "middle"
        ? "items-center"
        : "items-end";

  const justifyClass =
    style.alignment === "left"
      ? "justify-start"
      : style.alignment === "right"
        ? "justify-end"
        : "justify-center";

  const cueLines = activeCue ? activeCue.text.split("\n").filter(Boolean) : [];

  return (
    <div className="rounded-lg border border-zinc-800 bg-[#09090B] p-3 space-y-2.5">
      {hasAudio && (
        <audio
          ref={audioRef}
          src={audioSrc}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) {
              setAudioElemDuration(d);
            }
          }}
          onEnded={() => {
            setPlaying(false);
            setCurrentTime(0);
            if (activeAudioSceneId === previewToken) {
              onActivateSceneAudio(null);
            }
          }}
          onError={() => {
            setPlaying(false);
            setPlaybackError("Browser failed to decode voiceover audio.");
          }}
        />
      )}

      {/* Visual Stage + Safe-Area Caption Overlay */}
      <div className="flex justify-center">
        <div
          ref={stageRef}
          className={`relative w-full ${stageWidthClass} rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden select-none`}
        >
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={sceneTitle}
              className="h-full w-full object-cover opacity-80"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center bg-gradient-to-br from-zinc-900 to-black px-4 text-center">
              <span className="text-[11px] font-mono text-zinc-600 line-clamp-2">{sceneTitle}</span>
            </div>
          )}

          {/* Safe-Area Caption Overlay (Pure React Text Nodes — zero dangerouslySetInnerHTML) */}
          {style.enabled && cueLines.length > 0 && (
            <div
              className={`absolute inset-0 flex ${positionClass} ${justifyClass} px-3 pointer-events-none`}
              style={{
                paddingTop:
                  style.position === "top" ? `${computedStyle.safeMarginBottomPct}%` : undefined,
                paddingBottom:
                  style.position === "bottom" ? `${computedStyle.safeMarginBottomPct}%` : undefined,
              }}
            >
              <div
                className="rounded px-2 py-1 leading-snug break-words"
                style={{
                  maxWidth: `${computedStyle.maxWidthPct}%`,
                  fontFamily: computedStyle.fontFamily,
                  fontSize: `${computedStyle.fontSizePx}px`,
                  fontWeight: computedStyle.fontWeight,
                  color: computedStyle.color,
                  backgroundColor: computedStyle.backgroundColor,
                  textShadow: computedStyle.textShadow,
                  textAlign: computedStyle.textAlign,
                  paddingLeft: `${computedStyle.paddingX}px`,
                  paddingRight: `${computedStyle.paddingX}px`,
                  paddingTop: `${computedStyle.paddingY}px`,
                  paddingBottom: `${computedStyle.paddingY}px`,
                }}
              >
                {cueLines.map((line, i) => (
                  <span key={i} className="block">
                    {line}
                  </span>
                ))}
              </div>
            </div>
          )}

          {!style.enabled && (
            <span className="absolute top-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
              Captions Hidden
            </span>
          )}
        </div>
      </div>

      {/* Synchronized Playback & Scrub Controls */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void togglePlay()}
          aria-label={playing ? `Pause ${sceneTitle} caption preview` : `Play ${sceneTitle} caption preview`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-violet-500 hover:text-white transition-colors"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
        </button>

        <input
          type="range"
          min={0}
          max={effectiveDuration}
          step={0.05}
          aria-label={`Scrub ${sceneTitle} caption preview`}
          value={Math.min(currentTime, effectiveDuration)}
          onChange={(e) => handleSeek(Number(e.target.value))}
          className="flex-1 accent-violet-500 cursor-pointer"
        />

        <span className="font-mono text-[11px] text-zinc-300 tabular-nums whitespace-nowrap">
          {formatClock(currentTime)} / {formatClock(effectiveDuration)}
        </span>

        <span
          className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-400 whitespace-nowrap"
          title={
            hasAudio
              ? "Synchronized with local voiceover audio in IndexedDB"
              : "No voiceover audio generated yet; using silent scene duration timer"
          }
        >
          {hasAudio ? (
            <>
              <Volume2 className="h-3 w-3 text-emerald-400" />
              <span>Audio Sync</span>
            </>
          ) : (
            <>
              <VolumeX className="h-3 w-3 text-zinc-500" />
              <span>Silent Timer</span>
            </>
          )}
        </span>
      </div>

      {playbackError && <p className="text-[11px] text-rose-300">{playbackError}</p>}
    </div>
  );
}
