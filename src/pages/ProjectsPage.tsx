import { useMemo, useState } from "react";
import { Plus, Search, Film, Copy, Trash2, Pencil, Check, X } from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import { formatTimecode } from "../utils/media";

export function ProjectsPage() {
  const {
    projects,
    setActiveProjectId,
    navigate,
    renameProject,
    duplicateProject,
    deleteProject,
    setCreateProjectModalOpen,
  } = useStudio();

  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    );
  }, [projects, search]);

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
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">Projects</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Manage active video sequences, aspect ratios, and frame rates in your workspace.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="h-3.5 w-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter projects..."
              className="w-full rounded-lg border border-zinc-800 bg-[#111114] pl-9 pr-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#111114]/70 p-12 text-center">
            <Film className="h-8 w-8 text-violet-400 mx-auto mb-3" />
            <h2 className="text-base font-medium text-white">
              {projects.length === 0 ? "No video projects created yet" : "No matching projects"}
            </h2>
            <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto">
              {projects.length === 0
                ? "Create your first sequence to organize tracks, preview local video clips, and configure exports."
                : "Adjust your search filter or create a new sequence."}
            </p>
            <div className="mt-5">
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
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800/80 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Project</th>
                  <th className="py-3.5 px-4 font-medium">Format</th>
                  <th className="py-3.5 px-4 font-medium text-right">Clips</th>
                  <th className="py-3.5 px-4 font-medium text-right">Duration</th>
                  <th className="py-3.5 px-4 font-medium text-right">Updated</th>
                  <th className="py-3.5 px-5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filtered.map((project) => {
                  const duration = project.clips.reduce(
                    (max, c) => Math.max(max, c.startTime + c.duration),
                    0
                  );
                  const isEditing = editingId === project.id;

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
                          <div>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveProjectId(project.id);
                                navigate("editor");
                              }}
                              className="font-medium text-white hover:text-violet-400 transition-colors text-left"
                            >
                              {project.name}
                            </button>
                            {project.description && (
                              <p className="text-[11px] text-zinc-500 truncate max-w-xs mt-0.5">
                                {project.description}
                              </p>
                            )}
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
                        {new Date(project.updatedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-3.5 px-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveProjectId(project.id);
                              navigate("editor");
                            }}
                            className="text-violet-400 hover:text-violet-300 font-medium"
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            onClick={() => startRename(project.id, project.name)}
                            className="p-1 text-zinc-400 hover:text-white"
                            aria-label="Rename project"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => duplicateProject(project.id)}
                            className="p-1 text-zinc-400 hover:text-white"
                            aria-label="Duplicate project"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteProject(project.id)}
                            className="p-1 text-zinc-400 hover:text-rose-400"
                            aria-label="Delete project"
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
          title="Database Persistence Integration Point"
          endpoint="POST /api/projects"
          description="Projects are managed in active React state for this session. Connect PostgreSQL or Firestore to store project timelines persistently."
        />
      </div>
    </StudioShell>
  );
}
