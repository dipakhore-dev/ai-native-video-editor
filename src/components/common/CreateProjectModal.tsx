import React, { useState } from "react";
import { X, Film } from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { AspectRatioOption, ResolutionOption } from "../../types/studio";

export function CreateProjectModal() {
  const {
    createProjectModalOpen,
    setCreateProjectModalOpen,
    createProject,
    sessionUser,
  } = useStudio();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("16:9");
  const [resolution, setResolution] = useState<ResolutionOption>(sessionUser.defaultResolution);
  const [fps, setFps] = useState<24 | 30 | 60>(sessionUser.defaultFps);
  const [error, setError] = useState<string | null>(null);

  if (!createProjectModalOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
    setName("");
    setDescription("");
    setError(null);
    setCreateProjectModalOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-heading"
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#111114] p-6 shadow-2xl">
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
            onClick={() => setCreateProjectModalOpen(false)}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="project-name" className="block text-xs font-medium text-zinc-300 mb-1.5">
              Project Name
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. Autumn Product Launch Cut"
              className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              autoFocus
            />
            {error && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
          </div>

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

          <p className="text-xs text-zinc-500">
            Creates an active sequence in your current browser session. Connect a database integration in Settings to persist across sessions.
          </p>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setCreateProjectModalOpen(false)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
            >
              Create &amp; Open Editor
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
