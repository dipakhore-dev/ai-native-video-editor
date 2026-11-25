import mongoose, { Schema, type Document, type Model } from "mongoose";
import { getEnvConfig } from "../config/env.ts";

export interface IAiEditRequest extends Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  prompt: string;
  modelName: string;
  timelineMetadataSnapshot: Record<string, unknown>;
  proposedPlan: {
    summary: string;
    operations: Array<Record<string, unknown>>;
  };
  status: "proposed" | "applied" | "discarded" | "failed";
  appliedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AiEditRequestSchema = new Schema<IAiEditRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    prompt: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    modelName: {
      type: String,
      required: true,
      default: () => getEnvConfig().geminiModel,
    },
    timelineMetadataSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    proposedPlan: {
      summary: { type: String, required: true },
      operations: { type: [Schema.Types.Mixed], default: [] },
    },
    status: {
      type: String,
      enum: ["proposed", "applied", "discarded", "failed"],
      default: "proposed",
    },
    appliedAt: {
      type: Date,
    },
    errorMessage: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

AiEditRequestSchema.index({ userId: 1, createdAt: -1 });
AiEditRequestSchema.index({ userId: 1, projectId: 1, createdAt: -1 });

export const AiEditRequestModel: Model<IAiEditRequest> =
  mongoose.models.AiEditRequest ||
  mongoose.model<IAiEditRequest>("AiEditRequest", AiEditRequestSchema);
