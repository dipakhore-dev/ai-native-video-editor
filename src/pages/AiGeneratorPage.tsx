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
  createServerStoryboardDraft,
  deleteServerStoryboardDraft,
  fetchServerStoryboardDrafts,
  generateAiStoryboard,
  importStockMediaApi,
  updateServerStoryboardDraft,
  type ServerStoryboardDraftDto,
  type StockSearchItemDto,
} from "../services/api";
import type {
  AspectRatioOption,
  GeneratedSlideConfig,
  MediaAsset,
  StoryboardCaptionPreference,
  StoryboardDraftRecord,
  StoryboardGenerationStatus,
  StoryboardLanguage,
  StoryboardStyle,
  StoryboardTargetDuration,
  StoryboardVoiceoverPreference,
  VideoGenerationRequest,
  VideoGeneratorMode,
  VideoStoryboard,
} from "../types/studio";
import { detectMediaKind } from "../utils/media";
import {
  CAPTION_PREFERENCE_OPTIONS,
  clearLocalStoryboardDraft,
  loadLocalStoryboardDraft,
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
  autoMatchStoryboardScenes,
  computeStoryboardMediaSummary,
  createAssignmentFromAsset,
} from "../utils/storyboardMedia";

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

  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaPrepAbortRef = useRef<AbortController | null>(null);
  const storyboardRef = useRef<VideoStoryboard | null>(storyboard);
  storyboardRef.current = storyboard;
  const inFlightRef = useRef(false);
  const draftScopeKey = sessionUser.id || "local";

  const geminiConfigured = integrations?.aiAssistant?.connected ?? true;

  // Cleanup active request abort controllers on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      mediaPrepAbortRef.current?.abort();
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

  // Keep isolated local draft synced whenever user edits an existing storyboard
  const handleStoryboardChange = useCallback(
    (next: VideoStoryboard) => {
      const withSummary: VideoStoryboard = {
        ...next,
        mediaReadinessSummary: computeStoryboardMediaSummary(next, mediaAssets, !idbHydrating),
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
    const updatedStoryboard: VideoStoryboard = {
      ...storyboard,
      mediaReadinessSummary: summary,
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
              Plan structured video scripts, match scene visual media, render local text slides, and
              prepare drafts for Phase 5.5.3 FFmpeg composition.
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
                      Preference saved for later voice synthesis (not generated yet).
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
                      Controls caption formatting metadata for Phase 5.5.3.
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
                      duration, aspect ratio, style, and language. Next you can auto-match local
                      IndexedDB media, import free stock, or generate PNG text slides before Phase
                      5.5.3 FFmpeg timeline composition.
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
