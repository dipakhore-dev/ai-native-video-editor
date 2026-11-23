import { useMemo, useState } from "react";
import {
  Plus,
  Search,
  Film,
  Copy,
  Trash2,
  Pencil,
  Check,
  X,
  LayoutGrid,
  List,
  AlertTriangle,
  LayoutTemplate,
  ArrowUpDown,
} from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { ProjectThumbnail } from "../components/common/ProjectThumbnail";
import { useStudio } from "../context/StudioContext";
import type { Project } from "../types/studio";
import { formatTimecode } from "../utils/media";
import { getProjectMediaHealth } from "../utils/projectThumbnails";
import { PROJECT_TEMPLATES } from "../utils/templates";

type ProjectSortKey = "updatedAt" | "createdAt" | "name";
type ViewMode = "grid" | "list";

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ProjectsPage() {
  const {
    projects,
    mediaAssets,
    idbHydrating,
    isAuthenticated,
    setActiveProjectId,
    navigate,
    createProjectFromTemplateId,
    renameProject,
    duplicateProject,
    deleteProject,
    setCreateProjectModalOpen,
  } = useStudio();

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<ProjectSortKey>("updatedAt");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q)
    );

    return [...matches].sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      if (sortBy === "createdAt") {
        return b.createdAt.localeCompare(a.createdAt);
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [projects, search, sortBy]);

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setDraftName(currentName);
  };

  const commitRename = (id: string) => {
    if (draftName.trim()) {
      renameProject(id, draftName);
    }
    setEditingId(null);
  };

  const openInEditor = (projectId: string) => {
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
        <button
          type="button"
          onClick={() => setCreateProjectModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Create Project</span>
        </button>
      }
    >
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">Projects</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Manage active video sequences, templates, media health, and project copies.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects..."
                aria-label="Search projects"
                className="w-full rounded-lg border border-zinc-800 bg-[#111114] pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as ProjectSortKey)}
                aria-label="Sort projects"
                className="bg-transparent text-xs text-zinc-200 focus:outline-none cursor-pointer"
              >
                <option value="updatedAt" className="bg-[#111114]">Last Modified</option>
                <option value="createdAt" className="bg-[#111114]">Newest Created</option>
                <option value="name" className="bg-[#111114]">Name (A–Z)</option>
              </select>
            </div>

            <div
              className="inline-flex rounded-lg border border-zinc-800 bg-[#111114] p-0.5"
              role="group"
              aria-label="Project view mode"
            >
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`rounded-md p-1.5 transition-colors ${
                  viewMode === "grid"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-white"
                }`}
                aria-label="Grid view"
                title="Thumbnail card view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`rounded-md p-1.5 transition-colors ${
                  viewMode === "list"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-white"
                }`}
                aria-label="List view"
                title="Compact list view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Starter Templates Strip */}
        <section aria-label="Starter Templates" className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              <LayoutTemplate className="h-3.5 w-3.5 text-violet-400" />
              <span>Start from a Template</span>
            </div>
            <span className="text-[11px] text-zinc-500">
              Includes editable title overlays &amp; keyframe animations
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {PROJECT_TEMPLATES.map((tpl) => (
              <div
                key={tpl.id}
                className="rounded-xl border border-zinc-800/80 bg-[#111114] p-4 flex flex-col justify-between gap-3 hover:border-zinc-700 transition-colors"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-white truncate">{tpl.title}</h2>
                    <span className="font-mono text-[11px] text-violet-300 tabular-nums shrink-0">
                      {tpl.aspectRatio}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] font-mono text-zinc-500 tabular-nums">
                    {tpl.resolution} · {tpl.fps}fps · {tpl.estimatedDurationSec}s starter
                  </p>
                  <p className="mt-2 text-xs text-zinc-400 leading-relaxed line-clamp-2">
                    {tpl.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => createProjectFromTemplateId(tpl.id)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-violet-600 hover:border-violet-500 hover:text-white transition-colors whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Use Template</span>
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Project Collection */}
        {filteredAndSorted.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#111114]/70 p-12 text-center">
            <Film className="h-8 w-8 text-violet-400 mx-auto mb-3" />
            <h2 className="text-base font-medium text-white">
              {projects.length === 0 ? "No video projects created yet" : "No matching projects"}
            </h2>
            <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto">
              {projects.length === 0
                ? "Create your first sequence or start from one of the templates above to edit tracks, effects, and exports."
                : `No projects matched "${search}". Clear the search box or create a new project.`}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              {projects.length > 0 && search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                >
                  Clear Search
                </button>
              )}
              <button
                type="button"
                onClick={() => setCreateProjectModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create Project</span>
              </button>
            </div>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredAndSorted.map((project) => {
              const duration = project.clips.reduce(
                (max, c) => Math.max(max, c.startTime + c.duration),
                0
              );
              const health = getProjectMediaHealth(project, mediaAssets, !idbHydrating);
              const isEditing = editingId === project.id;
              const isDuplicating = duplicatingId === project.id;

              return (
                <div
                  key={project.id}
                  className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-hidden flex flex-col hover:border-zinc-700 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => openInEditor(project.id)}
                    className="relative h-40 bg-zinc-950 w-full text-left group overflow-hidden shrink-0"
                  >
                    <ProjectThumbnail
                      project={project}
                      mediaAssets={mediaAssets}
                      className="h-full w-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[11px] font-mono text-zinc-200 tabular-nums">
                      <span>
                        {project.aspectRatio} · {project.resolution} · {project.fps}fps
                      </span>
                      <span>{formatTimecode(duration)}</span>
                    </div>
                  </button>

                  <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                    <div>
                      {isEditing ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename(project.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            aria-label="Rename project"
                            className="flex-1 min-w-0 rounded border border-violet-500 bg-[#09090B] px-2 py-1 text-xs text-white focus:outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => commitRename(project.id)}
                            className="p-1 text-emerald-400 hover:text-emerald-300"
                            aria-label="Save name"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="p-1 text-zinc-400 hover:text-white"
                            aria-label="Cancel rename"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openInEditor(project.id)}
                          className="text-sm font-medium text-white hover:text-violet-400 transition-colors truncate block max-w-full text-left"
                          title={project.name}
                        >
                          {project.name}
                        </button>
                      )}

                      <p className="mt-1 text-xs text-zinc-500 tabular-nums">
                        {project.clips.length} clips · Modified {formatShortDate(project.updatedAt)}
                      </p>

                      {health.hasMissingMedia && (
                        <button
                          type="button"
                          onClick={() => openInEditor(project.id)}
                          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-400 hover:text-amber-300 text-left"
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          <span>
                            {health.missingCount} missing media{" "}
                            {health.missingCount === 1 ? "file" : "files"} · Relink in Editor
                          </span>
                        </button>
                      )}
                    </div>

                    <div className="pt-2 border-t border-zinc-800/70 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openInEditor(project.id)}
                        className="text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors whitespace-nowrap"
                      >
                        Open Editor
                      </button>
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startRename(project.id, project.name)}
                          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                          aria-label={`Rename ${project.name}`}
                          title="Rename project"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={isDuplicating}
                          onClick={() => void handleDuplicate(project.id)}
                          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40 transition-colors"
                          aria-label={`Duplicate ${project.name}`}
                          title="Duplicate project"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(project)}
                          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400 transition-colors"
                          aria-label={`Delete ${project.name}`}
                          title="Delete project"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800/80 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Project</th>
                  <th className="py-3.5 px-4 font-medium">Format</th>
                  <th className="py-3.5 px-4 font-medium text-right">Clips</th>
                  <th className="py-3.5 px-4 font-medium text-right">Duration</th>
                  <th className="py-3.5 px-4 font-medium text-right">Modified</th>
                  <th className="py-3.5 px-5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filteredAndSorted.map((project) => {
                  const duration = project.clips.reduce(
                    (max, c) => Math.max(max, c.startTime + c.duration),
                    0
                  );
                  const health = getProjectMediaHealth(project, mediaAssets, !idbHydrating);
                  const isEditing = editingId === project.id;
                  const isDuplicating = duplicatingId === project.id;

                  return (
                    <tr key={project.id} className="hover:bg-zinc-900/50">
                      <td className="py-3.5 px-5">
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={draftName}
                              onChange={(e) => setDraftName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(project.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="rounded border border-violet-500 bg-[#09090B] px-2 py-1 text-xs text-white focus:outline-none"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => commitRename(project.id)}
                              className="p-1 text-emerald-400 hover:text-emerald-300"
                              aria-label="Save name"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="p-1 text-zinc-400 hover:text-white"
                              aria-label="Cancel rename"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-16 rounded overflow-hidden bg-zinc-950 shrink-0">
                              <ProjectThumbnail project={project} mediaAssets={mediaAssets} />
                            </div>
                            <div className="min-w-0">
                              <button
                                type="button"
                                onClick={() => openInEditor(project.id)}
                                className="font-medium text-white hover:text-violet-400 transition-colors text-left"
                              >
                                {project.name}
                              </button>
                              {health.hasMissingMedia ? (
                                <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-amber-400">
                                  <AlertTriangle className="h-3 w-3 shrink-0" />
                                  <span>
                                    {health.missingCount} missing media{" "}
                                    {health.missingCount === 1 ? "file" : "files"}
                                  </span>
                                </p>
                              ) : project.description ? (
                                <p className="text-[11px] text-zinc-500 truncate max-w-xs mt-0.5">
                                  {project.description}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-zinc-300 tabular-nums">
                        {project.aspectRatio} · {project.resolution} · {project.fps}fps
                      </td>
                      <td className="py-3.5 px-4 font-mono text-zinc-300 text-right tabular-nums">
                        {project.clips.length}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-zinc-300 text-right tabular-nums">
                        {formatTimecode(duration)}
                      </td>
                      <td className="py-3.5 px-4 text-zinc-500 text-right tabular-nums">
                        {formatShortDate(project.updatedAt)}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openInEditor(project.id)}
                            className="text-violet-400 hover:text-violet-300 font-medium whitespace-nowrap"
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            onClick={() => startRename(project.id, project.name)}
                            className="p-1 text-zinc-400 hover:text-white"
                            aria-label={`Rename ${project.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={isDuplicating}
                            onClick={() => void handleDuplicate(project.id)}
                            className="p-1 text-zinc-400 hover:text-white disabled:opacity-40"
                            aria-label={`Duplicate ${project.name}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(project)}
                            className="p-1 text-zinc-400 hover:text-rose-400"
                            aria-label={`Delete ${project.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <IntegrationNotice
          title={isAuthenticated ? "MongoDB + IndexedDB Hybrid Persistence" : "Local IndexedDB + MongoDB Ready"}
          endpoint="POST /api/projects/:id/duplicate"
          description={
            isAuthenticated
              ? "Projects, clips, subtitles, and keyframes sync to MongoDB while large video, image, and audio blobs remain fast in browser IndexedDB."
              : "Projects save automatically in browser localStorage and IndexedDB. Sign in to sync your sequences and duplicates to MongoDB."
          }
        />
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete Project"
        description={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? This removes the timeline sequence, tracks, subtitles, and keyframes from your workspace. Linked media files shared with other projects stay intact.`
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
