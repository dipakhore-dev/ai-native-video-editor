import { ProjectModel, type IProject } from "../models/Project.ts";

export async function listUserProjects(userId: string, limit = 100): Promise<IProject[]> {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  return ProjectModel.find({ userId }).sort({ updatedAt: -1 }).limit(safeLimit);
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
    subtitles?: IProject["subtitles"];
    subtitleStyle?: IProject["subtitleStyle"];
    subtitleMeta?: IProject["subtitleMeta"];
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
    { returnDocument: "after", runValidators: true }
  );
}

export async function saveUserProjectTimeline(
  userId: string,
  projectId: string,
  timeline: {
    aspectRatio?: "16:9" | "9:16" | "1:1";
    tracks: IProject["tracks"];
    clips: IProject["clips"];
    subtitles?: IProject["subtitles"];
    subtitleStyle?: IProject["subtitleStyle"];
    subtitleMeta?: IProject["subtitleMeta"];
  }
): Promise<IProject | null> {
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { $set: timeline },
    { returnDocument: "after", runValidators: true }
  );
}

export async function saveUserProjectSubtitles(
  userId: string,
  projectId: string,
  payload: {
    subtitles: NonNullable<IProject["subtitles"]>;
    subtitleStyle?: IProject["subtitleStyle"];
    subtitleMeta?: IProject["subtitleMeta"];
  }
): Promise<IProject | null> {
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { $set: payload },
    { returnDocument: "after", runValidators: true }
  );
}

export async function duplicateUserProject(
  userId: string,
  projectId: string,
  customName?: string
): Promise<IProject | null> {
  const source = await ProjectModel.findOne({ _id: projectId, userId }).lean();
  if (!source) return null;

  const baseName = (customName?.trim() || `${source.name} (Copy)`).slice(0, 140);
  const stamp = Date.now();
  const clipIdMap = new Map<string, string>();

  const clonedTracks = (source.tracks ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    muted: Boolean(t.muted),
    locked: Boolean(t.locked),
  }));

  const clonedClips = (source.clips ?? []).map((clip, idx) => {
    const nextClipId = `clip_${stamp}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
    clipIdMap.set(clip.id, nextClipId);
    return {
      id: nextClipId,
      assetId: clip.assetId,
      trackId: clip.trackId,
      name: clip.name,
      kind: clip.kind,
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: clip.inPoint,
      sourceDuration: clip.sourceDuration,
      volume: clip.volume,
      muted: Boolean(clip.muted),
      fadeInSec: clip.fadeInSec ?? 0,
      fadeOutSec: clip.fadeOutSec ?? 0,
      ...(clip.kind === "audio"
        ? {
            duckingEnabled: Boolean(clip.duckingEnabled),
            duckingAmount: clip.duckingAmount ?? 0.6,
          }
        : {}),
      speed: clip.speed,
      opacity: clip.opacity,
      ...(clip.rotation !== undefined ? { rotation: clip.rotation } : {}),
      ...(Array.isArray(clip.keyframes) && clip.keyframes.length > 0
        ? {
            keyframes: clip.keyframes.map((kf, kfIdx) => ({
              id: `kf_${stamp}_${idx}_${kfIdx}_${Math.random().toString(36).slice(2, 6)}`,
              timeSec: kf.timeSec,
              property: kf.property,
              value: kf.value,
              easing: kf.easing,
            })),
          }
        : {}),
      ...(clip.transitionIn ? { transitionIn: { ...clip.transitionIn } } : {}),
      ...(clip.transitionOut ? { transitionOut: { ...clip.transitionOut } } : {}),
      ...(clip.effects ? { effects: { ...clip.effects } } : {}),
      ...(clip.overlayTransform ? { overlayTransform: { ...clip.overlayTransform } } : {}),
      ...(clip.sourceWidth !== undefined ? { sourceWidth: clip.sourceWidth } : {}),
      ...(clip.sourceHeight !== undefined ? { sourceHeight: clip.sourceHeight } : {}),
      ...(clip.sourceName !== undefined ? { sourceName: clip.sourceName } : {}),
      ...(clip.sourceSizeBytes !== undefined ? { sourceSizeBytes: clip.sourceSizeBytes } : {}),
      ...(clip.sourceMimeType !== undefined ? { sourceMimeType: clip.sourceMimeType } : {}),
      ...(clip.textStyle ? { textStyle: { ...clip.textStyle } } : {}),
    };
  });

  const clonedSubtitles = (source.subtitles ?? []).map((sub, idx) => ({
    id: `sub_${stamp}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
    start: sub.start,
    end: sub.end,
    text: sub.text,
    ...(sub.clipId ? { clipId: clipIdMap.get(sub.clipId) ?? sub.clipId } : {}),
  }));

  return ProjectModel.create({
    userId,
    name: baseName,
    description: source.description ?? "",
    aspectRatio: source.aspectRatio ?? "16:9",
    resolution: source.resolution ?? "1080p",
    fps: source.fps ?? 24,
    tracks: clonedTracks,
    clips: clonedClips,
    subtitles: clonedSubtitles,
    ...(source.subtitleStyle ? { subtitleStyle: { ...source.subtitleStyle } } : {}),
    ...(source.subtitleMeta ? { subtitleMeta: { ...source.subtitleMeta } } : {}),
  });
}

export async function deleteUserProject(
  userId: string,
  projectId: string
): Promise<boolean> {
  const deleted = await ProjectModel.findOneAndDelete({ _id: projectId, userId });
  return Boolean(deleted);
}
