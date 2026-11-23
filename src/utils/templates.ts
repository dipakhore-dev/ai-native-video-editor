import type {
  AspectRatioOption,
  ClipKeyframe,
  Project,
  ProjectTemplateId,
  ResolutionOption,
  TimelineClip,
} from "../types/studio";
import { DEFAULT_SUBTITLE_STYLE } from "./subtitles";
import { createDefaultTracks } from "./timeline";

export interface ProjectTemplateDefinition {
  id: ProjectTemplateId;
  title: string;
  subtitle: string;
  description: string;
  aspectRatio: AspectRatioOption;
  resolution: ResolutionOption;
  fps: 24 | 30 | 60;
  estimatedDurationSec: number;
  accentGradient: string;
  buildStarterClips: (idPrefix: string) => TimelineClip[];
}

function makeTextClip(params: {
  id: string;
  name: string;
  startTime: number;
  duration: number;
  text: string;
  fontSize: number;
  color?: string;
  backgroundColor?: string;
  backgroundOpacity?: number;
  x?: number;
  y?: number;
  align?: "left" | "center" | "right";
  opacity?: number;
  keyframes?: ClipKeyframe[];
}): TimelineClip {
  return {
    id: params.id,
    assetId: `text_${params.id}`,
    trackId: "track_t1",
    name: params.name,
    kind: "text",
    startTime: params.startTime,
    duration: params.duration,
    inPoint: 0,
    sourceDuration: params.duration,
    volume: 1,
    muted: false,
    speed: 1,
    opacity: params.opacity ?? 1,
    needsRelink: false,
    objectUrl: "",
    keyframes: params.keyframes,
    textStyle: {
      text: params.text,
      fontSize: params.fontSize,
      color: params.color ?? "#FFFFFF",
      backgroundColor: params.backgroundColor ?? "#09090B",
      backgroundOpacity: params.backgroundOpacity ?? 0.65,
      x: params.x ?? 50,
      y: params.y ?? 50,
      align: params.align ?? "center",
    },
  };
}

export const PROJECT_TEMPLATES: readonly ProjectTemplateDefinition[] = [
  {
    id: "youtube-landscape",
    title: "YouTube Landscape",
    subtitle: "16:9 · 1080p · 30fps",
    description:
      "Widescreen starter with animated title opener, lower-third speaker label, and closing call-to-action.",
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    estimatedDurationSec: 12,
    accentGradient: "from-violet-600/30 via-blue-600/20 to-zinc-900",
    buildStarterClips: (prefix) => [
      makeTextClip({
        id: `${prefix}_yt_intro`,
        name: "Intro Title Card",
        startTime: 0,
        duration: 4,
        text: "YOUR VIDEO TITLE",
        fontSize: 52,
        color: "#FFFFFF",
        backgroundColor: "#0F172A",
        backgroundOpacity: 0.72,
        x: 50,
        y: 46,
        align: "center",
        keyframes: [
          { id: `${prefix}_kf1`, timeSec: 0, property: "opacity", value: 0, easing: "ease-out" },
          { id: `${prefix}_kf2`, timeSec: 0.5, property: "opacity", value: 1, easing: "linear" },
          { id: `${prefix}_kf3`, timeSec: 3.4, property: "opacity", value: 1, easing: "ease-in" },
          { id: `${prefix}_kf4`, timeSec: 4, property: "opacity", value: 0, easing: "linear" },
          { id: `${prefix}_kf5`, timeSec: 0, property: "scale", value: 0.9, easing: "ease-out" },
          { id: `${prefix}_kf6`, timeSec: 0.6, property: "scale", value: 1, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_yt_lower`,
        name: "Lower Third Callout",
        startTime: 4.2,
        duration: 4,
        text: "Speaker Name · Chapter 01",
        fontSize: 28,
        color: "#F8FAFC",
        backgroundColor: "#1E1B4B",
        backgroundOpacity: 0.8,
        x: 28,
        y: 82,
        align: "left",
        keyframes: [
          { id: `${prefix}_kf7`, timeSec: 0, property: "opacity", value: 0, easing: "ease-out" },
          { id: `${prefix}_kf8`, timeSec: 0.4, property: "opacity", value: 1, easing: "linear" },
          { id: `${prefix}_kf9`, timeSec: 0, property: "x", value: 20, easing: "ease-out" },
          { id: `${prefix}_kf10`, timeSec: 0.45, property: "x", value: 28, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_yt_cta`,
        name: "End Screen CTA",
        startTime: 8.5,
        duration: 3.5,
        text: "Thanks for Watching · Subscribe",
        fontSize: 38,
        color: "#FFFFFF",
        backgroundColor: "#09090B",
        backgroundOpacity: 0.7,
        x: 50,
        y: 50,
        align: "center",
        keyframes: [
          { id: `${prefix}_kf11`, timeSec: 0, property: "opacity", value: 0, easing: "ease-out" },
          { id: `${prefix}_kf12`, timeSec: 0.4, property: "opacity", value: 1, easing: "linear" },
        ],
      }),
    ],
  },
  {
    id: "instagram-reels",
    title: "Instagram Reels / Shorts",
    subtitle: "9:16 · 1080p · 30fps",
    description:
      "Vertical mobile starter with safe-zone hook headline, mid-clip prompt, and animated follow footer.",
    aspectRatio: "9:16",
    resolution: "1080p",
    fps: 30,
    estimatedDurationSec: 9.5,
    accentGradient: "from-fuchsia-600/30 via-violet-600/20 to-zinc-900",
    buildStarterClips: (prefix) => [
      makeTextClip({
        id: `${prefix}_reel_hook`,
        name: "Vertical Hook",
        startTime: 0,
        duration: 3,
        text: "3 QUICK EDIT TIPS",
        fontSize: 44,
        color: "#FFFFFF",
        backgroundColor: "#3B0764",
        backgroundOpacity: 0.78,
        x: 50,
        y: 26,
        align: "center",
        keyframes: [
          { id: `${prefix}_rk1`, timeSec: 0, property: "y", value: 32, easing: "ease-out" },
          { id: `${prefix}_rk2`, timeSec: 0.4, property: "y", value: 26, easing: "linear" },
          { id: `${prefix}_rk3`, timeSec: 0, property: "scale", value: 0.88, easing: "ease-out" },
          { id: `${prefix}_rk4`, timeSec: 0.4, property: "scale", value: 1, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_reel_body`,
        name: "Topic Caption",
        startTime: 3.2,
        duration: 3.3,
        text: "Drop your footage onto V1",
        fontSize: 32,
        color: "#F4F4F5",
        backgroundColor: "#09090B",
        backgroundOpacity: 0.72,
        x: 50,
        y: 52,
        align: "center",
        keyframes: [
          { id: `${prefix}_rk5`, timeSec: 0, property: "opacity", value: 0, easing: "ease-out" },
          { id: `${prefix}_rk6`, timeSec: 0.35, property: "opacity", value: 1, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_reel_cta`,
        name: "Follow Prompt",
        startTime: 6.7,
        duration: 2.8,
        text: "Save & Follow for Part 2",
        fontSize: 34,
        color: "#FFFFFF",
        backgroundColor: "#1D4ED8",
        backgroundOpacity: 0.75,
        x: 50,
        y: 74,
        align: "center",
      }),
    ],
  },
  {
    id: "square-social",
    title: "Square Social Video",
    subtitle: "1:1 · 1080p · 30fps",
    description:
      "Square feed starter built for product highlights with headline bar, feature callout, and closing tag.",
    aspectRatio: "1:1",
    resolution: "1080p",
    fps: 30,
    estimatedDurationSec: 10,
    accentGradient: "from-emerald-600/25 via-cyan-600/20 to-zinc-900",
    buildStarterClips: (prefix) => [
      makeTextClip({
        id: `${prefix}_sq_head`,
        name: "Headline Strip",
        startTime: 0,
        duration: 3.5,
        text: "PRODUCT SPOTLIGHT",
        fontSize: 42,
        color: "#FFFFFF",
        backgroundColor: "#064E3B",
        backgroundOpacity: 0.78,
        x: 50,
        y: 22,
        align: "center",
        keyframes: [
          { id: `${prefix}_sq1`, timeSec: 0, property: "opacity", value: 0, easing: "ease-out" },
          { id: `${prefix}_sq2`, timeSec: 0.45, property: "opacity", value: 1, easing: "linear" },
          { id: `${prefix}_sq3`, timeSec: 0, property: "scale", value: 0.92, easing: "ease-out" },
          { id: `${prefix}_sq4`, timeSec: 0.45, property: "scale", value: 1, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_sq_feat`,
        name: "Feature Callout",
        startTime: 3.7,
        duration: 3.6,
        text: "Built to Share · Ready in Minutes",
        fontSize: 30,
        color: "#ECFEFF",
        backgroundColor: "#0F172A",
        backgroundOpacity: 0.75,
        x: 50,
        y: 50,
        align: "center",
        keyframes: [
          { id: `${prefix}_sq5`, timeSec: 0, property: "x", value: 40, easing: "ease-out" },
          { id: `${prefix}_sq6`, timeSec: 0.4, property: "x", value: 50, easing: "linear" },
        ],
      }),
      makeTextClip({
        id: `${prefix}_sq_close`,
        name: "Closing Tag",
        startTime: 7.5,
        duration: 2.5,
        text: "Learn More Below",
        fontSize: 34,
        color: "#FFFFFF",
        backgroundColor: "#09090B",
        backgroundOpacity: 0.7,
        x: 50,
        y: 80,
        align: "center",
      }),
    ],
  },
];

export function getProjectTemplateById(
  templateId: ProjectTemplateId
): ProjectTemplateDefinition | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === templateId);
}

export function createProjectFromTemplate(
  templateId: ProjectTemplateId,
  overrides?: {
    name?: string;
    description?: string;
    resolution?: ResolutionOption;
    fps?: 24 | 30 | 60;
  }
): Project {
  const template = getProjectTemplateById(templateId);
  if (!template) {
    throw new Error(`Unknown project template '${templateId}'.`);
  }

  const now = new Date().toISOString();
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const projectId = `proj_${uniqueSuffix}`;
  const clipPrefix = `tpl_${uniqueSuffix}`;

  return {
    id: projectId,
    name: overrides?.name?.trim() || `${template.title} Cut`,
    description: overrides?.description?.trim() ?? template.description,
    aspectRatio: template.aspectRatio,
    resolution: overrides?.resolution ?? template.resolution,
    fps: overrides?.fps ?? template.fps,
    createdAt: now,
    updatedAt: now,
    tracks: createDefaultTracks(),
    clips: template.buildStarterClips(clipPrefix),
    subtitles: [],
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
  };
}
