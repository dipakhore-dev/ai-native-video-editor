import mongoose from "mongoose";
import { MediaAssetModel, type IMediaAsset } from "../models/MediaAsset.ts";
import { ProjectModel } from "../models/Project.ts";

export async function listUserMediaAssets(
  userId: string,
  projectId?: string,
  limit = 100
): Promise<IMediaAsset[]> {
  const filter: Record<string, unknown> = { userId };
  if (projectId !== undefined && projectId.trim() !== "") {
    if (!mongoose.Types.ObjectId.isValid(projectId.trim())) {
      throw Object.assign(new Error("Invalid projectId filter."), { statusCode: 400 });
    }
    filter.projectId = projectId.trim();
  }
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  return MediaAssetModel.find(filter).sort({ createdAt: -1 }).limit(safeLimit);
}

export async function getUserMediaAssetById(
  userId: string,
  mediaId: string
): Promise<IMediaAsset | null> {
  return MediaAssetModel.findOne({ _id: mediaId, userId });
}

export async function createUserMediaMetadata(
  userId: string,
  data: {
    projectId?: string | null;
    name: string;
    kind: "video" | "image" | "audio";
    mimeType: string;
    sizeBytes: number;
    duration: number;
    width?: number;
    height?: number;
    storageProvider?: "local_browser" | "s3" | "gcs";
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
  }
): Promise<IMediaAsset> {
  if (data.projectId) {
    if (!mongoose.Types.ObjectId.isValid(data.projectId)) {
      throw Object.assign(new Error("Invalid projectId for media asset."), { statusCode: 400 });
    }
    const ownsProject = await ProjectModel.exists({ _id: data.projectId, userId });
    if (!ownsProject) {
      throw Object.assign(new Error("Referenced project not found for authenticated user."), {
        statusCode: 404,
      });
    }
  }

  return MediaAssetModel.create({
    userId,
    ...data,
    projectId: data.projectId ? new mongoose.Types.ObjectId(data.projectId) : null,
  });
}

export async function updateUserMediaMetadata(
  userId: string,
  mediaId: string,
  updates: {
    name?: string;
    projectId?: string | null;
    storageProvider?: "local_browser" | "s3" | "gcs";
    storageKey?: string;
    tags?: string[];
    description?: string;
  }
): Promise<IMediaAsset | null> {
  if (updates.projectId) {
    if (!mongoose.Types.ObjectId.isValid(updates.projectId)) {
      throw Object.assign(new Error("Invalid projectId."), { statusCode: 400 });
    }
    const ownsProject = await ProjectModel.exists({ _id: updates.projectId, userId });
    if (!ownsProject) {
      throw Object.assign(new Error("Referenced project not found for authenticated user."), {
        statusCode: 404,
      });
    }
  }

  return MediaAssetModel.findOneAndUpdate(
    { _id: mediaId, userId },
    { $set: updates },
    { new: true, runValidators: true }
  );
}

export async function deleteUserMediaAsset(
  userId: string,
  mediaId: string
): Promise<boolean> {
  const deleted = await MediaAssetModel.findOneAndDelete({ _id: mediaId, userId });
  return Boolean(deleted);
}
