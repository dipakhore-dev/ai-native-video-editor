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
  waveformPeaks?: number[]; // normalized 0..1 amplitude buckets across source duration
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

export type TransitionType =
  | "none"
  | "fade"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "zoomin";

export interface ClipTransition {
  type: TransitionType;
  durationSec: number; // 0.2 to 2.0
}

export type EffectPreset =
  | "none"
  | "cinematic"
  | "bw"
  | "vintage"
  | "warm"
  | "cool"
  | "vivid";

export interface ClipVisualEffects {
  preset: EffectPreset;
  brightness: number; // -0.5 to 0.5 (default 0)
  contrast: number; // 0.5 to 1.8 (default 1)
  saturation: number; // 0 to 2 (default 1)
  blur: number; // 0 to 10 (default 0)
}

export type OverlayPresetId =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-right"
  | "pip"
  | "watermark"
  | "fullscreen";

export interface OverlayTransform {
  x: number; // 0 to 100 (% horizontal center)
  y: number; // 0 to 100 (% vertical center)
  widthPct: number; // 5 to 100 (% of canvas width)
  heightPct: number; // 5 to 100 (% of canvas height)
  scale: number; // 0.1 to 2.0 (uniform scale multiplier)
  lockAspectRatio: boolean;
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
  volume: number; // 0 to 2 (0% to 200%)
  muted?: boolean;
  fadeInSec?: number; // 0 to 30
  fadeOutSec?: number; // 0 to 30
  duckingEnabled?: boolean;
  duckingAmount?: number; // 0 to 0.95 (fraction attenuated during speech)
  speed: number; // 0.5 to 2
  opacity: number; // 0 to 1
  transitionIn?: ClipTransition;
  transitionOut?: ClipTransition;
  effects?: ClipVisualEffects;
  overlayTransform?: OverlayTransform;
  sourceWidth?: number;
  sourceHeight?: number;
  thumbnailUrl?: string;
  waveformPeaks?: number[];
  objectUrl: string;
  sourceName?: string;
  sourceSizeBytes?: number;
  sourceMimeType?: string;
  needsRelink?: boolean;
  textStyle?: TextOverlayStyle;
}

export type AspectRatioOption = "16:9" | "9:16" | "1:1";
export type ResolutionOption = "1080p" | "4K" | "720p";
export type ExportProfileId = "fast_preview" | "balanced" | "high_quality";
export type HardwareEncodingMode = "auto" | "cpu" | "gpu";

export type SubtitlePosition = "bottom" | "middle" | "top";

export interface SubtitleSegment {
  id: string;
  start: number; // timeline seconds
  end: number; // timeline seconds
  text: string;
  clipId?: string;
}

export interface SubtitleStyle {
  enabled: boolean;
  fontSize: number;
  color: string;
  position: SubtitlePosition;
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface SubtitleMetadata {
  language?: string;
  model?: string;
  generatedAt?: string;
}

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
  subtitles?: SubtitleSegment[];
  subtitleStyle?: SubtitleStyle;
  subtitleMeta?: SubtitleMetadata;
}

export interface SpeechInterval {
  start: number;
  end: number;
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
  muted?: boolean;
  fadeInSec?: number;
  fadeOutSec?: number;
  duckingEnabled?: boolean;
  duckingAmount?: number;
  opacity: number;
  transitionIn?: ClipTransition;
  transitionOut?: ClipTransition;
  effects?: ClipVisualEffects;
  overlayTransform?: OverlayTransform;
  sourceWidth?: number;
  sourceHeight?: number;
  fileIndex?: number;
  textStyle?: TextOverlayStyle;
}

export interface RenderTimelinePayload {
  schemaVersion: "1.0";
  exportedAt: string;
  exportProfile?: ExportProfileId;
  encodingMode?: HardwareEncodingMode;
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
  speechIntervals?: SpeechInterval[];
  burnSubtitles?: boolean;
  subtitles?: SubtitleSegment[];
  subtitleStyle?: SubtitleStyle;
}

export interface ExportAttempt {
  id: string;
  projectId: string;
  projectName: string;
  resolution: string;
  exportProfile?: ExportProfileId;
  encodingMode?: HardwareEncodingMode;
  encoderUsed?: string;
  format: "mp4" | "webm" | "mov";
  fps: number;
  clipCount: number;
  totalDuration: number;
  status: "completed" | "failed" | "cancelled" | "integration_required";
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
  id?: string;
  displayName: string;
  email: string;
  workspaceName: string;
  mode: "local_session" | "authenticated";
  defaultFps: 24 | 30 | 60;
  defaultResolution: ResolutionOption;
}
