import React, { useRef, useState } from "react";
import { Wand2, Image as ImageIcon, Upload, AlertCircle, Film, X } from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import { submitVideoGenerationRequest } from "../services/api";
import type { AspectRatioOption } from "../types/studio";

export function AiGeneratorPage() {
  const { mediaAssets, integrations } = useStudio();
  const isVideoGenConfigured = Boolean(integrations?.videoGeneration?.connected);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<"text-to-video" | "image-to-video">("text-to-video");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("16:9");
  const [durationSeconds, setDurationSeconds] = useState<4 | 8 | 12>(4);
  const [cameraMotion, setCameraMotion] = useState("slow-dolly-in");
  const [referencePreviewUrl, setReferencePreviewUrl] = useState<string | null>(null);
  const [referenceName, setReferenceName] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [serverResponse, setServerResponse] = useState<{
    kind: "error" | "integration";
    message: string;
    endpoint?: string;
    payload?: Record<string, unknown>;
  } | null>(null);

  const libraryImages = mediaAssets.filter((a) => a.kind === "image");

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setReferencePreviewUrl(url);
    setReferenceName(file.name);
    setServerResponse(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isVideoGenConfigured) {
      setServerResponse({
        kind: "integration",
        message:
          "Paid text-to-video and image-to-video generation is disabled until an external provider (VIDEO_GEN_PROVIDER_URL) is configured.",
        endpoint: "POST /api/ai/generate-video",
      });
      return;
    }

    setSubmitting(true);
    setServerResponse(null);

    const res = await submitVideoGenerationRequest({
      mode,
      prompt,
      negativePrompt,
      aspectRatio,
      durationSeconds,
      cameraMotion,
      hasReferenceImage: Boolean(referencePreviewUrl),
    });

    setSubmitting(false);

    if (!res.ok) {
      setServerResponse({
        kind: res.status === 501 || res.status === 503 ? "integration" : "error",
        message: res.error || "Unable to dispatch generation request.",
        endpoint: res.integrationPoint,
        payload: res.data?.validatedRequest,
      });
    }
  };

  return (
    <StudioShell>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageSelect}
        className="hidden"
      />

      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">AI Video Generator</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Configure Text-to-Video and Image-to-Video generation jobs wired to the backend worker endpoint.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Form Controls */}
          <form
            onSubmit={handleSubmit}
            className="lg:col-span-6 rounded-2xl border border-zinc-800/80 bg-[#111114] p-6 space-y-5"
          >
            {/* Mode Switch */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800/80">
              <button
                type="button"
                onClick={() => {
                  setMode("text-to-video");
                  setServerResponse(null);
                }}
                className={`rounded-md py-2 text-xs font-medium transition-colors ${
                  mode === "text-to-video"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Text-to-Video
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("image-to-video");
                  setServerResponse(null);
                }}
                className={`rounded-md py-2 text-xs font-medium transition-colors ${
                  mode === "image-to-video"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Image-to-Video
              </button>
            </div>

            {mode === "image-to-video" && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-300">
                    Starting Reference Frame
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setReferencePreviewUrl("/src/assets/images/feature_cinema_frame_1794647536308.jpg");
                      setReferenceName("Studio Sample Still");
                      setServerResponse(null);
                    }}
                    className="text-[11px] font-medium text-violet-400 hover:text-violet-300"
                  >
                    Use Sample Studio Still
                  </button>
                </div>

                {referencePreviewUrl ? (
                  <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 h-44">
                    <img
                      src={referencePreviewUrl}
                      alt={referenceName ?? "Reference frame"}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent flex items-center justify-between">
                      <span className="text-xs text-zinc-200 truncate">{referenceName}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setReferencePreviewUrl(null);
                          setReferenceName(null);
                        }}
                        className="rounded-md bg-black/70 p-1 text-zinc-300 hover:text-white"
                        aria-label="Remove reference image"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="w-full rounded-xl border border-dashed border-zinc-800 bg-[#09090B] p-6 text-center hover:border-zinc-700 transition-colors"
                  >
                    <Upload className="h-5 w-5 text-blue-400 mx-auto mb-2" />
                    <p className="text-xs font-medium text-zinc-200">
                      Upload a local PNG or JPG keyframe
                    </p>
                    <p className="text-[11px] text-zinc-500 mt-1">
                      Or select a sample still above
                    </p>
                  </button>
                )}

                {libraryImages.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto pt-1">
                    {libraryImages.map((img) => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => {
                          setReferencePreviewUrl(img.objectUrl);
                          setReferenceName(img.name);
                        }}
                        className="h-12 w-20 shrink-0 rounded-md overflow-hidden border border-zinc-800 hover:border-violet-500"
                        title={img.name}
                      >
                        <img
                          src={img.objectUrl}
                          alt={img.name}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div>
              <label htmlFor="gen-prompt" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Scene &amp; Motion Prompt
              </label>
              <textarea
                id="gen-prompt"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe subject, lighting, lens, and camera movement..."
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none resize-none"
              />
            </div>

            <div>
              <label htmlFor="neg-prompt" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Negative Prompt (optional)
              </label>
              <input
                id="neg-prompt"
                type="text"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="e.g. motion blur, text overlays, jitter"
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Aspect</label>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value as AspectRatioOption)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Duration</label>
                <select
                  value={durationSeconds}
                  onChange={(e) => setDurationSeconds(Number(e.target.value) as 4 | 8 | 12)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  <option value={4}>4 seconds</option>
                  <option value={8}>8 seconds</option>
                  <option value={12}>12 seconds</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Camera</label>
                <select
                  value={cameraMotion}
                  onChange={(e) => setCameraMotion(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-2.5 py-2 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none"
                >
                  <option value="static">Static Tripod</option>
                  <option value="slow-dolly-in">Slow Dolly In</option>
                  <option value="pan-right">Pan Right</option>
                  <option value="aerial-orbit">Aerial Orbit</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || !isVideoGenConfigured}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Wand2 className="h-3.5 w-3.5" />
              <span>
                {!isVideoGenConfigured
                  ? "Generation Disabled (No Paid Provider)"
                  : submitting
                    ? "Dispatching to Backend..."
                    : "Submit Generation Job"}
              </span>
            </button>
          </form>

          {/* Output / Integration Viewport */}
          <div className="lg:col-span-6 space-y-4">
            <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white">Generation Output Viewport</h2>
                <span className="text-xs font-mono text-zinc-400">
                  {aspectRatio} · {durationSeconds}s
                </span>
              </div>

              <div className="aspect-video rounded-xl border border-zinc-800 bg-[#09090B] flex flex-col items-center justify-center p-6 text-center">
                {submitting ? (
                  <div className="space-y-2">
                    <div className="h-6 w-6 rounded-full border-2 border-violet-500 border-t-transparent animate-spin mx-auto" />
                    <p className="text-xs text-zinc-300">Validating request with Node.js API...</p>
                  </div>
                ) : serverResponse ? (
                  <div className="w-full max-w-md text-left space-y-3">
                    <div
                      className={`rounded-lg border p-3.5 text-xs flex items-start gap-2.5 ${
                        serverResponse.kind === "integration"
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                          : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                      }`}
                    >
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">
                          {serverResponse.kind === "integration"
                            ? "Video Provider Disabled"
                            : "Validation Error"}
                        </p>
                        <p className="mt-1 leading-relaxed opacity-90">{serverResponse.message}</p>
                        {serverResponse.endpoint && (
                          <p className="mt-1.5 font-mono text-[11px]">
                            Endpoint: {serverResponse.endpoint}
                          </p>
                        )}
                      </div>
                    </div>

                    {serverResponse.payload && (
                      <div className="rounded-lg border border-zinc-800 bg-[#111114] p-3">
                        <p className="text-[11px] font-medium text-zinc-400 mb-1.5">
                          Validated Server Payload
                        </p>
                        <pre className="text-[11px] font-mono text-zinc-300 overflow-x-auto">
                          {JSON.stringify(serverResponse.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 mb-3">
                      {mode === "image-to-video" ? (
                        <ImageIcon className="h-5 w-5" />
                      ) : (
                        <Film className="h-5 w-5" />
                      )}
                    </div>
                    <p className="text-sm font-medium text-zinc-200">
                      {isVideoGenConfigured
                        ? "Ready for worker dispatch"
                        : "Paid generation disabled (₹0 Local Mode)"}
                    </p>
                    <p className="mt-1.5 text-xs text-zinc-500 max-w-sm leading-relaxed">
                      {isVideoGenConfigured
                        ? "Submit a prompt to validate the generation contract against POST /api/ai/generate-video. Rendered clips are never faked."
                        : "Paid text-to-video and image-to-video generation is disabled until VIDEO_GEN_PROVIDER_URL is configured. Local FFmpeg/FFprobe editing and faster-whisper subtitles run free without paid APIs."}
                    </p>
                  </>
                )}
              </div>
            </div>

            <IntegrationNotice
              title="External Video Model Endpoint"
              endpoint="POST /api/ai/generate-video"
              description="Disabled until VIDEO_GEN_PROVIDER_URL is configured on the Express server. Connect a provider when ready to synthesize real MP4 outputs."
            />
          </div>
        </div>
      </div>
    </StudioShell>
  );
}
