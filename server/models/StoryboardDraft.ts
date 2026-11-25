import mongoose, { Schema, type Document, type Model } from "mongoose";
import type {
  AspectRatioOption,
  StoryboardLanguage,
  StoryboardSourceMode,
  StoryboardStyle,
  StoryboardTargetDuration,
  VideoStoryboard,
} from "../../src/types/studio.ts";

export interface IStoryboardDraft extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  sourceMode: StoryboardSourceMode;
  aspectRatio: AspectRatioOption;
  totalDuration: StoryboardTargetDuration;
  style: StoryboardStyle;
  language: StoryboardLanguage;
  status: "draft" | "validated";
  modelName: string;
  storyboard: VideoStoryboard;
  createdAt: Date;
  updatedAt: Date;
}

const StoryboardDraftSchema = new Schema<IStoryboardDraft>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    sourceMode: {
      type: String,
      enum: ["prompt-to-video", "script-to-video"],
      required: true,
    },
    aspectRatio: {
      type: String,
      enum: ["16:9", "9:16", "1:1"],
      required: true,
    },
    totalDuration: {
      type: Number,
      enum: [15, 30, 60],
      required: true,
    },
    style: {
      type: String,
      enum: ["Cinematic", "Educational", "Motivational", "Minimal", "Social Media"],
      required: true,
    },
    language: {
      type: String,
      enum: ["English", "Hindi", "Bengali"],
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "validated"],
      default: "validated",
    },
    modelName: {
      type: String,
      default: "gemini-4-hydrogen",
      maxlength: 80,
    },
    storyboard: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

StoryboardDraftSchema.index({ userId: 1, updatedAt: -1 });

export const StoryboardDraftModel: Model<IStoryboardDraft> =
  mongoose.models.StoryboardDraft ||
  mongoose.model<IStoryboardDraft>("StoryboardDraft", StoryboardDraftSchema);
