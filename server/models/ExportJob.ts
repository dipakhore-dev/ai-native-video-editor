import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface IExportJob extends Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  projectName: string;
  format: "mp4" | "webm" | "mov";
  resolution: string;
  fps: 24 | 30 | 60;
  clipCount: number;
  totalDuration: number;
  status: "queued" | "processing" | "completed" | "failed" | "integration_required";
  timelineSpec: Record<string, unknown>;
  outputUrl?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExportJobSchema = new Schema<IExportJob>(
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
      required: true,
      index: true,
    },
    projectName: {
      type: String,
      required: true,
      trim: true,
    },
    format: {
      type: String,
      enum: ["mp4", "webm", "mov"],
      default: "mp4",
    },
    resolution: {
      type: String,
      required: true,
      default: "1920x1080",
    },
    fps: {
      type: Number,
      enum: [24, 30, 60],
      default: 24,
    },
    clipCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalDuration: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "integration_required"],
      default: "integration_required",
    },
    timelineSpec: {
      type: Schema.Types.Mixed,
      required: true,
    },
    outputUrl: {
      type: String,
    },
    errorMessage: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

ExportJobSchema.index({ userId: 1, createdAt: -1 });

export const ExportJobModel: Model<IExportJob> =
  mongoose.models.ExportJob || mongoose.model<IExportJob>("ExportJob", ExportJobSchema);
