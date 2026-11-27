import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Clock,
  FileText,
  Film,
  FolderOpen,
  LogIn,
  RotateCcw,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { StoryboardReviewPanel } from "../components/generator/StoryboardReviewPanel";
import { useStudio } from "../context/StudioContext";
import {
  cancelCaptionJob,
  cancelTtsJob,
  createServerStoryboardDraft,
  deleteServerStoryboardDraft,
  fetchCaptionsStatus,
  fetchServerStoryboardDrafts,
  fetchTtsStatus,
  fetchTtsVoices,
  generateAiStoryboard,
  generateAudioCaptions,
  generateTtsVoiceover,
  importStockMediaApi,
  updateServerStoryboardDraft,
  type ServerStoryboardDraftDto,
  type StockSearchItemDto,
} from "../services/api";
import type {
  AspectRatioOption,
  CaptionGenerationMode,
  CaptionsStatusInfo,
  GeneratedSlideConfig,
  MediaAsset,
  StoryboardCaptionPreference,
  StoryboardCaptionSegment,
  StoryboardDraftRecord,
  StoryboardGenerationStatus,
  StoryboardLanguage,
  StoryboardSceneCaptions,
  StoryboardSceneVoiceover,
  StoryboardStyle,
  StoryboardTargetDuration,
  StoryboardVoiceoverPreference,
  StoryboardVoiceoverSettings,
  TtsStatusInfo,
  TtsVoiceOption,
  VideoGenerationRequest,
  VideoGeneratorMode,
  VideoStoryboard,
} from "../types/studio";
import { detectMediaKind } from "../utils/media";
import {
  CAPTION_PREFERENCE_OPTIONS,
  clearLocalStoryboardDraft,
  loadLocalStoryboardDraft,
  MAX_STORYBOARD_SCENES,
  saveLocalStoryboardDraft,
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_LANGUAGES,
  STORYBOARD_STYLES,
  STORYBOARD_TARGET_DURATIONS,
  StoryboardGenerationInputSchema,
  validateStoryboardInvariants,
  VOICEOVER_PREFERENCE_OPTIONS,
} from "../utils/storyboard";
import {
  buildAudioTranscriptionCaptionsRecord,
  computeCaptionFingerprint,
  computeStoryboardCaptionsSummary,
  evaluateSceneCaptionsReadiness,
  generateScriptCaptionsForScene,
  getDefaultCaptionSettings,
  resolveEffectiveCaptionLanguage,
  roundTo3,
} from "../utils/storyboardCaptions";
import {
  autoMatchStoryboardScenes,
  computeStoryboardMediaSummary,
  createAssignmentFromAsset,
} from "../utils/storyboardMedia";
import {
  computeNarrationFingerprint,
  computeStoryboardVoiceoverSummary,
  evaluateSceneVoiceoverReadiness,
  pickDefaultVoiceForLanguage,
  resolveEffectiveSceneVoiceParams,
} from "../utils/storyboardVoiceover";

export function AiGeneratorPage() {
  const {
    isAuthenticated,
    sessionUser,
    integrations,
    navigate,
    mediaAssets,
    idbHydrating,
    importMediaFileWithMetadata,
    relinkMissingClipAsset,
  } = useStudio();

  const [mode, setMode] = useState<VideoGeneratorMode>("prompt-to-video");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [targetDurationSec, setTargetDurationSec] = useState<StoryboardTargetDuration>(30);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("16:9");
  const [style, setStyle] = useState<StoryboardStyle>("Cinematic");
  const [language, setLanguage] = useState<StoryboardLanguage>("English");
  const [voiceoverEnabled, setVoiceoverEnabled] = useState(true);
  const [voiceoverPreference, setVoiceoverPreference] =
    useState<StoryboardVoiceoverPreference>("natural_narrator");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionStyle, setCaptionStyle] =
    useState<StoryboardCaptionPreference>("clean_subtitles");
  const [targetAudience, setTargetAudience] = useState("");
  const [additionalInstructions, setAdditionalInstructions] = useState("");

  const [generationStatus, setGenerationStatus] =
    useState<StoryboardGenerationStatus>("idle");
  const [errorBanner, setErrorBanner] = useState<{
    kind: "error" | "integration" | "cancelled";
    title: string;
    message: string;
    endpoint?: string;
    retryable?: boolean;
  } | null>(null);

  const [storyboard, setStoryboard] = useState<VideoStoryboard | null>(null);
  const [activeServerDraftId, setActiveServerDraftId] = useState<string | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<ServerStoryboardDraftDto[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  const [savingDraft, setSavingDraft] = useState(false);
  const [saveStatusMessage, setSaveStatusMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mediaPrepActive, setMediaPrepActive] = useState(false);
  const [mediaPrepStatusMessage, setMediaPrepStatusMessage] = useState<string | null>(null);

  const [ttsStatus, setTtsStatus] = useState<TtsStatusInfo | null>(null);
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceOption[]>([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [generatingVoiceoverSceneIds, setGeneratingVoiceoverSceneIds] = useState<Set<string>>(
    () => new Set()
  );
  const [voiceoverBatchState, setVoiceoverBatchState] = useState<{
    active: boolean;
    currentSceneId: string | null;
    completedCount: number;
    totalCount: number;
    statusMessage: string | null;
  }>({
    active: false,
    currentSceneId: null,
    completedCount: 0,
    totalCount: 0,
    statusMessage: null,
  });
  const [activeAudioSceneId, setActiveAudioSceneId] = useState<string | null>(null);

  const [captionsStatus, setCaptionsStatus] = useState<CaptionsStatusInfo | null>(null);
  const [captionsLoading, setCaptionsLoading] = useState(false);
  const [captionsError, setCaptionsError] = useState<string | null>(null);
  const [generatingCaptionSceneIds, setGeneratingCaptionSceneIds] = useState<Set<string>>(
    () => new Set()
  );
  const [captionBatchState, setCaptionBatchState] = useState<{
    active: boolean;
    mode: CaptionGenerationMode;
    currentSceneId: string | null;
    completedCount: number;
    totalCount: number;
    statusMessage: string | null;
  }>({
    active: false,
    mode: "script",
    currentSceneId: null,
    completedCount: 0,
    totalCount: 0,
    statusMessage: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaPrepAbortRef = useRef<AbortController | null>(null);
  const activeVoiceoverJobsRef = useRef<
    Map<string, { controller: AbortController; clientJobId: string }>
  >(new Map());
  const batchVoiceoverCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const activeCaptionJobsRef = useRef<
    Map<string, { controller: AbortController; clientJobId: string }>
  >(new Map());
  const batchCaptionCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const storyboardRef = useRef<VideoStoryboard | null>(storyboard);
  storyboardRef.current = storyboard;
  const generatingSceneIdsRef = useRef<Set<string>>(generatingVoiceoverSceneIds);
  generatingSceneIdsRef.current = generatingVoiceoverSceneIds;
  const generatingCaptionSceneIdsRef = useRef<Set<string>>(generatingCaptionSceneIds);
  generatingCaptionSceneIdsRef.current = generatingCaptionSceneIds;
  const inFlightRef = useRef(false);
  const draftScopeKey = sessionUser.id || "local";

  const geminiConfigured = integrations?.aiAssistant?.connected ?? true;

  // Cleanup active request abort controllers on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      mediaPrepAbortRef.current?.abort();
      if (batchVoiceoverCancelRef.current) {
        batchVoiceoverCancelRef.current.cancelled = true;
      }
      for (const entry of activeVoiceoverJobsRef.current.values()) {
        entry.controller.abort();
        void cancelTtsJob(entry.clientJobId, { keepalive: true });
      }
      activeVoiceoverJobsRef.current.clear();

      if (batchCaptionCancelRef.current) {
        batchCaptionCancelRef.current.cancelled = true;
      }
      for (const entry of activeCaptionJobsRef.current.values()) {
        entry.controller.abort();
        void cancelCaptionJob(entry.clientJobId, { keepalive: true });
      }
      activeCaptionJobsRef.current.clear();
    };
  }, []);

  // Restore isolated local storyboard draft on load/refresh
  useEffect(() => {
    const restored = loadLocalStoryboardDraft(draftScopeKey);
    if (restored) {
      setStoryboard(restored.storyboard);
      setActiveServerDraftId(restored.serverDraftId ?? null);
      setGenerationStatus("ready");
      setMode(restored.storyboard.sourceMode);
      setTitle(restored.storyboard.title);
      setTargetDurationSec(restored.storyboard.totalDuration);
      setAspectRatio(restored.storyboard.aspectRatio);
      setStyle(restored.storyboard.style);
      setLanguage(restored.storyboard.language);
      setVoiceoverEnabled(restored.storyboard.settings.voiceoverEnabled);
      setVoiceoverPreference(restored.storyboard.settings.voiceoverPreference);
      setCaptionsEnabled(restored.storyboard.settings.captionsEnabled);
      setCaptionStyle(restored.storyboard.settings.captionStyle);
      setTargetAudience(restored.storyboard.settings.targetAudience);
      setAdditionalInstructions(restored.storyboard.settings.additionalInstructions);
    }
  }, [draftScopeKey]);

  const loadServerDrafts = useCallback(async () => {
    if (!isAuthenticated) {
      setSavedDrafts([]);
      return;
    }
    setLoadingDrafts(true);
    const res = await fetchServerStoryboardDrafts();
    setLoadingDrafts(false);
    if (res.ok && Array.isArray(res.data?.drafts)) {
      setSavedDrafts(res.data.drafts);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadServerDrafts();
  }, [loadServerDrafts]);

  const loadTtsCapabilities = useCallback(async () => {
    if (!isAuthenticated) {
      setTtsStatus(null);
      setTtsVoices([]);
      setTtsError(null);
      return;
    }
    setTtsLoading(true);
    setTtsError(null);
    const [statusRes, voicesRes] = await Promise.all([fetchTtsStatus(), fetchTtsVoices()]);
    setTtsLoading(false);

    if (statusRes.ok && statusRes.data) {
      setTtsStatus(statusRes.data);
    } else {
      setTtsStatus(null);
      setTtsError(statusRes.error || "Unable to inspect local TTS engine status.");
    }

    if (voicesRes.ok && Array.isArray(voicesRes.data?.voices)) {
      setTtsVoices(voicesRes.data.voices);
    } else if (!voicesRes.ok) {
      setTtsVoices([]);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadTtsCapabilities();
  }, [loadTtsCapabilities]);

  const loadCaptionsCapabilities = useCallback(async () => {
    if (!isAuthenticated) {
      setCaptionsStatus(null);
      setCaptionsError(null);
      return;
    }
    setCaptionsLoading(true);
    setCaptionsError(null);
    const res = await fetchCaptionsStatus();
    setCaptionsLoading(false);
    if (res.ok && res.data) {
      setCaptionsStatus(res.data);
    } else {
      setCaptionsStatus(null);
      setCaptionsError(res.error || "Unable to inspect local faster-whisper caption status.");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void loadCaptionsCapabilities();
  }, [loadCaptionsCapabilities]);

  // Keep isolated local draft synced whenever user edits an existing storyboard
  const handleStoryboardChange = useCallback(
    (next: VideoStoryboard) => {
      const withSummary: VideoStoryboard = {
        ...next,
        mediaReadinessSummary: computeStoryboardMediaSummary(next, mediaAssets, !idbHydrating),
        voiceoverSummary: computeStoryboardVoiceoverSummary(
          next,
          mediaAssets,
          !idbHydrating,
          generatingSceneIdsRef.current
        ),
        captionSummary: computeStoryboardCaptionsSummary(
          next,
          mediaAssets,
          generatingCaptionSceneIdsRef.current
        ),
      };
      storyboardRef.current = withSummary;
      setStoryboard(withSummary);
      setSaveStatusMessage(null);
      setSaveError(null);
      const record: StoryboardDraftRecord = {
        id: withSummary.id,
        ...(activeServerDraftId ? { serverDraftId: activeServerDraftId } : {}),
        title: withSummary.title,
        status: validateStoryboardInvariants(withSummary).valid ? "validated" : "draft",
        storyboard: withSummary,
        savedAt: new Date().toISOString(),
      };
      saveLocalStoryboardDraft(record, draftScopeKey);
    },
    [activeServerDraftId, draftScopeKey, idbHydrating, mediaAssets]
  );

  const handleCancelMediaPrep = useCallback(() => {
    mediaPrepAbortRef.current?.abort();
    mediaPrepAbortRef.current = null;
    setMediaPrepActive(false);
    setMediaPrepStatusMessage("Media preparation cancelled. Existing assignments remain intact.");
  }, []);

  const handleAutoMatchMedia = useCallback(
    ({ overwriteManual }: { overwriteManual: boolean }) => {
      const current = storyboardRef.current;
      if (!current) return;
      mediaPrepAbortRef.current?.abort();
      const controller = new AbortController();
      mediaPrepAbortRef.current = controller;
      setMediaPrepActive(true);
      setMediaPrepStatusMessage(null);

      try {
        const visualCount = mediaAssets.filter(
          (a) => a.kind === "video" || a.kind === "image"
        ).length;
        if (visualCount === 0) {
          setMediaPrepStatusMessage(
            "No local video or image assets exist in IndexedDB yet. Upload files, search free Pexels stock, or render text slides."
          );
          return;
        }

        const result = autoMatchStoryboardScenes(current, mediaAssets, {
          overwriteManual,
          avoidDuplicates: true,
          minScore: 24,
          signal: controller.signal,
        });

        if (result.cancelled) {
          setMediaPrepStatusMessage("Auto-matching cancelled.");
          return;
        }

        handleStoryboardChange(result.storyboard);
        setMediaPrepStatusMessage(
          `Auto-matched ${result.matchedCount} scene(s) from IndexedDB filenames and metadata` +
            (result.skippedCount > 0 ? ` (${result.skippedCount} already assigned preserved)` : "") +
            (result.unmatchedSceneIds.length > 0
              ? `. ${result.unmatchedSceneIds.length} scene(s) left unassigned — upload media, search Pexels stock, or generate a text slide.`
              : ".")
        );
      } finally {
        setMediaPrepActive(false);
        if (mediaPrepAbortRef.current === controller) {
          mediaPrepAbortRef.current = null;
        }
      }
    },
    [handleStoryboardChange, mediaAssets]
  );

  const handleSelectLibraryAsset = useCallback(
    (asset: MediaAsset, sceneId: string) => {
      const current = storyboardRef.current;
      if (!current) return;
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return;
      const assignment = createAssignmentFromAsset(targetScene, asset, current.aspectRatio);
      const nextScenes = current.scenes.map((s) =>
        s.id === sceneId ? { ...s, mediaAssignment: assignment } : s
      );
      handleStoryboardChange({
        ...current,
        scenes: nextScenes,
        updatedAt: new Date().toISOString(),
      });
      setMediaPrepStatusMessage(`Assigned "${asset.name}" to "${targetScene.title}".`);
    },
    [handleStoryboardChange]
  );

  const handleUploadSceneFile = useCallback(
    async (files: FileList, sceneId: string) => {
      const file = files[0];
      if (!file) return;
      const kind = detectMediaKind(file);
      if (kind !== "video" && kind !== "image") {
        setMediaPrepStatusMessage(
          `Cannot assign '${file.name}' (${kind || "unsupported"}): scene visual slots accept video or image files only.`
        );
        return;
      }

      setMediaPrepActive(true);
      setMediaPrepStatusMessage(null);
      try {
        const asset = await importMediaFileWithMetadata(
          file,
          { sourceOrigin: "uploaded" },
          { reuseDuplicate: true }
        );
        if (!asset) return;
        const latest = storyboardRef.current;
        const scene = latest?.scenes.find((s) => s.id === sceneId);
        if (!latest || !scene) return;
        const assignment = createAssignmentFromAsset(scene, asset, latest.aspectRatio, {
          mediaSource: "uploaded",
        });
        handleStoryboardChange({
          ...latest,
          scenes: latest.scenes.map((s) =>
            s.id === sceneId ? { ...s, mediaAssignment: assignment } : s
          ),
          updatedAt: new Date().toISOString(),
        });
        setMediaPrepStatusMessage(`Imported "${asset.name}" to IndexedDB and assigned to "${scene.title}".`);
      } finally {
        setMediaPrepActive(false);
      }
    },
    [handleStoryboardChange, importMediaFileWithMetadata]
  );

  const handleUploadBatchMedia = useCallback(
    async (files: FileList) => {
      const current = storyboardRef.current;
      if (!current || files.length === 0) return;
      mediaPrepAbortRef.current?.abort();
      const controller = new AbortController();
      mediaPrepAbortRef.current = controller;

      setMediaPrepActive(true);
      setMediaPrepStatusMessage(null);
      const imported: MediaAsset[] = [];
      let skippedAudio = 0;

      try {
        for (const file of Array.from(files)) {
          if (controller.signal.aborted) break;
          const kind = detectMediaKind(file);
          if (kind !== "video" && kind !== "image") {
            skippedAudio += 1;
            continue;
          }
          const asset = await importMediaFileWithMetadata(
            file,
            { sourceOrigin: "uploaded" },
            { reuseDuplicate: true }
          );
          if (asset) {
            imported.push(asset);
          }
        }

        if (controller.signal.aborted) {
          setMediaPrepStatusMessage("Batch upload cancelled.");
          return;
        }

        const latest = storyboardRef.current ?? current;
        const mergedPoolMap = new Map<string, MediaAsset>();
        for (const a of [...imported, ...mediaAssets]) {
          mergedPoolMap.set(a.id, a);
        }
        const matchResult = autoMatchStoryboardScenes(latest, Array.from(mergedPoolMap.values()), {
          overwriteManual: false,
          avoidDuplicates: true,
          minScore: 24,
          signal: controller.signal,
        });
        handleStoryboardChange(matchResult.storyboard);
        setMediaPrepStatusMessage(
          `Saved ${imported.length} visual file(s) to IndexedDB and matched ${matchResult.matchedCount} unassigned scene(s).` +
            (skippedAudio > 0
              ? ` Skipped ${skippedAudio} audio/unsupported file(s) from visual slots.`
              : "")
        );
      } finally {
        setMediaPrepActive(false);
        if (mediaPrepAbortRef.current === controller) {
          mediaPrepAbortRef.current = null;
        }
      }
    },
    [handleStoryboardChange, importMediaFileWithMetadata, mediaAssets]
  );

  const handleImportStockResult = useCallback(
    async (
      item: StockSearchItemDto,
      sceneId: string,
      signal: AbortSignal
    ): Promise<{ ok: boolean; error?: string }> => {
      const res = await importStockMediaApi(
        {
          provider: "pexels",
          providerAssetId: item.providerAssetId,
          mediaType: item.mediaType,
        },
        { signal }
      );
      if (res.cancelled) {
        return { ok: false, error: "Stock media download was cancelled." };
      }
      if (!res.ok || !res.data) {
        return { ok: false, error: res.error || "Failed to import stock media." };
      }

      const asset = await importMediaFileWithMetadata(
        res.data.file,
        {
          sourceOrigin: "stock",
          providerName: res.data.providerName,
          providerAssetId: res.data.providerAssetId,
          creatorName: res.data.creatorName,
          attributionUrl: res.data.attributionUrl,
          licenseInfo: res.data.licenseInfo,
          sourceUrl: res.data.sourceUrl,
          tags: [item.title],
        },
        { reuseDuplicate: true }
      );

      if (!asset) {
        return {
          ok: false,
          error: "Downloaded stock media could not be stored inside browser IndexedDB.",
        };
      }

      const latest = storyboardRef.current;
      const scene = latest?.scenes.find((s) => s.id === sceneId);
      if (latest && scene) {
        const assignment = createAssignmentFromAsset(scene, asset, latest.aspectRatio, {
          mediaSource: "stock",
        });
        handleStoryboardChange({
          ...latest,
          scenes: latest.scenes.map((s) =>
            s.id === sceneId ? { ...s, mediaAssignment: assignment } : s
          ),
          updatedAt: new Date().toISOString(),
        });
        setMediaPrepStatusMessage(
          `Imported stock ${item.mediaType} by ${res.data.creatorName || "contributor"} to IndexedDB and assigned to "${scene.title}".`
        );
      }
      return { ok: true };
    },
    [handleStoryboardChange, importMediaFileWithMetadata]
  );

  const handleGenerateAndAssignSlide = useCallback(
    async (result: { file: File; config: GeneratedSlideConfig; sceneId: string }) => {
      const asset = await importMediaFileWithMetadata(
        result.file,
        {
          sourceOrigin: "generated_slide",
          generatedSlideConfig: result.config,
          tags: [result.config.headingText, result.config.template, result.config.language],
          description: result.config.bodyText || undefined,
        },
        { reuseDuplicate: false }
      );
      if (!asset) return;

      const latest = storyboardRef.current;
      const scene = latest?.scenes.find((s) => s.id === result.sceneId);
      if (!latest || !scene) return;
      const assignment = createAssignmentFromAsset(scene, asset, latest.aspectRatio, {
        mediaSource: "generated_slide",
      });
      handleStoryboardChange({
        ...latest,
        scenes: latest.scenes.map((s) =>
          s.id === result.sceneId ? { ...s, mediaAssignment: assignment } : s
        ),
        updatedAt: new Date().toISOString(),
      });
      setMediaPrepStatusMessage(`Generated PNG text slide saved to IndexedDB for "${scene.title}".`);
    },
    [handleStoryboardChange, importMediaFileWithMetadata]
  );

  const handleRelinkMissingSceneMedia = useCallback(
    async (assetId: string, file: File, sceneId: string) => {
      const kind = detectMediaKind(file);
      if (kind !== "video" && kind !== "image") {
        setMediaPrepStatusMessage(
          `Selected file '${file.name}' is ${kind || "unsupported"}; pick a video or image file to re-link this scene.`
        );
        return;
      }

      setMediaPrepActive(true);
      try {
        const res = await relinkMissingClipAsset(assetId, file);
        if (!res.ok) {
          setMediaPrepStatusMessage(res.error || "Failed to re-link local media file.");
          return;
        }
        const latest = storyboardRef.current;
        const scene = latest?.scenes.find((s) => s.id === sceneId);
        if (latest && scene && scene.mediaAssignment) {
          handleStoryboardChange({
            ...latest,
            scenes: latest.scenes.map((s) =>
              s.id === sceneId
                ? {
                    ...s,
                    mediaAssignment: {
                      ...s.mediaAssignment!,
                      assetTitle: file.name,
                      mimeType: file.type || s.mediaAssignment!.mimeType,
                      assignmentStatus: "assigned",
                      assignedAt: new Date().toISOString(),
                    },
                  }
                : s
            ),
            updatedAt: new Date().toISOString(),
          });
        }
        setMediaPrepStatusMessage(`Re-linked '${file.name}' into IndexedDB cleanly.`);
      } finally {
        setMediaPrepActive(false);
      }
    },
    [handleStoryboardChange, relinkMissingClipAsset]
  );

  const synthesizeSceneVoiceover = useCallback(
    async (
      sceneId: string,
      overrideParams?: Partial<StoryboardVoiceoverSettings>
    ): Promise<"ready" | "cancelled" | "failed" | "skipped"> => {
      const current = storyboardRef.current;
      if (!current) return "failed";
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return "failed";

      const narrationSnapshot = targetScene.narration;
      const trimmedNarration = narrationSnapshot.trim();
      if (!trimmedNarration) {
        return "skipped";
      }

      if (activeVoiceoverJobsRef.current.has(sceneId)) {
        return "skipped";
      }

      const resolved = resolveEffectiveSceneVoiceParams(targetScene, current);
      const effectiveProvider = overrideParams?.provider ?? resolved.provider;
      const effectiveRate = overrideParams?.speakingRate ?? resolved.speakingRate;
      const effectivePitch = overrideParams?.pitch ?? resolved.pitch;
      const effectiveFormat =
        (overrideParams?.format ?? resolved.format) === "mp3" && ttsStatus?.mp3Supported
          ? "mp3"
          : "wav";
      const effectiveVolume = overrideParams?.volume ?? resolved.volume;

      let effectiveVoiceId =
        overrideParams?.voiceId !== undefined ? overrideParams.voiceId : resolved.voiceId;
      if (!effectiveVoiceId) {
        const picked = pickDefaultVoiceForLanguage(ttsVoices, resolved.language, effectiveProvider);
        effectiveVoiceId = picked?.voiceId || "";
      }

      const clientJobId = `vo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      activeVoiceoverJobsRef.current.set(sceneId, { controller, clientJobId });
      setGeneratingVoiceoverSceneIds((prev) => {
        const next = new Set(prev);
        next.add(sceneId);
        return next;
      });

      if (activeAudioSceneId === sceneId) {
        setActiveAudioSceneId(null);
      }

      try {
        const res = await generateTtsVoiceover(
          {
            text: trimmedNarration,
            language: resolved.language,
            provider: effectiveProvider,
            ...(effectiveVoiceId ? { voiceId: effectiveVoiceId } : {}),
            speakingRate: effectiveRate,
            pitch: effectivePitch,
            format: effectiveFormat,
            clientJobId,
            sceneId,
            storyboardId: current.id,
          },
          { clientJobId, signal: controller.signal }
        );

        if (res.cancelled || res.status === 499) {
          return "cancelled";
        }

        if (!res.ok || !res.data) {
          const latest = storyboardRef.current;
          if (latest) {
            const existingVo = latest.scenes.find((s) => s.id === sceneId)?.voiceover;
            const failedRecord: StoryboardSceneVoiceover = {
              sceneId,
              ...(existingVo?.mediaAssetId ? { mediaAssetId: existingVo.mediaAssetId } : {}),
              provider:
                effectiveProvider === "piper" ||
                effectiveProvider === "espeak_ng" ||
                effectiveProvider === "windows_sapi"
                  ? effectiveProvider
                  : "espeak_ng",
              voiceId: effectiveVoiceId || "default",
              voiceLabel: effectiveVoiceId || "Unavailable",
              language: resolved.language,
              speakingRate: effectiveRate,
              pitch: effectivePitch,
              volume: effectiveVolume,
              format: effectiveFormat,
              mimeType: effectiveFormat === "mp3" ? "audio/mpeg" : "audio/wav",
              durationSeconds: existingVo?.durationSeconds ?? 0,
              sizeBytes: existingVo?.sizeBytes ?? 0,
              sampleRateHz: existingVo?.sampleRateHz ?? 22050,
              channels: 1,
              narrationFingerprint: computeNarrationFingerprint({
                text: narrationSnapshot,
                language: resolved.language,
                provider: effectiveProvider,
                voiceId: effectiveVoiceId,
                speakingRate: effectiveRate,
                pitch: effectivePitch,
              }),
              generatedAt: new Date().toISOString(),
              status: "failed",
              errorMessage: res.error || "Local TTS synthesis failed.",
            };
            handleStoryboardChange({
              ...latest,
              scenes: latest.scenes.map((s) =>
                s.id === sceneId ? { ...s, voiceover: failedRecord } : s
              ),
              updatedAt: new Date().toISOString(),
            });
          }
          return "failed";
        }

        const data = res.data;
        const asset = await importMediaFileWithMetadata(
          data.file,
          {
            sourceOrigin: "generated_voiceover",
            providerName: data.provider,
            providerAssetId: data.jobId,
            tags: ["voiceover", data.language, data.voiceId],
            description: `Generated voiceover for scene "${targetScene.title}"`,
            durationOverride: data.durationSeconds > 0 ? data.durationSeconds : undefined,
          },
          { reuseDuplicate: false }
        );

        if (!asset) {
          const latest = storyboardRef.current;
          if (latest) {
            handleStoryboardChange({
              ...latest,
              scenes: latest.scenes.map((s) =>
                s.id === sceneId
                  ? {
                      ...s,
                      voiceover: {
                        sceneId,
                        provider: data.provider,
                        voiceId: data.voiceId,
                        voiceLabel: data.voiceLabel,
                        language: data.language,
                        speakingRate: effectiveRate,
                        pitch: effectivePitch,
                        volume: effectiveVolume,
                        format: data.format,
                        mimeType: data.mimeType,
                        durationSeconds: data.durationSeconds,
                        sizeBytes: data.sizeBytes,
                        sampleRateHz: data.sampleRateHz,
                        channels: data.channels,
                        narrationFingerprint: computeNarrationFingerprint({
                          text: narrationSnapshot,
                          language: data.language,
                          provider: data.provider,
                          voiceId: data.voiceId,
                          speakingRate: effectiveRate,
                          pitch: effectivePitch,
                        }),
                        generatedAt: new Date().toISOString(),
                        status: "failed",
                        errorMessage:
                          "Audio synthesized, but could not persist to IndexedDB storage.",
                      },
                    }
                  : s
              ),
              updatedAt: new Date().toISOString(),
            });
          }
          return "failed";
        }

        const latestAfterSave = storyboardRef.current;
        if (!latestAfterSave) return "failed";
        const latestScene = latestAfterSave.scenes.find((s) => s.id === sceneId);
        if (!latestScene) return "failed";

        // Compute fingerprint using the exact narrationSnapshot that was synthesized!
        // If user edited narration mid-flight, stale check automatically flags it as stale.
        const synthFingerprint = computeNarrationFingerprint({
          text: narrationSnapshot,
          language: data.language,
          provider: data.provider,
          voiceId: data.voiceId,
          speakingRate: effectiveRate,
          pitch: effectivePitch,
        });

        const nextVoiceover: StoryboardSceneVoiceover = {
          sceneId,
          mediaAssetId: asset.id,
          provider: data.provider,
          voiceId: data.voiceId,
          voiceLabel: data.voiceLabel,
          language: data.language,
          speakingRate: Number(effectiveRate.toFixed(2)),
          pitch: Number(effectivePitch.toFixed(2)),
          volume: Number(effectiveVolume.toFixed(2)),
          format: data.format,
          mimeType: data.mimeType,
          durationSeconds:
            data.durationSeconds > 0 ? data.durationSeconds : Number(asset.duration.toFixed(3)),
          sizeBytes: data.sizeBytes,
          sampleRateHz: data.sampleRateHz,
          channels: data.channels,
          narrationFingerprint: synthFingerprint,
          generatedAt: new Date().toISOString(),
          status:
            latestScene.narration.trim() === trimmedNarration ? "ready" : "stale",
        };

        handleStoryboardChange({
          ...latestAfterSave,
          scenes: latestAfterSave.scenes.map((s) =>
            s.id === sceneId ? { ...s, voiceover: nextVoiceover } : s
          ),
          updatedAt: new Date().toISOString(),
        });
        return "ready";
      } finally {
        activeVoiceoverJobsRef.current.delete(sceneId);
        setGeneratingVoiceoverSceneIds((prev) => {
          const next = new Set(prev);
          next.delete(sceneId);
          return next;
        });
      }
    },
    [
      activeAudioSceneId,
      handleStoryboardChange,
      importMediaFileWithMetadata,
      ttsStatus?.mp3Supported,
      ttsVoices,
    ]
  );

  const handleCancelSceneVoiceover = useCallback((sceneId: string) => {
    const active = activeVoiceoverJobsRef.current.get(sceneId);
    if (!active) return;
    active.controller.abort();
    void cancelTtsJob(active.clientJobId);
  }, []);

  const handleRemoveSceneVoiceover = useCallback(
    (sceneId: string) => {
      const current = storyboardRef.current;
      if (!current) return;
      if (activeAudioSceneId === sceneId) {
        setActiveAudioSceneId(null);
      }
      handleStoryboardChange({
        ...current,
        scenes: current.scenes.map((s) =>
          s.id === sceneId ? { ...s, voiceover: undefined } : s
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [activeAudioSceneId, handleStoryboardChange]
  );

  const handleClearAllVoiceovers = useCallback(() => {
    const current = storyboardRef.current;
    if (!current) return;
    setActiveAudioSceneId(null);
    handleStoryboardChange({
      ...current,
      scenes: current.scenes.map((s) => ({ ...s, voiceover: undefined })),
      updatedAt: new Date().toISOString(),
    });
    setVoiceoverBatchState({
      active: false,
      currentSceneId: null,
      completedCount: 0,
      totalCount: 0,
      statusMessage: "Cleared scene voiceover links (audio files kept safely in IndexedDB).",
    });
  }, [handleStoryboardChange]);

  const handleUpdateSceneVoiceoverVolume = useCallback(
    (sceneId: string, volume: number) => {
      const current = storyboardRef.current;
      if (!current) return;
      const clampedVol = Math.max(0, Math.min(2, Number(volume.toFixed(2))));
      handleStoryboardChange({
        ...current,
        scenes: current.scenes.map((s) =>
          s.id === sceneId && s.voiceover
            ? { ...s, voiceover: { ...s.voiceover, volume: clampedVol } }
            : s
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [handleStoryboardChange]
  );

  const handleCancelVoiceoverBatch = useCallback(() => {
    if (batchVoiceoverCancelRef.current) {
      batchVoiceoverCancelRef.current.cancelled = true;
    }
    for (const entry of activeVoiceoverJobsRef.current.values()) {
      entry.controller.abort();
      void cancelTtsJob(entry.clientJobId);
    }
    setVoiceoverBatchState((prev) => ({
      ...prev,
      active: false,
      currentSceneId: null,
      statusMessage: "Batch voiceover generation cancelled. Completed scenes were preserved.",
    }));
  }, []);

  const handleGenerateBatchVoiceovers = useCallback(
    async (mode: "missing_or_stale" | "all") => {
      const current = storyboardRef.current;
      if (!current || batchVoiceoverCancelRef.current?.cancelled === false) return;

      const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
      const targetSceneIds: string[] = [];
      for (const scene of current.scenes.slice(0, MAX_STORYBOARD_SCENES)) {
        const evalRes = evaluateSceneVoiceoverReadiness(
          scene,
          current,
          assetsById,
          !idbHydrating
        );
        if (!evalRes.hasNarration) continue;
        if (
          mode === "all" ||
          evalRes.status === "none" ||
          evalRes.status === "stale" ||
          evalRes.status === "missing" ||
          evalRes.status === "failed"
        ) {
          targetSceneIds.push(scene.id);
        }
      }

      if (targetSceneIds.length === 0) {
        setVoiceoverBatchState({
          active: false,
          currentSceneId: null,
          completedCount: 0,
          totalCount: 0,
          statusMessage: "All spoken scenes already have ready voiceovers.",
        });
        return;
      }

      const batchToken = { cancelled: false };
      batchVoiceoverCancelRef.current = batchToken;
      setVoiceoverBatchState({
        active: true,
        currentSceneId: targetSceneIds[0],
        completedCount: 0,
        totalCount: targetSceneIds.length,
        statusMessage: `Synthesizing voiceovers sequentially (0/${targetSceneIds.length})...`,
      });

      let readyCount = 0;
      let failedCount = 0;

      for (let i = 0; i < targetSceneIds.length; i += 1) {
        if (batchToken.cancelled) break;
        const sid = targetSceneIds[i];
        setVoiceoverBatchState({
          active: true,
          currentSceneId: sid,
          completedCount: i,
          totalCount: targetSceneIds.length,
          statusMessage: `Synthesizing scene ${i + 1} of ${targetSceneIds.length}...`,
        });

        const result = await synthesizeSceneVoiceover(sid);
        if (result === "cancelled" || batchToken.cancelled) {
          break;
        }
        if (result === "ready") {
          readyCount += 1;
        } else if (result === "failed") {
          failedCount += 1;
        }
      }

      const wasCancelled = batchToken.cancelled;
      batchVoiceoverCancelRef.current = null;
      setVoiceoverBatchState({
        active: false,
        currentSceneId: null,
        completedCount: readyCount,
        totalCount: targetSceneIds.length,
        statusMessage: wasCancelled
          ? `Batch cancelled (${readyCount} scene(s) completed and saved to IndexedDB).`
          : failedCount > 0
            ? `Completed ${readyCount}/${targetSceneIds.length} voiceover(s); ${failedCount} failed.`
            : `Synthesized ${readyCount} voiceover audio file(s) cleanly into IndexedDB.`,
      });
    },
    [idbHydrating, mediaAssets, synthesizeSceneVoiceover]
  );

  const handleGenerateSceneScriptCaptions = useCallback(
    (sceneId: string) => {
      const current = storyboardRef.current;
      if (!current) return;
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return;
      const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
      const voiceoverAsset = targetScene.voiceover?.mediaAssetId
        ? assetsById.get(targetScene.voiceover.mediaAssetId) ?? null
        : null;
      const effectiveSettings = current.captionSettings ?? getDefaultCaptionSettings(current);
      const record = generateScriptCaptionsForScene({
        scene: targetScene,
        storyboard: current,
        voiceoverAsset,
        maxLines: effectiveSettings.style.maxLines,
      });

      handleStoryboardChange({
        ...current,
        captionSettings: current.captionSettings ?? effectiveSettings,
        scenes: current.scenes.map((s) =>
          s.id === sceneId ? { ...s, captions: record } : s
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [handleStoryboardChange, mediaAssets]
  );

  const transcribeSceneAudioCaptions = useCallback(
    async (sceneId: string): Promise<"ready" | "cancelled" | "failed" | "skipped"> => {
      const current = storyboardRef.current;
      if (!current) return "failed";
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return "failed";

      const storyboardIdSnapshot = current.id;
      const narrationSnapshot = targetScene.narration;
      const vo = targetScene.voiceover;
      const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
      const voiceoverAsset = vo?.mediaAssetId ? assetsById.get(vo.mediaAssetId) ?? null : null;

      if (!vo?.mediaAssetId || !voiceoverAsset || !voiceoverAsset.sourceFile) {
        return "skipped";
      }

      if (activeCaptionJobsRef.current.has(sceneId)) {
        return "skipped";
      }

      const effectiveSettings = current.captionSettings ?? getDefaultCaptionSettings(current);
      const effectiveLang = resolveEffectiveCaptionLanguage(current);
      const clientJobId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      activeCaptionJobsRef.current.set(sceneId, { controller, clientJobId });

      setGeneratingCaptionSceneIds((prev) => {
        const next = new Set(prev);
        next.add(sceneId);
        return next;
      });

      try {
        const res = await generateAudioCaptions(voiceoverAsset.sourceFile, {
          filename: voiceoverAsset.name || `voiceover_${sceneId}.wav`,
          language: effectiveLang,
          wordTimestamps: effectiveSettings.wordTimestamps,
          clientJobId,
          sceneId,
          storyboardId: storyboardIdSnapshot,
          signal: controller.signal,
        });

        const latest = storyboardRef.current;
        if (!latest || latest.id !== storyboardIdSnapshot) {
          return "cancelled";
        }

        if (res.cancelled || res.status === 499) {
          return "cancelled";
        }

        const latestScene = latest.scenes.find((s) => s.id === sceneId);
        if (!latestScene) {
          return "cancelled";
        }

        if (!res.ok || !res.data) {
          const failedRecord: StoryboardSceneCaptions = {
            sceneId,
            mode: "audio",
            timingSource: "audio_transcription",
            language: effectiveLang,
            status: "failed",
            segments: latestScene.captions?.segments ?? [],
            fingerprint: computeCaptionFingerprint({
              narration: narrationSnapshot,
              mode: "audio",
              language: effectiveLang,
              voiceoverMediaAssetId: vo.mediaAssetId,
              voiceoverNarrationFingerprint: vo.narrationFingerprint,
              sceneDurationSec: latestScene.duration,
              usedVoiceoverDuration: true,
            }),
            sourceNarrationSnapshot: narrationSnapshot,
            sourceVoiceoverMediaAssetId: vo.mediaAssetId,
            generatedAt: new Date().toISOString(),
            hasManualEdits: latestScene.captions?.hasManualEdits ?? false,
            errorMessage: res.error || "Audio caption transcription failed.",
          };
          handleStoryboardChange({
            ...latest,
            scenes: latest.scenes.map((s) =>
              s.id === sceneId ? { ...s, captions: failedRecord } : s
            ),
            updatedAt: new Date().toISOString(),
          });
          return "failed";
        }

        const nextRecord = buildAudioTranscriptionCaptionsRecord({
          scene: latestScene,
          storyboard: latest,
          narrationSnapshot,
          effectiveLang,
          voiceoverAssetId: vo.mediaAssetId,
          voiceoverFingerprint: vo.narrationFingerprint,
          transcription: res.data,
        });

        handleStoryboardChange({
          ...latest,
          captionSettings: latest.captionSettings ?? effectiveSettings,
          scenes: latest.scenes.map((s) =>
            s.id === sceneId ? { ...s, captions: nextRecord } : s
          ),
          updatedAt: new Date().toISOString(),
        });
        return "ready";
      } finally {
        activeCaptionJobsRef.current.delete(sceneId);
        setGeneratingCaptionSceneIds((prev) => {
          const next = new Set(prev);
          next.delete(sceneId);
          return next;
        });
      }
    },
    [handleStoryboardChange, mediaAssets]
  );

  const handleCancelSceneCaptions = useCallback((sceneId: string) => {
    const active = activeCaptionJobsRef.current.get(sceneId);
    if (!active) return;
    active.controller.abort();
    void cancelCaptionJob(active.clientJobId);
  }, []);

  const handleUpdateSceneCaptionSegments = useCallback(
    (sceneId: string, nextSegments: StoryboardCaptionSegment[]) => {
      const current = storyboardRef.current;
      if (!current) return;
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene) return;

      const effectiveSettings = current.captionSettings ?? getDefaultCaptionSettings(current);
      const effectiveLang = resolveEffectiveCaptionLanguage(current);
      const existing = targetScene.captions;
      const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
      const voiceoverAsset = targetScene.voiceover?.mediaAssetId
        ? assetsById.get(targetScene.voiceover.mediaAssetId) ?? null
        : null;
      const usedVoDuration = Boolean(
        targetScene.voiceover?.status === "ready" && targetScene.voiceover?.mediaAssetId
      );

      const baseFingerprint =
        existing?.fingerprint ||
        computeCaptionFingerprint({
          narration: targetScene.narration,
          mode: existing?.mode ?? "script",
          language: effectiveLang,
          voiceoverMediaAssetId: voiceoverAsset?.id ?? targetScene.voiceover?.mediaAssetId,
          voiceoverNarrationFingerprint: targetScene.voiceover?.narrationFingerprint,
          sceneDurationSec: targetScene.duration,
          usedVoiceoverDuration: usedVoDuration,
        });

      const nextCaptions: StoryboardSceneCaptions = {
        sceneId,
        mode: existing?.mode ?? "script",
        timingSource:
          existing?.timingSource === "audio_transcription"
            ? "audio_transcription"
            : nextSegments.length > 0
              ? "manual"
              : "estimated",
        language: existing?.language ?? effectiveLang,
        status: nextSegments.length > 0 ? "ready" : "none",
        segments: nextSegments,
        fingerprint: baseFingerprint,
        sourceNarrationSnapshot: existing?.sourceNarrationSnapshot ?? targetScene.narration,
        ...(existing?.sourceVoiceoverMediaAssetId
          ? { sourceVoiceoverMediaAssetId: existing.sourceVoiceoverMediaAssetId }
          : {}),
        ...(existing?.model ? { model: existing.model } : {}),
        ...(existing?.detectedLanguage ? { detectedLanguage: existing.detectedLanguage } : {}),
        generatedAt: existing?.generatedAt ?? new Date().toISOString(),
        hasManualEdits: true,
        overflowsSceneDuration:
          nextSegments.length > 0
            ? Math.max(...nextSegments.map((s) => s.end)) > targetScene.duration + 0.15
            : false,
      };

      handleStoryboardChange({
        ...current,
        captionSettings: current.captionSettings ?? effectiveSettings,
        scenes: current.scenes.map((s) =>
          s.id === sceneId ? { ...s, captions: nextCaptions } : s
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [handleStoryboardChange, mediaAssets]
  );

  const handleRemoveSceneCaptions = useCallback(
    (sceneId: string) => {
      const current = storyboardRef.current;
      if (!current) return;
      if (activeAudioSceneId === `cap:${sceneId}`) {
        setActiveAudioSceneId(null);
      }
      handleStoryboardChange({
        ...current,
        scenes: current.scenes.map((s) =>
          s.id === sceneId ? { ...s, captions: undefined } : s
        ),
        updatedAt: new Date().toISOString(),
      });
    },
    [activeAudioSceneId, handleStoryboardChange]
  );

  const handleTrimSceneCaptionsToDuration = useCallback(
    (sceneId: string) => {
      const current = storyboardRef.current;
      if (!current) return;
      const targetScene = current.scenes.find((s) => s.id === sceneId);
      if (!targetScene?.captions) return;

      const maxEnd = roundTo3(targetScene.duration);
      const clampedSegments = targetScene.captions.segments
        .filter((seg) => seg.start < maxEnd - 0.05)
        .map((seg) => ({
          ...seg,
          end: Math.min(maxEnd, seg.end),
          isManuallyEdited: true,
        }))
        .filter((seg) => seg.end > seg.start);

      handleUpdateSceneCaptionSegments(sceneId, clampedSegments);
    },
    [handleUpdateSceneCaptionSegments]
  );

  const handleCancelCaptionBatch = useCallback(() => {
    if (batchCaptionCancelRef.current) {
      batchCaptionCancelRef.current.cancelled = true;
    }
    for (const entry of activeCaptionJobsRef.current.values()) {
      entry.controller.abort();
      void cancelCaptionJob(entry.clientJobId);
    }
    setCaptionBatchState((prev) => ({
      ...prev,
      active: false,
      currentSceneId: null,
      statusMessage: "Batch caption generation cancelled. Completed scenes were preserved.",
    }));
  }, []);

  const handleClearAllCaptions = useCallback(() => {
    const current = storyboardRef.current;
    if (!current) return;
    if (activeAudioSceneId?.startsWith("cap:")) {
      setActiveAudioSceneId(null);
    }
    handleStoryboardChange({
      ...current,
      scenes: current.scenes.map((s) => ({ ...s, captions: undefined })),
      updatedAt: new Date().toISOString(),
    });
    setCaptionBatchState({
      active: false,
      mode: current.captionSettings?.defaultMode ?? "script",
      currentSceneId: null,
      completedCount: 0,
      totalCount: 0,
      statusMessage: "Cleared caption cues across all scenes.",
    });
  }, [activeAudioSceneId, handleStoryboardChange]);

  const handleGenerateBatchCaptions = useCallback(
    async (filterMode: "missing_or_stale" | "all", mode: CaptionGenerationMode) => {
      const current = storyboardRef.current;
      if (!current) return;
      const assetsById = new Map(mediaAssets.map((a) => [a.id, a]));
      const effectiveSettings = current.captionSettings ?? getDefaultCaptionSettings(current);

      const targetScenes = current.scenes.slice(0, MAX_STORYBOARD_SCENES).filter((scene) => {
        const evalRes = evaluateSceneCaptionsReadiness(scene, current, assetsById);
        if (!evalRes.hasNarration) return false;
        if (filterMode === "all") return true;
        return evalRes.status === "none" || evalRes.status === "stale" || evalRes.status === "failed";
      });

      if (targetScenes.length === 0) {
        setCaptionBatchState({
          active: false,
          mode,
          currentSceneId: null,
          completedCount: 0,
          totalCount: 0,
          statusMessage: "All spoken scenes already have up-to-date captions.",
        });
        return;
      }

      if (mode === "script") {
        let nextScenes = [...current.scenes];
        let generatedCount = 0;
        const targetIdSet = new Set(targetScenes.map((s) => s.id));
        nextScenes = nextScenes.map((scene) => {
          if (!targetIdSet.has(scene.id)) return scene;
          const voAsset = scene.voiceover?.mediaAssetId
            ? assetsById.get(scene.voiceover.mediaAssetId) ?? null
            : null;
          generatedCount += 1;
          return {
            ...scene,
            captions: generateScriptCaptionsForScene({
              scene,
              storyboard: current,
              voiceoverAsset: voAsset,
              maxLines: effectiveSettings.style.maxLines,
            }),
          };
        });

        handleStoryboardChange({
          ...current,
          captionSettings: current.captionSettings ?? effectiveSettings,
          scenes: nextScenes,
          updatedAt: new Date().toISOString(),
        });
        setCaptionBatchState({
          active: false,
          mode: "script",
          currentSceneId: null,
          completedCount: generatedCount,
          totalCount: generatedCount,
          statusMessage: `Generated script-estimated captions for ${generatedCount} scene(s) locally.`,
        });
        return;
      }

      // Sequential local Whisper transcription (bounded concurrency = 1)
      if (batchCaptionCancelRef.current?.cancelled === false) return;
      const eligibleIds = targetScenes
        .filter((s) => {
          const asset = s.voiceover?.mediaAssetId
            ? assetsById.get(s.voiceover.mediaAssetId)
            : undefined;
          return Boolean(asset && asset.kind === "audio" && asset.sourceFile);
        })
        .map((s) => s.id);

      if (eligibleIds.length === 0) {
        setCaptionBatchState({
          active: false,
          mode: "audio",
          currentSceneId: null,
          completedCount: 0,
          totalCount: 0,
          statusMessage:
            "None of the target scenes have ready voiceover audio in IndexedDB yet. Synthesize voiceovers or switch to Script Timing.",
        });
        return;
      }

      const batchToken = { cancelled: false };
      batchCaptionCancelRef.current = batchToken;
      setCaptionBatchState({
        active: true,
        mode: "audio",
        currentSceneId: eligibleIds[0],
        completedCount: 0,
        totalCount: eligibleIds.length,
        statusMessage: `Transcribing scene voiceover audio with faster-whisper (0/${eligibleIds.length})...`,
      });

      let readyCount = 0;
      let failedCount = 0;

      for (let i = 0; i < eligibleIds.length; i += 1) {
        if (batchToken.cancelled) break;
        const sid = eligibleIds[i];
        setCaptionBatchState({
          active: true,
          mode: "audio",
          currentSceneId: sid,
          completedCount: i,
          totalCount: eligibleIds.length,
          statusMessage: `Transcribing scene ${i + 1} of ${eligibleIds.length}...`,
        });

        const resStatus = await transcribeSceneAudioCaptions(sid);
        if (resStatus === "cancelled" || batchToken.cancelled) {
          break;
        }
        if (resStatus === "ready") {
          readyCount += 1;
        } else if (resStatus === "failed") {
          failedCount += 1;
        }
      }

      const wasCancelled = batchToken.cancelled;
      batchCaptionCancelRef.current = null;
      setCaptionBatchState({
        active: false,
        mode: "audio",
        currentSceneId: null,
        completedCount: readyCount,
        totalCount: eligibleIds.length,
        statusMessage: wasCancelled
          ? `Audio caption batch cancelled (${readyCount} scene(s) preserved).`
          : failedCount > 0
            ? `Transcribed ${readyCount}/${eligibleIds.length} scene(s); ${failedCount} failed.`
            : `Transcribed ${readyCount} scene(s) from local voiceover audio via faster-whisper.`,
      });
    },
    [handleStoryboardChange, mediaAssets, transcribeSceneAudioCaptions]
  );

  const clientValidation = useMemo(() => {
    const payload: VideoGenerationRequest = {
      mode,
      title,
      prompt,
      targetDurationSec,
      aspectRatio,
      style,
      language,
      voiceoverEnabled,
      voiceoverPreference: voiceoverEnabled ? voiceoverPreference : "none",
      captionsEnabled,
      captionStyle: captionsEnabled ? captionStyle : "none",
      targetAudience,
      additionalInstructions,
    };
    return StoryboardGenerationInputSchema.safeParse(payload);
  }, [
    additionalInstructions,
    aspectRatio,
    captionStyle,
    captionsEnabled,
    language,
    mode,
    prompt,
    style,
    targetAudience,
    targetDurationSec,
    title,
    voiceoverEnabled,
    voiceoverPreference,
  ]);

  const runStoryboardGeneration = async () => {
    if (inFlightRef.current || generationStatus === "generating") {
      return;
    }

    if (mode === "image-animation") {
      setErrorBanner({
        kind: "integration",
        title: "Image Animation Coming Soon",
        message:
          "Image Animation is planned for a later FFmpeg motion-composition phase. Switch to Prompt to Video or Script to Video to generate a storyboard today.",
      });
      return;
    }

    const requestPayload: VideoGenerationRequest = {
      mode,
      title: title.trim(),
      prompt: prompt.trim(),
      targetDurationSec,
      aspectRatio,
      style,
      language,
      voiceoverEnabled,
      voiceoverPreference: voiceoverEnabled ? voiceoverPreference : "none",
      captionsEnabled,
      captionStyle: captionsEnabled ? captionStyle : "none",
      targetAudience: targetAudience.trim(),
      additionalInstructions: additionalInstructions.trim(),
    };

    const parsed = StoryboardGenerationInputSchema.safeParse(requestPayload);
    if (!parsed.success) {
      setGenerationStatus("error");
      setErrorBanner({
        kind: "error",
        title: "Check Your Inputs",
        message: parsed.error.issues[0]?.message || "Please complete the required inputs.",
      });
      return;
    }

    if (!isAuthenticated) {
      setGenerationStatus("error");
      setErrorBanner({
        kind: "integration",
        title: "Sign In Required",
        message:
          "AI storyboard generation requires an authenticated session so your quota and saved drafts stay scoped to your account.",
        endpoint: "POST /api/ai/storyboard",
      });
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    inFlightRef.current = true;
    setGenerationStatus("generating");
    setErrorBanner(null);
    setSaveStatusMessage(null);
    setSaveError(null);

    try {
      const res = await generateAiStoryboard(requestPayload, {
        signal: controller.signal,
      });

      if (res.cancelled || res.status === 499) {
        setGenerationStatus("cancelled");
        setErrorBanner({
          kind: "cancelled",
          title: "Generation Cancelled",
          message:
            "Storyboard generation was cancelled. Your previous draft and manual editor remain untouched.",
        });
        return;
      }

      if (!res.ok || !res.data?.storyboard) {
        setGenerationStatus("error");
        const cat = res.errorCategory;
        const isIntegration =
          cat === "MISSING_API_KEY" ||
          cat === "INVALID_API_KEY" ||
          cat === "UNAUTHENTICATED" ||
          cat === "PERMISSION_DENIED" ||
          cat === "NOT_FOUND" ||
          (res.status === 503 &&
            Boolean(res.integrationPoint || /GEMINI_API_KEY|MongoDB/i.test(res.error || "")));
        const titleLabel =
          cat === "RESOURCE_EXHAUSTED" || res.status === 429
            ? "Gemini Quota / Rate Limit Reached"
            : cat === "TIMEOUT" || res.status === 504
              ? "Request Timed Out"
              : res.status === 409
                ? "Generation Already In Progress"
                : cat === "SAFETY_BLOCK"
                  ? "Blocked by Safety Filters"
                  : cat === "NOT_FOUND"
                    ? "Configured Gemini Model Unavailable"
                    : cat === "UNAUTHENTICATED" || cat === "INVALID_API_KEY"
                      ? "Gemini Authentication Failed"
                      : cat === "PERMISSION_DENIED"
                        ? "Gemini Model Access Denied"
                        : cat === "INVALID_ARGUMENT"
                          ? "Invalid AI Request Parameters"
                          : cat === "UNAVAILABLE"
                            ? "Gemini Service Temporarily Unavailable"
                            : res.status === 422
                              ? "Storyboard Validation Failed"
                              : isIntegration
                                ? "Gemini Service Configuration Required"
                                : "Storyboard Generation Failed";

        setErrorBanner({
          kind: isIntegration ? "integration" : "error",
          title: titleLabel,
          message:
            res.error ||
            "Could not generate storyboard. Try again or continue editing locally.",
          endpoint: res.integrationPoint,
          retryable:
            res.status === 0 ||
            cat === "UNAVAILABLE" ||
            cat === "TIMEOUT" ||
            res.status === 504 ||
            (res.status === 503 && !isIntegration),
        });
        return;
      }

      const generated = res.data.storyboard;
      setStoryboard(generated);
      setActiveServerDraftId(null);
      setGenerationStatus("ready");
      saveLocalStoryboardDraft(
        {
          id: generated.id,
          title: generated.title,
          status: "validated",
          storyboard: generated,
          savedAt: new Date().toISOString(),
        },
        draftScopeKey
      );
    } finally {
      inFlightRef.current = false;
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await runStoryboardGeneration();
  };

  const handleCancelGeneration = () => {
    abortControllerRef.current?.abort();
  };

  const handleSaveDraft = async () => {
    if (!storyboard || savingDraft) return;
    setSaveError(null);
    setSaveStatusMessage(null);

    const check = validateStoryboardInvariants(storyboard);
    if (!check.valid) {
      setSaveError(check.errors[0]);
      return;
    }

    const summary = computeStoryboardMediaSummary(storyboard, mediaAssets, !idbHydrating);
    const voSummary = computeStoryboardVoiceoverSummary(
      storyboard,
      mediaAssets,
      !idbHydrating,
      generatingSceneIdsRef.current
    );
    const capSummary = computeStoryboardCaptionsSummary(
      storyboard,
      mediaAssets,
      generatingCaptionSceneIdsRef.current
    );
    const updatedStoryboard: VideoStoryboard = {
      ...storyboard,
      mediaReadinessSummary: summary,
      voiceoverSummary: voSummary,
      captionSummary: capSummary,
      updatedAt: new Date().toISOString(),
    };

    setSavingDraft(true);
    const localRecord: StoryboardDraftRecord = {
      id: updatedStoryboard.id,
      ...(activeServerDraftId ? { serverDraftId: activeServerDraftId } : {}),
      title: updatedStoryboard.title,
      status: summary.isMediaReady ? "validated" : "draft",
      storyboard: updatedStoryboard,
      savedAt: updatedStoryboard.updatedAt,
    };
    saveLocalStoryboardDraft(localRecord, draftScopeKey);

    if (!isAuthenticated) {
      setSavingDraft(false);
      setSaveStatusMessage(
        "Storyboard draft and media assignments saved to local browser storage (sign in to sync metadata to MongoDB)."
      );
      return;
    }

    const res = activeServerDraftId
      ? await updateServerStoryboardDraft(activeServerDraftId, localRecord.storyboard, localRecord.status)
      : await createServerStoryboardDraft(localRecord.storyboard, localRecord.status);

    setSavingDraft(false);

    if (!res.ok || !res.data?.draft) {
      setSaveError(
        res.error ||
          "Saved locally, but could not sync storyboard draft to MongoDB."
      );
      return;
    }

    const serverId = String(res.data.draft._id || res.data.draft.id || "");
    if (serverId) {
      setActiveServerDraftId(serverId);
      saveLocalStoryboardDraft(
        {
          ...localRecord,
          serverDraftId: serverId,
        },
        draftScopeKey
      );
    }
    setSaveStatusMessage(
      summary.missingOrInvalidCount > 0
        ? "Storyboard draft saved, though some scenes reference missing IndexedDB media."
        : "Storyboard draft and scene media assignments saved and restored across refreshes."
    );
    void loadServerDrafts();
  };

  const handleLoadDraftFromServer = (draft: ServerStoryboardDraftDto) => {
    const serverId = String(draft._id || draft.id || "");
    const summary = computeStoryboardMediaSummary(draft.storyboard, mediaAssets, !idbHydrating);
    setActiveAudioSceneId(null);
    if (batchVoiceoverCancelRef.current) {
      batchVoiceoverCancelRef.current.cancelled = true;
    }
    if (batchCaptionCancelRef.current) {
      batchCaptionCancelRef.current.cancelled = true;
    }
    for (const entry of activeCaptionJobsRef.current.values()) {
      entry.controller.abort();
      void cancelCaptionJob(entry.clientJobId);
    }
    setStoryboard(draft.storyboard);
    setActiveServerDraftId(serverId || null);
    setGenerationStatus("ready");
    setErrorBanner(null);
    setSaveError(null);
    setMediaPrepStatusMessage(
      summary.missingOrInvalidCount > 0
        ? `${summary.missingOrInvalidCount} scene(s) in "${draft.title}" reference missing IndexedDB media on this browser — use Re-link File or Replace.`
        : null
    );
    setSaveStatusMessage(`Loaded saved draft "${draft.title}".`);
    saveLocalStoryboardDraft(
      {
        id: draft.storyboard.id,
        ...(serverId ? { serverDraftId: serverId } : {}),
        title: draft.title,
        status: draft.status,
        storyboard: draft.storyboard,
        savedAt: draft.updatedAt || new Date().toISOString(),
      },
      draftScopeKey
    );
  };

  const handleDeleteServerDraft = async (draftId: string) => {
    const res = await deleteServerStoryboardDraft(draftId);
    if (res.ok) {
      if (activeServerDraftId === draftId) {
        setActiveServerDraftId(null);
      }
      void loadServerDrafts();
    }
  };

  const handleClearActiveDraft = () => {
    setActiveAudioSceneId(null);
    if (batchVoiceoverCancelRef.current) {
      batchVoiceoverCancelRef.current.cancelled = true;
    }
    if (batchCaptionCancelRef.current) {
      batchCaptionCancelRef.current.cancelled = true;
    }
    for (const entry of activeCaptionJobsRef.current.values()) {
      entry.controller.abort();
      void cancelCaptionJob(entry.clientJobId);
    }
    setVoiceoverBatchState({
      active: false,
      currentSceneId: null,
      completedCount: 0,
      totalCount: 0,
      statusMessage: null,
    });
    setCaptionBatchState({
      active: false,
      mode: "script",
      currentSceneId: null,
      completedCount: 0,
      totalCount: 0,
      statusMessage: null,
    });
    setStoryboard(null);
    setActiveServerDraftId(null);
    setGenerationStatus("idle");
    setSaveStatusMessage(null);
    setSaveError(null);
    clearLocalStoryboardDraft(draftScopeKey);
  };

  return (
    <StudioShell>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">
              AI Script &amp; Storyboard Generator
            </h1>
            <p className="mt-1 text-sm text-zinc-400 max-w-3xl">
              Plan structured video scripts, match scene visual media, synthesize offline local
              voiceovers, edit styled captions / SRT / WebVTT subtitles, and prepare drafts for
              Phase 5.5.5 FFmpeg composition.
            </p>
          </div>

          {storyboard && (
            <button
              type="button"
              onClick={handleClearActiveDraft}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Start Fresh Draft</span>
            </button>
          )}
        </div>

        {/* Auth / Gemini Configuration Banners */}
        {!isAuthenticated && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 text-xs text-amber-200">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
              <div>
                <p className="font-medium">Sign in required for AI storyboard generation</p>
                <p className="mt-0.5 opacity-90">
                  Storyboard planning calls `POST /api/ai/storyboard` with your account session.
                  Manual timeline editing remains available without signing in.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate("auth")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 border border-amber-400/40 px-3.5 py-2 text-xs font-medium text-white hover:bg-amber-500/30 transition-colors whitespace-nowrap shrink-0"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span>Sign In / Register</span>
            </button>
          </div>
        )}

        {!geminiConfigured && (
          <IntegrationNotice
            title="Gemini API Key Required"
            endpoint="POST /api/ai/storyboard"
            description="Set GEMINI_API_KEY on the server to enable AI script and storyboard generation at ₹0 quota cost. The manual editor remains fully functional."
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Generator Configuration Form */}
          <form
            onSubmit={handleSubmit}
            className="lg:col-span-5 rounded-2xl border border-zinc-800/80 bg-[#111114] p-6 space-y-5"
          >
            {/* Mode Tabs (Prompt to Video, Script to Video, Image Animation [Upcoming]) */}
            <div
              role="tablist"
              aria-label="Generator modes"
              className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800/80"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "prompt-to-video"}
                onClick={() => {
                  setMode("prompt-to-video");
                  setErrorBanner(null);
                }}
                className={`rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === "prompt-to-video"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Prompt to Video
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "script-to-video"}
                onClick={() => {
                  setMode("script-to-video");
                  setErrorBanner(null);
                }}
                className={`rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === "script-to-video"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Script to Video
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "image-animation"}
                onClick={() => {
                  setMode("image-animation");
                  setErrorBanner(null);
                }}
                className={`rounded-md py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  mode === "image-animation"
                    ? "bg-zinc-800 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Image Animation · Soon
              </button>
            </div>

            {mode === "image-animation" ? (
              <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-6 space-y-3 text-center">
                <Film className="h-6 w-6 text-zinc-400 mx-auto" />
                <h2 className="font-display text-sm font-semibold text-white">
                  Image Animation (Upcoming Feature)
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed max-w-sm mx-auto">
                  Local FFmpeg pan, zoom, and keyframe motion animation for still images will be
                  introduced in an upcoming composition phase. No fake frames or placeholder videos
                  are generated here.
                </p>
                <div className="pt-1 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMode("prompt-to-video")}
                    className="rounded-lg bg-zinc-800 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 transition-colors"
                  >
                    Switch to Prompt to Video
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="sb-title"
                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                  >
                    Video Title (optional)
                  </label>
                  <input
                    id="sb-title"
                    type="text"
                    maxLength={120}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. 3 Habits That Double Deep Focus"
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="sb-prompt"
                      className="text-xs font-medium text-zinc-300"
                    >
                      {mode === "script-to-video"
                        ? "Existing Narration Script"
                        : "Video Topic or Prompt"}
                    </label>
                    <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
                      {prompt.length} / 4000
                    </span>
                  </div>
                  <textarea
                    id="sb-prompt"
                    rows={5}
                    maxLength={4000}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      mode === "script-to-video"
                        ? "Paste your existing narration script to break it into timed visual scenes, captions, and stock media search keywords..."
                        : "Describe your video topic, key message, pacing, and visual tone..."
                    }
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none resize-y"
                  />
                </div>

                {/* Duration & Aspect Ratio */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <span className="block text-xs font-medium text-zinc-300 mb-1.5">
                      Target Duration
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800">
                      {STORYBOARD_TARGET_DURATIONS.map((sec) => (
                        <button
                          key={sec}
                          type="button"
                          onClick={() => setTargetDurationSec(sec)}
                          className={`rounded-md py-1.5 text-xs font-mono tabular-nums transition-colors ${
                            targetDurationSec === sec
                              ? "bg-zinc-800 text-white"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {sec}s
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <span className="block text-xs font-medium text-zinc-300 mb-1.5">
                      Aspect Ratio
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800">
                      {STORYBOARD_ASPECT_RATIOS.map((ar) => (
                        <button
                          key={ar}
                          type="button"
                          onClick={() => setAspectRatio(ar)}
                          className={`rounded-md py-1.5 text-xs font-mono tabular-nums transition-colors ${
                            aspectRatio === ar
                              ? "bg-zinc-800 text-white"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {ar}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Style & Language */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="sb-style"
                      className="block text-xs font-medium text-zinc-300 mb-1.5"
                    >
                      Video Style
                    </label>
                    <select
                      id="sb-style"
                      value={style}
                      onChange={(e) => setStyle(e.target.value as StoryboardStyle)}
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {STORYBOARD_STYLES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="sb-language"
                      className="block text-xs font-medium text-zinc-300 mb-1.5"
                    >
                      Language
                    </label>
                    <select
                      id="sb-language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value as StoryboardLanguage)}
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                    >
                      {STORYBOARD_LANGUAGES.map((lang) => (
                        <option key={lang} value={lang}>
                          {lang}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Voiceover & Caption Preferences (stored in storyboard metadata) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-zinc-800/80">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="sb-vo-pref" className="text-xs font-medium text-zinc-300">
                        Voiceover Preference
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={voiceoverEnabled}
                          onChange={(e) => setVoiceoverEnabled(e.target.checked)}
                          className="accent-violet-500"
                        />
                        <span>Plan</span>
                      </label>
                    </div>
                    <select
                      id="sb-vo-pref"
                      disabled={!voiceoverEnabled}
                      value={voiceoverEnabled ? voiceoverPreference : "none"}
                      onChange={(e) =>
                        setVoiceoverPreference(e.target.value as StoryboardVoiceoverPreference)
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                    >
                      {VOICEOVER_PREFERENCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-zinc-500">
                      Initial voiceover plan metadata; synthesize offline voices below.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="sb-cap-pref" className="text-xs font-medium text-zinc-300">
                        Caption Preference
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={captionsEnabled}
                          onChange={(e) => setCaptionsEnabled(e.target.checked)}
                          className="accent-violet-500"
                        />
                        <span>Plan</span>
                      </label>
                    </div>
                    <select
                      id="sb-cap-pref"
                      disabled={!captionsEnabled}
                      value={captionsEnabled ? captionStyle : "none"}
                      onChange={(e) =>
                        setCaptionStyle(e.target.value as StoryboardCaptionPreference)
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                    >
                      {CAPTION_PREFERENCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-zinc-500">
                      Initial caption preset hint; edit timed cues &amp; export SRT/VTT below.
                    </p>
                  </div>
                </div>

                {/* Optional Audience & Instructions */}
                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="sb-audience"
                      className="block text-xs font-medium text-zinc-300 mb-1.5"
                    >
                      Target Audience (optional)
                    </label>
                    <input
                      id="sb-audience"
                      type="text"
                      maxLength={160}
                      value={targetAudience}
                      onChange={(e) => setTargetAudience(e.target.value)}
                      placeholder="e.g. College students, indie founders, creators"
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="sb-notes"
                      className="block text-xs font-medium text-zinc-300 mb-1.5"
                    >
                      Additional Instructions (optional)
                    </label>
                    <input
                      id="sb-notes"
                      type="text"
                      maxLength={500}
                      value={additionalInstructions}
                      onChange={(e) => setAdditionalInstructions(e.target.value)}
                      placeholder="e.g. Open with a 3-second hook question, avoid jargon"
                      className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Submit / Cancel Buttons */}
                <div className="flex items-center gap-2.5 pt-1">
                  <button
                    type="submit"
                    disabled={
                      generationStatus === "generating" || !clientValidation.success
                    }
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    <span>
                      {generationStatus === "generating"
                        ? "Generating Storyboard..."
                        : "Generate Storyboard"}
                    </span>
                  </button>

                  {generationStatus === "generating" && (
                    <button
                      type="button"
                      onClick={handleCancelGeneration}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>Cancel</span>
                    </button>
                  )}
                </div>

                {!clientValidation.success && prompt.trim().length > 0 && (
                  <p className="text-[11px] text-amber-300">
                    {clientValidation.error.issues[0]?.message}
                  </p>
                )}
              </>
            )}
          </form>

          {/* Right Column: Generation State / Storyboard Review / Drafts */}
          <div className="lg:col-span-7 space-y-5">
            {generationStatus === "generating" && (
              <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-8 text-center space-y-3">
                <div className="h-7 w-7 rounded-full border-2 border-violet-500 border-t-transparent animate-spin mx-auto" />
                <p className="text-sm font-medium text-white">
                  Planning script and scenes with Gemini...
                </p>
                <p className="text-xs text-zinc-400 max-w-md mx-auto">
                  Generating structured JSON scene timings, narration, on-screen captions, and
                  media search keywords. No MP4 video frames are rendered in this step.
                </p>
              </div>
            )}

            {errorBanner && (
              <div
                role="alert"
                className={`rounded-2xl border p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4 ${
                  errorBanner.kind === "integration"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    : errorBanner.kind === "cancelled"
                      ? "border-zinc-700 bg-zinc-900/80 text-zinc-200"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-200"
                }`}
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold">{errorBanner.title}</p>
                    <p className="leading-relaxed opacity-90">{errorBanner.message}</p>
                    {errorBanner.endpoint && (
                      <p className="font-mono text-[11px] opacity-80">
                        Endpoint: {errorBanner.endpoint}
                      </p>
                    )}
                  </div>
                </div>
                {errorBanner.retryable && (
                  <button
                    type="button"
                    onClick={() => void runStoryboardGeneration()}
                    className="rounded-lg border border-current/30 bg-black/25 px-3 py-1.5 text-xs font-medium hover:bg-black/40 transition-colors whitespace-nowrap shrink-0"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {storyboard ? (
              <StoryboardReviewPanel
                storyboard={storyboard}
                onChange={handleStoryboardChange}
                onSaveDraft={handleSaveDraft}
                onRegenerate={() => void runStoryboardGeneration()}
                savingDraft={savingDraft}
                saveStatusMessage={saveStatusMessage}
                saveError={saveError}
                regenerating={generationStatus === "generating"}
                isAuthenticated={isAuthenticated}
                mediaAssets={mediaAssets}
                idbHydrating={idbHydrating}
                mediaPrepActive={mediaPrepActive}
                mediaPrepStatusMessage={mediaPrepStatusMessage}
                onAutoMatchMedia={handleAutoMatchMedia}
                onUploadBatchMedia={handleUploadBatchMedia}
                onUploadSceneFile={handleUploadSceneFile}
                onSelectLibraryAsset={handleSelectLibraryAsset}
                onImportStockResult={handleImportStockResult}
                onGenerateAndAssignSlide={handleGenerateAndAssignSlide}
                onRelinkMissingSceneMedia={handleRelinkMissingSceneMedia}
                onCancelMediaPrep={handleCancelMediaPrep}
                ttsStatus={ttsStatus}
                ttsLoading={ttsLoading}
                ttsError={ttsError}
                ttsVoices={ttsVoices}
                generatingVoiceoverSceneIds={generatingVoiceoverSceneIds}
                voiceoverBatchState={voiceoverBatchState}
                activeAudioSceneId={activeAudioSceneId}
                onActivateSceneAudio={setActiveAudioSceneId}
                onRefreshTts={() => void loadTtsCapabilities()}
                onGenerateSceneVoiceover={(sceneId, overrideParams) =>
                  void synthesizeSceneVoiceover(sceneId, overrideParams)
                }
                onCancelSceneVoiceover={handleCancelSceneVoiceover}
                onRemoveSceneVoiceover={handleRemoveSceneVoiceover}
                onUpdateSceneVoiceoverVolume={handleUpdateSceneVoiceoverVolume}
                onGenerateMissingOrStaleVoiceovers={() =>
                  void handleGenerateBatchVoiceovers("missing_or_stale")
                }
                onRegenerateAllVoiceovers={() => void handleGenerateBatchVoiceovers("all")}
                onCancelVoiceoverBatch={handleCancelVoiceoverBatch}
                onClearAllVoiceovers={handleClearAllVoiceovers}
                captionsStatus={captionsStatus}
                captionsLoading={captionsLoading}
                captionsError={captionsError}
                generatingCaptionSceneIds={generatingCaptionSceneIds}
                captionBatchState={captionBatchState}
                onRefreshCaptionsStatus={() => void loadCaptionsCapabilities()}
                onGenerateSceneScriptCaptions={handleGenerateSceneScriptCaptions}
                onTranscribeSceneAudioCaptions={(sceneId) =>
                  void transcribeSceneAudioCaptions(sceneId)
                }
                onCancelSceneCaptions={handleCancelSceneCaptions}
                onUpdateSceneCaptionSegments={handleUpdateSceneCaptionSegments}
                onRemoveSceneCaptions={handleRemoveSceneCaptions}
                onTrimSceneCaptionsToDuration={handleTrimSceneCaptionsToDuration}
                onGenerateMissingOrStaleCaptions={(targetMode) =>
                  void handleGenerateBatchCaptions("missing_or_stale", targetMode)
                }
                onRegenerateAllCaptions={(targetMode) =>
                  void handleGenerateBatchCaptions("all", targetMode)
                }
                onCancelCaptionBatch={handleCancelCaptionBatch}
                onClearAllCaptions={handleClearAllCaptions}
              />
            ) : (
              generationStatus !== "generating" && (
                <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-8 text-center space-y-4">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-800 bg-[#09090B] text-violet-400">
                    {mode === "script-to-video" ? (
                      <FileText className="h-5 w-5" />
                    ) : (
                      <BookOpen className="h-5 w-5" />
                    )}
                  </div>
                  <div className="space-y-1.5 max-w-md mx-auto">
                    <h2 className="font-display text-base font-semibold text-white">
                      Ready to plan your storyboard
                    </h2>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Enter a prompt or existing narration script on the left and select target
                      duration, aspect ratio, style, and language. Next you can match local media,
                      synthesize offline scene voiceovers, and prepare drafts before Phase 5.5.4+
                      FFmpeg timeline composition.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                    <span>Gemini Structured JSON</span>
                    <span aria-hidden="true">·</span>
                    <span>Up to 12 Sequential Scenes</span>
                    <span aria-hidden="true">·</span>
                    <span>₹0 Local FFmpeg Roadmap</span>
                  </div>
                </div>
              )
            )}

            {/* Saved Storyboard Drafts List (User-Scoped MongoDB Drafts) */}
            {isAuthenticated && (
              <section
                aria-label="Saved Storyboard Drafts"
                className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-5 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-violet-400" />
                    <h2 className="font-display text-sm font-semibold text-white">
                      Saved Storyboard Drafts
                    </h2>
                  </div>
                  <span className="text-[11px] text-zinc-500 tabular-nums">
                    {loadingDrafts ? "Loading..." : `${savedDrafts.length} saved`}
                  </span>
                </div>

                {savedDrafts.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No saved server drafts yet. Generate a storyboard and click Save Storyboard
                    Draft to restore it anytime across sessions.
                  </p>
                ) : (
                  <div className="divide-y divide-zinc-800/80 border-t border-zinc-800/80">
                    {savedDrafts.map((draft) => {
                      const draftId = String(draft._id || draft.id || "");
                      const isActive = activeServerDraftId === draftId;
                      return (
                        <div
                          key={draftId}
                          className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-xs font-medium text-white truncate">
                              {draft.title}
                              {isActive ? " (Open)" : ""}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400 tabular-nums">
                              <span>{draft.totalDuration}s</span>
                              <span aria-hidden="true">·</span>
                              <span>{draft.aspectRatio}</span>
                              <span aria-hidden="true">·</span>
                              <span>{draft.style}</span>
                              <span aria-hidden="true">·</span>
                              <span>{draft.language}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {new Date(draft.updatedAt).toLocaleDateString()}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleLoadDraftFromServer(draft)}
                              className="rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap"
                            >
                              Restore Draft
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteServerDraft(draftId)}
                              className="rounded-lg border border-zinc-800 bg-[#09090B] p-1.5 text-zinc-400 hover:text-rose-400 transition-colors"
                              title="Delete draft"
                              aria-label={`Delete draft ${draft.title}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </StudioShell>
  );
}
