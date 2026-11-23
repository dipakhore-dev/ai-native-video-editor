import type { SpeechInterval, SubtitleSegment, TimelineClip } from "../types/studio";
import { evaluateClipProperty } from "./keyframes";
import { waveformCache } from "./mediaCache";

export const SUPPORTED_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"] as const;
export const DEFAULT_WAVEFORM_BUCKETS = 160;
export const DEFAULT_DUCKING_AMOUNT = 0.6;
export const MAX_CLIP_VOLUME = 2; // 200%

export function clampVolume(value: number | undefined, fallback = 1): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(MAX_CLIP_VOLUME, Math.max(0, Number(num.toFixed(3))));
}

export function clampFadeSeconds(value: number | undefined, maxDuration = 30): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(Math.max(0, maxDuration), Math.min(30, Number(num.toFixed(2))));
}

export function clampDuckingAmount(value: number | undefined, fallback = DEFAULT_DUCKING_AMOUNT): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(0.95, Math.max(0, Number(num.toFixed(2))));
}

export function normalizeAudioMimeType(file: Pick<File, "name" | "type">): string {
  const rawType = (file.type || "").split(";")[0].trim().toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "flac") return "audio/flac";
  if (rawType.startsWith("audio/")) return rawType;
  return "audio/mpeg";
}

/**
 * Computes normalized peak values in [0, 1] from raw decoded PCM channel samples.
 * Returns normalized amplitudes suitable for Canvas/SVG waveform rendering.
 */
export function computeWaveformPeaksFromChannels(
  channels: Array<Float32Array | number[]>,
  bucketCount = DEFAULT_WAVEFORM_BUCKETS
): number[] {
  if (!channels.length || !channels[0]?.length || bucketCount <= 0) {
    return [];
  }

  const totalSamples = channels[0].length;
  const effectiveBuckets = Math.max(8, Math.min(512, Math.floor(bucketCount)));
  const blockSize = Math.max(1, Math.floor(totalSamples / effectiveBuckets));
  const rawPeaks: number[] = [];

  for (let i = 0; i < effectiveBuckets; i++) {
    const start = Math.floor((i * totalSamples) / effectiveBuckets);
    const end = Math.min(totalSamples, Math.max(start + 1, start + blockSize));
    let sumSq = 0;
    let peak = 0;
    let count = 0;

    // Sample cleanly without scanning millions of samples unnecessarily
    const stride = Math.max(1, Math.floor((end - start) / 128));
    for (let s = start; s < end; s += stride) {
      let mixed = 0;
      for (let c = 0; c < channels.length; c++) {
        mixed += Math.abs(channels[c][s] ?? 0);
      }
      mixed /= channels.length;
      if (mixed > peak) peak = mixed;
      sumSq += mixed * mixed;
      count++;
    }

    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    // Blend RMS and peak so both speech transients and music sustain are visible
    const val = rms * 0.55 + peak * 0.45;
    rawPeaks.push(val);
  }

  const maxVal = rawPeaks.reduce((m, v) => Math.max(m, v), 0);
  if (maxVal <= 0.0001) {
    return rawPeaks.map(() => 0.04);
  }

  return rawPeaks.map((v) => {
    const norm = v / maxVal;
    return Number(Math.max(0.04, Math.min(1, norm)).toFixed(3));
  });
}

const inFlightWaveformExtractions = new Map<string, Promise<number[] | undefined>>();

/**
 * Decodes real audio PCM samples locally in the browser using Web Audio API
 * and returns a compact peak array for timeline rendering and IndexedDB caching.
 */
export async function extractAudioWaveformPeaks(
  blob: Blob,
  bucketCount = DEFAULT_WAVEFORM_BUCKETS,
  cacheKey?: string
): Promise<number[] | undefined> {
  if (cacheKey) {
    const cached = waveformCache.getAssetPeaks(cacheKey);
    if (cached) return cached;
    const pending = inFlightWaveformExtractions.get(cacheKey);
    if (pending) return pending;
  }

  if (typeof window === "undefined") return undefined;

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return undefined;

  // Skip attempting full decode for massive video files > 180 MB to keep UI snappy
  if (blob.size <= 0 || blob.size > 180 * 1024 * 1024) {
    return undefined;
  }

  const run = (async () => {
    let ctx: AudioContext | null = null;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      ctx = new AudioCtx();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) {
        channels.push(audioBuffer.getChannelData(c));
      }
      const peaks = computeWaveformPeaksFromChannels(channels, bucketCount);
      if (peaks.length > 0 && cacheKey) {
        waveformCache.setAssetPeaks(cacheKey, peaks);
      }
      return peaks.length > 0 ? peaks : undefined;
    } catch {
      // Expected for silent video files with no audio track or unsupported container codecs
      return undefined;
    } finally {
      if (ctx && typeof ctx.close === "function") {
        await ctx.close().catch(() => undefined);
      }
    }
  })();

  if (cacheKey) {
    inFlightWaveformExtractions.set(cacheKey, run);
    try {
      return await run;
    } finally {
      inFlightWaveformExtractions.delete(cacheKey);
    }
  }

  return run;
}

/**
 * Slices cached source waveform peaks to match the visible trimmed portion of a TimelineClip,
 * backed by a bounded LRU cache keyed by clip bounds, speed, source duration, and bar density.
 */
export function sliceWaveformPeaksForClip(
  peaks: number[] | undefined,
  clip: Pick<TimelineClip, "inPoint" | "duration" | "speed" | "sourceDuration">,
  targetBars = 64,
  cacheKey?: string
): number[] {
  if (!peaks || peaks.length === 0) return [];

  const cached = waveformCache.getSlicedBars(peaks, clip, targetBars, cacheKey);
  if (cached) return cached;

  const srcDur = Math.max(0.1, clip.sourceDuration || clip.duration || 1);
  const startFrac = Math.max(0, Math.min(1, clip.inPoint / srcDur));
  const endFrac = Math.max(
    startFrac + 0.01,
    Math.min(1, (clip.inPoint + clip.duration * Math.max(0.25, clip.speed || 1)) / srcDur)
  );

  const startIdx = Math.floor(startFrac * peaks.length);
  const endIdx = Math.min(peaks.length, Math.max(startIdx + 1, Math.ceil(endFrac * peaks.length)));
  const slice = peaks.slice(startIdx, endIdx);
  if (slice.length === 0) return [];

  const bars = Math.max(12, Math.min(180, Math.round(targetBars)));
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * slice.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * slice.length) / bars));
    let sum = 0;
    for (let j = from; j < to && j < slice.length; j++) {
      sum += slice[j];
    }
    out.push(Number((sum / Math.max(1, Math.min(slice.length, to) - from)).toFixed(3)));
  }

  waveformCache.setSlicedBars(peaks, clip, targetBars, out, cacheKey);
  return out;
}

/**
 * Resolves non-overlapping fade-in / fade-out durations constrained to clip length,
 * scaling proportionally if fadeIn + fadeOut exceed duration (matching FFmpeg math).
 */
export function computeEffectiveFadeDurations(
  clipDurationSec: number,
  fadeInSec = 0,
  fadeOutSec = 0
): { fadeIn: number; fadeOut: number } {
  const dur = Math.max(0, Number(clipDurationSec) || 0);
  if (dur <= 0.02) return { fadeIn: 0, fadeOut: 0 };

  let fIn = Math.max(0, Number(fadeInSec) || 0);
  let fOut = Math.max(0, Number(fadeOutSec) || 0);
  const sum = fIn + fOut;
  if (sum > dur && sum > 0) {
    const scale = dur / sum;
    fIn = Number((fIn * scale).toFixed(3));
    fOut = Number((fOut * scale).toFixed(3));
  }
  return { fadeIn: fIn, fadeOut: fOut };
}

/**
 * Computes linear fade envelope multiplier in [0, 1] at local clip time.
 */
export function computeClipFadeEnvelope(
  localTimeSec: number,
  clipDurationSec: number,
  fadeInSec = 0,
  fadeOutSec = 0
): number {
  if (localTimeSec < 0 || localTimeSec > clipDurationSec) return 0;
  const { fadeIn, fadeOut } = computeEffectiveFadeDurations(
    clipDurationSec,
    fadeInSec,
    fadeOutSec
  );

  let gain = 1;
  if (fadeIn > 0.005 && localTimeSec < fadeIn) {
    gain = Math.min(gain, Math.max(0, localTimeSec / fadeIn));
  }
  if (fadeOut > 0.005 && localTimeSec > clipDurationSec - fadeOut) {
    const remaining = Math.max(0, clipDurationSec - localTimeSec);
    gain = Math.min(gain, Math.max(0, remaining / fadeOut));
  }
  return Math.max(0, Math.min(1, gain));
}

/**
 * Builds merged, padded speech intervals from subtitle cues for speech-aware ducking.
 */
export function buildSpeechIntervals(
  subtitles: SubtitleSegment[] | undefined,
  paddingSec = 0.15
): SpeechInterval[] {
  if (!subtitles || subtitles.length === 0) return [];
  const raw = subtitles
    .filter(
      (s) =>
        s.text.trim().length > 0 &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > s.start
    )
    .map((s) => ({
      start: Math.max(0, Number((s.start - paddingSec).toFixed(2))),
      end: Number((s.end + paddingSec).toFixed(2)),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (raw.length === 0) return [];

  const merged: SpeechInterval[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = raw[i];
    if (cur.start <= prev.end + 0.05) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Computes speech-aware ducking multiplier in [0.05, 1].
 * Supports smooth ramps around subtitle speech intervals and V1 fallback when no subtitles exist yet.
 */
export function computeDuckingMultiplier(
  timelineTimeSec: number,
  duckingEnabled = false,
  duckingAmount = DEFAULT_DUCKING_AMOUNT,
  speechIntervals: SpeechInterval[] = [],
  v1AudibleAtTime = false
): number {
  if (!duckingEnabled) return 1;
  const amount = clampDuckingAmount(duckingAmount);
  if (amount <= 0) return 1;
  const minFloor = Math.max(0.05, 1 - amount);

  if (speechIntervals.length > 0) {
    const rampSec = 0.15;
    let bestAttenuation = 0;

    for (const iv of speechIntervals) {
      if (timelineTimeSec >= iv.start && timelineTimeSec <= iv.end) {
        bestAttenuation = 1;
        break;
      }
      if (timelineTimeSec >= iv.start - rampSec && timelineTimeSec < iv.start) {
        const progress = (timelineTimeSec - (iv.start - rampSec)) / rampSec;
        bestAttenuation = Math.max(bestAttenuation, progress);
      } else if (timelineTimeSec > iv.end && timelineTimeSec <= iv.end + rampSec) {
        const progress = 1 - (timelineTimeSec - iv.end) / rampSec;
        bestAttenuation = Math.max(bestAttenuation, progress);
      }
    }

    return 1 - bestAttenuation * (1 - minFloor);
  }

  return v1AudibleAtTime ? minFloor : 1;
}

export function computeEffectiveClipGain(params: {
  clip: TimelineClip;
  timelineTimeSec: number;
  trackMuted: boolean;
  masterVolume: number;
  masterMuted: boolean;
  speechIntervals?: SpeechInterval[];
  v1AudibleAtTime?: boolean;
}): { effectiveGain: number; isMuted: boolean } {
  const {
    clip,
    timelineTimeSec,
    trackMuted,
    masterVolume,
    masterMuted,
    speechIntervals = [],
    v1AudibleAtTime = false,
  } = params;

  const localTime = Math.max(0, timelineTimeSec - clip.startTime);
  const hasVolumeKeyframes = Boolean(
    clip.keyframes?.some((kf) => kf.property === "volume")
  );
  const evaluatedVolume = hasVolumeKeyframes
    ? evaluateClipProperty(clip, "volume", localTime)
    : clampVolume(clip.volume, 1);

  const isMuted = Boolean(
    masterMuted || trackMuted || clip.muted || (!hasVolumeKeyframes && clip.volume <= 0.001)
  );
  if (isMuted) {
    return { effectiveGain: 0, isMuted: true };
  }

  const fade = computeClipFadeEnvelope(
    localTime,
    clip.duration,
    clip.fadeInSec ?? 0,
    clip.fadeOutSec ?? 0
  );
  const duck =
    clip.kind === "audio"
      ? computeDuckingMultiplier(
          timelineTimeSec,
          Boolean(clip.duckingEnabled),
          clip.duckingAmount,
          speechIntervals,
          v1AudibleAtTime
        )
      : 1;

  const base = clampVolume(evaluatedVolume, 1);
  const master = Math.max(0, Math.min(1, masterVolume));
  const effectiveGain = Number(Math.max(0, Math.min(2, master * base * fade * duck)).toFixed(4));

  return {
    effectiveGain,
    isMuted: effectiveGain <= 0.0001,
  };
}
