import type {
  IntegrationStatusMap,
  Project,
  RenderTimelinePayload,
  SubtitleMetadata,
  SubtitleSegment,
  SubtitleStyle,
  TimelineClip,
} from "../types/studio";
import { AiEditPlanSchema, type AiEditPlan } from "../utils/aiOperations";
import { clampClipRotation, sortAndDedupeKeyframes } from "../utils/keyframes";
import { createDefaultTracks, ensureProjectTracks } from "../utils/timeline";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  integrationPoint?: string;
  cancelled?: boolean;
  jobId?: string;
}

let sessionExpiredHandler: (() => void) | null = null;

export function registerSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

function shouldTriggerSessionExpired(url: string, status: number): boolean {
  if (status !== 401) return false;
  return (
    !url.startsWith("/api/auth/me") &&
    !url.startsWith("/api/auth/login") &&
    !url.startsWith("/api/auth/register")
  );
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "AIStudioClient",
        ...(options?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (shouldTriggerSessionExpired(url, res.status)) {
        sessionExpiredHandler?.();
      }
      return {
        ok: false,
        status: res.status,
        data: body as T,
        error: body.error || body.message || `Request failed (${res.status})`,
        integrationPoint: body.integrationPoint,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: body as T,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Network error reaching server.",
    };
  }
}

export async function fetchIntegrationStatus(): Promise<
  ApiResult<{ integrations: IntegrationStatusMap; checkedAt: string }>
> {
  return requestJson("/api/integrations/status");
}

export interface VideoProcessorStatusResponse {
  status: string;
  processor: {
    configured: boolean;
    reachable: boolean;
    status: "ok" | "degraded" | "unreachable";
    ffmpegAvailable: boolean;
    ffprobeAvailable: boolean;
    fasterWhisperAvailable: boolean;
    hardwareEncoders?: string[];
    recommendedEncoder?: string;
    encoderCapabilities?: Record<string, { available: boolean; label: string; detail: string }>;
    exportProfiles?: Record<string, { id: string; label: string; resolution: string; description?: string }>;
    error: string | null;
  };
  capabilities: {
    exportMp4: boolean;
    localSubtitles: boolean;
    hardwareEncoding?: boolean;
    hardwareEncoders?: string[];
    recommendedEncoder?: string;
    encoderCapabilities?: Record<string, { available: boolean; label: string; detail: string }>;
    exportProfiles?: Record<string, { id: string; label: string; resolution: string; description?: string }>;
  };
}

export async function fetchVideoProcessorStatus(): Promise<
  ApiResult<VideoProcessorStatusResponse>
> {
  return requestJson("/api/video/status");
}

export interface TimelineMetadataPayload {
  projectId: string;
  projectName: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: string;
  fps: number;
  durationSeconds: number;
  selectedClipId: string | null;
  playheadTime: number;
  clips: Array<{
    id: string;
    name: string;
    kind: string;
    trackId: string;
    startTime: number;
    duration: number;
    inPoint: number;
    sourceDuration: number;
    speed: number;
    volume: number;
    opacity?: number;
    rotation?: number;
    keyframes?: Array<{
      id: string;
      timeSec: number;
      property: string;
      value: number;
      easing: string;
    }>;
    effects?: Record<string, unknown>;
    transitionIn?: Record<string, unknown>;
    transitionOut?: Record<string, unknown>;
    overlayTransform?: Record<string, unknown>;
    text?: string;
  }>;
}

export async function requestAiAssistant(payload: {
  prompt: string;
  timelineMetadata: TimelineMetadataPayload;
}): Promise<ApiResult<{ status: string; model?: string; plan?: AiEditPlan }>> {
  const res = await requestJson<{ status: string; model?: string; plan?: unknown }>(
    "/api/ai/assistant",
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok || !res.data?.plan) {
    return {
      ok: res.ok,
      status: res.status,
      error: res.error,
      integrationPoint: res.integrationPoint,
    };
  }

  const parsed = AiEditPlanSchema.safeParse(res.data.plan);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      error: "Server returned an editing plan that failed schema validation.",
    };
  }

  return {
    ok: true,
    status: res.status,
    data: {
      status: res.data.status,
      model: res.data.model,
      plan: parsed.data,
    },
  };
}

export async function submitVideoGenerationRequest(payload: {
  mode: "text-to-video" | "image-to-video";
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
  durationSeconds: number;
  cameraMotion: string;
  hasReferenceImage: boolean;
}): Promise<
  ApiResult<{
    status: string;
    integrationPoint: string;
    message: string;
    validatedRequest?: Record<string, unknown>;
  }>
> {
  return requestJson("/api/ai/generate-video", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function submitExportJob(payload: {
  projectId: string;
  projectName: string;
  resolution: string;
  format: "mp4" | "webm" | "mov";
  fps: number;
  clipCount: number;
  totalDuration: number;
  timelineSpec?: RenderTimelinePayload;
}): Promise<
  ApiResult<{
    status: string;
    integrationPoint: string;
    message: string;
  }>
> {
  return requestJson("/api/exports", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface ExportMp4BinaryResult {
  blob: Blob;
  filename: string;
  sizeBytes: number;
  jobId: string;
  exportProfile?: string;
  encoderUsed?: string;
  hardwareFallbackUsed?: boolean;
}

export interface ExportProgressSnapshot {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  stage: string;
  stageLabel: string;
  progress: number;
  measurable: boolean;
  elapsedMs: number;
  cancelled: boolean;
  error: string | null;
}

export function exportTimelineMp4(
  formData: FormData,
  options?: {
    clientJobId?: string;
    onUploadProgress?: (pct: number | null) => void;
    onUploadComplete?: () => void;
    signal?: AbortSignal;
  }
): Promise<ApiResult<ExportMp4BinaryResult>> {
  return new Promise((resolve) => {
    if (options?.signal?.aborted) {
      resolve({
        ok: false,
        status: 499,
        cancelled: true,
        error: "Export cancelled by user.",
      });
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video/export-mp4");
    xhr.withCredentials = true;
    xhr.responseType = "blob";
    xhr.setRequestHeader("X-Requested-With", "AIStudioClient");
    if (options?.clientJobId) {
      xhr.setRequestHeader("X-Export-Job-Id", options.clientJobId);
    }

    let settled = false;
    const finish = (result: ApiResult<ExportMp4BinaryResult>) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbortSignal);
      resolve(result);
    };

    const onAbortSignal = () => {
      try {
        xhr.abort();
      } catch {
        // Ignore abort errors
      }
      finish({
        ok: false,
        status: 499,
        cancelled: true,
        error: "Export cancelled by user.",
      });
    };

    options?.signal?.addEventListener("abort", onAbortSignal, { once: true });

    xhr.upload.onprogress = (event) => {
      if (options?.signal?.aborted || !options?.onUploadProgress) return;
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        options.onUploadProgress(pct);
      } else {
        options.onUploadProgress(null);
      }
    };

    xhr.upload.onload = () => {
      if (options?.signal?.aborted) return;
      options?.onUploadComplete?.();
    };

    xhr.onabort = () => {
      finish({
        ok: false,
        status: 499,
        cancelled: true,
        error: "Export cancelled by user.",
      });
    };

    xhr.onerror = () => {
      if (options?.signal?.aborted) {
        finish({
          ok: false,
          status: 499,
          cancelled: true,
          error: "Export cancelled by user.",
        });
        return;
      }
      finish({
        ok: false,
        status: 0,
        error: "Network error during MP4 export. Check that the local server is running.",
      });
    };

    xhr.onload = async () => {
      if (options?.signal?.aborted) {
        finish({
          ok: false,
          status: 499,
          cancelled: true,
          error: "Export cancelled by user.",
        });
        return;
      }

      const responseBlob = xhr.response instanceof Blob ? xhr.response : null;

      if (xhr.status < 200 || xhr.status >= 300) {
        let errBody: {
          error?: string;
          message?: string;
          integrationPoint?: string;
          cancelled?: boolean;
          jobId?: string;
        } = {};
        if (responseBlob) {
          try {
            const text = await responseBlob.text();
            errBody = JSON.parse(text) as typeof errBody;
          } catch {
            // Non-JSON error body
          }
        }
        const errJobId = xhr.getResponseHeader("x-video-job-id") || errBody.jobId || undefined;
        const isCancelled =
          xhr.status === 499 ||
          Boolean(errBody.cancelled) ||
          Boolean(options?.signal?.aborted);
        if (xhr.status === 401) {
          sessionExpiredHandler?.();
        }
        finish({
          ok: false,
          status: isCancelled ? 499 : xhr.status,
          cancelled: isCancelled,
          jobId: errJobId,
          error:
            errBody.error ||
            errBody.message ||
            (isCancelled ? "Export cancelled by user." : `MP4 export failed (${xhr.status}).`),
          integrationPoint: errBody.integrationPoint,
        });
        return;
      }

      if (options?.signal?.aborted) {
        finish({
          ok: false,
          status: 499,
          cancelled: true,
          error: "Export cancelled by user.",
        });
        return;
      }

      if (!responseBlob || responseBlob.size === 0) {
        finish({
          ok: false,
          status: 502,
          error: "Server returned an empty MP4 file.",
        });
        return;
      }

      const disposition = xhr.getResponseHeader("content-disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] || "export.mp4";
      const jobId = xhr.getResponseHeader("x-video-job-id") || "";
      const exportProfile = xhr.getResponseHeader("x-export-profile") || undefined;
      const encoderUsed = xhr.getResponseHeader("x-export-encoder") || undefined;
      const hardwareFallbackUsed = xhr.getResponseHeader("x-export-fallback") === "1";

      finish({
        ok: true,
        status: xhr.status,
        data: {
          blob: responseBlob,
          filename,
          sizeBytes: responseBlob.size,
          jobId,
          exportProfile,
          encoderUsed,
          hardwareFallbackUsed,
        },
      });
    };

    xhr.send(formData);
  });
}

export async function fetchExportProgress(
  jobId: string
): Promise<ApiResult<{ status: string; progress: ExportProgressSnapshot }>> {
  return requestJson(`/api/video/export-progress/${encodeURIComponent(jobId)}`);
}

export async function cancelExportMp4(
  jobId: string,
  options?: { keepalive?: boolean; allowPrecreate?: boolean }
): Promise<ApiResult<{ status: string; progress: ExportProgressSnapshot }>> {
  const query = options?.allowPrecreate ? "?allowPrecreate=1" : "";
  return requestJson(`/api/video/export-cancel/${encodeURIComponent(jobId)}${query}`, {
    method: "POST",
    ...(options?.keepalive ? { keepalive: true } : {}),
  });
}

export interface GeneratedSubtitlesResponse {
  status: string;
  mode?: string;
  jobId?: string;
  model: string;
  language: string;
  language_probability: number;
  duration_seconds: number;
  segments: Array<{
    id: number | string;
    start: number;
    end: number;
    text: string;
  }>;
  srt?: string;
  vtt?: string;
}

export async function generateVideoSubtitles(
  formData: FormData
): Promise<ApiResult<GeneratedSubtitlesResponse>> {
  try {
    const res = await fetch("/api/video/subtitles", {
      method: "POST",
      credentials: "include",
      headers: {
        "X-Requested-With": "AIStudioClient",
      },
      body: formData,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<GeneratedSubtitlesResponse> & {
      error?: string;
      message?: string;
      integrationPoint?: string;
    };
    if (!res.ok || !Array.isArray(body.segments)) {
      if (res.status === 401) {
        sessionExpiredHandler?.();
      }
      return {
        ok: false,
        status: res.status,
        error: body.error || body.message || `Subtitle generation failed (${res.status}).`,
        integrationPoint: body.integrationPoint,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: body as GeneratedSubtitlesResponse,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Network error generating subtitles.",
    };
  }
}

export interface AuthUserDto {
  id: string;
  fullName: string;
  email: string;
  workspaceName: string;
  defaultFps: 24 | 30 | 60;
  defaultResolution: "720p" | "1080p" | "4K";
}

export async function fetchCurrentAuthUser(): Promise<
  ApiResult<{ status: string; user?: AuthUserDto }>
> {
  return requestJson("/api/auth/me");
}

export async function submitAuthLogin(payload: {
  email: string;
  password: string;
}): Promise<ApiResult<{ status: string; user?: AuthUserDto; integrationPoint?: string; message?: string }>> {
  return requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function submitAuthRegister(payload: {
  fullName: string;
  email: string;
  password: string;
}): Promise<ApiResult<{ status: string; user?: AuthUserDto; integrationPoint?: string; message?: string }>> {
  return requestJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function submitAuthLogout(): Promise<ApiResult<{ status: string }>> {
  return requestJson("/api/auth/logout", {
    method: "POST",
  });
}

export interface ServerProjectDto {
  _id?: string;
  id?: string;
  name: string;
  description?: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p" | "4K";
  fps: 24 | 30 | 60;
  tracks: Project["tracks"];
  clips: Array<Omit<TimelineClip, "objectUrl" | "needsRelink" | "thumbnailUrl">>;
  subtitles?: SubtitleSegment[];
  subtitleStyle?: SubtitleStyle;
  subtitleMeta?: SubtitleMetadata;
  createdAt: string;
  updatedAt: string;
}

export function mapServerProjectToStudioProject(dto: ServerProjectDto): Project {
  const id = String(dto._id || dto.id || "");
  return {
    id,
    name: dto.name,
    description: dto.description ?? "",
    aspectRatio: dto.aspectRatio ?? "16:9",
    resolution: dto.resolution ?? "1080p",
    fps: dto.fps ?? 24,
    tracks: ensureProjectTracks(dto.tracks?.length ? dto.tracks : createDefaultTracks()),
    clips: (dto.clips ?? []).map((c) => ({
      ...c,
      volume: Number.isFinite(Number(c.volume)) ? Math.min(2, Math.max(0, Number(c.volume))) : 1,
      muted: Boolean(c.muted),
      fadeInSec: Number.isFinite(Number(c.fadeInSec)) ? Math.max(0, Number(c.fadeInSec)) : 0,
      fadeOutSec: Number.isFinite(Number(c.fadeOutSec)) ? Math.max(0, Number(c.fadeOutSec)) : 0,
      ...(c.kind === "audio"
        ? {
            duckingEnabled: Boolean(c.duckingEnabled),
            duckingAmount: Number.isFinite(Number(c.duckingAmount))
              ? Math.min(0.95, Math.max(0, Number(c.duckingAmount)))
              : 0.6,
          }
        : {}),
      ...(c.transitionIn ? { transitionIn: { ...c.transitionIn } } : {}),
      ...(c.transitionOut ? { transitionOut: { ...c.transitionOut } } : {}),
      ...(c.effects ? { effects: { ...c.effects } } : {}),
      ...(c.overlayTransform ? { overlayTransform: { ...c.overlayTransform } } : {}),
      ...(Number.isFinite(Number(c.rotation)) && Math.abs(Number(c.rotation)) > 0.05
        ? { rotation: clampClipRotation(Number(c.rotation), 0) }
        : {}),
      ...(Array.isArray(c.keyframes) && c.keyframes.length > 0
        ? { keyframes: sortAndDedupeKeyframes(c.keyframes, c.duration) }
        : {}),
      ...(c.sourceWidth ? { sourceWidth: c.sourceWidth } : {}),
      ...(c.sourceHeight ? { sourceHeight: c.sourceHeight } : {}),
      objectUrl: "",
      needsRelink: c.kind !== "text",
    })),
    subtitles: dto.subtitles ?? [],
    subtitleStyle: dto.subtitleStyle,
    subtitleMeta: dto.subtitleMeta,
    createdAt: dto.createdAt || new Date().toISOString(),
    updatedAt: dto.updatedAt || new Date().toISOString(),
  };
}

export function serializeClipForServer(clip: TimelineClip) {
  const normalizedKeyframes =
    clip.keyframes && clip.keyframes.length > 0
      ? sortAndDedupeKeyframes(clip.keyframes, Math.max(0.1, Number(clip.duration.toFixed(2))))
      : undefined;
  const clampedRotation = clampClipRotation(clip.rotation, 0);

  return {
    id: clip.id,
    assetId: clip.assetId,
    trackId: clip.trackId,
    name: clip.name,
    kind: clip.kind,
    startTime: Math.max(0, Number(clip.startTime.toFixed(2))),
    duration: Math.max(0.1, Number(clip.duration.toFixed(2))),
    inPoint: Math.max(0, Number(clip.inPoint.toFixed(2))),
    sourceDuration: Math.max(0, Number(clip.sourceDuration.toFixed(2))),
    volume: Math.min(2, Math.max(0, Number(clip.volume.toFixed(3)))),
    muted: Boolean(clip.muted),
    fadeInSec: Math.min(30, Math.max(0, Number((clip.fadeInSec ?? 0).toFixed(2)))),
    fadeOutSec: Math.min(30, Math.max(0, Number((clip.fadeOutSec ?? 0).toFixed(2)))),
    ...(clip.kind === "audio"
      ? {
          duckingEnabled: Boolean(clip.duckingEnabled),
          duckingAmount: Math.min(0.95, Math.max(0, Number((clip.duckingAmount ?? 0.6).toFixed(2)))),
        }
      : {}),
    speed: Math.min(2, Math.max(0.5, Number(clip.speed.toFixed(2)))),
    opacity: Math.min(1, Math.max(0, Number(clip.opacity.toFixed(3)))),
    ...(Math.abs(clampedRotation) > 0.05 ? { rotation: clampedRotation } : {}),
    ...(normalizedKeyframes && normalizedKeyframes.length > 0
      ? { keyframes: normalizedKeyframes }
      : {}),
    ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {}),
    ...(clip.transitionOut ? { transitionOut: clip.transitionOut } : {}),
    ...(clip.effects ? { effects: clip.effects } : {}),
    ...(clip.overlayTransform ? { overlayTransform: clip.overlayTransform } : {}),
    ...(clip.sourceWidth ? { sourceWidth: clip.sourceWidth } : {}),
    ...(clip.sourceHeight ? { sourceHeight: clip.sourceHeight } : {}),
    ...(clip.sourceName ? { sourceName: clip.sourceName } : {}),
    ...(clip.sourceSizeBytes !== undefined ? { sourceSizeBytes: clip.sourceSizeBytes } : {}),
    ...(clip.sourceMimeType ? { sourceMimeType: clip.sourceMimeType } : {}),
    ...(clip.textStyle ? { textStyle: clip.textStyle } : {}),
  };
}

function sanitizeSubtitleForServer(cue: SubtitleSegment): SubtitleSegment | null {
  const trimmed = cue.text.trim();
  if (!trimmed || cue.end <= cue.start || cue.start < 0) return null;
  return {
    id: cue.id,
    start: Number(cue.start.toFixed(2)),
    end: Number(cue.end.toFixed(2)),
    text: trimmed.slice(0, 500),
    ...(cue.clipId ? { clipId: cue.clipId } : {}),
  };
}

export async function fetchServerProjects(): Promise<
  ApiResult<{ status: string; projects: ServerProjectDto[] }>
> {
  return requestJson("/api/projects");
}

export async function createServerProject(
  project: Project
): Promise<ApiResult<{ status: string; project: ServerProjectDto }>> {
  const cleanSubtitles = (project.subtitles ?? [])
    .map(sanitizeSubtitleForServer)
    .filter((s): s is SubtitleSegment => s !== null);

  return requestJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: project.name,
      description: project.description || "",
      aspectRatio: project.aspectRatio,
      resolution: project.resolution,
      fps: project.fps,
      tracks: project.tracks,
      clips: project.clips.map(serializeClipForServer),
      subtitles: cleanSubtitles,
      ...(project.subtitleStyle ? { subtitleStyle: project.subtitleStyle } : {}),
      ...(project.subtitleMeta ? { subtitleMeta: project.subtitleMeta } : {}),
    }),
  });
}

export async function updateServerProject(
  projectId: string,
  updates: {
    name?: string;
    description?: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
    resolution?: "720p" | "1080p" | "4K";
    fps?: 24 | 30 | 60;
  }
): Promise<ApiResult<{ status: string; project: ServerProjectDto }>> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteServerProject(
  projectId: string
): Promise<ApiResult<{ status: string; deleted: boolean }>> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export async function duplicateServerProject(
  projectId: string,
  name?: string
): Promise<ApiResult<{ status: string; project: ServerProjectDto }>> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/duplicate`, {
    method: "POST",
    body: JSON.stringify(name ? { name } : {}),
  });
}

export async function saveServerProjectTimeline(
  projectId: string,
  project: Project
): Promise<ApiResult<{ status: string; project: ServerProjectDto }>> {
  const cleanSubtitles = (project.subtitles ?? [])
    .map(sanitizeSubtitleForServer)
    .filter((s): s is SubtitleSegment => s !== null);

  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/timeline`, {
    method: "PUT",
    body: JSON.stringify({
      aspectRatio: project.aspectRatio,
      tracks: project.tracks,
      clips: project.clips.map(serializeClipForServer),
      subtitles: cleanSubtitles,
      ...(project.subtitleStyle ? { subtitleStyle: project.subtitleStyle } : {}),
      ...(project.subtitleMeta ? { subtitleMeta: project.subtitleMeta } : {}),
    }),
  });
}

export async function saveServerProjectSubtitles(
  projectId: string,
  payload: {
    subtitles: SubtitleSegment[];
    subtitleStyle?: SubtitleStyle;
    subtitleMeta?: SubtitleMetadata;
  }
): Promise<ApiResult<{ status: string; project: ServerProjectDto }>> {
  const cleanSubtitles = payload.subtitles
    .map(sanitizeSubtitleForServer)
    .filter((s): s is SubtitleSegment => s !== null);

  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/subtitles`, {
    method: "PUT",
    body: JSON.stringify({
      subtitles: cleanSubtitles,
      ...(payload.subtitleStyle ? { subtitleStyle: payload.subtitleStyle } : {}),
      ...(payload.subtitleMeta ? { subtitleMeta: payload.subtitleMeta } : {}),
    }),
  });
}

export interface ServerMediaAssetDto {
  _id?: string;
  id?: string;
  projectId?: string | null;
  name: string;
  kind: "video" | "image" | "audio";
  mimeType: string;
  sizeBytes: number;
  duration: number;
  width?: number;
  height?: number;
  storageProvider: "local_browser" | "s3" | "gcs";
  storageKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function fetchServerMediaAssets(): Promise<
  ApiResult<{ status: string; assets: ServerMediaAssetDto[] }>
> {
  return requestJson("/api/media");
}

export async function createServerMediaMetadata(payload: {
  projectId?: string | null;
  name: string;
  kind: "video" | "image" | "audio";
  mimeType: string;
  sizeBytes: number;
  duration: number;
  width?: number;
  height?: number;
  storageProvider: "local_browser";
  storageKey: string;
}): Promise<ApiResult<{ status: string; asset: ServerMediaAssetDto }>> {
  return requestJson("/api/media", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteServerMediaMetadata(
  mediaId: string
): Promise<ApiResult<{ status: string; deleted: boolean }>> {
  return requestJson(`/api/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
  });
}

export async function fetchServerVideoJobs(
  operation?: string
): Promise<
  ApiResult<{
    status: string;
    jobs: Array<{
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
    }>;
  }>
> {
  const qs = operation ? `?operation=${encodeURIComponent(operation)}` : "";
  return requestJson(`/api/video/jobs${qs}`);
}

export async function deleteServerVideoJob(
  jobId: string
): Promise<ApiResult<{ status: string; deleted: boolean }>> {
  return requestJson(`/api/video/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

