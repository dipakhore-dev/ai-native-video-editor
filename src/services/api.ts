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
import { createDefaultTracks, ensureProjectTracks } from "../utils/timeline";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  integrationPoint?: string;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
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
}

export async function exportTimelineMp4(
  formData: FormData
): Promise<ApiResult<ExportMp4BinaryResult>> {
  try {
    const res = await fetch("/api/video/export-mp4", {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        integrationPoint?: string;
      };
      return {
        ok: false,
        status: res.status,
        error: errBody.error || errBody.message || `MP4 export failed (${res.status}).`,
        integrationPoint: errBody.integrationPoint,
      };
    }

    const blob = await res.blob();
    if (blob.size === 0) {
      return {
        ok: false,
        status: 502,
        error: "Server returned an empty MP4 file.",
      };
    }

    const disposition = res.headers.get("content-disposition") || "";
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] || "export.mp4";
    const jobId = res.headers.get("x-video-job-id") || "";

    return {
      ok: true,
      status: res.status,
      data: {
        blob,
        filename,
        sizeBytes: blob.size,
        jobId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Network error during MP4 export.",
    };
  }
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
      body: formData,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<GeneratedSubtitlesResponse> & {
      error?: string;
      message?: string;
      integrationPoint?: string;
    };
    if (!res.ok || !Array.isArray(body.segments)) {
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

function serializeClipForServer(clip: TimelineClip) {
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
    speed: Math.min(4, Math.max(0.25, Number(clip.speed.toFixed(2)))),
    opacity: Math.min(1, Math.max(0, Number(clip.opacity.toFixed(3)))),
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

