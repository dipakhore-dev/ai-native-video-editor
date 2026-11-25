import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface IMediaAsset extends Document {
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId | null;
  name: string;
  kind: "video" | "image" | "audio";
  mimeType: string;
  sizeBytes: number;
  duration: number;
  width?: number;
  height?: number;
  storageProvider: "local_browser" | "s3" | "gcs";
  storageKey?: string;
  tags?: string[];
  description?: string;
  sourceOrigin?: "uploaded" | "existing_library" | "stock" | "generated_slide";
  providerName?: string;
  providerAssetId?: string;
  sourceUrl?: string;
  creatorName?: string;
  attributionUrl?: string;
  licenseInfo?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MediaAssetSchema = new Schema<IMediaAsset>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    kind: {
      type: String,
      enum: ["video", "image", "audio"],
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: Number,
      required: true,
      min: 0,
    },
    width: {
      type: Number,
      min: 1,
    },
    height: {
      type: Number,
      min: 1,
    },
    storageProvider: {
      type: String,
      enum: ["local_browser", "s3", "gcs"],
      default: "local_browser",
    },
    storageKey: {
      type: String,
      default: "",
    },
    tags: {
      type: [String],
      default: undefined,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 400,
    },
    sourceOrigin: {
      type: String,
      enum: ["uploaded", "existing_library", "stock", "generated_slide"],
      default: "uploaded",
    },
    providerName: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    providerAssetId: {
      type: String,
      trim: true,
      maxlength: 120,
    },
    sourceUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    creatorName: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    attributionUrl: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    licenseInfo: {
      type: String,
      trim: true,
      maxlength: 200,
    },
  },
  {
    timestamps: true,
  }
);

MediaAssetSchema.index({ userId: 1, createdAt: -1 });
MediaAssetSchema.index({ userId: 1, projectId: 1, createdAt: -1 });

export const MediaAssetModel: Model<IMediaAsset> =
  mongoose.models.MediaAsset || mongoose.model<IMediaAsset>("MediaAsset", MediaAssetSchema);
