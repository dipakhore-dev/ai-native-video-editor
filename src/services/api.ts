import type { IntegrationStatusMap, RenderTimelinePayload } from "../types/studio";
import { AiEditPlanSchema, type AiEditPlan } from "../utils/aiOperations";

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

export interface AuthUserDto {
  id: string;
  fullName: string;
  email: string;
  workspaceName: string;
  defaultFps: 24 | 30 | 60;
  defaultResolution: "720p" | "1080p" | "4K";
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
