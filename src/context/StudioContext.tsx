import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createServerMediaMetadata,
  createServerProject,
  deleteServerMediaMetadata,
  deleteServerProject,
  fetchCurrentAuthUser,
  fetchIntegrationStatus,
  fetchServerMediaAssets,
  fetchServerProjects,
  mapServerProjectToStudioProject,
  saveServerProjectSubtitles,
  saveServerProjectTimeline,
  submitAuthLogout,
  updateServerProject,
  type AuthUserDto,
} from "../services/api";
import type {
  AppRoute,
  AspectRatioOption,
  ExportAttempt,
  IntegrationStatusMap,
  MediaAsset,
  MediaKind,
  Project,
  ResolutionOption,
  SessionUser,
  SubtitleMetadata,
  SubtitleSegment,
  SubtitleStyle,
  TextOverlayStyle,
  TimelineClip,
} from "../types/studio";
import { DEFAULT_DUCKING_AMOUNT, extractAudioWaveformPeaks } from "../utils/audio";
import { extractMediaAsset } from "../utils/media";
import {
  checkStorageQuotaForBytes,
  deleteMediaFromIndexedDB,
  estimateBrowserStorage,
  findOrphanedAssetIds,
  findProjectsUsingAsset,
  getAllMediaFromIndexedDB,
  hydrateAssetFromStoredRecord,
  MediaStorageQuotaError,
  reconcileProjectsWithMediaAssets,
  reconcileProjectWithMediaAssets,
  saveMediaToIndexedDB,
  type BrowserStorageEstimate,
  type StoredMediaRecord,
} from "../utils/mediaStorage";
import {
  createDefaultTracks,
  duplicateClipWithoutOverlap,
  ensureProjectTracks,
  insertClipOnTrack,
  moveClipWithTrackOrdering,
  packTrackClips,
  reorderClipOnTrack,
  reorderClipToIndex,
  splitClipAtTimestamp,
} from "../utils/timeline";
import {
  applyAiOperationsToProject,
  type AiEditOperation,
  type ApplyOperationsResult,
} from "../utils/aiOperations";
import {
  DEFAULT_SUBTITLE_STYLE,
  sortSubtitles,
  syncSubtitlesForClipDelete,
  syncSubtitlesForClipSplit,
  syncSubtitlesForClipUpdate,
  syncSubtitlesForProjectClips,
} from "../utils/subtitles";

const STORAGE_KEY = "ai_studio_saved_projects_v1";
const MAX_HISTORY_ENTRIES = 50;
const MONGO_OBJECT_ID_RE = /^[a-f\d]{24}$/i;

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
  idbHydrating: boolean;
  storageEstimate: BrowserStorageEstimate | null;
  refreshStorageEstimate: () => Promise<void>;
  mediaError: string | null;
  clearMediaError: () => void;
  uploadLocalFiles: (files: FileList | File[]) => Promise<MediaAsset[]>;
  relinkMissingClipAsset: (
    assetId: string,
    file: File
  ) => Promise<{ ok: boolean; error?: string }>;
  getProjectsUsingAsset: (assetId: string) => Project[];
  removeMediaAsset: (
    assetId: string,
    force?: boolean
  ) => Promise<{ deleted: boolean; blockedByProjects?: Project[]; error?: string }>;
  cleanupUnusedMediaAssets: () => Promise<number>;
  totalMediaBytes: number;
  addClipToTimeline: (asset: MediaAsset, trackId?: string, startTime?: number) => TimelineClip | null;
  addTextOverlay: (text?: string, startTime?: number) => TimelineClip | null;
  updateClip: (
    clipId: string,
    patch: Partial<TimelineClip>,
    recordHistory?: boolean,
    syncBase?: { clip: TimelineClip; subtitles?: SubtitleSegment[] }
  ) => void;
  updateTextStyle: (
    clipId: string,
    patch: Partial<TextOverlayStyle>,
    recordHistory?: boolean
  ) => void;
  commitProjectSnapshot: (beforeSnapshot: Project) => void;
  splitClipAtTime: (clipId: string, playheadTime: number) => boolean;
  reorderClip: (clipId: string, direction: "earlier" | "later") => boolean;
  reorderClipToSlot: (clipId: string, targetIndex: number) => boolean;
  moveClipOnTimeline: (
    clipId: string,
    desiredStartTime: number,
    targetTrackId?: string,
    recordHistory?: boolean,
    syncBase?: { clips: TimelineClip[]; subtitles?: SubtitleSegment[] }
  ) => void;
  packTrackGaps: (trackId: string) => boolean;
  duplicateClip: (clipId: string) => TimelineClip | null;
  deleteClip: (clipId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackLock: (trackId: string) => void;
  applyAiEditPlan: (operations: AiEditOperation[]) => ApplyOperationsResult;
  replaceClipSubtitles: (
    clipId: string,
    segments: SubtitleSegment[],
    meta?: SubtitleMetadata
  ) => { subtitles: SubtitleSegment[]; style: SubtitleStyle };
  updateSubtitleSegment: (
    segmentId: string,
    patch: Partial<SubtitleSegment>,
    recordHistory?: boolean
  ) => void;
  addSubtitleSegment: (
    startTime: number,
    endTime?: number,
    text?: string,
    clipId?: string
  ) => SubtitleSegment | null;
  deleteSubtitleSegment: (segmentId: string) => void;
  updateSubtitleStyle: (patch: Partial<SubtitleStyle>, recordHistory?: boolean) => void;
  saveSubtitlesToMongo: (override?: {
    projectId?: string;
    subtitles?: SubtitleSegment[];
    subtitleStyle?: SubtitleStyle;
    subtitleMeta?: SubtitleMetadata;
  }) => Promise<{ ok: boolean; error?: string; projectId?: string }>;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  lastLocalSaveAt: string | null;
  saveTimelineLocally: () => void;
  mongoSaveStatus: "idle" | "saving" | "saved" | "error";
  lastMongoSaveAt: string | null;
  mongoSaveError: string | null;
  saveTimelineToMongo: (
    overrideProjectId?: string
  ) => Promise<{ ok: boolean; error?: string; projectId?: string }>;
  exportAttempts: ExportAttempt[];
  recordExportAttempt: (attempt: ExportAttempt) => void;
  integrations: IntegrationStatusMap | null;
  integrationsLoading: boolean;
  integrationsError: string | null;
  refreshIntegrations: () => Promise<void>;
  sessionUser: SessionUser;
  isAuthenticated: boolean;
  updateSessionUser: (patch: Partial<SessionUser>) => void;
  hydrateAuthenticatedWorkspace: (user?: AuthUserDto) => Promise<void>;
  logoutSession: () => Promise<void>;
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
      waveformPeaks: c.waveformPeaks ? [...c.waveformPeaks] : undefined,
      transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
      transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
      effects: c.effects ? { ...c.effects } : undefined,
      textStyle: c.textStyle ? { ...c.textStyle } : undefined,
    })),
    subtitles: project.subtitles ? project.subtitles.map((s) => ({ ...s })) : [],
    subtitleStyle: project.subtitleStyle ? { ...project.subtitleStyle } : undefined,
    subtitleMeta: project.subtitleMeta ? { ...project.subtitleMeta } : undefined,
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
        // Never treat persisted blob URLs as permanent references; IndexedDB hydration regenerates fresh URLs
        objectUrl: "",
        needsRelink: false,
      })),
      subtitles: Array.isArray(p.subtitles) ? p.subtitles : [],
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
  const [idbHydrating, setIdbHydrating] = useState(true);
  const [storageEstimate, setStorageEstimate] = useState<BrowserStorageEstimate | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [exportAttempts, setExportAttempts] = useState<ExportAttempt[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatusMap | null>(null);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [createProjectModalOpen, setCreateProjectModalOpen] = useState(false);

  const [undoStack, setUndoStack] = useState<Project[]>([]);
  const [redoStack, setRedoStack] = useState<Project[]>([]);
  const [lastLocalSaveAt, setLastLocalSaveAt] = useState<string | null>(initialSaved.savedAt);
  const [mongoSaveStatus, setMongoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastMongoSaveAt, setLastMongoSaveAt] = useState<string | null>(null);
  const [mongoSaveError, setMongoSaveError] = useState<string | null>(null);

  // Refs for leak-free Object URL tracking and async startup reconciliation (IndexedDB vs MongoDB fetch order)
  const activeObjectUrlsRef = useRef<Map<string, string>>(new Map());
  const mediaAssetsRef = useRef<MediaAsset[]>([]);
  const projectsRef = useRef<Project[]>(initialSaved.projects);
  const idbHydratedRef = useRef(false);
  const serverMediaIdByClientIdRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    mediaAssetsRef.current = mediaAssets;
  }, [mediaAssets]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const registerTrackedObjectUrl = useCallback((assetId: string, nextUrl: string) => {
    const prevUrl = activeObjectUrlsRef.current.get(assetId);
    if (prevUrl && prevUrl !== nextUrl && prevUrl.startsWith("blob:")) {
      URL.revokeObjectURL(prevUrl);
    }
    if (nextUrl.startsWith("blob:")) {
      activeObjectUrlsRef.current.set(assetId, nextUrl);
    } else {
      activeObjectUrlsRef.current.delete(assetId);
    }
  }, []);

  const revokeTrackedObjectUrl = useCallback((assetId: string) => {
    const prevUrl = activeObjectUrlsRef.current.get(assetId);
    if (prevUrl && prevUrl.startsWith("blob:")) {
      URL.revokeObjectURL(prevUrl);
    }
    activeObjectUrlsRef.current.delete(assetId);
  }, []);

  const refreshStorageEstimate = useCallback(async () => {
    const estimate = await estimateBrowserStorage();
    setStorageEstimate(estimate);
  }, []);

  const [sessionUser, setSessionUser] = useState<SessionUser>({
    displayName: "Elena Vance",
    email: "editor@local.session",
    workspaceName: "Local Studio Session",
    mode: "local_session",
    defaultFps: 24,
    defaultResolution: "1080p",
  });

  const isAuthenticated = sessionUser.mode === "authenticated";

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

  const hydrateAuthenticatedWorkspace = useCallback(
    async (explicitUser?: AuthUserDto) => {
      let user = explicitUser;
      if (!user) {
        const meRes = await fetchCurrentAuthUser();
        if (!meRes.ok || !meRes.data?.user) return;
        user = meRes.data.user;
      }

      setSessionUser({
        id: user.id,
        displayName: user.fullName,
        email: user.email,
        workspaceName: user.workspaceName,
        mode: "authenticated",
        defaultFps: user.defaultFps,
        defaultResolution: user.defaultResolution,
      });

      const [projRes, serverMediaRes] = await Promise.all([
        fetchServerProjects(),
        fetchServerMediaAssets(),
      ]);

      if (serverMediaRes.ok && serverMediaRes.data?.assets) {
        const nextMap = new Map<string, string>();
        for (const item of serverMediaRes.data.assets) {
          const serverId = String(item._id || item.id || "");
          if (serverId && item.storageKey) {
            nextMap.set(item.storageKey, serverId);
          }
        }
        serverMediaIdByClientIdRef.current = nextMap;
      }

      if (projRes.ok && projRes.data?.projects) {
        const serverProjects = projRes.data.projects.map(mapServerProjectToStudioProject);
        setProjects((prev) => {
          const prevById = new Map(prev.map((p) => [p.id, p]));
          const mergedServer = serverProjects.map((sp) => {
            const existing = prevById.get(sp.id);
            if (!existing) return sp;
            return {
              ...sp,
              clips: sp.clips.map((sc) => {
                const matchClip = existing.clips.find((ec) => ec.id === sc.id);
                if (matchClip && !matchClip.needsRelink && matchClip.objectUrl) {
                  return {
                    ...sc,
                    objectUrl: matchClip.objectUrl,
                    thumbnailUrl: matchClip.thumbnailUrl,
                    waveformPeaks: matchClip.waveformPeaks,
                    needsRelink: false,
                  };
                }
                return sc;
              }),
            };
          });
          const serverIds = new Set(mergedServer.map((p) => p.id));
          const localOnly = prev.filter((p) => !serverIds.has(p.id) && !MONGO_OBJECT_ID_RE.test(p.id));
          const combined = [...localOnly, ...mergedServer];
          return reconcileProjectsWithMediaAssets(
            combined,
            mediaAssetsRef.current,
            idbHydratedRef.current
          );
        });

        setActiveProjectIdState((curr) => {
          if (curr) return curr;
          return serverProjects[0]?.id ?? null;
        });
      }
    },
    []
  );

  const logoutSession = useCallback(async () => {
    await submitAuthLogout();
    serverMediaIdByClientIdRef.current.clear();
    setSessionUser({
      displayName: "Elena Vance",
      email: "editor@local.session",
      workspaceName: "Local Studio Session",
      mode: "local_session",
      defaultFps: 24,
      defaultResolution: "1080p",
    });
  }, []);

  // Hydrate persistent local media from IndexedDB and revoke object URLs cleanly on unmount
  useEffect(() => {
    let cancelled = false;

    const hydrateLocalIndexedDb = async () => {
      setIdbHydrating(true);
      try {
        const records = await getAllMediaFromIndexedDB();
        const hydrated = records.map(hydrateAssetFromStoredRecord);

        if (cancelled) {
          for (const asset of hydrated) {
            if (asset.objectUrl.startsWith("blob:")) {
              URL.revokeObjectURL(asset.objectUrl);
            }
          }
          return;
        }

        for (const asset of hydrated) {
          registerTrackedObjectUrl(asset.id, asset.objectUrl);
        }

        mediaAssetsRef.current = hydrated;
        idbHydratedRef.current = true;
        setMediaAssets(hydrated);
        setProjects((prev) => reconcileProjectsWithMediaAssets(prev, hydrated, true));

        // Lazily backfill real PCM waveform peaks for legacy audio files saved before Phase 2
        const audioNeedingPeaks = records.filter(
          (rec) => rec.kind === "audio" && (!rec.waveformPeaks || rec.waveformPeaks.length === 0)
        );
        if (audioNeedingPeaks.length > 0) {
          void (async () => {
            const backfilledById = new Map<string, number[]>();
            for (const rec of audioNeedingPeaks) {
              if (cancelled) return;
              const peaks = await extractAudioWaveformPeaks(rec.blob);
              if (peaks && peaks.length > 0) {
                backfilledById.set(rec.id, peaks);
                try {
                  await saveMediaToIndexedDB({
                    ...rec,
                    waveformPeaks: peaks,
                    updatedAt: new Date().toISOString(),
                  });
                } catch {
                  // Best-effort backfill only
                }
              }
            }
            if (cancelled || backfilledById.size === 0) return;
            const nextAssets = mediaAssetsRef.current.map((asset) => {
              const peaks = backfilledById.get(asset.id);
              return peaks ? { ...asset, waveformPeaks: peaks } : asset;
            });
            mediaAssetsRef.current = nextAssets;
            setMediaAssets(nextAssets);
            setProjects((prev) => reconcileProjectsWithMediaAssets(prev, nextAssets, true));
          })();
        }
      } catch (err) {
        idbHydratedRef.current = true;
        if (!cancelled) {
          setProjects((prev) => reconcileProjectsWithMediaAssets(prev, mediaAssetsRef.current, true));
          setMediaError(
            err instanceof Error
              ? `Local IndexedDB media could not be restored: ${err.message}`
              : "Local IndexedDB media storage is unavailable in this browser."
          );
        }
      } finally {
        if (!cancelled) {
          setIdbHydrating(false);
          void refreshStorageEstimate();
        }
      }
    };

    void hydrateLocalIndexedDb();
    void refreshIntegrations();
    void hydrateAuthenticatedWorkspace();

    return () => {
      cancelled = true;
      for (const url of activeObjectUrlsRef.current.values()) {
        if (url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
      }
      activeObjectUrlsRef.current.clear();
    };
  }, [
    hydrateAuthenticatedWorkspace,
    refreshIntegrations,
    refreshStorageEstimate,
    registerTrackedObjectUrl,
  ]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  const totalMediaBytes = useMemo(
    () => mediaAssets.reduce((sum, item) => sum + item.sizeBytes, 0),
    [mediaAssets]
  );

  const persistProjectsToLocalStorage = useCallback((list: Project[]) => {
    try {
      const savedAt = new Date().toISOString();
      const serializableProjects = list.map((p) => ({
        ...p,
        clips: p.clips.map((c) => ({
          ...c,
          // Never store temporary blob URLs or large waveform arrays in localStorage; IndexedDB restores both
          objectUrl: "",
          waveformPeaks: undefined,
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
  }, []);

  const saveTimelineLocally = useCallback(() => {
    persistProjectsToLocalStorage(projects);
  }, [persistProjectsToLocalStorage, projects]);

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
        subtitles: [],
        subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
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

  const renameProject = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name: trimmed, updatedAt: new Date().toISOString() } : p))
      );
      if (isAuthenticated && MONGO_OBJECT_ID_RE.test(id)) {
        void updateServerProject(id, { name: trimmed });
      }
    },
    [isAuthenticated]
  );

  const duplicateProject = useCallback((id: string) => {
    setProjects((prev) => {
      const source = prev.find((p) => p.id === id);
      if (!source) return prev;
      const now = new Date().toISOString();
      const clipIdMap = new Map<string, string>();
      const clonedClips = source.clips.map((c) => {
        const nextClipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        clipIdMap.set(c.id, nextClipId);
        return {
          ...c,
          id: nextClipId,
          transitionIn: c.transitionIn ? { ...c.transitionIn } : undefined,
          transitionOut: c.transitionOut ? { ...c.transitionOut } : undefined,
          effects: c.effects ? { ...c.effects } : undefined,
          textStyle: c.textStyle ? { ...c.textStyle } : undefined,
        };
      });
      const copy: Project = {
        ...cloneProject(source),
        id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `${source.name} (Copy)`,
        createdAt: now,
        updatedAt: now,
        clips: clonedClips,
        subtitles: (source.subtitles ?? []).map((s, idx) => ({
          ...s,
          id: `sub_${Date.now()}_${idx}`,
          clipId: s.clipId ? clipIdMap.get(s.clipId) ?? s.clipId : undefined,
        })),
      };
      return [copy, ...prev];
    });
  }, []);

  const cleanupOrphanedAssets = useCallback(
    async (candidateAssetIds: string[], remainingProjects: Project[]): Promise<number> => {
      const orphanedIds = findOrphanedAssetIds(candidateAssetIds, remainingProjects);
      if (orphanedIds.length === 0) return 0;

      const orphanedSet = new Set(orphanedIds);
      for (const assetId of orphanedIds) {
        try {
          await deleteMediaFromIndexedDB(assetId);
        } catch {
          // Continue revoking/cleaning remaining entries even if one IDB record is already missing
        }
        revokeTrackedObjectUrl(assetId);

        const serverMediaId = serverMediaIdByClientIdRef.current.get(assetId);
        if (serverMediaId && isAuthenticated) {
          serverMediaIdByClientIdRef.current.delete(assetId);
          void deleteServerMediaMetadata(serverMediaId);
        }
      }

      setMediaAssets((prev) => prev.filter((a) => !orphanedSet.has(a.id)));
      void refreshStorageEstimate();
      return orphanedIds.length;
    },
    [isAuthenticated, refreshStorageEstimate, revokeTrackedObjectUrl]
  );

  const deleteProject = useCallback(
    (id: string) => {
      const currentProjects = projectsRef.current;
      const targetProject = currentProjects.find((p) => p.id === id);
      const remainingProjects = currentProjects.filter((p) => p.id !== id);
      const candidateAssetIds = targetProject
        ? targetProject.clips
            .filter((c) => c.kind !== "text" && Boolean(c.assetId))
            .map((c) => c.assetId)
        : [];

      setProjects(remainingProjects);
      persistProjectsToLocalStorage(remainingProjects);
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
      if (isAuthenticated && MONGO_OBJECT_ID_RE.test(id)) {
        void deleteServerProject(id);
      }
      if (candidateAssetIds.length > 0) {
        void cleanupOrphanedAssets(candidateAssetIds, remainingProjects);
      }
    },
    [
      activeProjectId,
      cleanupOrphanedAssets,
      isAuthenticated,
      persistProjectsToLocalStorage,
      setActiveProjectId,
    ]
  );

  const syncAssetMetadataToMongo = useCallback(
    async (asset: MediaAsset) => {
      if (!isAuthenticated || asset.kind === "text") return;
      if (serverMediaIdByClientIdRef.current.has(asset.id)) return;

      const projectId =
        activeProjectId && MONGO_OBJECT_ID_RE.test(activeProjectId) ? activeProjectId : null;

      const res = await createServerMediaMetadata({
        projectId,
        name: asset.name,
        kind: asset.kind,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        duration: Math.max(0, Number(asset.duration.toFixed(2))),
        ...(asset.width ? { width: Math.round(asset.width) } : {}),
        ...(asset.height ? { height: Math.round(asset.height) } : {}),
        storageProvider: "local_browser",
        storageKey: asset.id,
      });

      if (res.ok && res.data?.asset) {
        const serverId = String(res.data.asset._id || res.data.asset.id || "");
        if (serverId) {
          serverMediaIdByClientIdRef.current.set(asset.id, serverId);
        }
      }
    },
    [activeProjectId, isAuthenticated]
  );

  const uploadLocalFiles = useCallback(
    async (files: FileList | File[]): Promise<MediaAsset[]> => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return [];
      setUploadingMedia(true);
      setMediaError(null);

      const added: MediaAsset[] = [];
      const failures: string[] = [];

      for (const file of fileArray) {
        let extractedAsset: MediaAsset | null = null;
        try {
          const quotaCheck = await checkStorageQuotaForBytes(file.size, file.name);
          if (!quotaCheck.canFit) {
            throw new MediaStorageQuotaError(
              quotaCheck.reason || `Browser storage quota exceeded for '${file.name}'.`,
              file.size,
              quotaCheck.estimate.availableBytes
            );
          }

          extractedAsset = await extractMediaAsset(file);
          const now = new Date().toISOString();
          const record: StoredMediaRecord = {
            id: extractedAsset.id,
            name: extractedAsset.name,
            kind: extractedAsset.kind as Exclude<MediaKind, "text">,
            mimeType: extractedAsset.mimeType,
            sizeBytes: extractedAsset.sizeBytes,
            duration: extractedAsset.duration,
            width: extractedAsset.width,
            height: extractedAsset.height,
            thumbnailDataUrl: extractedAsset.thumbnailUrl?.startsWith("data:")
              ? extractedAsset.thumbnailUrl
              : undefined,
            waveformPeaks: extractedAsset.waveformPeaks,
            blob: file,
            addedAt: extractedAsset.addedAt,
            updatedAt: now,
          };

          await saveMediaToIndexedDB(record);
          registerTrackedObjectUrl(extractedAsset.id, extractedAsset.objectUrl);
          added.push(extractedAsset);
          void syncAssetMetadataToMongo(extractedAsset);
        } catch (err) {
          if (extractedAsset?.objectUrl.startsWith("blob:")) {
            URL.revokeObjectURL(extractedAsset.objectUrl);
          }
          failures.push(err instanceof Error ? err.message : `Could not save ${file.name}`);
        }
      }

      if (added.length > 0) {
        setMediaAssets((prev) => [...added, ...prev]);

        // Reconnect any restored clips missing media whose stable ID or original filename/size matches
        setProjects((prevProjects) =>
          prevProjects.map((proj) => {
            let changed = false;
            const nextClips = proj.clips.map((clip) => {
              if (!clip.needsRelink) return clip;
              const match =
                added.find((a) => a.id === clip.assetId) ??
                added.find(
                  (a) =>
                    a.name === (clip.sourceName || clip.name) &&
                    (!clip.sourceSizeBytes || a.sizeBytes === clip.sourceSizeBytes)
                );
              if (!match) return clip;
              changed = true;
              return {
                ...clip,
                assetId: match.id,
                objectUrl: match.objectUrl,
                thumbnailUrl: match.thumbnailUrl ?? clip.thumbnailUrl,
                waveformPeaks: match.waveformPeaks ?? clip.waveformPeaks,
                sourceName: match.name,
                sourceSizeBytes: match.sizeBytes,
                sourceMimeType: match.mimeType,
                needsRelink: false,
              };
            });
            return changed
              ? { ...proj, updatedAt: new Date().toISOString(), clips: nextClips }
              : proj;
          })
        );
      }

      if (failures.length > 0) {
        setMediaError(failures.join(" "));
      }

      await refreshStorageEstimate();
      setUploadingMedia(false);
      return added;
    },
    [refreshStorageEstimate, registerTrackedObjectUrl, syncAssetMetadataToMongo]
  );

  const relinkMissingClipAsset = useCallback(
    async (assetId: string, file: File): Promise<{ ok: boolean; error?: string }> => {
      setUploadingMedia(true);
      setMediaError(null);
      let extracted: MediaAsset | null = null;
      try {
        const quotaCheck = await checkStorageQuotaForBytes(file.size, file.name);
        if (!quotaCheck.canFit) {
          throw new MediaStorageQuotaError(
            quotaCheck.reason || `Browser storage quota exceeded for '${file.name}'.`,
            file.size,
            quotaCheck.estimate.availableBytes
          );
        }

        extracted = await extractMediaAsset(file, assetId);
        const now = new Date().toISOString();
        await saveMediaToIndexedDB({
          id: assetId,
          name: extracted.name,
          kind: extracted.kind as Exclude<MediaKind, "text">,
          mimeType: extracted.mimeType,
          sizeBytes: extracted.sizeBytes,
          duration: extracted.duration,
          width: extracted.width,
          height: extracted.height,
          thumbnailDataUrl: extracted.thumbnailUrl?.startsWith("data:")
            ? extracted.thumbnailUrl
            : undefined,
          waveformPeaks: extracted.waveformPeaks,
          blob: file,
          addedAt: extracted.addedAt,
          updatedAt: now,
        });

        registerTrackedObjectUrl(assetId, extracted.objectUrl);

        setMediaAssets((prev) => {
          const without = prev.filter((a) => a.id !== assetId);
          return [extracted!, ...without];
        });

        setProjects((prev) =>
          prev.map((proj) => {
            let changed = false;
            const nextClips = proj.clips.map((clip) => {
              if (clip.assetId !== assetId) return clip;
              changed = true;
              return {
                ...clip,
                objectUrl: extracted!.objectUrl,
                thumbnailUrl: extracted!.thumbnailUrl ?? clip.thumbnailUrl,
                waveformPeaks: extracted!.waveformPeaks ?? clip.waveformPeaks,
                sourceName: extracted!.name,
                sourceSizeBytes: extracted!.sizeBytes,
                sourceMimeType: extracted!.mimeType,
                needsRelink: false,
              };
            });
            return changed
              ? { ...proj, updatedAt: new Date().toISOString(), clips: nextClips }
              : proj;
          })
        );

        void syncAssetMetadataToMongo(extracted);
        await refreshStorageEstimate();
        setUploadingMedia(false);
        return { ok: true };
      } catch (err) {
        if (extracted?.objectUrl.startsWith("blob:")) {
          URL.revokeObjectURL(extracted.objectUrl);
        }
        const msg = err instanceof Error ? err.message : `Could not relink '${file.name}'.`;
        setMediaError(msg);
        setUploadingMedia(false);
        return { ok: false, error: msg };
      }
    },
    [refreshStorageEstimate, registerTrackedObjectUrl, syncAssetMetadataToMongo]
  );

  const getProjectsUsingAsset = useCallback(
    (assetId: string): Project[] => findProjectsUsingAsset(assetId, projectsRef.current),
    []
  );

  const removeMediaAsset = useCallback(
    async (
      assetId: string,
      force = false
    ): Promise<{ deleted: boolean; blockedByProjects?: Project[]; error?: string }> => {
      const referencingProjects = findProjectsUsingAsset(assetId, projectsRef.current);
      if (referencingProjects.length > 0 && !force) {
        const names = referencingProjects.map((p) => `'${p.name}'`).join(", ");
        const msg = `Cannot delete media while still used by ${referencingProjects.length} project(s): ${names}.`;
        setMediaError(msg);
        return { deleted: false, blockedByProjects: referencingProjects, error: msg };
      }

      try {
        await deleteMediaFromIndexedDB(assetId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to remove media from IndexedDB.";
        setMediaError(msg);
        return { deleted: false, error: msg };
      }

      revokeTrackedObjectUrl(assetId);
      setMediaAssets((prev) => prev.filter((a) => a.id !== assetId));

      const serverMediaId = serverMediaIdByClientIdRef.current.get(assetId);
      if (serverMediaId && isAuthenticated) {
        serverMediaIdByClientIdRef.current.delete(assetId);
        void deleteServerMediaMetadata(serverMediaId);
      }

      if (referencingProjects.length > 0) {
        setProjects((prev) =>
          prev.map((proj) => {
            const removedClipIds = new Set(
              proj.clips.filter((c) => c.assetId === assetId).map((c) => c.id)
            );
            if (removedClipIds.size === 0) return proj;
            return {
              ...proj,
              updatedAt: new Date().toISOString(),
              clips: proj.clips.filter((c) => c.assetId !== assetId),
              subtitles: (proj.subtitles ?? []).filter(
                (s) => !s.clipId || !removedClipIds.has(s.clipId)
              ),
            };
          })
        );
      }

      await refreshStorageEstimate();
      return { deleted: true };
    },
    [isAuthenticated, refreshStorageEstimate, revokeTrackedObjectUrl]
  );

  const cleanupUnusedMediaAssets = useCallback(async (): Promise<number> => {
    const allIds = mediaAssetsRef.current.map((a) => a.id);
    return cleanupOrphanedAssets(allIds, projectsRef.current);
  }, [cleanupOrphanedAssets]);

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
    const assetsById = new Map(mediaAssetsRef.current.map((a) => [a.id, a]));
    setProjects((prev) => {
      const current = prev.find((p) => p.id === activeProjectId);
      if (current) {
        setRedoStack((r) => [...r.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]);
      }
      const restored = reconcileProjectWithMediaAssets(
        cloneProject(previous),
        assetsById,
        idbHydratedRef.current
      );
      return prev.map((p) => (p.id === activeProjectId ? restored : p));
    });
  }, [activeProjectId, undoStack]);

  const redo = useCallback(() => {
    if (!activeProjectId || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((stack) => stack.slice(0, -1));
    const assetsById = new Map(mediaAssetsRef.current.map((a) => [a.id, a]));
    setProjects((prev) => {
      const current = prev.find((p) => p.id === activeProjectId);
      if (current) {
        setUndoStack((u) => [...u.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(current)]);
      }
      const restored = reconcileProjectWithMediaAssets(
        cloneProject(next),
        assetsById,
        idbHydratedRef.current
      );
      return prev.map((p) => (p.id === activeProjectId ? restored : p));
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
            subtitles: [],
            subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
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
            duration: Math.max(0.5, Number(asset.duration.toFixed(2))),
            inPoint: 0,
            sourceDuration: asset.duration,
            volume: 1,
            muted: false,
            fadeInSec: 0,
            fadeOutSec: 0,
            ...(asset.kind === "audio"
              ? {
                  duckingEnabled: false,
                  duckingAmount: DEFAULT_DUCKING_AMOUNT,
                }
              : {}),
            speed: 1,
            opacity: 1,
            thumbnailUrl: asset.thumbnailUrl,
            waveformPeaks: asset.waveformPeaks,
            objectUrl: asset.objectUrl,
            sourceName: asset.name,
            sourceSizeBytes: asset.sizeBytes,
            sourceMimeType: asset.mimeType,
            needsRelink: false,
          };

          const nextClips =
            explicitStartTime !== undefined
              ? insertClipOnTrack(proj.clips, clip, clip.startTime)
              : [...proj.clips, clip];
          createdClip = nextClips.find((c) => c.id === clip.id) ?? clip;

          setUndoStack((stack) => [...stack.slice(-(MAX_HISTORY_ENTRIES - 1)), cloneProject(proj)]);
          setRedoStack([]);

          return {
            ...proj,
            tracks,
            updatedAt: new Date().toISOString(),
            clips: nextClips,
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
          explicitStartTime !== undefined
            ? Math.max(0, Number(explicitStartTime.toFixed(2)))
            : Number(trackEnd.toFixed(2));

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
    (
      clipId: string,
      patch: Partial<TimelineClip>,
      recordHistory = true,
      syncBase?: { clip: TimelineClip; subtitles?: SubtitleSegment[] }
    ) => {
      mutateActiveProject((proj) => {
        const beforeClip = proj.clips.find((c) => c.id === clipId);
        if (!beforeClip) return proj;
        const afterClip = { ...beforeClip, ...patch };
        const nextClips = proj.clips.map((c) => (c.id === clipId ? afterClip : c));
        const nextSubtitles = syncSubtitlesForClipUpdate(
          syncBase ? syncBase.subtitles : proj.subtitles,
          syncBase ? syncBase.clip : beforeClip,
          afterClip
        );
        return {
          ...proj,
          clips: nextClips,
          subtitles: nextSubtitles,
        };
      }, recordHistory);
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

        const targetIdx = result.clips.findIndex((c) => c.id === clipId);
        const leftClip = targetIdx >= 0 ? result.clips[targetIdx] : null;
        const rightClip = targetIdx >= 0 ? result.clips[targetIdx + 1] : null;

        const nextSubtitles =
          leftClip && rightClip
            ? syncSubtitlesForClipSplit(proj.subtitles, target, leftClip, rightClip)
            : proj.subtitles ?? [];

        return {
          ...proj,
          clips: result.clips,
          subtitles: nextSubtitles,
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

        const nextProj = {
          ...proj,
          clips: result.clips,
        };
        return {
          ...nextProj,
          subtitles: syncSubtitlesForProjectClips(proj, nextProj),
        };
      }, true);
      return didMove;
    },
    [mutateActiveProject]
  );

  const reorderClipToSlot = useCallback(
    (clipId: string, targetIndex: number): boolean => {
      let didMove = false;
      mutateActiveProject((proj) => {
        const target = proj.clips.find((c) => c.id === clipId);
        if (!target) return proj;
        const track = proj.tracks.find((t) => t.id === target.trackId);
        if (track?.locked) return proj;

        const result = reorderClipToIndex(proj.clips, clipId, targetIndex);
        didMove = result.moved;
        if (!result.moved) return proj;

        const nextProj = {
          ...proj,
          clips: result.clips,
        };
        return {
          ...nextProj,
          subtitles: syncSubtitlesForProjectClips(proj, nextProj),
        };
      }, true);
      return didMove;
    },
    [mutateActiveProject]
  );

  const moveClipOnTimeline = useCallback(
    (
      clipId: string,
      desiredStartTime: number,
      targetTrackId?: string,
      recordHistory = true,
      syncBase?: { clips: TimelineClip[]; subtitles?: SubtitleSegment[] }
    ) => {
      mutateActiveProject((proj) => {
        const baseClips = syncBase ? syncBase.clips : proj.clips;
        const target = baseClips.find((c) => c.id === clipId);
        if (!target) return proj;

        const destTrackId = targetTrackId || target.trackId;
        const destTrack = proj.tracks.find((t) => t.id === destTrackId);
        if (destTrack?.locked) return proj;

        const movedResult = moveClipWithTrackOrdering(
          baseClips,
          clipId,
          desiredStartTime,
          destTrackId
        );
        const baseProj = syncBase
          ? { ...proj, clips: syncBase.clips, subtitles: syncBase.subtitles }
          : proj;
        const nextProj = {
          ...proj,
          clips: movedResult.clips,
        };
        return {
          ...nextProj,
          subtitles: syncSubtitlesForProjectClips(baseProj, nextProj),
        };
      }, recordHistory);
    },
    [mutateActiveProject]
  );

  const packTrackGaps = useCallback(
    (trackId: string): boolean => {
      let didChange = false;
      mutateActiveProject((proj) => {
        const track = proj.tracks.find((t) => t.id === trackId);
        if (track?.locked) return proj;

        const result = packTrackClips(proj.clips, trackId);
        didChange = result.changed;
        if (!result.changed) return proj;

        const nextProj = {
          ...proj,
          clips: result.clips,
        };
        return {
          ...nextProj,
          subtitles: syncSubtitlesForProjectClips(proj, nextProj),
        };
      }, true);
      return didChange;
    },
    [mutateActiveProject]
  );

  const duplicateClip = useCallback(
    (clipId: string): TimelineClip | null => {
      let created: TimelineClip | null = null;
      mutateActiveProject((proj) => {
        const target = proj.clips.find((c) => c.id === clipId);
        if (!target) return proj;
        const track = proj.tracks.find((t) => t.id === target.trackId);
        if (track?.locked) return proj;

        const { clips: nextClips, duplicated } = duplicateClipWithoutOverlap(proj.clips, clipId);
        if (!duplicated) return proj;
        created = duplicated;
        const nextProj = {
          ...proj,
          clips: nextClips,
        };
        return {
          ...nextProj,
          subtitles: syncSubtitlesForProjectClips(proj, nextProj),
        };
      }, true);
      return created;
    },
    [mutateActiveProject]
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          clips: proj.clips.filter((c) => c.id !== clipId),
          subtitles: syncSubtitlesForClipDelete(proj.subtitles, clipId),
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
        const syncedSubs = syncSubtitlesForProjectClips(proj, result.project);
        result = {
          ...result,
          project: {
            ...result.project,
            subtitles: syncedSubs,
          },
        };
        return result.project;
      }, true);

      return result;
    },
    [activeProject, mutateActiveProject]
  );

  const replaceClipSubtitles = useCallback(
    (
      clipId: string,
      segments: SubtitleSegment[],
      meta?: SubtitleMetadata
    ): { subtitles: SubtitleSegment[]; style: SubtitleStyle } => {
      let mergedSubtitles: SubtitleSegment[] = sortSubtitles(segments);
      let nextStyle: SubtitleStyle = {
        ...DEFAULT_SUBTITLE_STYLE,
        ...(activeProject?.subtitleStyle ?? {}),
        enabled: true,
      };

      mutateActiveProject((proj) => {
        const otherClipSubs = (proj.subtitles ?? []).filter((s) => s.clipId !== clipId);
        mergedSubtitles = sortSubtitles([...otherClipSubs, ...segments]);
        nextStyle = {
          ...DEFAULT_SUBTITLE_STYLE,
          ...(proj.subtitleStyle ?? {}),
          enabled: true,
        };
        return {
          ...proj,
          subtitles: mergedSubtitles,
          subtitleStyle: nextStyle,
          subtitleMeta: meta ?? proj.subtitleMeta,
        };
      }, true);

      return { subtitles: mergedSubtitles, style: nextStyle };
    },
    [activeProject?.subtitleStyle, mutateActiveProject]
  );

  const updateSubtitleSegment = useCallback(
    (segmentId: string, patch: Partial<SubtitleSegment>, recordHistory = true) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          subtitles: sortSubtitles(
            (proj.subtitles ?? []).map((s) => (s.id === segmentId ? { ...s, ...patch } : s))
          ),
        }),
        recordHistory
      );
    },
    [mutateActiveProject]
  );

  const addSubtitleSegment = useCallback(
    (
      startTime: number,
      endTime?: number,
      text = "New subtitle line",
      clipId?: string
    ): SubtitleSegment | null => {
      if (!activeProjectId) return null;
      const start = Math.max(0, Number(startTime.toFixed(2)));
      const end = Math.max(
        Number((start + 0.5).toFixed(2)),
        Number((endTime ?? start + 2.5).toFixed(2))
      );
      const created: SubtitleSegment = {
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        start,
        end,
        text,
        ...(clipId ? { clipId } : {}),
      };
      mutateActiveProject(
        (proj) => ({
          ...proj,
          subtitles: sortSubtitles([...(proj.subtitles ?? []), created]),
          subtitleStyle: {
            ...DEFAULT_SUBTITLE_STYLE,
            ...(proj.subtitleStyle ?? {}),
            enabled: true,
          },
        }),
        true
      );
      return created;
    },
    [activeProjectId, mutateActiveProject]
  );

  const deleteSubtitleSegment = useCallback(
    (segmentId: string) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          subtitles: (proj.subtitles ?? []).filter((s) => s.id !== segmentId),
        }),
        true
      );
    },
    [mutateActiveProject]
  );

  const updateSubtitleStyle = useCallback(
    (patch: Partial<SubtitleStyle>, recordHistory = true) => {
      mutateActiveProject(
        (proj) => ({
          ...proj,
          subtitleStyle: {
            ...DEFAULT_SUBTITLE_STYLE,
            ...(proj.subtitleStyle ?? {}),
            ...patch,
          },
        }),
        recordHistory
      );
    },
    [mutateActiveProject]
  );

  const saveSubtitlesToMongo = useCallback(
    async (override?: {
      projectId?: string;
      subtitles?: SubtitleSegment[];
      subtitleStyle?: SubtitleStyle;
      subtitleMeta?: SubtitleMetadata;
    }): Promise<{ ok: boolean; error?: string; projectId?: string }> => {
      const targetId = override?.projectId ?? activeProjectId;
      const targetProject = projects.find((p) => p.id === targetId) ?? activeProject;
      if (!targetProject) {
        return { ok: false, error: "No active project selected." };
      }

      if (!isAuthenticated) {
        return {
          ok: false,
          error: "Sign in to save subtitles to your MongoDB project.",
        };
      }

      const payloadSubtitles = override?.subtitles ?? targetProject.subtitles ?? [];
      const payloadStyle = override?.subtitleStyle ?? {
        ...DEFAULT_SUBTITLE_STYLE,
        ...(targetProject.subtitleStyle ?? {}),
      };
      const payloadMeta = override?.subtitleMeta ?? targetProject.subtitleMeta;

      const projectWithLatest: Project = {
        ...targetProject,
        subtitles: payloadSubtitles,
        subtitleStyle: payloadStyle,
        subtitleMeta: payloadMeta,
      };

      if (MONGO_OBJECT_ID_RE.test(targetProject.id)) {
        const res = await saveServerProjectSubtitles(targetProject.id, {
          subtitles: payloadSubtitles,
          subtitleStyle: payloadStyle,
          subtitleMeta: payloadMeta,
        });
        if (res.ok) {
          return { ok: true, projectId: targetProject.id };
        }
        if (res.status !== 404) {
          return { ok: false, error: res.error || "Failed to save subtitles to MongoDB." };
        }
      }

      // Project is local-only or missing on server: create it in MongoDB and upgrade its ID
      const createdRes = await createServerProject(projectWithLatest);
      if (!createdRes.ok || !createdRes.data?.project) {
        return {
          ok: false,
          error: createdRes.error || "Failed to create project in MongoDB.",
        };
      }

      const mongoId = String(createdRes.data.project._id || createdRes.data.project.id || "");
      if (!mongoId) {
        return { ok: false, error: "Server returned a project without an ID." };
      }

      setProjects((prev) => {
        const nextList = prev.map((p) =>
          p.id === targetProject.id ? { ...p, id: mongoId, updatedAt: new Date().toISOString() } : p
        );
        persistProjectsToLocalStorage(nextList);
        return nextList;
      });
      setActiveProjectIdState((curr) => (curr === targetProject.id ? mongoId : curr));

      return { ok: true, projectId: mongoId };
    },
    [activeProject, activeProjectId, isAuthenticated, persistProjectsToLocalStorage, projects]
  );

  const saveTimelineToMongo = useCallback(
    async (
      overrideProjectId?: string
    ): Promise<{ ok: boolean; error?: string; projectId?: string }> => {
      const targetId = overrideProjectId ?? activeProjectId;
      const targetProject = projects.find((p) => p.id === targetId) ?? activeProject;
      if (!targetProject) {
        return { ok: false, error: "No active project selected." };
      }

      if (!isAuthenticated) {
        return {
          ok: false,
          error: "Sign in to persist timeline changes in MongoDB.",
        };
      }

      setMongoSaveStatus("saving");
      setMongoSaveError(null);

      if (MONGO_OBJECT_ID_RE.test(targetProject.id)) {
        const res = await saveServerProjectTimeline(targetProject.id, targetProject);
        if (res.ok) {
          const savedAt = new Date().toISOString();
          setMongoSaveStatus("saved");
          setLastMongoSaveAt(savedAt);
          return { ok: true, projectId: targetProject.id };
        }
        if (res.status !== 404) {
          const errMsg = res.error || "Failed to save timeline to MongoDB.";
          setMongoSaveStatus("error");
          setMongoSaveError(errMsg);
          return { ok: false, error: errMsg };
        }
      }

      const createdRes = await createServerProject(targetProject);
      if (!createdRes.ok || !createdRes.data?.project) {
        const errMsg = createdRes.error || "Failed to create project in MongoDB.";
        setMongoSaveStatus("error");
        setMongoSaveError(errMsg);
        return { ok: false, error: errMsg };
      }

      const mongoId = String(createdRes.data.project._id || createdRes.data.project.id || "");
      if (!mongoId) {
        const errMsg = "Server returned a project without an ID.";
        setMongoSaveStatus("error");
        setMongoSaveError(errMsg);
        return { ok: false, error: errMsg };
      }

      setProjects((prev) => {
        const nextList = prev.map((p) =>
          p.id === targetProject.id ? { ...p, id: mongoId } : p
        );
        persistProjectsToLocalStorage(nextList);
        return nextList;
      });
      setActiveProjectIdState((curr) => (curr === targetProject.id ? mongoId : curr));

      const savedAt = new Date().toISOString();
      setMongoSaveStatus("saved");
      setLastMongoSaveAt(savedAt);
      return { ok: true, projectId: mongoId };
    },
    [activeProject, activeProjectId, isAuthenticated, persistProjectsToLocalStorage, projects]
  );

  // Automatic debounced MongoDB persistence when authenticated user edits a Mongo-backed project
  useEffect(() => {
    if (!isAuthenticated || !activeProject) return;
    if (!MONGO_OBJECT_ID_RE.test(activeProject.id) && activeProject.clips.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveTimelineToMongo(activeProject.id);
    }, 1500);

    return () => window.clearTimeout(timer);
    // Re-run whenever active project's timeline revision changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, activeProject?.id, activeProject?.updatedAt]);

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
    idbHydrating,
    storageEstimate,
    refreshStorageEstimate,
    mediaError,
    clearMediaError: () => setMediaError(null),
    uploadLocalFiles,
    relinkMissingClipAsset,
    getProjectsUsingAsset,
    removeMediaAsset,
    cleanupUnusedMediaAssets,
    totalMediaBytes,
    addClipToTimeline,
    addTextOverlay,
    updateClip,
    updateTextStyle,
    commitProjectSnapshot,
    splitClipAtTime,
    reorderClip,
    reorderClipToSlot,
    moveClipOnTimeline,
    packTrackGaps,
    duplicateClip,
    deleteClip,
    toggleTrackMute,
    toggleTrackLock,
    applyAiEditPlan,
    replaceClipSubtitles,
    updateSubtitleSegment,
    addSubtitleSegment,
    deleteSubtitleSegment,
    updateSubtitleStyle,
    saveSubtitlesToMongo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undo,
    redo,
    lastLocalSaveAt,
    saveTimelineLocally,
    mongoSaveStatus,
    lastMongoSaveAt,
    mongoSaveError,
    saveTimelineToMongo,
    exportAttempts,
    recordExportAttempt,
    integrations,
    integrationsLoading,
    integrationsError,
    refreshIntegrations,
    sessionUser,
    isAuthenticated,
    updateSessionUser,
    hydrateAuthenticatedWorkspace,
    logoutSession,
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
