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

export type MediaSourceOrigin =
  | "uploaded"
  | "existing_library"
  | "stock"
  | "generated_slide"
  | "generated_voiceover";

export type GeneratedSlideTemplate =
  | "title"
  | "educational"
  | "section_heading"
  | "closing";

export interface GeneratedSlideConfig {
  template: GeneratedSlideTemplate;
  headingText: string;
  bodyText?: string;
  footerText?: string;
  backgroundColor: string;
  gradientColor?: string;
  useGradient?: boolean;
  textColor: string;
  textAlign: "left" | "center" | "right";
  fontSize: number;
  aspectRatio: AspectRatioOption;
  language: StoryboardLanguage;
}

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
  tags?: string[];
  description?: string;
  sourceOrigin?: MediaSourceOrigin;
  providerName?: string;
  providerAssetId?: string;
  sourceUrl?: string;
  creatorName?: string;
  attributionUrl?: string;
  licenseInfo?: string;
  generatedSlideConfig?: GeneratedSlideConfig;
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

export type KeyframeProperty =
  | "x"
  | "y"
  | "scale"
  | "rotation"
  | "opacity"
  | "volume";

export type KeyframeEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "hold";

export interface ClipKeyframe {
  id: string;
  timeSec: number; // relative to clip start (0 .. clip.duration)
  property: KeyframeProperty;
  value: number;
  easing: KeyframeEasing;
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
  rotation?: number; // -360 to 360 degrees
  keyframes?: ClipKeyframe[];
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
  rotation?: number;
  keyframes?: ClipKeyframe[];
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
  clientJobId?: string;
  serverJobId?: string;
  projectId: string;
  projectName: string;
  aspectRatio?: AspectRatioOption;
  resolution: string;
  exportProfile?: ExportProfileId;
  encodingMode?: HardwareEncodingMode;
  encoderUsed?: string;
  format: "mp4" | "webm" | "mov";
  fps: number;
  clipCount: number;
  totalDuration: number;
  exportDurationMs?: number;
  burnSubtitles?: boolean;
  status: "completed" | "failed" | "cancelled" | "integration_required";
  message: string;
  requestedAt: string;
  timelineSnapshotJson: string;
  outputFilename?: string;
  outputSizeBytes?: number;
}

export interface ExportRetryConfig {
  projectId: string;
  format: "mp4" | "webm" | "mov";
  exportProfile?: ExportProfileId;
  encodingMode?: HardwareEncodingMode;
  fps: 24 | 30 | 60;
  burnSubtitles?: boolean;
}

export type ProjectTemplateId = "youtube-landscape" | "instagram-reels" | "square-social";

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

export type VideoGeneratorMode = "prompt-to-video" | "script-to-video" | "image-animation";
export type StoryboardSourceMode = "prompt-to-video" | "script-to-video";
export type StoryboardTargetDuration = 15 | 30 | 60;
export type StoryboardStyle =
  | "Cinematic"
  | "Educational"
  | "Motivational"
  | "Minimal"
  | "Social Media";
export type StoryboardLanguage = "English" | "Hindi" | "Bengali";
export type StoryboardVoiceoverPreference =
  | "none"
  | "natural_narrator"
  | "energetic_host"
  | "calm_explainer";
export type StoryboardCaptionPreference =
  | "none"
  | "clean_subtitles"
  | "bold_social"
  | "minimal_lower";
export type StoryboardMediaType = "video" | "image" | "text_card" | "motion_graphic";
export type StoryboardCameraMotion =
  | "static"
  | "slow-dolly-in"
  | "slow-dolly-out"
  | "pan-left"
  | "pan-right"
  | "aerial-orbit"
  | "handheld-subtle";
export type StoryboardGenerationStatus =
  | "idle"
  | "generating"
  | "ready"
  | "error"
  | "cancelled";

export interface VideoGenerationRequest {
  mode: VideoGeneratorMode;
  title?: string;
  prompt: string;
  targetDurationSec: StoryboardTargetDuration;
  aspectRatio: AspectRatioOption;
  style: StoryboardStyle;
  language: StoryboardLanguage;
  voiceoverEnabled: boolean;
  voiceoverPreference: StoryboardVoiceoverPreference;
  captionsEnabled: boolean;
  captionStyle: StoryboardCaptionPreference;
  targetAudience?: string;
  additionalInstructions?: string;
  requestKey?: string;
}

export interface StoryboardSettings {
  mode: StoryboardSourceMode;
  targetDurationSec: StoryboardTargetDuration;
  aspectRatio: AspectRatioOption;
  style: StoryboardStyle;
  language: StoryboardLanguage;
  voiceoverEnabled: boolean;
  voiceoverPreference: StoryboardVoiceoverPreference;
  captionsEnabled: boolean;
  captionStyle: StoryboardCaptionPreference;
  targetAudience: string;
  additionalInstructions: string;
}

export type SceneAssignedMediaType = "image" | "video" | "generated_slide";
export type SceneMediaSource = "uploaded" | "existing_library" | "stock" | "generated_slide";
export type SceneMediaAssignmentStatus =
  | "unassigned"
  | "matching"
  | "assigned"
  | "missing"
  | "invalid"
  | "failed";
export type AspectRatioHandlingMode = "preserve" | "fit" | "fill";

export interface StoryboardSceneMediaAssignment {
  sceneId: string;
  mediaAssetId: string;
  mediaType: SceneAssignedMediaType;
  mediaSource: SceneMediaSource;
  assetTitle: string;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailRef?: string; // Stable non-blob reference key only; live object URLs come from IndexedDB MediaAsset
  sourceUrl?: string; // External reference/attribution URL only; never a temporary blob URL
  providerName?: string;
  providerAssetId?: string;
  creatorName?: string;
  attributionUrl?: string;
  licenseInfo?: string;
  matchScore?: number;
  matchExplanation?: string;
  assignmentStatus: SceneMediaAssignmentStatus;
  sourceStartTime: number;
  aspectRatioHandling: AspectRatioHandlingMode;
  assignedAt: string;
}

export interface StoryboardMediaSummary {
  totalScenes: number;
  assignedCount: number;
  unassignedCount: number;
  missingOrInvalidCount: number;
  readyCount: number;
  progressPercent: number;
  overallStatus: SceneMediaAssignmentStatus;
  isMediaReady: boolean;
}

export type TtsLanguageCode = "en" | "hi" | "bn";
export type TtsEngineId = "piper" | "espeak_ng" | "windows_sapi";
export type TtsProviderId = "auto" | TtsEngineId | "none";
export type TtsAudioFormat = "wav" | "mp3";

export interface TtsVoiceOption {
  voiceId: string;
  provider: TtsEngineId;
  label: string;
  language: TtsLanguageCode;
  languageTag: string;
  gender?: string | null;
  quality: string;
  sampleRateHz?: number | null;
  description?: string | null;
}

export interface TtsProviderStatus {
  provider: TtsEngineId;
  label: string;
  available: boolean;
  installed: boolean;
  license: string;
  supportedLanguages: TtsLanguageCode[];
  voiceCount: number;
  message: string;
}

export interface TtsStatusInfo {
  enabled: boolean;
  available: boolean;
  configuredProvider: string;
  activeProvider: string | null;
  defaultLanguage: TtsLanguageCode;
  supportedLanguages: TtsLanguageCode[];
  mp3Supported: boolean;
  maxTextChars: number;
  maxAudioMb: number;
  providers: TtsProviderStatus[];
  message: string;
}

export type SceneVoiceoverStatus =
  | "none"
  | "generating"
  | "ready"
  | "stale"
  | "missing"
  | "failed"
  | "skipped_empty";

export interface StoryboardSceneVoiceover {
  sceneId: string;
  mediaAssetId?: string;
  provider: TtsEngineId;
  voiceId: string;
  voiceLabel: string;
  language: TtsLanguageCode;
  speakingRate: number;
  pitch: number;
  volume: number;
  format: TtsAudioFormat;
  mimeType: string;
  durationSeconds: number;
  sizeBytes: number;
  sampleRateHz: number;
  channels: number;
  narrationFingerprint: string;
  generatedAt: string;
  status: SceneVoiceoverStatus;
  errorMessage?: string;
}

export interface StoryboardVoiceoverSettings {
  provider: TtsProviderId;
  voiceId?: string;
  speakingRate: number;
  pitch: number;
  format: TtsAudioFormat;
  volume: number;
}

export interface StoryboardVoiceoverSummary {
  totalScenes: number;
  spokenScenes: number;
  readyCount: number;
  staleCount: number;
  missingCount: number;
  failedCount: number;
  unassignedCount: number;
  overflowCount: number;
  totalAudioDurationSec: number;
  progressPercent: number;
  isVoiceoverReady: boolean;
}

export type CaptionGenerationMode = "script" | "audio";
export type CaptionTimingSource = "estimated" | "audio_transcription" | "manual";
export type SceneCaptionStatus =
  | "none"
  | "queued"
  | "generating"
  | "ready"
  | "stale"
  | "failed"
  | "skipped_empty";
export type CaptionStylePresetId =
  | "classic"
  | "cinematic"
  | "educational"
  | "social_media"
  | "minimal"
  | "yellow_highlight";

export interface CaptionStyleConfig {
  presetId: CaptionStylePresetId;
  enabled: boolean;
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700 | 800;
  color: string;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  outlineWidth: number;
  outlineColor: string;
  position: "top" | "middle" | "bottom";
  alignment: "left" | "center" | "right";
  safeMarginBottomPct: number;
  maxLines: 1 | 2 | 3;
}

export interface StoryboardCaptionWordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface StoryboardCaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  timingSource: CaptionTimingSource;
  words?: StoryboardCaptionWordTimestamp[];
  isManuallyEdited?: boolean;
  confidence?: number;
}

export interface StoryboardSceneCaptions {
  sceneId: string;
  mode: CaptionGenerationMode;
  timingSource: CaptionTimingSource;
  language: TtsLanguageCode;
  status: SceneCaptionStatus;
  segments: StoryboardCaptionSegment[];
  fingerprint: string;
  sourceNarrationSnapshot: string;
  sourceVoiceoverMediaAssetId?: string;
  sourceVoiceoverDurationSec?: number;
  sourceSceneDurationSec?: number;
  model?: string;
  detectedLanguage?: string;
  languageProbability?: number;
  generatedAt: string;
  hasManualEdits?: boolean;
  overflowsSceneDuration?: boolean;
  warnings?: string[];
  errorMessage?: string;
}

export interface StoryboardCaptionSettings {
  enabled: boolean;
  defaultMode: CaptionGenerationMode;
  language: "match_storyboard" | TtsLanguageCode;
  wordTimestamps: boolean;
  style: CaptionStyleConfig;
}

export interface StoryboardCaptionSummary {
  totalScenes: number;
  captionableScenes: number;
  readyCount: number;
  staleCount: number;
  failedCount: number;
  unassignedCount: number;
  manualCount: number;
  overflowCount: number;
  totalCueCount: number;
  estimatedCount: number;
  transcribedCount: number;
  progressPercent: number;
  isCaptionsReady: boolean;
}

export interface CaptionsStatusInfo {
  enabled: boolean;
  defaultMode: CaptionGenerationMode;
  scriptModeAvailable: boolean;
  audioTranscriptionAvailable: boolean;
  fasterWhisperInstalled: boolean;
  localModelReady: boolean;
  localFilesOnly: boolean;
  model: string | null;
  device: string;
  computeType: string;
  maxAudioMb: number;
  maxDurationSec: number;
  maxConcurrentJobs: number;
  maxSegmentsPerScene: number;
  maxBatchScenes: number;
  supportedLanguages: TtsLanguageCode[];
  message: string;
}

export interface StoryboardScene {
  id: string;
  title: string;
  startTime: number;
  duration: number;
  narration: string;
  onScreenText: string;
  visualDescription: string;
  mediaKeywords: string[];
  mediaType: StoryboardMediaType;
  transition: TransitionType;
  effect: EffectPreset;
  cameraMotion: StoryboardCameraMotion;
  mediaAssignment?: StoryboardSceneMediaAssignment;
  voiceover?: StoryboardSceneVoiceover;
  captions?: StoryboardSceneCaptions;
}

export interface VideoStoryboard {
  id: string;
  title: string;
  description: string;
  targetAudience: string;
  language: StoryboardLanguage;
  totalDuration: StoryboardTargetDuration;
  aspectRatio: AspectRatioOption;
  style: StoryboardStyle;
  fullNarrationScript: string;
  backgroundMusicMood: string;
  captionText: string;
  settings: StoryboardSettings;
  scenes: StoryboardScene[];
  sourceMode: StoryboardSourceMode;
  model?: string;
  compositionReady: false;
  mediaReadinessSummary?: StoryboardMediaSummary;
  voiceoverSettings?: StoryboardVoiceoverSettings;
  voiceoverSummary?: StoryboardVoiceoverSummary;
  captionSettings?: StoryboardCaptionSettings;
  captionSummary?: StoryboardCaptionSummary;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardDraftRecord {
  id: string;
  serverDraftId?: string;
  title: string;
  status: "draft" | "validated";
  storyboard: VideoStoryboard;
  savedAt: string;
}

