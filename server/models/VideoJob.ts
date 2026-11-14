import mongoose, { Schema, type Document, type Model } from "mongoose";

export type VideoOperationType =
  | "metadata"
  | "thumbnail"
  | "trim"
  | "merge"
  | "resize_crop"
  | "aspect_ratio"
  | "export_mp4"
  | "subtitles";

export type VideoJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "integration_required";

export interface IVideoJob extends Document {
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId | null;
  mediaAssetId?: mongoose.Types.ObjectId | null;
  operation: VideoOperationType;
  status: VideoJobStatus;
  progress: number;
  executionMode: "sync" | "bullmq";
  queueJobId?: string;
  processorJobId?: string;
  sourceFilename: string;
  sourceSizeBytes: number;
  inputParams: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const VideoJobSchema = new Schema<IVideoJob>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },
    mediaAssetId: {
      type: Schema.Types.ObjectId,
      ref: "MediaAsset",
      default: null,
      index: true,
    },
    operation: {
      type: String,
      enum: [
        "metadata",
        "thumbnail",
        "trim",
        "merge",
        "resize_crop",
        "aspect_ratio",
        "export_mp4",
        "subtitles",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "integration_required"],
      default: "queued",
      index: true,
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    executionMode: {
      type: String,
      enum: ["sync", "bullmq"],
      default: "sync",
    },
    queueJobId: {
      type: String,
      default: "",
    },
    processorJobId: {
      type: String,
      default: "",
    },
    sourceFilename: {
      type: String,
      required: true,
      trim: true,
    },
    sourceSizeBytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    inputParams: {
      type: Schema.Types.Mixed,
      default: {},
    },
    result: {
      type: Schema.Types.Mixed,
    },
    errorMessage: {
      type: String,
    },
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

VideoJobSchema.index({ userId: 1, createdAt: -1 });

export const VideoJobModel: Model<IVideoJob> =
  mongoose.models.VideoJob || mongoose.model<IVideoJob>("VideoJob", VideoJobSchema);
