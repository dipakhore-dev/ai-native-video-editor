import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface IUser extends Document {
  fullName: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string;
  workspaceName: string;
  defaultFps: 24 | 30 | 60;
  defaultResolution: "720p" | "1080p" | "4K";
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    avatarUrl: {
      type: String,
      default: "",
    },
    workspaceName: {
      type: String,
      default: "Personal Studio",
      trim: true,
      maxlength: 120,
    },
    defaultFps: {
      type: Number,
      enum: [24, 30, 60],
      default: 24,
    },
    defaultResolution: {
      type: String,
      enum: ["720p", "1080p", "4K"],
      default: "1080p",
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete (ret as Record<string, unknown>).passwordHash;
        delete (ret as Record<string, unknown>).__v;
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete (ret as Record<string, unknown>).passwordHash;
        delete (ret as Record<string, unknown>).__v;
        return ret;
      },
    },
  }
);

export const UserModel: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);
