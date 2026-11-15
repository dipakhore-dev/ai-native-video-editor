import type { MediaAsset, MediaKind, Project } from "../types/studio";

export const IDB_MEDIA_DB_NAME = "ai_studio_local_media_db";
export const IDB_MEDIA_STORE_NAME = "media_assets";
export const IDB_MEDIA_DB_VERSION = 1;

export interface StoredMediaRecord {
  id: string;
  name: string;
  kind: Exclude<MediaKind, "text">;
  mimeType: string;
  sizeBytes: number;
  duration: number;
  width?: number;
  height?: number;
  thumbnailDataUrl?: string;
  blob: Blob;
  addedAt: string;
  updatedAt: string;
}

export interface BrowserStorageEstimate {
  supported: boolean;
  usageBytes: number;
  quotaBytes: number;
  availableBytes: number;
  percentUsed: number;
}

export interface QuotaCheckResult {
  canFit: boolean;
  estimate: BrowserStorageEstimate;
  reason?: string;
}

export class MediaStorageQuotaError extends Error {
  public readonly code = "QUOTA_EXCEEDED";
  public readonly requiredBytes?: number;
  public readonly availableBytes?: number;

  constructor(message: string, requiredBytes?: number, availableBytes?: number) {
    super(message);
    this.name = "MediaStorageQuotaError";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

export function isQuotaExceededDomError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof MediaStorageQuotaError) return true;
  const domErr = err as { name?: string; code?: number };
  return (
    domErr.name === "QuotaExceededError" ||
    domErr.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    domErr.code === 22 ||
    domErr.code === 1014
  );
}

function formatReadableBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export async function estimateBrowserStorage(
  customEstimate?: () => Promise<{ usage?: number; quota?: number }>
): Promise<BrowserStorageEstimate> {
  try {
    const estimator =
      customEstimate ??
      (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function"
        ? () => navigator.storage.estimate()
        : null);

    if (!estimator) {
      return {
        supported: false,
        usageBytes: 0,
        quotaBytes: 0,
        availableBytes: Number.POSITIVE_INFINITY,
        percentUsed: 0,
      };
    }

    const result = await estimator();
    const usageBytes = Math.max(0, Number(result.usage ?? 0));
    const quotaBytes = Math.max(0, Number(result.quota ?? 0));
    const availableBytes = quotaBytes > 0 ? Math.max(0, quotaBytes - usageBytes) : Number.POSITIVE_INFINITY;
    const percentUsed = quotaBytes > 0 ? Math.min(100, Number(((usageBytes / quotaBytes) * 100).toFixed(1))) : 0;

    return {
      supported: true,
      usageBytes,
      quotaBytes,
      availableBytes,
      percentUsed,
    };
  } catch {
    return {
      supported: false,
      usageBytes: 0,
      quotaBytes: 0,
      availableBytes: Number.POSITIVE_INFINITY,
      percentUsed: 0,
    };
  }
}

export async function checkStorageQuotaForBytes(
  requiredBytes: number,
  assetLabel?: string,
  customEstimate?: () => Promise<{ usage?: number; quota?: number }>
): Promise<QuotaCheckResult> {
  const estimate = await estimateBrowserStorage(customEstimate);
  // Reserve a small metadata/thumbnail buffer (~64 KB) alongside file bytes
  const effectiveNeeded = Math.max(0, requiredBytes) + 64 * 1024;

  if (estimate.supported && estimate.quotaBytes > 0 && effectiveNeeded > estimate.availableBytes) {
    const label = assetLabel ? `'${assetLabel}'` : "this file";
    return {
      canFit: false,
      estimate,
      reason: `Not enough browser storage for ${label} (requires ${formatReadableBytes(requiredBytes)}, only ${formatReadableBytes(estimate.availableBytes)} free of ${formatReadableBytes(estimate.quotaBytes)} quota). Remove unused media or old projects first.`,
    };
  }

  return {
    canFit: true,
    estimate,
  };
}

function getIndexedDbFactory(customFactory?: IDBFactory): IDBFactory {
  const factory = customFactory ?? (typeof window !== "undefined" ? window.indexedDB : undefined);
  if (!factory) {
    throw new Error("IndexedDB is not available in this browser environment.");
  }
  return factory;
}

export function openMediaDatabase(customFactory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let factory: IDBFactory;
    try {
      factory = getIndexedDbFactory(customFactory);
    } catch (err) {
      reject(err);
      return;
    }

    const request = factory.open(IDB_MEDIA_DB_NAME, IDB_MEDIA_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_MEDIA_STORE_NAME)) {
        db.createObjectStore(IDB_MEDIA_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Failed to open IndexedDB local media storage."));
  });
}

export async function saveMediaToIndexedDB(
  record: StoredMediaRecord,
  customFactory?: IDBFactory
): Promise<void> {
  const db = await openMediaDatabase(customFactory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_MEDIA_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_MEDIA_STORE_NAME);
      const putReq = store.put(record);

      putReq.onerror = () => {
        const err = putReq.error;
        if (isQuotaExceededDomError(err)) {
          reject(
            new MediaStorageQuotaError(
              `Browser storage quota exceeded while saving '${record.name}' (${formatReadableBytes(record.sizeBytes)}). Delete unused projects or media files to free IndexedDB space.`,
              record.sizeBytes
            )
          );
          return;
        }
        reject(err || new Error(`Failed to store '${record.name}' in IndexedDB.`));
      };

      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const err = tx.error;
        if (isQuotaExceededDomError(err)) {
          reject(
            new MediaStorageQuotaError(
              `Browser storage quota exceeded while saving '${record.name}' (${formatReadableBytes(record.sizeBytes)}). Delete unused projects or media files to free IndexedDB space.`,
              record.sizeBytes
            )
          );
          return;
        }
        reject(err || new Error(`IndexedDB transaction aborted for '${record.name}'.`));
      };
      tx.onerror = () => {
        const err = tx.error;
        if (isQuotaExceededDomError(err)) {
          reject(
            new MediaStorageQuotaError(
              `Browser storage quota exceeded while saving '${record.name}'.`,
              record.sizeBytes
            )
          );
          return;
        }
        reject(err || new Error(`IndexedDB transaction error for '${record.name}'.`));
      };
    });
  } finally {
    db.close();
  }
}

export async function getMediaFromIndexedDB(
  assetId: string,
  customFactory?: IDBFactory
): Promise<StoredMediaRecord | null> {
  const db = await openMediaDatabase(customFactory);
  try {
    return await new Promise<StoredMediaRecord | null>((resolve, reject) => {
      const tx = db.transaction(IDB_MEDIA_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_MEDIA_STORE_NAME);
      const req = store.get(assetId);
      req.onsuccess = () => resolve((req.result as StoredMediaRecord | undefined) ?? null);
      req.onerror = () => reject(req.error || new Error(`Failed to read media '${assetId}' from IndexedDB.`));
    });
  } finally {
    db.close();
  }
}

export async function getAllMediaFromIndexedDB(
  customFactory?: IDBFactory
): Promise<StoredMediaRecord[]> {
  const db = await openMediaDatabase(customFactory);
  try {
    return await new Promise<StoredMediaRecord[]>((resolve, reject) => {
      const tx = db.transaction(IDB_MEDIA_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_MEDIA_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? (req.result as StoredMediaRecord[]) : [];
        rows.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
        resolve(rows);
      };
      req.onerror = () => reject(req.error || new Error("Failed to read stored media from IndexedDB."));
    });
  } finally {
    db.close();
  }
}

export async function deleteMediaFromIndexedDB(
  assetId: string,
  customFactory?: IDBFactory
): Promise<void> {
  const db = await openMediaDatabase(customFactory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_MEDIA_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_MEDIA_STORE_NAME);
      const req = store.delete(assetId);
      req.onerror = () => reject(req.error || new Error(`Failed to delete media '${assetId}' from IndexedDB.`));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error(`Delete aborted for '${assetId}'.`));
    });
  } finally {
    db.close();
  }
}

export function hydrateAssetFromStoredRecord(record: StoredMediaRecord): MediaAsset {
  const mimeType = record.mimeType || record.blob.type || "application/octet-stream";
  const objectUrl = URL.createObjectURL(record.blob);
  const sourceFile =
    record.blob instanceof File
      ? record.blob
      : new File([record.blob], record.name, {
          type: mimeType,
          lastModified: Date.parse(record.updatedAt || record.addedAt) || Date.now(),
        });

  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    mimeType,
    sizeBytes: record.sizeBytes || record.blob.size,
    duration: record.duration,
    width: record.width,
    height: record.height,
    objectUrl,
    thumbnailUrl: record.thumbnailDataUrl || (record.kind === "image" ? objectUrl : undefined),
    sourceFile,
    addedAt: record.addedAt,
  };
}

/**
 * Returns all project objects that reference the specified media asset ID on any timeline clip.
 */
export function findProjectsUsingAsset(assetId: string, projects: Project[]): Project[] {
  return projects.filter((project) => project.clips.some((clip) => clip.assetId === assetId));
}

/**
 * Given asset IDs associated with a deleted project (or cleanup pass) and the remaining projects,
 * returns only the asset IDs that are no longer referenced by any remaining project.
 */
export function findOrphanedAssetIds(
  candidateAssetIds: string[],
  remainingProjects: Project[]
): string[] {
  const activeAssetIds = new Set<string>();
  for (const project of remainingProjects) {
    for (const clip of project.clips) {
      if (clip.kind !== "text" && clip.assetId) {
        activeAssetIds.add(clip.assetId);
      }
    }
  }

  const seen = new Set<string>();
  const orphaned: string[] = [];
  for (const assetId of candidateAssetIds) {
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    if (!activeAssetIds.has(assetId)) {
      orphaned.push(assetId);
    }
  }
  return orphaned;
}

/**
 * Reconciles timeline clips in a project with restored/active IndexedDB MediaAssets,
 * regenerating object URLs and thumbnails without losing clip edits, trims, or subtitles.
 */
export function reconcileProjectWithMediaAssets(
  project: Project,
  assetsById: Map<string, MediaAsset>,
  isStorageReady: boolean
): Project {
  let anyClipChanged = false;
  const nextClips = project.clips.map((clip) => {
    if (clip.kind === "text") {
      if (clip.needsRelink || clip.objectUrl) {
        anyClipChanged = true;
        return { ...clip, objectUrl: "", needsRelink: false };
      }
      return clip;
    }

    const asset = assetsById.get(clip.assetId);
    if (asset) {
      const nextThumb = asset.thumbnailUrl ?? clip.thumbnailUrl;
      const nextName = clip.sourceName || asset.name;
      const nextSize = clip.sourceSizeBytes ?? asset.sizeBytes;
      const nextMime = clip.sourceMimeType || asset.mimeType;

      if (
        clip.objectUrl !== asset.objectUrl ||
        clip.needsRelink ||
        clip.thumbnailUrl !== nextThumb ||
        clip.sourceName !== nextName ||
        clip.sourceSizeBytes !== nextSize ||
        clip.sourceMimeType !== nextMime
      ) {
        anyClipChanged = true;
        return {
          ...clip,
          objectUrl: asset.objectUrl,
          thumbnailUrl: nextThumb,
          sourceName: nextName,
          sourceSizeBytes: nextSize,
          sourceMimeType: nextMime,
          needsRelink: false,
        };
      }
      return clip;
    }

    // Asset missing from IndexedDB
    const shouldFlagMissing = isStorageReady;
    if (clip.objectUrl !== "" || clip.needsRelink !== shouldFlagMissing) {
      anyClipChanged = true;
      return {
        ...clip,
        objectUrl: "",
        needsRelink: shouldFlagMissing,
      };
    }
    return clip;
  });

  if (!anyClipChanged) {
    return project;
  }

  return {
    ...project,
    clips: nextClips,
  };
}

export function reconcileProjectsWithMediaAssets(
  projects: Project[],
  assets: MediaAsset[],
  isStorageReady: boolean
): Project[] {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  let anyProjectChanged = false;

  const nextProjects = projects.map((proj) => {
    const updated = reconcileProjectWithMediaAssets(proj, assetsById, isStorageReady);
    if (updated !== proj) {
      anyProjectChanged = true;
    }
    return updated;
  });

  return anyProjectChanged ? nextProjects : projects;
}
