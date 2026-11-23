import React, { useState } from "react";
import { X, Film, LayoutTemplate } from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type {
  AspectRatioOption,
  ProjectTemplateId,
  ResolutionOption,
} from "../../types/studio";
import { PROJECT_TEMPLATES } from "../../utils/templates";

type CreationMode = "blank" | ProjectTemplateId;

export function CreateProjectModal() {
  const {
    createProjectModalOpen,
    setCreateProjectModalOpen,
    createProject,
    createProjectFromTemplateId,
    isAuthenticated,
    sessionUser,
  } = useStudio();

  const [mode, setMode] = useState<CreationMode>("blank");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("16:9");
  const [resolution, setResolution] = useState<ResolutionOption>(sessionUser.defaultResolution);
  const [fps, setFps] = useState<24 | 30 | 60>(sessionUser.defaultFps);
  const [error, setError] = useState<string | null>(null);

  if (!createProjectModalOpen) return null;

  const selectedTemplate =
    mode !== "blank" ? PROJECT_TEMPLATES.find((t) => t.id === mode) ?? null : null;

  const handleSelectMode = (nextMode: CreationMode) => {
    setMode(nextMode);
    if (error) setError(null);
    if (nextMode !== "blank") {
      const tpl = PROJECT_TEMPLATES.find((t) => t.id === nextMode);
      if (tpl) {
        setAspectRatio(tpl.aspectRatio);
        setResolution(tpl.resolution);
        setFps(tpl.fps);
      }
    }
  };

  const resetAndClose = () => {
    setMode("blank");
    setName("");
    setDescription("");
    setError(null);
    setCreateProjectModalOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTemplate) {
      createProjectFromTemplateId(
        selectedTemplate.id,
        name.trim() || undefined,
        true
      );
      resetAndClose();
      return;
    }

    if (!name.trim()) {
      setError("Enter a project title to create your sequence.");
      return;
    }
    createProject({
      name: name.trim(),
      description,
      aspectRatio,
      resolution,
      fps,
    });
    resetAndClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-heading"
    >
      <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-[#111114] p-6 shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-blue-600 text-white">
              <Film className="h-4 w-4" />
            </div>
            <h2 id="create-project-heading" className="text-base font-semibold text-zinc-100">
              Create Video Project
            </h2>
          </div>
          <button
            type="button"
            onClick={resetAndClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-300 inline-flex items-center gap-1.5">
                <LayoutTemplate className="h-3.5 w-3.5 text-violet-400" />
                <span>Starting Format</span>
              </span>
              <span className="text-[11px] text-zinc-500">
                Editable starter tracks &amp; animated titles
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSelectMode("blank")}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  mode === "blank"
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-zinc-800 bg-[#09090B] hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">Blank Sequence</span>
                  <span className="font-mono text-[10px] text-zinc-400">Custom</span>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400 leading-snug">
                  Empty multitrack timeline with custom aspect ratio &amp; frame rate.
                </p>
              </button>

              {PROJECT_TEMPLATES.map((tpl) => {
                const active = mode === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => handleSelectMode(tpl.id)}
                    className={`rounded-xl border p-3 text-left transition-colors ${
                      active
                        ? "border-violet-500 bg-violet-500/10"
                        : "border-zinc-800 bg-[#09090B] hover:border-zinc-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-white truncate">
                        {tpl.title}
                      </span>
                      <span className="font-mono text-[10px] text-violet-300 shrink-0 tabular-nums">
                        {tpl.aspectRatio}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-400 line-clamp-2 leading-snug">
                      {tpl.subtitle} · {tpl.estimatedDurationSec}s starter
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="project-name" className="block text-xs font-medium text-zinc-300 mb-1.5">
              Project Name {selectedTemplate ? "(optional override)" : ""}
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={
                selectedTemplate
                  ? `${selectedTemplate.title} Cut`
                  : "e.g. Autumn Product Launch Cut"
              }
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              autoFocus
            />
            {error && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
          </div>

          {!selectedTemplate && (
            <>
              <div>
                <label htmlFor="project-desc" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Sequence Notes (optional)
                </label>
                <input
                  id="project-desc"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief goal, target channel, or cut notes"
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Aspect Ratio</label>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value as AspectRatioOption)}
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                  >
                    <option value="16:9">16:9 Landscape</option>
                    <option value="9:16">9:16 Vertical</option>
                    <option value="1:1">1:1 Square</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Resolution</label>
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value as ResolutionOption)}
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                  >
                    <option value="1080p">1080p Full HD</option>
                    <option value="4K">4K UHD</option>
                    <option value="720p">720p HD</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Frame Rate</label>
                  <select
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value) as 24 | 30 | 60)}
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                  >
                    <option value={24}>24 fps</option>
                    <option value={30}>30 fps</option>
                    <option value={60}>60 fps</option>
                  </select>
                </div>
              </div>
            </>
          )}

          <p className="text-xs text-zinc-500">
            {isAuthenticated
              ? "Projects automatically sync to your MongoDB workspace while local video/audio files stay fast in browser IndexedDB."
              : "Projects save in browser localStorage and IndexedDB. Sign in to sync projects across sessions in MongoDB."}
          </p>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={resetAndClose}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
            >
              {selectedTemplate ? "Use Template & Open Editor" : "Create & Open Editor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
