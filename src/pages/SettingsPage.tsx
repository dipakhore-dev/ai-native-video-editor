import React, { useState } from "react";
import { Check, RefreshCw, Keyboard, PlugZap, User } from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { useStudio } from "../context/StudioContext";
import type { ResolutionOption } from "../types/studio";

export function SettingsPage() {
  const {
    sessionUser,
    updateSessionUser,
    integrations,
    integrationsLoading,
    integrationsError,
    refreshIntegrations,
    navigate,
  } = useStudio();

  const [activeTab, setActiveTab] = useState<"profile" | "integrations" | "shortcuts">("profile");
  const [displayName, setDisplayName] = useState(sessionUser.displayName);
  const [email, setEmail] = useState(sessionUser.email);
  const [workspaceName, setWorkspaceName] = useState(sessionUser.workspaceName);
  const [defaultFps, setDefaultFps] = useState<24 | 30 | 60>(sessionUser.defaultFps);
  const [defaultResolution, setDefaultResolution] = useState<ResolutionOption>(
    sessionUser.defaultResolution
  );
  const [savedNotice, setSavedNotice] = useState(false);

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    updateSessionUser({
      displayName: displayName.trim() || "Editor",
      email: email.trim() || "editor@local.session",
      workspaceName: workspaceName.trim() || "Local Studio Session",
      defaultFps,
      defaultResolution,
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  return (
    <StudioShell>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">Account Settings</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Configure local workspace defaults and inspect connected external service integrations.
          </p>
        </div>

        {/* Segmented Tabs */}
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#111114] border border-zinc-800/80">
          <button
            type="button"
            onClick={() => setActiveTab("profile")}
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeTab === "profile" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <User className="h-3.5 w-3.5" />
            <span>Profile &amp; Defaults</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("integrations")}
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeTab === "integrations"
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <PlugZap className="h-3.5 w-3.5" />
            <span>Service Integrations</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("shortcuts")}
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
              activeTab === "shortcuts"
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Keyboard className="h-3.5 w-3.5" />
            <span>Shortcuts</span>
          </button>
        </div>

        {activeTab === "profile" && (
          <form
            onSubmit={handleSaveProfile}
            className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-6 space-y-6"
          >
            <div className="flex items-center gap-4 pb-6 border-b border-zinc-800/80">
              <img
                src="/src/assets/images/avatar_director_1794647537537.jpg"
                alt={sessionUser.displayName}
                referrerPolicy="no-referrer"
                className="h-14 w-14 rounded-xl object-cover border border-zinc-800"
              />
              <div>
                <p className="text-sm font-medium text-white">{sessionUser.displayName}</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Active Mode: Local Studio Session ·{" "}
                  <button
                    type="button"
                    onClick={() => navigate("auth")}
                    className="text-violet-400 hover:text-violet-300"
                  >
                    Connect Identity Provider
                  </button>
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Session Email Label
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Workspace Name
                </label>
                <input
                  type="text"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Default Resolution
                  </label>
                  <select
                    value={defaultResolution}
                    onChange={(e) => setDefaultResolution(e.target.value as ResolutionOption)}
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                  >
                    <option value="1080p">1080p</option>
                    <option value="4K">4K</option>
                    <option value="720p">720p</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Default FPS
                  </label>
                  <select
                    value={defaultFps}
                    onChange={(e) => setDefaultFps(Number(e.target.value) as 24 | 30 | 60)}
                    className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                  >
                    <option value={24}>24 fps</option>
                    <option value={30}>30 fps</option>
                    <option value={60}>60 fps</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-zinc-500">
                Preferences apply to newly created projects in this session.
              </p>
              <div className="flex items-center gap-3">
                {savedNotice && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <Check className="h-3.5 w-3.5" />
                    <span>Saved to session</span>
                  </span>
                )}
                <button
                  type="submit"
                  className="rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors"
                >
                  Save Preferences
                </button>
              </div>
            </div>
          </form>
        )}

        {activeTab === "integrations" && (
          <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] overflow-hidden">
            <div className="p-5 border-b border-zinc-800/80 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Server Integration Registry</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Live inspection from GET /api/integrations/status
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refreshIntegrations()}
                disabled={integrationsLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${integrationsLoading ? "animate-spin" : ""}`} />
                <span>Recheck</span>
              </button>
            </div>

            {integrationsError && (
              <div className="p-4 text-xs text-rose-300 bg-rose-500/10 border-b border-rose-500/20">
                {integrationsError}
              </div>
            )}

            <div className="divide-y divide-zinc-800/80">
              {integrations &&
                Object.values(integrations).map((item) => (
                  <div
                    key={item.id}
                    className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1 max-w-2xl">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="text-sm font-medium text-white">{item.label}</span>
                        <span className="text-xs font-mono text-zinc-500">{item.endpoint}</span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">{item.summary}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span
                        className={`text-xs font-medium ${
                          item.connected ? "text-emerald-400" : "text-amber-400"
                        }`}
                      >
                        {item.connected ? "Connected" : "Integration Required"}
                      </span>
                      <p className="text-[11px] text-zinc-500 mt-0.5">{item.provider}</p>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {activeTab === "shortcuts" && (
          <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] divide-y divide-zinc-800/80">
            {[
              { keys: "Space", action: "Play / Pause sequence preview" },
              { keys: "V", action: "Activate Select & Move tool" },
              { keys: "C", action: "Activate Razor Split tool" },
              { keys: "S", action: "Split selected clip at playhead" },
              { keys: "Left / Right", action: "Step playhead backward or forward 1 frame" },
              { keys: "Delete / Backspace", action: "Remove selected clip from timeline" },
            ].map((row) => (
              <div key={row.keys} className="px-6 py-4 flex items-center justify-between text-xs">
                <span className="text-zinc-300">{row.action}</span>
                <kbd className="rounded-md border border-zinc-700 bg-[#09090B] px-2.5 py-1 font-mono text-[11px] text-zinc-200">
                  {row.keys}
                </kbd>
              </div>
            ))}
          </div>
        )}
      </div>
    </StudioShell>
  );
}
