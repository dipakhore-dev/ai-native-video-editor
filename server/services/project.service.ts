import { ProjectModel, type IProject } from "../models/Project.ts";

export async function listUserProjects(userId: string): Promise<IProject[]> {
  return ProjectModel.find({ userId }).sort({ updatedAt: -1 });
}

export async function getUserProjectById(
  userId: string,
  projectId: string
): Promise<IProject | null> {
  return ProjectModel.findOne({ _id: projectId, userId });
}

export async function createUserProject(
  userId: string,
  data: {
    name: string;
    description?: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
    resolution?: "720p" | "1080p" | "4K";
    fps?: 24 | 30 | 60;
    tracks?: IProject["tracks"];
    clips?: IProject["clips"];
  }
): Promise<IProject> {
  return ProjectModel.create({
    userId,
    ...data,
  });
}

export async function updateUserProject(
  userId: string,
  projectId: string,
  updates: {
    name?: string;
    description?: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
    resolution?: "720p" | "1080p" | "4K";
    fps?: 24 | 30 | 60;
  }
): Promise<IProject | null> {
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { $set: updates },
    { new: true, runValidators: true }
  );
}

export async function saveUserProjectTimeline(
  userId: string,
  projectId: string,
  timeline: {
    aspectRatio?: "16:9" | "9:16" | "1:1";
    tracks: IProject["tracks"];
    clips: IProject["clips"];
  }
): Promise<IProject | null> {
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { $set: timeline },
    { new: true, runValidators: true }
  );
}

export async function deleteUserProject(
  userId: string,
  projectId: string
): Promise<boolean> {
  const deleted = await ProjectModel.findOneAndDelete({ _id: projectId, userId });
  return Boolean(deleted);
}
