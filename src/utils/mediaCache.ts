import type { TimelineClip } from "../types/studio";

export interface LRUCacheStats {
  entries: number;
  maxEntries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface CacheNode<V> {
  value: V;
  bytes: number;
  onEvict?: (value: V) => void;
}

/**
 * Bounded O(1) LRU cache backed by ES Map insertion order,
 * tracking both item count and approximate byte footprint.
 */
export class BoundedLRUCache<K, V> {
  private readonly map = new Map<K, CacheNode<V>>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {}

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, node);
    return node.value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V, bytes = 0, onEvict?: (val: V) => void): void {
    const existing = this.map.get(key);
    if (existing) {
      this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
      if (existing.value !== value) {
        existing.onEvict?.(existing.value);
      }
      this.map.delete(key);
    }

    const safeBytes = Math.max(0, Number(bytes) || 0);
    this.map.set(key, { value, bytes: safeBytes, onEvict });
    this.totalBytes += safeBytes;
    this.evictIfNeeded();
  }

  delete(key: K): boolean {
    const existing = this.map.get(key);
    if (!existing) return false;
    this.map.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
    existing.onEvict?.(existing.value);
    return true;
  }

  deleteWhere(predicate: (key: K, value: V) => boolean): number {
    let removed = 0;
    for (const [k, node] of Array.from(this.map.entries())) {
      if (predicate(k, node.value)) {
        this.map.delete(k);
        this.totalBytes = Math.max(0, this.totalBytes - node.bytes);
        node.onEvict?.(node.value);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    for (const node of this.map.values()) {
      node.onEvict?.(node.value);
    }
    this.map.clear();
    this.totalBytes = 0;
  }

  getStats(): LRUCacheStats {
    return {
      entries: this.map.size,
      maxEntries: this.maxEntries,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private evictIfNeeded(): void {
    while (
      this.map.size > this.maxEntries ||
      (this.maxBytes > 0 && this.totalBytes > this.maxBytes && this.map.size > 1)
    ) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) {
        this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
        this.evictions++;
        oldest.onEvict?.(oldest.value);
      }
    }
  }
}

function revokeIfBlobUrl(url: string | undefined): void {
  if (url && url.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revocation failures during shutdown
    }
  }
}

export interface ThumbnailRequest {
  assetId: string;
  sourceUrl: string;
  timeSec?: number;
  width?: number;
  height?: number;
  persistableDataUrl?: boolean;
}

class ThumbnailCacheManager {
  private readonly cache = new BoundedLRUCache<string, string>(240, 24 * 1024 * 1024);
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private activeWorkers = 0;
  private readonly maxConcurrentWorkers = 2;

  makeKey(assetId: string, width = 320, height = 180, timeSec = 0): string {
    const bucketMs = Math.max(0, Math.round(timeSec * 4) * 250);
    return `${assetId}:${Math.round(width)}x${Math.round(height)}:${bucketMs}`;
  }

  getCached(assetId: string, width = 320, height = 180, timeSec = 0): string | undefined {
    return this.cache.get(this.makeKey(assetId, width, height, timeSec));
  }

  setCached(
    assetId: string,
    url: string,
    options?: { width?: number; height?: number; timeSec?: number; approxBytes?: number }
  ): void {
    if (!assetId || !url) return;
    const width = options?.width ?? 320;
    const height = options?.height ?? 180;
    const timeSec = options?.timeSec ?? 0;
    const key = this.makeKey(assetId, width, height, timeSec);
    const bytes = options?.approxBytes ?? (url.startsWith("data:") ? url.length : 16_384);
    this.cache.set(key, url, bytes, (evictedUrl) => {
      revokeIfBlobUrl(evictedUrl);
    });
  }

  invalidateAsset(assetId: string): number {
    if (!assetId) return 0;
    const prefix = `${assetId}:`;
    for (const key of Array.from(this.inFlight.keys())) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    return this.cache.deleteWhere((key) => key.startsWith(prefix));
  }

  clear(): void {
    this.inFlight.clear();
    this.queue.length = 0;
    this.cache.clear();
  }

  getStats(): LRUCacheStats {
    return this.cache.getStats();
  }

  private enqueueWork<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeWorkers++;
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        } finally {
          this.activeWorkers--;
          const next = this.queue.shift();
          if (next) {
            void next();
          }
        }
      };

      if (this.activeWorkers < this.maxConcurrentWorkers) {
        void run();
      } else {
        this.queue.push(run);
      }
    });
  }

  async getOrCaptureVideoThumbnail(
    req: ThumbnailRequest,
    capturer?: (req: ThumbnailRequest) => Promise<{ url?: string; width?: number; height?: number; duration?: number } | undefined>
  ): Promise<string | undefined> {
    const width = req.width ?? 320;
    const height = req.height ?? 180;
    const timeSec = req.timeSec ?? 0;
    const key = this.makeKey(req.assetId, width, height, timeSec);

    const cached = this.cache.get(key);
    if (cached) return cached;

    const existingPromise = this.inFlight.get(key);
    if (existingPromise) return existingPromise;

    const promise = this.enqueueWork(async () => {
      const result = capturer
        ? await capturer(req)
        : await captureVideoFrameDefault(req);
      if (result?.url) {
        this.cache.set(
          key,
          result.url,
          result.url.startsWith("data:") ? result.url.length : 16_384,
          (evictedUrl) => revokeIfBlobUrl(evictedUrl)
        );
      }
      return result?.url;
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }
}

async function captureVideoFrameDefault(
  req: ThumbnailRequest
): Promise<{ url?: string; width?: number; height?: number; duration?: number } | undefined> {
  if (typeof document === "undefined" || !req.sourceUrl) return undefined;

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const cleanupVideo = () => {
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // Ignore cleanup failure
      }
    };

    const finish = (payload?: { url?: string; width?: number; height?: number; duration?: number }) => {
      if (settled) return;
      settled = true;
      cleanupVideo();
      resolve(payload);
    };

    video.onloadeddata = () => {
      const targetSeek =
        req.timeSec !== undefined && req.timeSec > 0
          ? Math.min(Math.max(0.02, req.timeSec), Math.max(0.05, (video.duration || 1) - 0.05))
          : Math.min(0.6, Math.max(0.05, (video.duration || 1) * 0.1));
      try {
        video.currentTime = targetSeek;
      } catch {
        finish(undefined);
      }
    };

    video.onseeked = () => {
      try {
        const w = req.width ?? 320;
        const h =
          req.height ??
          Math.max(180, Math.round((video.videoHeight / (video.videoWidth || 16)) * w) || 180);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(undefined);
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);

        if (req.persistableDataUrl !== false) {
          finish({
            url: canvas.toDataURL("image/jpeg", 0.78),
            width: video.videoWidth || 1920,
            height: video.videoHeight || 1080,
            duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
          });
          return;
        }

        if (typeof canvas.toBlob === "function") {
          canvas.toBlob(
            (blob) => {
              if (blob && typeof URL.createObjectURL === "function") {
                finish({
                  url: URL.createObjectURL(blob),
                  width: video.videoWidth || 1920,
                  height: video.videoHeight || 1080,
                  duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
                });
              } else {
                finish({
                  url: canvas.toDataURL("image/jpeg", 0.78),
                  width: video.videoWidth || 1920,
                  height: video.videoHeight || 1080,
                  duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
                });
              }
            },
            "image/jpeg",
            0.78
          );
          return;
        }

        finish({
          url: canvas.toDataURL("image/jpeg", 0.78),
          width: video.videoWidth || 1920,
          height: video.videoHeight || 1080,
          duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
        });
      } catch {
        finish(undefined);
      }
    };

    video.onerror = () => finish(undefined);
    setTimeout(() => finish(undefined), 3500);
    video.src = req.sourceUrl;
  });
}

class WaveformCacheManager {
  private readonly assetPeaksCache = new BoundedLRUCache<string, number[]>(120, 4 * 1024 * 1024);
  private readonly slicedBarsCache = new BoundedLRUCache<string, number[]>(600, 4 * 1024 * 1024);
  private readonly peaksIdentity = new WeakMap<number[], string>();
  private nextPeaksId = 1;

  getPeaksKey(peaks: number[], explicitKey?: string): string {
    if (explicitKey) return explicitKey;
    let id = this.peaksIdentity.get(peaks);
    if (!id) {
      id = `pk_${this.nextPeaksId++}_${peaks.length}`;
      this.peaksIdentity.set(peaks, id);
    }
    return id;
  }

  getAssetPeaks(assetId: string): number[] | undefined {
    return this.assetPeaksCache.get(assetId);
  }

  setAssetPeaks(assetId: string, peaks: number[]): void {
    if (!assetId || !peaks.length) return;
    this.peaksIdentity.set(peaks, assetId);
    this.assetPeaksCache.set(assetId, peaks, peaks.length * 8);
  }

  makeSliceKey(
    peaksKey: string,
    clip: Pick<TimelineClip, "inPoint" | "duration" | "speed" | "sourceDuration">,
    targetBars: number
  ): string {
    const srcDur = Math.max(0.1, clip.sourceDuration || clip.duration || 1);
    const spd = Math.max(0.25, clip.speed || 1);
    const bars = Math.max(12, Math.min(180, Math.round(targetBars)));
    return `${peaksKey}:${clip.inPoint.toFixed(3)}:${clip.duration.toFixed(3)}:${spd.toFixed(3)}:${srcDur.toFixed(3)}:${bars}`;
  }

  getSlicedBars(
    peaks: number[],
    clip: Pick<TimelineClip, "inPoint" | "duration" | "speed" | "sourceDuration">,
    targetBars: number,
    explicitPeaksKey?: string
  ): number[] | undefined {
    const pkKey = this.getPeaksKey(peaks, explicitPeaksKey);
    return this.slicedBarsCache.get(this.makeSliceKey(pkKey, clip, targetBars));
  }

  setSlicedBars(
    peaks: number[],
    clip: Pick<TimelineClip, "inPoint" | "duration" | "speed" | "sourceDuration">,
    targetBars: number,
    barsOut: number[],
    explicitPeaksKey?: string
  ): void {
    const pkKey = this.getPeaksKey(peaks, explicitPeaksKey);
    const key = this.makeSliceKey(pkKey, clip, targetBars);
    this.slicedBarsCache.set(key, barsOut, barsOut.length * 8);
  }

  invalidateAsset(assetId: string): void {
    if (!assetId) return;
    this.assetPeaksCache.delete(assetId);
    const prefix = `${assetId}:`;
    this.slicedBarsCache.deleteWhere((key) => key.startsWith(prefix));
  }

  clear(): void {
    this.assetPeaksCache.clear();
    this.slicedBarsCache.clear();
  }

  getStats(): { assetPeaks: LRUCacheStats; slicedBars: LRUCacheStats } {
    return {
      assetPeaks: this.assetPeaksCache.getStats(),
      slicedBars: this.slicedBarsCache.getStats(),
    };
  }
}

export const thumbnailCache = new ThumbnailCacheManager();
export const waveformCache = new WaveformCacheManager();

export function clearAssetMediaCaches(assetId: string): void {
  thumbnailCache.invalidateAsset(assetId);
  waveformCache.invalidateAsset(assetId);
}

export function clearAllMediaCaches(): void {
  thumbnailCache.clear();
  waveformCache.clear();
}

export function getMediaCacheStats() {
  return {
    thumbnails: thumbnailCache.getStats(),
    waveforms: waveformCache.getStats(),
  };
}
