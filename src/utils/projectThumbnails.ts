import type { MediaAsset, MediaKind, Project, TimelineClip } from "../types/studio";
import { projectThumbnailCache, thumbnailCache } from "./mediaCache";

export interface MissingMediaDescriptor {
  assetId: string;
  name: string;
  kind: MediaKind;
  sizeBytes?: number;
}

export interface ProjectMediaHealth {
  totalAssetCount: number;
  missingCount: number;
  hasMissingMedia: boolean;
  missingAssets: MissingMediaDescriptor[];
}

export function getProjectMediaHealth(
  project: Project,
  mediaAssets: MediaAsset[],
  isStorageReady: boolean
): ProjectMediaHealth {
  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const distinctAssetIds = new Set<string>();
  const missingById = new Map<string, MissingMediaDescriptor>();

  for (const clip of project.clips) {
    if (clip.kind === "text" || !clip.assetId) continue;
    distinctAssetIds.add(clip.assetId);

    const hasAsset = assetsById.has(clip.assetId);
    const isMissing = clip.needsRelink || (isStorageReady && !hasAsset);
    if (isMissing && !missingById.has(clip.assetId)) {
      missingById.set(clip.assetId, {
        assetId: clip.assetId,
        name: clip.sourceName || clip.name,
        kind: clip.kind,
        sizeBytes: clip.sourceSizeBytes,
      });
    }
  }

  const missingAssets = Array.from(missingById.values());
  return {
    totalAssetCount: distinctAssetIds.size,
    missingCount: missingAssets.length,
    hasMissingMedia: missingAssets.length > 0,
    missingAssets,
  };
}

function findRepresentativeVisualClip(project: Project): TimelineClip | null {
  const visualKinds = new Set<MediaKind>(["video", "image"]);
  const v1Visual = project.clips
    .filter((c) => c.trackId === "track_v1" && visualKinds.has(c.kind) && !c.needsRelink)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (v1Visual.length > 0) return v1Visual[0];

  const v2Visual = project.clips
    .filter((c) => c.trackId === "track_v2" && visualKinds.has(c.kind) && !c.needsRelink)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (v2Visual.length > 0) return v2Visual[0];

  const anyVisual = project.clips
    .filter((c) => visualKinds.has(c.kind) && !c.needsRelink)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  return anyVisual[0] ?? null;
}

export function computeProjectThumbnailFingerprint(
  project: Project,
  mediaAssets: MediaAsset[] = []
): string {
  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const visualClip = findRepresentativeVisualClip(project);
  if (visualClip) {
    const asset = assetsById.get(visualClip.assetId);
    const fx = visualClip.effects
      ? `${visualClip.effects.preset}:${visualClip.effects.brightness}:${visualClip.effects.contrast}:${visualClip.effects.saturation}:${visualClip.effects.blur}`
      : "nofx";
    return [
      "vis",
      project.aspectRatio,
      visualClip.id,
      visualClip.assetId,
      visualClip.kind,
      visualClip.inPoint.toFixed(2),
      visualClip.duration.toFixed(2),
      visualClip.needsRelink ? "missing" : "ready",
      asset?.objectUrl ? "url" : visualClip.thumbnailUrl ? "thumb" : "nourl",
      fx,
    ].join("|");
  }

  const firstText = project.clips
    .filter((c) => c.kind === "text")
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))[0];
  const hasAudio = project.clips.some((c) => c.kind === "audio");
  const missingCount = project.clips.filter((c) => c.needsRelink).length;

  return [
    "fallback",
    project.aspectRatio,
    project.name,
    project.clips.length,
    missingCount,
    hasAudio ? "audio" : "noaudio",
    firstText?.textStyle?.text ?? "",
    firstText?.textStyle?.color ?? "",
    firstText?.textStyle?.backgroundColor ?? "",
  ].join("|");
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderFallbackProjectThumbnailDataUrl(project: Project): string {
  const firstTextClip = project.clips
    .filter((c) => c.kind === "text" && c.textStyle?.text)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))[0];
  const hasAudio = project.clips.some((c) => c.kind === "audio");
  const missingCount = project.clips.filter((c) => c.needsRelink).length;

  const headline = (firstTextClip?.textStyle?.text || project.name || "Untitled Sequence")
    .trim()
    .slice(0, 34);
  const sublabel =
    missingCount > 0
      ? `${missingCount} missing media ${missingCount === 1 ? "file" : "files"}`
      : firstTextClip
        ? `${project.aspectRatio} · Text Starter`
        : hasAudio
          ? `${project.aspectRatio} · Audio Sequence`
          : `${project.aspectRatio} · Empty Sequence`;

  if (typeof document !== "undefined") {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, 320, 180);
        if (project.aspectRatio === "9:16") {
          grad.addColorStop(0, "#1E1036");
          grad.addColorStop(1, "#0B0D14");
        } else if (project.aspectRatio === "1:1") {
          grad.addColorStop(0, "#0A2524");
          grad.addColorStop(1, "#0B0E14");
        } else {
          grad.addColorStop(0, "#13172B");
          grad.addColorStop(1, "#090A0F");
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 320, 180);

        // Draw subtle aspect-ratio safe frame box in center
        const frameW =
          project.aspectRatio === "9:16" ? 72 : project.aspectRatio === "1:1" ? 120 : 210;
        const frameH =
          project.aspectRatio === "9:16" ? 128 : project.aspectRatio === "1:1" ? 120 : 118;
        const fx = Math.round((320 - frameW) / 2);
        const fy = Math.round((180 - frameH) / 2);
        ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(fx, fy, frameW, frameH);

        if (hasAudio && !firstTextClip) {
          ctx.fillStyle = "rgba(56, 189, 248, 0.65)";
          const bars = [18, 34, 52, 28, 62, 44, 56, 24, 48, 32, 20];
          bars.forEach((h, idx) => {
            ctx.fillRect(102 + idx * 11, 90 - h / 2, 6, h);
          });
        }

        ctx.fillStyle = "#F8FAFC";
        ctx.font = "600 14px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(headline, 160, 82, 270);

        ctx.fillStyle = missingCount > 0 ? "#FBBF24" : "#94A3B8";
        ctx.font = "500 11px monospace";
        ctx.fillText(sublabel, 160, 108, 260);

        return canvas.toDataURL("image/jpeg", 0.8);
      }
    } catch {
      // Fall through to deterministic SVG data URL when canvas 2D isn't mocked/available
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#171530"/><stop offset="100%" stop-color="#09090b"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect x="64" y="34" width="192" height="112" rx="6" fill="none" stroke="rgba(148,163,184,0.28)" stroke-width="1.5"/><text x="160" y="84" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="600">${escapeXml(headline)}</text><text x="160" y="108" text-anchor="middle" fill="${missingCount > 0 ? "#fbbf24" : "#94a3b8"}" font-family="monospace" font-size="11">${escapeXml(sublabel)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function getOrCreateProjectThumbnail(
  project: Project,
  mediaAssets: MediaAsset[]
): Promise<{ url: string; fingerprint: string; fromCache: boolean }> {
  const fingerprint = computeProjectThumbnailFingerprint(project, mediaAssets);
  const cached = projectThumbnailCache.get(project.id, fingerprint);
  if (cached) {
    return { url: cached, fingerprint, fromCache: true };
  }

  const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
  const visualClip = findRepresentativeVisualClip(project);

  if (visualClip) {
    const asset = assetsById.get(visualClip.assetId);
    const sourceUrl = visualClip.objectUrl || asset?.objectUrl || "";
    if (visualClip.kind === "image") {
      const imgUrl = asset?.thumbnailUrl || visualClip.thumbnailUrl || sourceUrl;
      if (imgUrl) {
        projectThumbnailCache.set(project.id, fingerprint, imgUrl);
        return { url: imgUrl, fingerprint, fromCache: false };
      }
    } else if (visualClip.kind === "video") {
      const repTimeSec = Math.max(
        0,
        visualClip.inPoint + Math.min(Math.max(0.1, visualClip.duration * 0.25), 1.5)
      );
      if (sourceUrl) {
        const captured = await thumbnailCache.getOrCaptureVideoThumbnail({
          assetId: visualClip.assetId,
          sourceUrl,
          width: 320,
          height: 180,
          timeSec: repTimeSec,
          persistableDataUrl: true,
        });
        if (captured) {
          projectThumbnailCache.set(project.id, fingerprint, captured);
          return { url: captured, fingerprint, fromCache: false };
        }
      }
      const existingClipThumb = asset?.thumbnailUrl || visualClip.thumbnailUrl;
      if (existingClipThumb) {
        projectThumbnailCache.set(project.id, fingerprint, existingClipThumb);
        return { url: existingClipThumb, fingerprint, fromCache: false };
      }
    }
  }

  const fallback = renderFallbackProjectThumbnailDataUrl(project);
  projectThumbnailCache.set(project.id, fingerprint, fallback);
  return { url: fallback, fingerprint, fromCache: false };
}
