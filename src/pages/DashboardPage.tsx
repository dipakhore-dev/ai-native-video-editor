import React, { useRef } from "react";
import {
  Plus,
  Film,
  Upload,
  Wand2,
  FolderOpen,
  HardDrive,
  ArrowRight,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import { formatBytes, formatTimecode } from "../utils/media";

export function DashboardPage() {
  const {
    navigate,
    projects,
    setActiveProjectId,
    deleteProject,
    mediaAssets,
    totalMediaBytes,
    uploadLocalFiles,
    uploadingMedia,
    mediaError,
    integrations,
    integrationsLoading,
    integrationsError,
    refreshIntegrations,
    setCreateProjectModalOpen,
  } = useStudio();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const videoCount = mediaAssets.filter((a) => a.kind === "video").length;
  const imageCount = mediaAssets.filter((a) => a.kind === "image").length;
  const audioCount = mediaAssets.filter((a) => a.kind === "audio").length;

  const handleQuickUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadLocalFiles(e.target.files);
      e.target.value = "";
    }
  };

  const openProject = (projectId: string) => {
    setActiveProjectId(projectId);
    navigate("editor");
  };

  return (
    <StudioShell
      headerAction={
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5 text-blue-400" />
            <span>Upload Media</span>
          </button>
          <button
            type="button"
            onClick={() => setCreateProjectModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create Project</span>
          </button>
        </div>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        onChange={handleQuickUpload}
        className="hidden"
      />

      <div className="max-w-7xl mx-auto space-y-8">
        {/* Welcome Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white">
              Studio Workspace
            </h1>
            <p className="mt-1.5 text-sm text-zinc-400">
              Manage active editing sequences, local media assets, and connected backend services.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigate("generator")}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#111114] px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-900 transition-colors whitespace-nowrap"
            >
              <Wand2 className="h-3.5 w-3.5 text-violet-400" />
              <span>AI Video Generator</span>
            </button>
            <button
              type="button"
              onClick={() => navigate("editor")}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#111114] px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-900 transition-colors whitespace-nowrap"
            >
              <Film className="h-3.5 w-3.5 text-blue-400" />
              <span>Open Video Editor</span>
            </button>
          </div>
        </div>

        {mediaError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
            {mediaError}
          </div>
        )}

        {/* Real Session & Storage Statistics */}
        <section aria-label="Workspace Statistics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Local Media Footprint</span>
              <HardDrive className="h-4 w-4 text-blue-400" />
            </div>
            <p className="mt-3 font-mono text-2xl font-semibold text-white tabular-nums">
              {formatBytes(totalMediaBytes)}
            </p>
            <p className="mt-1.5 text-xs text-zinc-500 tabular-nums">
              {uploadingMedia ? "Inspecting local files..." : `${mediaAssets.length} active session files`}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Session Projects</span>
              <FolderOpen className="h-4 w-4 text-violet-400" />
            </div>
            <p className="mt-3 font-mono text-2xl font-semibold text-white tabular-nums">
              {projects.length}
            </p>
            <p className="mt-1.5 text-xs text-zinc-500">
              Stored in browser memory
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Asset Breakdown</span>
              <Film className="h-4 w-4 text-zinc-400" />
            </div>
            <p className="mt-3 font-mono text-2xl font-semibold text-white tabular-nums">
              {videoCount} <span className="text-sm font-normal text-zinc-400">video</span>
            </p>
            <p className="mt-1.5 text-xs text-zinc-500 tabular-nums">
              {imageCount} images · {audioCount} audio
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Cloud Storage Quota</span>
              <Upload className="h-4 w-4 text-zinc-400" />
            </div>
            <p className="mt-3 text-sm font-semibold text-zinc-200">
              Not Connected
            </p>
            <p className="mt-1.5 text-xs text-zinc-500">
              Attach S3 / GCS in Integrations
            </p>
          </div>
        </section>

        {/* Recent Projects */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-white">Recent Projects</h2>
            {projects.length > 0 && (
              <button
                type="button"
                onClick={() => navigate("projects")}
                className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
              >
                <span>View All Projects</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#111114]/60 p-10 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-violet-400 mb-4">
                <Film className="h-5 w-5" />
              </div>
              <h3 className="text-base font-medium text-white">No projects in this session yet</h3>
              <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                Create a new sequence to launch the multitrack timeline editor, or upload local video files to inspect thumbnails and duration.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setCreateProjectModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Create Project</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Upload Local Video</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.slice(0, 6).map((project) => {
                const totalDuration = project.clips.reduce(
                  (max, clip) => Math.max(max, clip.startTime + clip.duration),
                  0
                );
                const previewThumb = project.clips.find((c) => c.thumbnailUrl)?.thumbnailUrl;

                return (
                  <div
                    key={project.id}
                    className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-hidden flex flex-col hover:border-zinc-700 transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => openProject(project.id)}
                      className="relative h-36 bg-zinc-950 w-full text-left group overflow-hidden"
                    >
                      {previewThumb ? (
                        <img
                          src={previewThumb}
                          alt={project.name}
                          className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-zinc-600">
                          <Film className="h-7 w-7" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[11px] font-mono text-zinc-300 tabular-nums">
                        <span>{project.aspectRatio} · {project.resolution}</span>
                        <span>{formatTimecode(totalDuration)}</span>
                      </div>
                    </button>

                    <div className="p-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => openProject(project.id)}
                          className="text-sm font-medium text-white hover:text-violet-400 transition-colors truncate block max-w-full text-left"
                        >
                          {project.name}
                        </button>
                        <p className="mt-1 text-xs text-zinc-500 tabular-nums">
                          {project.clips.length} clips · {project.fps} fps
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteProject(project.id)}
                        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 transition-colors shrink-0"
                        aria-label={`Delete ${project.name}`}
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

        {/* Backend Integration Readiness */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                External Service Integration Points
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Live readiness reported by the Node.js Express server.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshIntegrations()}
              disabled={integrationsLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${integrationsLoading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>

          {integrationsError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">
              {integrationsError}
            </div>
          )}

          {integrationsLoading && !integrations ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-28 rounded-xl border border-zinc-800/80 bg-[#111114] animate-pulse" />
              ))}
            </div>
          ) : integrations ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.values(integrations).map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-zinc-800/80 bg-[#111114] p-4 flex flex-col justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-white truncate">{item.label}</h3>
                      <span
                        className={`text-[11px] font-medium whitespace-nowrap ${
                          item.connected ? "text-emerald-400" : "text-amber-400"
                        }`}
                      >
                        {item.connected ? "Connected" : "Integration Required"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-mono text-zinc-500 truncate">{item.endpoint}</p>
                    <p className="mt-2 text-xs text-zinc-400 leading-relaxed">{item.summary}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <IntegrationNotice
            title="Session-Only Persistence"
            endpoint="POST /api/projects"
            description="Projects and uploaded local media live in browser memory during this preview. Connect PostgreSQL or Firestore to persist edits across reloads."
          />
        </section>
      </div>
    </StudioShell>
  );
}
