import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface ITimelineTrackSubdoc {
  id: string;
  name: string;
  type: "video" | "overlay" | "text" | "audio";
  muted: boolean;
  locked: boolean;
}

export interface ITextOverlayStyleSubdoc {
  text: string;
  fontSize: number;
  color: string;
  backgroundColor: string;
  backgroundOpacity: number;
  x: number;
  y: number;
  align: "left" | "center" | "right";
}

export interface ITimelineClipSubdoc {
  id: string;
  assetId: string;
  trackId: string;
  name: string;
  kind: "video" | "image" | "audio" | "text";
  startTime: number;
  duration: number;
  inPoint: number;
  sourceDuration: number;
  volume: number;
  muted?: boolean;
  fadeInSec?: number;
  fadeOutSec?: number;
  duckingEnabled?: boolean;
  duckingAmount?: number;
  speed: number;
  opacity: number;
  sourceName?: string;
  sourceSizeBytes?: number;
  sourceMimeType?: string;
  textStyle?: ITextOverlayStyleSubdoc;
}

export interface ISubtitleSegmentSubdoc {
  id: string;
  start: number;
  end: number;
  text: string;
  clipId?: string;
}

export interface ISubtitleStyleSubdoc {
  enabled: boolean;
  fontSize: number;
  color: string;
  position: "bottom" | "middle" | "top";
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface ISubtitleMetaSubdoc {
  language?: string;
  model?: string;
  generatedAt?: string;
}

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  description: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p" | "4K";
  fps: 24 | 30 | 60;
  tracks: ITimelineTrackSubdoc[];
  clips: ITimelineClipSubdoc[];
  subtitles?: ISubtitleSegmentSubdoc[];
  subtitleStyle?: ISubtitleStyleSubdoc;
  subtitleMeta?: ISubtitleMetaSubdoc;
  createdAt: Date;
  updatedAt: Date;
}

const TextOverlayStyleSchema = new Schema<ITextOverlayStyleSubdoc>(
  {
    text: { type: String, required: true, maxlength: 200 },
    fontSize: { type: Number, required: true, min: 12, max: 120 },
    color: { type: String, required: true },
    backgroundColor: { type: String, default: "#09090B" },
    backgroundOpacity: { type: Number, default: 0.6, min: 0, max: 1 },
    x: { type: Number, default: 50, min: 0, max: 100 },
    y: { type: Number, default: 80, min: 0, max: 100 },
    align: { type: String, enum: ["left", "center", "right"], default: "center" },
  },
  { _id: false }
);

const TimelineTrackSchema = new Schema<ITimelineTrackSubdoc>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["video", "overlay", "text", "audio"], required: true },
    muted: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
  },
  { _id: false }
);

const TimelineClipSchema = new Schema<ITimelineClipSubdoc>(
  {
    id: { type: String, required: true },
    assetId: { type: String, required: true },
    trackId: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ["video", "image", "audio", "text"], required: true },
    startTime: { type: Number, required: true, min: 0 },
    duration: { type: Number, required: true, min: 0.1 },
    inPoint: { type: Number, default: 0, min: 0 },
    sourceDuration: { type: Number, required: true, min: 0 },
    volume: { type: Number, default: 1, min: 0, max: 2 },
    muted: { type: Boolean, default: false },
    fadeInSec: { type: Number, default: 0, min: 0, max: 30 },
    fadeOutSec: { type: Number, default: 0, min: 0, max: 30 },
    duckingEnabled: { type: Boolean, default: false },
    duckingAmount: { type: Number, default: 0.6, min: 0, max: 0.95 },
    speed: { type: Number, default: 1, min: 0.25, max: 4 },
    opacity: { type: Number, default: 1, min: 0, max: 1 },
    sourceName: { type: String },
    sourceSizeBytes: { type: Number },
    sourceMimeType: { type: String },
    textStyle: { type: TextOverlayStyleSchema, required: false },
  },
  { _id: false }
);

const SubtitleSegmentSchema = new Schema<ISubtitleSegmentSubdoc>(
  {
    id: { type: String, required: true },
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    text: { type: String, required: true, maxlength: 500 },
    clipId: { type: String },
  },
  { _id: false }
);

const SubtitleStyleSchema = new Schema<ISubtitleStyleSubdoc>(
  {
    enabled: { type: Boolean, default: true },
    fontSize: { type: Number, default: 28, min: 12, max: 72 },
    color: { type: String, default: "#FFFFFF" },
    position: { type: String, enum: ["bottom", "middle", "top"], default: "bottom" },
    backgroundColor: { type: String, default: "#09090B" },
    backgroundOpacity: { type: Number, default: 0.75, min: 0, max: 1 },
  },
  { _id: false }
);

const SubtitleMetaSchema = new Schema<ISubtitleMetaSubdoc>(
  {
    language: { type: String },
    model: { type: String },
    generatedAt: { type: String },
  },
  { _id: false }
);

const ProjectSchema = new Schema<IProject>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    aspectRatio: {
      type: String,
      enum: ["16:9", "9:16", "1:1"],
      default: "16:9",
    },
    resolution: {
      type: String,
      enum: ["720p", "1080p", "4K"],
      default: "1080p",
    },
    fps: {
      type: Number,
      enum: [24, 30, 60],
      default: 24,
    },
    tracks: {
      type: [TimelineTrackSchema],
      default: [
        { id: "track_t1", name: "T1 Text", type: "text", muted: false, locked: false },
        { id: "track_v2", name: "V2 Overlay", type: "overlay", muted: false, locked: false },
        { id: "track_v1", name: "V1 Primary", type: "video", muted: false, locked: false },
        { id: "track_a1", name: "A1 Audio", type: "audio", muted: false, locked: false },
      ],
    },
    clips: {
      type: [TimelineClipSchema],
      default: [],
    },
    subtitles: {
      type: [SubtitleSegmentSchema],
      default: [],
    },
    subtitleStyle: {
      type: SubtitleStyleSchema,
      default: () => ({
        enabled: true,
        fontSize: 28,
        color: "#FFFFFF",
        position: "bottom",
        backgroundColor: "#09090B",
        backgroundOpacity: 0.75,
      }),
    },
    subtitleMeta: {
      type: SubtitleMetaSchema,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

ProjectSchema.index({ userId: 1, updatedAt: -1 });

export const ProjectModel: Model<IProject> =
  mongoose.models.Project || mongoose.model<IProject>("Project", ProjectSchema);
