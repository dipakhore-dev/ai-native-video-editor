import type { AspectRatioOption, ExportAttempt, ExportProfileId, HardwareEncodingMode } from "../types/studio";

export const EXPORT_HISTORY_STORAGE_KEY = "ai_studio_export_history_v1";
export const MAX_PERSISTED_EXPORT_ATTEMPTS = 60;

export const IDB_EXPORT_DB_NAME = "ai_studio_local_exports_db";
export const IDB_EXPORT_STORE_NAME = "export_files";
export const IDB_EXPORT_DB_VERSION = 1;
export const MAX_CACHED_EXPORT_FILES = 5;
export const MAX_CACHED_EXPORT_TOTAL_BYTES = 150 * 1024 * 1024;

export interface StoredExportFileRecord {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  blob: Blob;
  savedAt: string;
}

const inMemoryExportBlobs = new Map<string, Blob>();

function openExportDatabase(customFactory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = customFactory ?? (typeof window !== "undefined" ? window.indexedDB : undefined);
    if (!factory) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const req = factory.open(IDB_EXPORT_DB_NAME, IDB_EXPORT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_EXPORT_STORE_NAME)) {
        db.createObjectStore(IDB_EXPORT_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open local export IndexedDB."));
  });
}

export async function saveExportFileBlob(
  id: string,
  blob: Blob,
  filename: string,
  customFactory?: IDBFactory
): Promise<boolean> {
  if (!id || !blob || blob.size <= 0) return false;
  inMemoryExportBlobs.set(id, blob);

  try {
    const db = await openExportDatabase(customFactory);
    try {
      const existingRows = await new Promise<StoredExportFileRecord[]>((resolve, reject) => {
        const tx = db.transaction(IDB_EXPORT_STORE_NAME, "readonly");
        const req = tx.objectStore(IDB_EXPORT_STORE_NAME).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as StoredExportFileRecord[]) : []);
        req.onerror = () => reject(req.error);
      });

      const sortedOthers = existingRows
        .filter((r) => r.id !== id)
        .sort((a, b) => (a.savedAt || "").localeCompare(b.savedAt || ""));

      let runningBytes = sortedOthers.reduce((s, r) => s + (r.sizeBytes || 0), 0) + blob.size;
      const toEvict: string[] = [];
      while (
        sortedOthers.length - toEvict.length >= MAX_CACHED_EXPORT_FILES ||
        (runningBytes > MAX_CACHED_EXPORT_TOTAL_BYTES && toEvict.length < sortedOthers.length)
      ) {
        const oldest = sortedOthers[toEvict.length];
        if (!oldest) break;
        toEvict.push(oldest.id);
        runningBytes -= oldest.sizeBytes || 0;
      }

      if (blob.size > MAX_CACHED_EXPORT_TOTAL_BYTES) {
        // Keep in memory only for current session if single MP4 exceeds cache budget
        return true;
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_EXPORT_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_EXPORT_STORE_NAME);
        for (const evictId of toEvict) {
          store.delete(evictId);
          inMemoryExportBlobs.delete(evictId);
        }
        const record: StoredExportFileRecord = {
          id,
          filename,
          sizeBytes: blob.size,
          mimeType: blob.type || "video/mp4",
          blob,
          savedAt: new Date().toISOString(),
        };
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error("Export file cache aborted."));
        tx.onerror = () => reject(tx.error || new Error("Export file cache error."));
      });
      return true;
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

export async function getExportFileBlob(
  id: string,
  customFactory?: IDBFactory
): Promise<Blob | null> {
  if (!id) return null;
  const mem = inMemoryExportBlobs.get(id);
  if (mem && mem.size > 0) return mem;

  try {
    const db = await openExportDatabase(customFactory);
    try {
      const record = await new Promise<StoredExportFileRecord | null>((resolve, reject) => {
        const tx = db.transaction(IDB_EXPORT_STORE_NAME, "readonly");
        const req = tx.objectStore(IDB_EXPORT_STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as StoredExportFileRecord | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
      if (record?.blob && record.blob.size > 0) {
        inMemoryExportBlobs.set(id, record.blob);
        return record.blob;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function hasExportFileAvailable(
  id: string,
  customFactory?: IDBFactory
): Promise<boolean> {
  const blob = await getExportFileBlob(id, customFactory);
  return Boolean(blob && blob.size > 0);
}

export async function listAvailableExportFileIds(
  attemptIds: string[],
  customFactory?: IDBFactory
): Promise<Set<string>> {
  const available = new Set<string>();
  const remaining: string[] = [];
  for (const id of attemptIds) {
    const mem = inMemoryExportBlobs.get(id);
    if (mem && mem.size > 0) {
      available.add(id);
    } else {
      remaining.push(id);
    }
  }
  if (remaining.length === 0) return available;

  try {
    const db = await openExportDatabase(customFactory);
    try {
      const rows = await new Promise<StoredExportFileRecord[]>((resolve, reject) => {
        const tx = db.transaction(IDB_EXPORT_STORE_NAME, "readonly");
        const req = tx.objectStore(IDB_EXPORT_STORE_NAME).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as StoredExportFileRecord[]) : []);
        req.onerror = () => reject(req.error);
      });
      const wanted = new Set(remaining);
      for (const row of rows) {
        if (wanted.has(row.id) && row.blob && row.blob.size > 0) {
          inMemoryExportBlobs.set(row.id, row.blob);
          available.add(row.id);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // IndexedDB unavailable; rely strictly on verified in-memory blobs only
  }
  return available;
}

export async function deleteExportFileBlob(
  id: string,
  customFactory?: IDBFactory
): Promise<void> {
  if (!id) return;
  inMemoryExportBlobs.delete(id);
  try {
    const db = await openExportDatabase(customFactory);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_EXPORT_STORE_NAME, "readwrite");
        tx.objectStore(IDB_EXPORT_STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Ignore IDB delete error
  }
}

export function clearInMemoryExportBlobs(): void {
  inMemoryExportBlobs.clear();
}

export function loadPersistedExportAttempts(): ExportAttempt[] {
  try {
    const raw = localStorage.getItem(EXPORT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ExportAttempt => Boolean(item && typeof item === "object" && "id" in item))
      .slice(0, MAX_PERSISTED_EXPORT_ATTEMPTS);
  } catch {
    return [];
  }
}

export function persistExportAttempts(attempts: ExportAttempt[]): void {
  try {
    const trimmed = attempts.slice(0, MAX_PERSISTED_EXPORT_ATTEMPTS).map((item) => ({
      ...item,
      timelineSnapshotJson:
        item.timelineSnapshotJson.length > 64_000
          ? item.timelineSnapshotJson.slice(0, 64_000)
          : item.timelineSnapshotJson,
    }));
    localStorage.setItem(EXPORT_HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore localStorage quota failures cleanly
  }
}

/**
 * Enforces terminal cancellation immutability and deterministic deduplication
 * across clientJobId and serverJobId when recording or merging export history.
 * A cancelled export attempt must never transition to completed/processing or auto-restart.
 */
export function upsertExportAttemptSafely(
  prev: ExportAttempt[],
  incoming: ExportAttempt
): ExportAttempt[] {
  const incomingClientId =
    incoming.clientJobId || (!incoming.id.startsWith("srv_") ? incoming.id : undefined);

  const existingIdx = prev.findIndex((item) => {
    if (item.id === incoming.id) return true;
    if (incoming.serverJobId && item.serverJobId === incoming.serverJobId) return true;
    if (incomingClientId && item.id === incomingClientId) return true;
    if (item.clientJobId && item.clientJobId === incoming.id) return true;
    if (incomingClientId && item.clientJobId && item.clientJobId === incomingClientId) return true;
    return false;
  });

  if (existingIdx === -1) {
    return [incoming, ...prev].slice(0, MAX_PERSISTED_EXPORT_ATTEMPTS);
  }

  const existing = prev[existingIdx];
  // Preserve non-"srv_" local ID so cached IndexedDB MP4 blob lookup key stays intact
  const preservedId = !existing.id.startsWith("srv_")
    ? existing.id
    : incoming.clientJobId || existing.id;

  if (existing.status === "cancelled" && incoming.status !== "cancelled") {
    const patched: ExportAttempt = {
      ...existing,
      id: preservedId,
      serverJobId: incoming.serverJobId ?? existing.serverJobId,
      clientJobId: incomingClientId ?? existing.clientJobId,
    };
    const next = [...prev];
    next[existingIdx] = patched;
    return next;
  }

  const updated: ExportAttempt = {
    ...existing,
    ...incoming,
    id: preservedId,
    serverJobId: incoming.serverJobId ?? existing.serverJobId,
    clientJobId: incomingClientId ?? existing.clientJobId,
    timelineSnapshotJson:
      incoming.timelineSnapshotJson && incoming.timelineSnapshotJson.length > 2
        ? incoming.timelineSnapshotJson
        : existing.timelineSnapshotJson,
    totalDuration: incoming.totalDuration > 0 ? incoming.totalDuration : existing.totalDuration,
    exportDurationMs: incoming.exportDurationMs ?? existing.exportDurationMs,
    encoderUsed: incoming.encoderUsed ?? existing.encoderUsed,
    outputFilename: incoming.outputFilename ?? existing.outputFilename,
    outputSizeBytes: incoming.outputSizeBytes ?? existing.outputSizeBytes,
    status: existing.status === "cancelled" ? "cancelled" : incoming.status,
  };
  const next = [...prev];
  next[existingIdx] = updated;
  return next;
}

export interface ServerVideoJobDto {
  _id?: string;
  id?: string;
  projectId?: string | null;
  operation: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | "integration_required";
  sourceFilename: string;
  sourceSizeBytes?: number;
  inputParams?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
}

export function mapServerVideoJobToExportAttempt(job: ServerVideoJobDto): ExportAttempt | null {
  if (job.operation !== "export_mp4") return null;
  if (job.status === "queued" || job.status === "processing") return null;

  const serverId = String(job._id || job.id || "");
  if (!serverId) return null;

  const input = job.inputParams ?? {};
  const result = job.result ?? {};
  const rawSpec = typeof input.timeline_spec === "string" ? input.timeline_spec : "";
  let parsedSpec: {
    project?: { name?: string; aspectRatio?: AspectRatioOption; durationSeconds?: number };
    clips?: unknown[];
    burnSubtitles?: boolean;
  } = {};
  if (rawSpec) {
    try {
      parsedSpec = JSON.parse(rawSpec) as typeof parsedSpec;
    } catch {
      parsedSpec = {};
    }
  }

  const projectName =
    parsedSpec.project?.name?.trim() ||
    job.sourceFilename.replace(/\s*\(\+\d+\s+more\)$/, "") ||
    "Exported Sequence";

  const startedMs = job.startedAt ? Date.parse(job.startedAt) : NaN;
  const completedMs = job.completedAt ? Date.parse(job.completedAt) : NaN;
  const exportDurationMs =
    typeof result.exportDurationMs === "number"
      ? result.exportDurationMs
      : Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : undefined;

  const rawProfile = String(result.exportProfile || input.export_profile || "");
  const exportProfile: ExportProfileId | undefined =
    rawProfile === "fast_preview" || rawProfile === "balanced" || rawProfile === "high_quality"
      ? rawProfile
      : undefined;

  const rawEncMode = String(input.encoding_mode || "auto");
  const encodingMode: HardwareEncodingMode =
    rawEncMode === "cpu" || rawEncMode === "gpu" ? rawEncMode : "auto";

  const status: ExportAttempt["status"] =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled" ||
    job.status === "integration_required"
      ? job.status
      : "failed";

  const clientJobId =
    typeof input.client_job_id === "string" && input.client_job_id.trim()
      ? input.client_job_id.trim()
      : typeof input.clientJobId === "string" && input.clientJobId.trim()
        ? input.clientJobId.trim()
        : undefined;

  return {
    id: `srv_${serverId}`,
    ...(clientJobId ? { clientJobId } : {}),
    serverJobId: serverId,
    projectId: job.projectId ? String(job.projectId) : "",
    projectName,
    aspectRatio: parsedSpec.project?.aspectRatio,
    resolution: String(input.resolution || "1080p"),
    exportProfile,
    encodingMode,
    encoderUsed: typeof result.encoderUsed === "string" ? result.encoderUsed : undefined,
    format: "mp4",
    fps: Number(input.fps || 24),
    clipCount: Array.isArray(parsedSpec.clips) ? parsedSpec.clips.length : 1,
    totalDuration: Number(parsedSpec.project?.durationSeconds || 0),
    exportDurationMs,
    burnSubtitles: Boolean(parsedSpec.burnSubtitles),
    status,
    message:
      job.errorMessage ||
      (status === "completed"
        ? `Exported ${String(result.outputFilename || "export.mp4")}`
        : status === "cancelled"
          ? "Export cancelled by user."
          : "Export failed."),
    requestedAt: job.createdAt || new Date().toISOString(),
    timelineSnapshotJson: rawSpec || "{}",
    outputFilename: typeof result.outputFilename === "string" ? result.outputFilename : undefined,
    outputSizeBytes:
      typeof result.outputSizeBytes === "number" ? result.outputSizeBytes : undefined,
  };
}

export function canRetryExportAttempt(attempt: ExportAttempt): boolean {
  return attempt.status === "failed" || attempt.status === "integration_required";
}
