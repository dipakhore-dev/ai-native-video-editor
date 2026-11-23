import React, { useRef, useState } from "react";
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
  Copy,
  AlertTriangle,
  LayoutTemplate,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { ProjectThumbnail } from "../components/common/ProjectThumbnail";
import { useStudio } from "../context/StudioContext";
import type { Project } from "../types/studio";
import { formatBytes, formatTimecode } from "../utils/media";
import { getProjectMediaHealth } from "../utils/projectThumbnails";
import { PROJECT_TEMPLATES } from "../utils/templates";

export function DashboardPage() {
  const {
    navigate,
    projects,
    setActiveProjectId,
    createProjectFromTemplateId,
    duplicateProject,
    deleteProject,
    mediaAssets,
    idbHydrating,
    isAuthenticated,
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
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

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

  const handleDuplicate = async (projectId: string) => {
    if (duplicatingId) return;
    setDuplicatingId(projectId);
    try {
      await duplicateProject(projectId);
    } finally {
      setDuplicatingId(null);
    }
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
              {uploadingMedia ? "Inspecting local files..." : `${mediaAssets.length} active IndexedDB files`}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Workspace Projects</span>
              <FolderOpen className="h-4 w-4 text-violet-400" />
            </div>
            <p className="mt-3 font-mono text-2xl font-semibold text-white tabular-nums">
              {projects.length}
            </p>
            <p className="mt-1.5 text-xs text-zinc-500">
              {isAuthenticated ? "Synced with MongoDB" : "Saved in local browser storage"}
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
              <span>Export History</span>
              <Upload className="h-4 w-4 text-zinc-400" />
            </div>
            <button
              type="button"
              onClick={() => navigate("exports")}
              className="mt-3 text-sm font-semibold text-violet-400 hover:text-violet-300 inline-flex items-center gap-1.5"
            >
              <span>View Export Jobs</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <p className="mt-1.5 text-xs text-zinc-500">
              Local MP4 &amp; JSON export records
            </p>
          </div>
        </section>

        {/* Quick Starter Templates */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-white inline-flex items-center gap-2">
              <LayoutTemplate className="h-4 w-4 text-violet-400" />
              <span>Starter Templates</span>
            </h2>
            <button
              type="button"
              onClick={() => navigate("projects")}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
            >
              <span>Manage All Projects</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {PROJECT_TEMPLATES.map((tpl) => (
              <div
                key={tpl.id}
                className="rounded-xl border border-zinc-800/80 bg-[#111114] p-4 flex items-center justify-between gap-3 hover:border-zinc-700 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white truncate">{tpl.title}</h3>
                    <span className="font-mono text-[11px] text-violet-300 tabular-nums shrink-0">
                      {tpl.aspectRatio}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 tabular-nums truncate">
                    {tpl.resolution} · {tpl.fps}fps · {tpl.estimatedDurationSec}s
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => createProjectFromTemplateId(tpl.id)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-violet-600 hover:border-violet-500 hover:text-white transition-colors whitespace-nowrap shrink-0"
                >
                  Use
                </button>
              </div>
            ))}
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
              <h3 className="text-base font-medium text-white">No projects in this workspace yet</h3>
              <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
                Create a new sequence, choose a starter template above, or upload local video files to inspect thumbnails and duration.
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
                const health = getProjectMediaHealth(project, mediaAssets, !idbHydrating);

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
                      <ProjectThumbnail
                        project={project}
                        mediaAssets={mediaAssets}
                        className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[11px] font-mono text-zinc-200 tabular-nums">
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
                        {health.hasMissingMedia && (
                          <button
                            type="button"
                            onClick={() => openProject(project.id)}
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-400 hover:text-amber-300"
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            <span>{health.missingCount} missing file(s) · Relink</span>
                          </button>
                        )}
                      </div>
                      <div className="inline-flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={duplicatingId === project.id}
                          onClick={() => void handleDuplicate(project.id)}
                          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-40 transition-colors"
                          aria-label={`Duplicate ${project.name}`}
                          title="Duplicate project"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(project)}
                          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 transition-colors"
                          aria-label={`Delete ${project.name}`}
                          title="Delete project"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
            title={isAuthenticated ? "MongoDB + IndexedDB Hybrid Storage" : "Local IndexedDB + MongoDB Auth"}
            endpoint="POST /api/projects"
            description={
              isAuthenticated
                ? "Timelines, clips, subtitles, keyframes, and export jobs persist in MongoDB, while large local media blobs stay fast in browser IndexedDB."
                : "Local media blobs persist in browser IndexedDB across reloads, and project timelines save in localStorage. Sign in to sync projects with MongoDB."
            }
          />
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete Project"
        description={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? This removes the sequence, clips, subtitles, and keyframes from your workspace.`
            : ""
        }
        confirmLabel="Delete Project"
        cancelLabel="Keep Project"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteProject(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </StudioShell>
  );
}
