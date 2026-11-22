import type { MediaAsset, MediaKind, TimelineClip } from "../types/studio";
import { DEFAULT_WAVEFORM_BUCKETS, extractAudioWaveformPeaks, normalizeAudioMimeType } from "./audio";
import { thumbnailCache, waveformCache } from "./mediaCache";
import { getMediaFromIndexedDB } from "./mediaStorage";

export function formatTimecode(seconds: number, showFrames = false, fps = 30): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");

  if (!showFrames) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs > 0) {
      return `${pad(hrs)}:${pad(remMins)}:${pad(secs)}`;
    }
    return `${pad(remMins)}:${pad(secs)}`;
  }

  const frames = Math.floor((clamped - Math.floor(clamped)) * fps);
  return `${pad(mins)}:${pad(secs)}.${pad(frames)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

export function generateStableAssetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `asset_${crypto.randomUUID()}`;
  }
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function detectMediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "m4v", "mkv"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["mp3", "wav", "aac", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  return null;
}

const IMMEDIATE_VIDEO_WAVEFORM_MAX_BYTES = 12 * 1024 * 1024;

async function probeVideoDimensionsAndDuration(
  sourceUrl: string
): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (info: { duration: number; width: number; height: number }) => {
      if (settled) return;
      settled = true;
      video.onloadedmetadata = null;
      video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // Ignore cleanup failures
      }
      resolve(info);
    };

    video.onloadedmetadata = () => {
      finish({
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
        width: video.videoWidth || 1920,
        height: video.videoHeight || 1080,
      });
    };
    video.onerror = () => finish({ duration: 8, width: 1920, height: 1080 });
    setTimeout(() => finish({ duration: 8, width: 1920, height: 1080 }), 3500);
    video.src = sourceUrl;
  });
}

export async function extractMediaAsset(
  file: File,
  overrideAssetId?: string
): Promise<MediaAsset> {
  const kind = detectMediaKind(file);
  if (!kind || kind === "text") {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  const objectUrl = URL.createObjectURL(file);
  const id = overrideAssetId || generateStableAssetId();

  try {
    if (kind === "image") {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 1920, height: 1080 });
        img.src = objectUrl;
      });

      thumbnailCache.setCached(id, objectUrl, {
        width: dimensions.width,
        height: dimensions.height,
        approxBytes: file.size,
      });

      return {
        id,
        name: file.name,
        kind,
        mimeType: file.type || "image/png",
        sizeBytes: file.size,
        duration: 5,
        width: dimensions.width,
        height: dimensions.height,
        objectUrl,
        thumbnailUrl: objectUrl,
        sourceFile: file,
        addedAt: new Date().toISOString(),
      };
    }

    if (kind === "audio") {
      const [duration, waveformPeaks] = await Promise.all([
        new Promise<number>((resolve) => {
          const audio = document.createElement("audio");
          audio.preload = "metadata";
          let settled = false;
          const finish = (dur: number) => {
            if (settled) return;
            settled = true;
            audio.onloadedmetadata = null;
            audio.onerror = null;
            try {
              audio.removeAttribute("src");
              audio.load();
            } catch {
              // Ignore cleanup failures
            }
            resolve(dur);
          };
          audio.onloadedmetadata = () => {
            finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 10);
          };
          audio.onerror = () => finish(10);
          setTimeout(() => finish(10), 3500);
          audio.src = objectUrl;
        }),
        extractAudioWaveformPeaks(file, DEFAULT_WAVEFORM_BUCKETS, id),
      ]);

      return {
        id,
        name: file.name,
        kind,
        mimeType: normalizeAudioMimeType(file),
        sizeBytes: file.size,
        duration,
        objectUrl,
        waveformPeaks,
        sourceFile: file,
        addedAt: new Date().toISOString(),
      };
    }

    // Video inspection + deduplicated LRU-cached thumbnail capture
    const [videoMeta, thumbnailUrl, waveformPeaks] = await Promise.all([
      probeVideoDimensionsAndDuration(objectUrl),
      thumbnailCache.getOrCaptureVideoThumbnail({
        assetId: id,
        sourceUrl: objectUrl,
        width: 320,
        height: 180,
        timeSec: 0,
        persistableDataUrl: true,
      }),
      file.size <= IMMEDIATE_VIDEO_WAVEFORM_MAX_BYTES
        ? extractAudioWaveformPeaks(file, DEFAULT_WAVEFORM_BUCKETS, id)
        : Promise.resolve(undefined),
    ]);

    if (waveformPeaks?.length) {
      waveformCache.setAssetPeaks(id, waveformPeaks);
    }

    return {
      id,
      name: file.name,
      kind,
      mimeType: file.type || "video/mp4",
      sizeBytes: file.size,
      duration: videoMeta.duration,
      width: videoMeta.width,
      height: videoMeta.height,
      objectUrl,
      thumbnailUrl,
      waveformPeaks,
      sourceFile: file,
      addedAt: new Date().toISOString(),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * Resolves the actual File bytes for a TimelineClip across in-memory sourceFile,
 * IndexedDB persistent local media store, or an active blob: object URL.
 */
export async function resolveClipSourceFile(
  clip: TimelineClip,
  mediaAssets: MediaAsset[]
): Promise<File> {
  const asset = mediaAssets.find((a) => a.id === clip.assetId);
  if (asset?.sourceFile && asset.sourceFile.size > 0) {
    return asset.sourceFile;
  }

  // Fallback directly to IndexedDB using stable assetId (ensures export/subtitles work even right after reload)
  try {
    const stored = await getMediaFromIndexedDB(clip.assetId);
    if (stored?.blob && stored.blob.size > 0) {
      const filename = stored.name || clip.sourceName || clip.name || "clip.mp4";
      return new File([stored.blob], filename, {
        type: stored.mimeType || stored.blob.type || clip.sourceMimeType || "video/mp4",
      });
    }
  } catch {
    // Continue to object URL fallback if IndexedDB read is unavailable
  }

  const candidateUrl = clip.objectUrl || asset?.objectUrl || "";
  if (candidateUrl.startsWith("blob:")) {
    const response = await fetch(candidateUrl);
    if (!response.ok) {
      throw new Error(`Unable to read local file bytes for '${clip.name}'.`);
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Local media file for '${clip.name}' is empty.`);
    }
    const filename = clip.sourceName || clip.name || "clip.mp4";
    return new File([blob], filename, {
      type: blob.type || clip.sourceMimeType || "video/mp4",
    });
  }

  throw new Error(
    `Original media bytes for '${clip.sourceName || clip.name}' were not found in this browser's IndexedDB storage. Use "Re-link File" to restore it.`
  );
}
