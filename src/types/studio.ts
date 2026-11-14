export type AppRoute =
  | "landing"
  | "dashboard"
  | "editor"
  | "generator"
  | "media"
  | "projects"
  | "exports"
  | "auth"
  | "settings";

export type MediaKind = "video" | "image" | "audio" | "text";

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  duration: number; // seconds (images/text default to 5s when placed on timeline)
  width?: number;
  height?: number;
  objectUrl: string;
  thumbnailUrl?: string;
  sourceFile?: File;
  addedAt: string;
}

export type TrackType = "video" | "overlay" | "text" | "audio";

export interface TimelineTrack {
  id: string;
  name: string;
  type: TrackType;
  muted: boolean;
  locked: boolean;
}

export interface TextOverlayStyle {
  text: string;
  fontSize: number;
  color: string;
  backgroundColor: string;
  backgroundOpacity: number;
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  align: "left" | "center" | "right";
}

export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  name: string;
  kind: MediaKind;
  startTime: number; // position on timeline in seconds
  duration: number; // length on timeline in seconds
  inPoint: number; // offset inside source media in seconds
  sourceDuration: number;
  volume: number; // 0 to 1
  speed: number; // 0.5 to 2
  opacity: number; // 0 to 1
  thumbnailUrl?: string;
  objectUrl: string;
  sourceName?: string;
  sourceSizeBytes?: number;
  sourceMimeType?: string;
  needsRelink?: boolean;
  textStyle?: TextOverlayStyle;
}

export type AspectRatioOption = "16:9" | "9:16" | "1:1";
export type ResolutionOption = "1080p" | "4K" | "720p";

export interface Project {
  id: string;
  name: string;
  description: string;
  aspectRatio: AspectRatioOption;
  resolution: ResolutionOption;
  fps: 24 | 30 | 60;
  updatedAt: string;
  createdAt: string;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

export interface RenderTimelineClipSpec {
  id: string;
  trackId: string;
  kind: MediaKind;
  sourceName: string;
  sourceMimeType: string;
  timelineStartSec: number;
  timelineEndSec: number;
  durationSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  speed: number;
  volume: number;
  opacity: number;
  fileIndex?: number;
  textStyle?: TextOverlayStyle;
}

export interface RenderTimelinePayload {
  schemaVersion: "1.0";
  exportedAt: string;
  project: {
    id: string;
    name: string;
    aspectRatio: AspectRatioOption;
    resolution: ResolutionOption;
    width: number;
    height: number;
    fps: 24 | 30 | 60;
    durationSeconds: number;
  };
  tracks: TimelineTrack[];
  clips: RenderTimelineClipSpec[];
}

export interface ExportAttempt {
  id: string;
  projectId: string;
  projectName: string;
  resolution: string;
  format: "mp4" | "webm" | "mov";
  fps: number;
  clipCount: number;
  totalDuration: number;
  status: "completed" | "failed" | "integration_required";
  message: string;
  requestedAt: string;
  timelineSnapshotJson: string;
  outputFilename?: string;
  outputSizeBytes?: number;
}

export interface IntegrationStatusItem {
  id: string;
  label: string;
  connected: boolean;
  provider: string;
  endpoint: string;
  summary: string;
}

export type IntegrationStatusMap = Record<string, IntegrationStatusItem>;

export interface SessionUser {
  displayName: string;
  email: string;
  workspaceName: string;
  mode: "local_session";
  defaultFps: 24 | 30 | 60;
  defaultResolution: ResolutionOption;
}
