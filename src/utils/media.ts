import type { MediaAsset, MediaKind } from "../types/studio";

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

export async function extractMediaAsset(file: File): Promise<MediaAsset> {
  const kind = detectMediaKind(file);
  if (!kind) {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  const objectUrl = URL.createObjectURL(file);
  const id = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (kind === "image") {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 1920, height: 1080 });
      img.src = objectUrl;
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
      addedAt: new Date().toISOString(),
    };
  }

  if (kind === "audio") {
    const duration = await new Promise<number>((resolve) => {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 10);
      };
      audio.onerror = () => resolve(10);
      audio.src = objectUrl;
    });

    return {
      id,
      name: file.name,
      kind,
      mimeType: file.type || "audio/mpeg",
      sizeBytes: file.size,
      duration,
      objectUrl,
      addedAt: new Date().toISOString(),
    };
  }

  // Video inspection + canvas thumbnail capture
  const videoInfo = await new Promise<{
    duration: number;
    width: number;
    height: number;
    thumbnailUrl?: string;
  }>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (thumb?: string) => {
      if (settled) return;
      settled = true;
      resolve({
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8,
        width: video.videoWidth || 1920,
        height: video.videoHeight || 1080,
        thumbnailUrl: thumb,
      });
    };

    video.onloadeddata = () => {
      const targetSeek = Math.min(0.6, Math.max(0.05, (video.duration || 1) * 0.1));
      try {
        video.currentTime = targetSeek;
      } catch {
        finish(undefined);
      }
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        const w = 320;
        const h = Math.max(180, Math.round((video.videoHeight / (video.videoWidth || 16)) * w) || 180);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          finish(canvas.toDataURL("image/jpeg", 0.78));
          return;
        }
      } catch {
        // Fallback if canvas capture blocked
      }
      finish(undefined);
    };

    video.onerror = () => finish(undefined);
    setTimeout(() => finish(undefined), 3500);
    video.src = objectUrl;
  });

  return {
    id,
    name: file.name,
    kind,
    mimeType: file.type || "video/mp4",
    sizeBytes: file.size,
    duration: videoInfo.duration,
    width: videoInfo.width,
    height: videoInfo.height,
    objectUrl,
    thumbnailUrl: videoInfo.thumbnailUrl,
    addedAt: new Date().toISOString(),
  };
}
