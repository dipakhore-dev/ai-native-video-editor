import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchIntegrationStatus } from "../services/api";
import type {
  AppRoute,
  AspectRatioOption,
  ExportAttempt,
  IntegrationStatusMap,
  MediaAsset,
  Project,
  ResolutionOption,
  SessionUser,
  TextOverlayStyle,
  TimelineClip,
} from "../types/studio";
import { extractMediaAsset } from "../utils/media";
import {
  createDefaultTracks,
  ensureProjectTracks,
  reorderClipOnTrack,
  splitClipAtTimestamp,
} from "../utils/timeline";
import {
  applyAiOperationsToProject,
  type AiEditOperation,
  type ApplyOperationsResult,
} from "../utils/aiOperations";

const STORAGE_KEY = "ai_studio_saved_projects_v1";
const MAX_HISTORY_ENTRIES = 50;

interface CreateProjectInput {
  name: string;
  description?: string;
  aspectRatio: AspectRatioOption;
  resolution: ResolutionOption;
  fps: 24 | 30 | 60;
}

interface StudioContextValue {
  route: AppRoute;
  navigate: (next: AppRoute) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  projects: Project[];
  activeProject: Project | null;
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  createProject: (input: CreateProjectInput, openInEditor?: boolean) => Project;
  renameProject: (id: string, name: string) => void;
  duplicateProject: (id: string) => void;
  deleteProject: (id: string) => void;
  mediaAssets: MediaAsset[];
  uploadingMedia: boolean;
  mediaError: string | null;
  clearMediaError: () => void;
  uploadLocalFiles: (files: FileList | File[]) => Promise<MediaAsset[]>;
  removeMediaAsset: (assetId: string) => void;
  totalMediaBytes: number;
  addClipToTimeline: (asset: MediaAsset, trackId?: string, startTime?: number) => TimelineClip | null;
  addTextOverlay: (text?: string, startTime?: number) => TimelineClip | null;
  updateClip: (clipId: string, patch: Partial<TimelineClip>, recordHistory?: boolean) => void;
  updateTextStyle: (
    clipId: string,
    patch: Partial<TextOverlayStyle>,
    recordHistory?: boolean
  ) => void;
  commitProjectSnapshot: (beforeSnapshot: Project) => void;
  splitClipAtTime: (clipId: string, playheadTime: number) => boolean;
  reorderClip: (clipId: string, direction: "earlier" | "later") => boolean;
  duplicateClip: (clipId: string) => void;
  deleteClip: (clipId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackLock: (trackId: string) => void;
  applyAiEditPlan: (operations: AiEditOperation[]) => ApplyOperationsResult;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  lastLocalSaveAt: string | null;
  saveTimelineLocally: () => void;
  exportAttempts: ExportAttempt[];
  recordExportAttempt: (attempt: ExportAttempt) => void;
  integrations: IntegrationStatusMap | null;
  integrationsLoading: boolean;
  integrationsError: string | null;
  refreshIntegrations: () => Promise<void>;
  sessionUser: SessionUser;
  updateSessionUser: (patch: Partial<SessionUser>) => void;
  createProjectModalOpen: boolean;
  setCreateProjectModalOpen: (open: boolean) => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

function cloneProject(project: Project): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => ({ ...t })),
    clips: project.clips.map((c) => ({
      ...c,
      textStyle: c.textStyle ? { ...c.textStyle } : undefined,
    })),
  };
}

function loadSavedProjects(): { projects: Project[]; savedAt: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { projects: [], savedAt: null };
    const parsed = JSON.parse(raw) as { projects?: Project[]; savedAt?: string };
    if (!Array.isArray(parsed.projects)) return { projects: [], savedAt: null };

    const restored: Project[] = parsed.projects.map((p) => ({
      ...p,
      tracks: ensureProjectTracks(p.tracks || createDefaultTracks()),
      clips: (p.clips || []).map((c) => ({
        ...c,
        // Blob object URLs expire across browser page reloads; mark non-text clips for local relinking
        needsRelink: c.kind !== "text" && c.objectUrl.startsWith("blob:"),
      })),
    }));

    return {
      projects: restored,
      savedAt: parsed.savedAt ?? null,
    };
  } catch {
    return { projects: [], savedAt: null };
  }
}

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const initialSaved = useMemo(() => loadSavedProjects(), []);

  const [route, setRoute] = useState<AppRoute>("landing");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projects, setProjects] = useState<Project[]>(initialSaved.projects);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    initialSaved.projects[0]?.id ?? null
  );
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [exportAttempts, setExportAttempts] = useState<ExportAttempt[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatusMap | null>(null);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [createProjectModalOpen, setCreateProjectModalOpen] = useState(false);

  const [undoStack, setUndoStack] = useState<Project[]>([]);
  const [redoStack, setRedoStack] = useState<Project[]>([]);
  const [lastLocalSaveAt, setLastLocalSaveAt] = useState<string | null>(initialSaved.savedAt);

  const [sessionUser, setSessionUser] = useState<SessionUser>({
    displayName: "Elena Vance",
    email: "editor@local.session",
    workspaceName: "Local Studio Session",
    mode: "local_session",
    defaultFps: 24,
    defaultResolution: "1080p",
  });

  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdState(id);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const refreshIntegrations = useCallback(async () => {
    setIntegrationsLoading(true);
    setIntegrationsError(null);
    const res = await fetchIntegrationStatus();
    if (res.ok && res.data) {
      setIntegrations(res.data.integrations);
    } else {
      setIntegrationsError(res.error || "Unable to verify backend integration status.");
    }
    setIntegrationsLoading(false);
  }, []);

  useEffect(() => {
    void refreshIntegrations();
  }, [refreshIntegrations]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const totalMediaBytes = useMemo(
    () => mediaAssets.reduce((sum, item) => sum + item.sizeBytes, 0),
    [mediaAssets]
  );

  const saveTimelineLocally = useCallback(() => {
    try {
      const savedAt = new Date().toISOString();
      const serializableProjects = projects.map((p) => ({
        ...p,
        clips: p.clips.map((c) => ({
          ...c,
          thumbnailUrl: c.thumbnailUrl?.startsWith("data:") ? c.thumbnailUrl : undefined,
        })),
      }));
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schemaVersion: "1.0",
          savedAt,
          projects: serializableProjects,
        })
      );
      setLastLocalSaveAt(savedAt);
    } catch {
      setMediaError("Could not save timeline to browser localStorage (storage quota may be full).");
    }
  }, [projects]);

  const createProject = useCallback(
    (input: CreateProjectInput, openInEditor = true): Project => {
      const now = new Date().toISOString();
      const project: Project = {
        id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: input.name.trim() || "Untitled Sequence",
        description: input.description?.trim() || "",
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        fps: input.fps,
        createdAt: now,
        updatedAt: now,
        tracks: createDefaultTracks(),
        clips: [],
      };
      setProjects((prev) => [project, ...prev]);
      setActiveProjectId(project.id);
      if (openInEditor) {
        setRoute("editor");
      }
      return project;
    },
    [setActiveProjectId]
  );

  const renameProject = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name: trimmed, updatedAt: new Date().toISOString() } : p))
    );
  }, []);

  const duplicateProject = useCallback((id: string) => {
    setProjects((prev) => {
      const source = prev.find((p) => p.id === id);
      if (!source) return prev;
      const now = new Date().toISOString();
      const copy: Project = {
        ...cloneProject(source),
        id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `${source.name} (Copy)`,
        createdAt: now,
        updatedAt: now,
        clips: source.clips.map((c) => ({
          ...c,
          id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        })),
      };
      return [copy, ...prev];
    });
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
    },
    [activeProjectId, setActiveProjectId]
  );

  const uploadLocalFiles = useCallback(async (files: FileList | File[]): Promise<MediaAsset[]> => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return [];
    setUploadingMedia(true);
    setMediaError(null);

    const added: MediaAsset[] = [];
    const failures: string[] = [];

    for (const file of fileArray) {
      try {
        const asset = await extractMediaAsset(file);
        added.push(asset);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : `Could not read ${file.name}`);
      }
    }

    if (added.length > 0) {
      setMediaAssets((prev) => [...added, ...prev]);

      // Automatically relink any restored clips whose sourceName & size match newly uploaded files
      setProjects((prevProjects) =>
        prevProjects.map((proj) => ({
          ...proj,
          clips: proj.clips.map((clip) => {
            if (!clip.needsRelink) return clip;
            const match = added.find(
              (a) =>
                a.name === (clip.sourceName || clip.name) &&
                (!clip.sourceSizeBytes || a.sizeBytes === clip.sourceSizeBytes)
            );
            if (!match) return clip;
            return {
              ...clip,
              assetId: match.id,
              objectUrl: match.objectUrl,
              thumbnailUrl: match.thumbnailUrl ?? clip.thumbnailUrl,
              needsRelink: false,
            };
          }),
        }))
      );
    }
    if (failures.length > 0) {
      setMediaError(failures.join(" "));
    }
    setUploadingMedia(false);
    return added;
  }, []);

  const removeMediaAsset = useCallback((assetId: string) => {
    setMediaAssets((prev) => {
      const target = prev.find((a) => a.id === assetId);
      if (target) {
        URL.revokeObjectURL(target.objectUrl);
      }
      return prev.filter((a) => a.id !== assetId);
    });
    setProjects((prev) =>
      prev.map((proj) => ({
        ...proj,
        clips: proj.clips.filter((c) => c.assetId !== assetId),
      }))
    );
  }, []);

  const mutateActiveProject = useCallback(
    (updater: (project: Project) => Project, recordHistory = true) => {
      setProjects((prev) => {
        if (!activeProjectId) return prev;
        const current = prev.find((p) => p.id === activeProjectId);
        if (!current) return prev;

        const nextProject = {
          ...updater(current),
          updatedAt: new Date().toISOString(),
        };

        if (recordHistory) {
          const snapshot = cloneProject(current);
          setUndoStack((stack) => [...stack.slice(-(MAX_HISTORY_ENTRIES - 1)), snapshot]);
          setRedoStack([]);
        }

        return prev.map((proj) => (proj.id === activeProjectId ? nextProject : proj));
      });
    },
    [activeProjectId]
  );

  const commitProjectSnapshot = useCallback((beforeSnapshot: Project) => {
    setUndoStack((stack) => [
      ...stack.slice(-(MAX_HISTORY_ENTRIES - 1)),
      cloneProject(beforeSnapshot),
    ]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (!activeProjectId || undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((stack) => stack.slice(0, -1));
    setProjects((prev) => {
      const current = prev.find((p) => p.id === activeProjectId);
      if (current) {
        setRedoStack((r) => [...r.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]);
      }
      return prev.map((p) => (p.id === activeProjectId ? cloneProject(previous) : p));
    });
  }, [activeProjectId, undoStack]);

  const redo = useCallback(() => {
    if (!activeProjectId || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((stack) => stack.slice(0, -1));
    setProjects((prev) => {
      const current = prev.find((p) => p.id === activeProjectId);
      if (current) {
        setUndoStack((u) => [...u.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]);
      }
      return prev.map((p) => (p.id === activeProjectId ? cloneProject(next) : p));
    });
  }, [activeProjectId, redoStack]);

  const addClipToTimeline = useCallback(
    (asset: MediaAsset, preferredTrackId?: string, explicitStartTime?: number): TimelineClip | null => {
      let createdClip: TimelineClip | null = null;

      setProjects((prev) => {
        let targetId = activeProjectId;
        let nextProjects = prev;

        if (!targetId) {
          const now = new Date().toISOString();
          const autoProject: Project = {
            id: `proj_${Date.now()}`,
            name: "Sequence 01",
            description: "Created from media placement",
            aspectRatio: "16:9",
            resolution: sessionUser.defaultResolution,
            fps: sessionUser.defaultFps,
            createdAt: now,
            updatedAt: now,
            tracks: createDefaultTracks(),
            clips: [],
          };
          targetId = autoProject.id;
          nextProjects = [autoProject, ...prev];
          setActiveProjectIdState(targetId);
        }

        return nextProjects.map((proj) => {
          if (proj.id !== targetId) return proj;

          const tracks = ensureProjectTracks(proj.tracks);
          const defaultTrackId = asset.kind === "audio" ? "track_a1" : "track_v1";
          const trackId = preferredTrackId || defaultTrackId;
          const track = tracks.find((t) => t.id === trackId);
          if (track?.locked) return proj;

          const existingOnTrack = proj.clips.filter((c) => c.trackId === trackId);
          const trackEnd = existingOnTrack.reduce(
            (max, c) => Math.max(max, c.startTime + c.duration),
            0
          );

          const clip: TimelineClip = {
            id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            assetId: asset.id,
            trackId,
            name: asset.name,
            kind: asset.kind,
            startTime:
              explicitStartTime !== undefined
                ? Math.max(0, Number(explicitStartTime.toFixed(2)))
                : Number(trackEnd.toFixed(2)),
            duration: Math.max(1, Number(asset.duration.toFixed(2))),
            inPoint: 0,
            sourceDuration: asset.duration,
            volume: 1,
            speed: 1,
            opacity: 1,
            thumbnailUrl: asset.thumbnailUrl,
            objectUrl: asset.objectUrl,
            sourceName: asset.name,
            sourceSizeBytes: asset.sizeBytes,
            sourceMimeType: asset.mimeType,
            needsRelink: false,
          };
          createdClip = clip;

          setUndoStack((stack) => [...stack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(proj)]);
          setRedoStack([]);

          return {
            ...proj,
            tracks,
            updatedAt: new Date().toISOString(),
            clips: [...proj.clips, clip],
          };
        });
      });

      return createdClip;
    },
    [activeProjectId, sessionUser.defaultFps, sessionUser.defaultResolution]
  );

  const addTextOverlay = useCallback(
    (text = "Title Overlay", explicitStartTime?: number): TimelineClip | null => {
      if (!activeProjectId) return null;
      let createdClip: TimelineClip | null = null;

      mutateActiveProject((proj) => {
        const tracks = ensureProjectTracks(proj.tracks);
        const textTrack = tracks.find((t) => t.id === "track_t1");
        if (textTrack?.locked) return proj;

        const existingText = proj.clips.filter((c) => c.trackId === "track_t1");
        const trackEnd = existingText.reduce(
          (max, c) => Math.max(max, c.startTime + c.duration),
          0
        );

        const startTime =
          explicitStartTime !== undefined ? Math.max(0, Number(explicitStartTime.toFixed(2))) : Number(trackEnd.toFixed(2));

        const clip: TimelineClip = {
          id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          assetId: "text_overlay",
          trackId: "track_t1",
          name: text,
          kind: "text",
          startTime,
          duration: 4,
          inPoint: 0,
          sourceDuration: 60,
          volume: 0,
          speed: 1,
          opacity: 1,
          objectUrl: "",
          sourceName: text,
          sourceMimeType: "application/x-text-overlay",
          textStyle: {
            text,
            fontSize: 32,
            color: "#FFFFFF",
            backgroundColor: "#09090B",
            backgroundOpacity: 0.6,
            x: 50,
            y: 82,
            align: "center",
          },
        };
        createdClip = clip;

        return {
          ...proj,
          tracks,
          clips: [...proj.clips, clip],
        };
      }, true);

      return createdClip;
    },
    [activeProjectId, mutateActiveProject]
  );

  const updateClip = useCallback(
    (clipId: string, patch: Partial<TimelineClip>, recordHistory = true) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          clips: proj.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
        }),
        recordHistory
      );
    },
    [mutateActiveProject]
  );

  const updateTextStyle = useCallback(
    (clipId: string, patch: Partial<TextOverlayStyle>, recordHistory = true) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          clips: proj.clips.map((c) => {
            if (c.id !== clipId || !c.textStyle) return c;
            const nextStyle = { ...c.textStyle, ...patch };
            return {
              ...c,
              name: patch.text !== undefined ? patch.text || "Text Overlay" : c.name,
              textStyle: nextStyle,
            };
          }),
        }),
        recordHistory
      );
    },
    [mutateActiveProject]
  );

  const splitClipAtTime = useCallback(
    (clipId: string, playheadTime: number): boolean => {
      let didSplit = false;
      mutateActiveProject((proj) => {
        const target = proj.clips.find((c) => c.id === clipId);
        if (!target) return proj;
        const track = proj.tracks.find((t) => t.id === target.trackId);
        if (track?.locked) return proj;

        const result = splitClipAtTimestamp(proj.clips, clipId, playheadTime);
        didSplit = result.didSplit;
        if (!result.didSplit) return proj;

        return {
          ...proj,
          clips: result.clips,
        };
      }, true);
      return didSplit;
    },
    [mutateActiveProject]
  );

  const reorderClip = useCallback(
    (clipId: string, direction: "earlier" | "later"): boolean => {
      let didMove = false;
      mutateActiveProject((proj) => {
        const target = proj.clips.find((c) => c.id === clipId);
        if (!target) return proj;
        const track = proj.tracks.find((t) => t.id === target.trackId);
        if (track?.locked) return proj;

        const result = reorderClipOnTrack(proj.clips, clipId, direction);
        didMove = result.moved;
        if (!result.moved) return proj;

        return {
          ...proj,
          clips: result.clips,
        };
      }, true);
      return didMove;
    },
    [mutateActiveProject]
  );

  const duplicateClip = useCallback(
    (clipId: string) => {
      mutateActiveProject((proj) => {
        const target = proj.clips.find((c) => c.id === clipId);
        if (!target) return proj;
        const copy: TimelineClip = {
          ...target,
          id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          startTime: Number((target.startTime + target.duration).toFixed(2)),
          textStyle: target.textStyle ? { ...target.textStyle } : undefined,
        };
        return {
          ...proj,
          clips: [...proj.clips, copy],
        };
      }, true);
    },
    [mutateActiveProject]
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          clips: proj.clips.filter((c) => c.id !== clipId),
        }),
        true
      );
    },
    [mutateActiveProject]
  );

  const toggleTrackMute = useCallback(
    (trackId: string) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          tracks: proj.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
        }),
        true
      );
    },
    [mutateActiveProject]
  );

  const toggleTrackLock = useCallback(
    (trackId: string) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          tracks: proj.tracks.map((t) => (t.id === trackId ? { ...t, locked: !t.locked } : t)),
        }),
        true
      );
    },
    [mutateActiveProject]
  );

  const applyAiEditPlan = useCallback(
    (operations: AiEditOperation[]): ApplyOperationsResult => {
      let result: ApplyOperationsResult = {
        project: activeProject as Project,
        appliedCount: 0,
        skippedMessages: ["No active project selected."],
      };

      mutateActiveProject((proj) => {
        result = applyAiOperationsToProject(proj, operations);
        return result.project;
      }, true);

      return result;
    },
    [activeProject, mutateActiveProject]
  );

  const recordExportAttempt = useCallback((attempt: ExportAttempt) => {
    setExportAttempts((prev) => [attempt, ...prev]);
  }, []);

  const updateSessionUser = useCallback((patch: Partial<SessionUser>) => {
    setSessionUser((prev) => ({ ...prev, ...patch }));
  }, []);

  const value: StudioContextValue = {
    route,
    navigate,
    sidebarCollapsed,
    setSidebarCollapsed,
    projects,
    activeProject,
    activeProjectId,
    setActiveProjectId,
    createProject,
    renameProject,
    duplicateProject,
    deleteProject,
    mediaAssets,
    uploadingMedia,
    mediaError,
    clearMediaError: () => setMediaError(null),
    uploadLocalFiles,
    removeMediaAsset,
    totalMediaBytes,
    addClipToTimeline,
    addTextOverlay,
    updateClip,
    updateTextStyle,
    commitProjectSnapshot,
    splitClipAtTime,
    reorderClip,
    duplicateClip,
    deleteClip,
    toggleTrackMute,
    toggleTrackLock,
    applyAiEditPlan,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undo,
    redo,
    lastLocalSaveAt,
    saveTimelineLocally,
    exportAttempts,
    recordExportAttempt,
    integrations,
    integrationsLoading,
    integrationsError,
    refreshIntegrations,
    sessionUser,
    updateSessionUser,
    createProjectModalOpen,
    setCreateProjectModalOpen,
  };

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error("useStudio must be used inside StudioProvider");
  }
  return ctx;
}
