import { useEffect, useState } from "react";

export type PlaybackTimeListener = (timeSec: number) => void;

/**
 * External mutable playback clock shared between the preview transport loop and
 * lightweight leaf UI subscribers so high-frequency 60Hz ticks do not force full
 * parent React tree re-renders across Media Bin, Timeline Clips, or Inspector.
 */
export class TimelinePlaybackClock {
  private currentTime: number;
  private readonly listeners = new Set<PlaybackTimeListener>();

  constructor(initialTime = 0) {
    this.currentTime = Math.max(0, Number(initialTime) || 0);
  }

  getTime(): number {
    return this.currentTime;
  }

  setTime(nextTime: number, forceNotify = false): void {
    const safe = Math.max(0, Number.isFinite(nextTime) ? nextTime : 0);
    if (!forceNotify && Math.abs(safe - this.currentTime) < 0.0005) {
      return;
    }
    this.currentTime = safe;
    for (const listener of this.listeners) {
      listener(safe);
    }
  }

  subscribe(listener: PlaybackTimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export function usePlaybackTime(
  clock: TimelinePlaybackClock | undefined,
  options?: { fallbackTime?: number; throttleMs?: number }
): number {
  const fallback = options?.fallbackTime ?? 0;
  const throttleMs = options?.throttleMs ?? 0;

  const [time, setTime] = useState<number>(() => (clock ? clock.getTime() : fallback));

  useEffect(() => {
    if (!clock) {
      setTime(fallback);
      return;
    }

    setTime(clock.getTime());

    if (throttleMs <= 0) {
      return clock.subscribe((next) => {
        setTime(next);
      });
    }

    let lastCommitAt = 0;
    let lastCommittedVal = clock.getTime();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestPending = lastCommittedVal;

    const flush = (val: number) => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      lastCommitAt = performance.now();
      lastCommittedVal = val;
      setTime(val);
    };

    const unsub = clock.subscribe((next) => {
      latestPending = next;
      const now = performance.now();
      // Immediate update on manual seek jumps / reset to 0, throttled during steady playback
      if (Math.abs(next - lastCommittedVal) > 0.35 || next === 0 || now - lastCommitAt >= throttleMs) {
        flush(next);
        return;
      }
      if (timer === null) {
        const remaining = Math.max(8, throttleMs - (now - lastCommitAt));
        timer = setTimeout(() => {
          timer = null;
          flush(latestPending);
        }, remaining);
      }
    });

    return () => {
      unsub();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [clock, fallback, throttleMs]);

  return clock ? time : fallback;
}
