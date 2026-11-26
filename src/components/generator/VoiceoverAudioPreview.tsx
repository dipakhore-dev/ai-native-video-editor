import React, { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2 } from "lucide-react";

interface VoiceoverAudioPreviewProps {
  sceneId: string;
  src?: string;
  durationSeconds: number;
  volume: number;
  activeAudioSceneId: string | null;
  onActivateSceneAudio: (sceneId: string | null) => void;
  title?: string;
}

function formatSecondsPrecise(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${rem.toFixed(1).padStart(4, "0")}`;
}

export function VoiceoverAudioPreview({
  sceneId,
  src,
  durationSeconds,
  volume,
  activeAudioSceneId,
  onActivateSceneAudio,
  title,
}: VoiceoverAudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const effectiveDuration =
    elementDuration > 0 && Number.isFinite(elementDuration)
      ? elementDuration
      : Math.max(0.1, durationSeconds || 0.1);

  // Enforce single active audio preview across storyboard
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activeAudioSceneId !== sceneId && !audio.paused) {
      audio.pause();
      setPlaying(false);
    }
  }, [activeAudioSceneId, sceneId]);

  // Reset playback state when source changes
  useEffect(() => {
    const audio = audioRef.current;
    setPlaying(false);
    setCurrentTime(0);
    setElementDuration(0);
    setPlaybackError(null);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [src]);

  // Sync HTMLAudioElement volume (capped at 1.0 by browser Audio API; >1.0 applies in FFmpeg mix)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  }, [volume]);

  // Cleanup audio element cleanly on unmount
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
  }, []);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    setPlaybackError(null);

    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      if (activeAudioSceneId === sceneId) {
        onActivateSceneAudio(null);
      }
      return;
    }

    onActivateSceneAudio(sceneId);
    try {
      await audio.play();
      setPlaying(true);
    } catch (err) {
      setPlaying(false);
      setPlaybackError(
        err instanceof Error ? err.message : "Could not play audio preview in this browser."
      );
    }
  };

  const handleSeek = (nextTime: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(effectiveDuration, nextTime));
    audio.currentTime = clamped;
    setCurrentTime(clamped);
  };

  if (!src) {
    return (
      <p className="text-[11px] text-zinc-500">
        Audio blob is not hydrated in IndexedDB memory yet.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-[#09090B] px-3 py-2 space-y-1.5">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setElementDuration(d);
          }
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime || 0);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
          if (activeAudioSceneId === sceneId) {
            onActivateSceneAudio(null);
          }
        }}
        onError={() => {
          setPlaying(false);
          setPlaybackError("Browser failed to decode audio file.");
        }}
      />

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void togglePlay()}
          aria-label={playing ? `Pause ${title || "voiceover"}` : `Play ${title || "voiceover"}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-violet-500 hover:text-white transition-colors"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
        </button>

        <input
          type="range"
          min={0}
          max={effectiveDuration}
          step={0.05}
          aria-label="Seek voiceover preview"
          value={Math.min(currentTime, effectiveDuration)}
          onChange={(e) => handleSeek(Number(e.target.value))}
          className="flex-1 accent-violet-500 cursor-pointer"
        />

        <span className="font-mono text-[11px] text-zinc-300 tabular-nums whitespace-nowrap">
          {formatSecondsPrecise(currentTime)} / {formatSecondsPrecise(effectiveDuration)}
        </span>

        <span
          className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 tabular-nums whitespace-nowrap"
          title={
            volume > 1
              ? "Playback previews at 100%; boost >100% applies during timeline FFmpeg audio mix."
              : "Scene voiceover volume"
          }
        >
          <Volume2 className="h-3 w-3 text-zinc-500" />
          {Math.round(volume * 100)}%
        </span>
      </div>

      {playbackError && <p className="text-[11px] text-rose-300">{playbackError}</p>}
    </div>
  );
}
