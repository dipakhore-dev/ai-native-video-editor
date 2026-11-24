import mongoose from "mongoose";
import { ExportJobModel, type IExportJob } from "../models/ExportJob.ts";
import { ProjectModel } from "../models/Project.ts";

export async function listUserExportJobs(userId: string): Promise<IExportJob[]> {
  return ExportJobModel.find({ userId }).sort({ createdAt: -1 }).limit(50);
}

export async function getUserExportJobById(
  userId: string,
  jobId: string
): Promise<IExportJob | null> {
  return ExportJobModel.findOne({ _id: jobId, userId });
}

export async function createUserExportJob(
  userId: string,
  data: {
    projectId: string;
    projectName: string;
    format: "mp4" | "webm" | "mov";
    resolution: string;
    fps: 24 | 30 | 60;
    clipCount: number;
    totalDuration: number;
    timelineSpec?: Record<string, unknown>;
  }
): Promise<IExportJob> {
  if (!mongoose.Types.ObjectId.isValid(data.projectId)) {
    throw Object.assign(new Error("Invalid projectId for persistent export job."), {
      statusCode: 400,
    });
  }

  const ownsProject = await ProjectModel.exists({ _id: data.projectId, userId });
  if (!ownsProject) {
    throw Object.assign(new Error("Project not found for authenticated user."), {
      statusCode: 404,
    });
  }

  return ExportJobModel.create({
    userId,
    projectId: data.projectId,
    projectName: data.projectName,
    format: data.format,
    resolution: data.resolution,
    fps: data.fps,
    clipCount: data.clipCount,
    totalDuration: data.totalDuration,
    status: "integration_required",
    timelineSpec: data.timelineSpec ?? {},
    errorMessage:
      "Cloud render worker (FFmpeg / transcoding queue) is not connected. Job specification saved to MongoDB.",
  });
}

const UPDATABLE_EXPORT_STATUSES: Array<
  Exclude<IExportJob["status"], "completed">
> = ["queued", "processing", "failed", "integration_required"];

export async function updateUserExportJobStatus(
  userId: string,
  jobId: string,
  updates: {
    status: "queued" | "processing" | "completed" | "failed" | "integration_required";
    outputUrl?: string;
    errorMessage?: string;
  }
): Promise<IExportJob | null> {
  const filter: mongoose.QueryFilter<IExportJob> = {
    _id: jobId,
    userId,
    status: { $in: UPDATABLE_EXPORT_STATUSES },
  };

  return ExportJobModel.findOneAndUpdate(
    filter,
    { $set: updates },
    { new: true, runValidators: true }
  );
}
