import React, { useState } from "react";
import {
  LayoutDashboard,
  Film,
  Wand2,
  FolderOpen,
  Layers,
  Download,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  LogIn,
  Menu,
  X,
  AlertCircle,
} from "lucide-react";
import { useStudio } from "../../context/StudioContext";
import type { AppRoute } from "../../types/studio";

interface NavItem {
  id: AppRoute;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "editor", label: "Video Editor", icon: Film },
  { id: "generator", label: "AI Video Generator", icon: Wand2 },
  { id: "media", label: "Media Library", icon: Layers },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "exports", label: "Export History", icon: Download },
  { id: "settings", label: "Account Settings", icon: Settings },
];

const ROUTE_TITLES: Record<AppRoute, string> = {
  landing: "Overview",
  dashboard: "Dashboard",
  editor: "Video Editor",
  generator: "AI Video Generator",
  media: "Media Library",
  projects: "Projects",
  exports: "Export History",
  auth: "Sign In",
  settings: "Account Settings",
};

interface StudioShellProps {
  children: React.ReactNode;
  headerAction?: React.ReactNode;
  fullBleed?: boolean;
}

export function StudioShell({ children, headerAction, fullBleed = false }: StudioShellProps) {
  const {
    route,
    navigate,
    sidebarCollapsed,
    setSidebarCollapsed,
    activeProject,
    sessionUser,
    isAuthenticated,
    sessionNotice,
    dismissSessionNotice,
    lastSaveError,
    saveTimelineToMongo,
    saveTimelineLocally,
    setCreateProjectModalOpen,
  } = useStudio();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleNav = (id: AppRoute) => {
    navigate(id);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex">
      {/* Desktop Collapsible Sidebar */}
      <aside
        className={`hidden lg:flex flex-col border-r border-zinc-800/80 bg-[#0D0D10] shrink-0 transition-[width] duration-200 ${
          sidebarCollapsed ? "w-[72px]" : "w-[248px]"
        }`}
      >
        <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800/80">
          <button
            type="button"
            onClick={() => navigate("landing")}
            className="flex items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded-md"
            title="AI Studio Home"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-blue-600 text-white font-display font-bold text-xs">
              AI
            </div>
            {!sidebarCollapsed && (
              <span className="font-display text-sm font-semibold tracking-tight text-white whitespace-nowrap">
                AI Studio
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100 transition-colors"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={() => setCreateProjectModalOpen(true)}
            className={`w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-xs font-medium py-2.5 px-3 transition-colors whitespace-nowrap ${
              sidebarCollapsed ? "px-0" : ""
            }`}
            title="Create Project"
          >
            <Plus className="h-4 w-4 shrink-0" />
            {!sidebarCollapsed && <span>Create Project</span>}
          </button>
        </div>

        <nav className="flex-1 px-2.5 py-2 space-y-1 overflow-y-auto" aria-label="Workspace Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = route === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNav(item.id)}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? "bg-zinc-800/90 text-white border border-zinc-700/60"
                    : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 border border-transparent"
                } ${sidebarCollapsed ? "justify-center px-0" : ""}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? "text-violet-400" : ""}`} />
                {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-zinc-800/80 space-y-2">
          <button
            type="button"
            onClick={() => handleNav("auth")}
            className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors whitespace-nowrap ${
              sidebarCollapsed ? "justify-center px-0" : ""
            }`}
            title="Sign In / Register"
          >
            <LogIn className="h-4 w-4 shrink-0" />
            {!sidebarCollapsed && <span>Account Sign In</span>}
          </button>

          <button
            type="button"
            onClick={() => handleNav("settings")}
            className={`w-full flex items-center gap-2.5 rounded-lg p-2 hover:bg-zinc-900 transition-colors text-left ${
              sidebarCollapsed ? "justify-center" : ""
            }`}
          >
            <img
              src="/src/assets/images/avatar_director_1794647537537.jpg"
              alt={sessionUser.displayName}
              referrerPolicy="no-referrer"
              className="h-8 w-8 rounded-lg object-cover shrink-0 border border-zinc-800"
            />
            {!sidebarCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-200 truncate">{sessionUser.displayName}</p>
                <p className="text-[11px] text-zinc-500 truncate">{sessionUser.workspaceName}</p>
              </div>
            )}
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/75"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-64 bg-[#0D0D10] border-r border-zinc-800 flex flex-col h-full">
            <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800">
              <span className="font-display text-sm font-semibold text-white">AI Studio</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-zinc-400 hover:text-white"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-3">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setCreateProjectModalOpen(true);
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs font-medium py-2.5 px-3"
              >
                <Plus className="h-4 w-4" />
                <span>Create Project</span>
              </button>
            </div>
            <nav className="flex-1 px-2.5 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = route === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNav(item.id)}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium ${
                      active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => handleNav("auth")}
                className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium text-zinc-400 hover:text-white"
              >
                <LogIn className="h-4 w-4 shrink-0" />
                <span>Account Sign In</span>
              </button>
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        <header className="h-14 shrink-0 border-b border-zinc-800/80 bg-[#09090B]/95 backdrop-blur-sm px-4 lg:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden rounded-md p-2 text-zinc-400 hover:bg-zinc-900 hover:text-white"
              aria-label="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <nav className="flex items-center gap-2 text-xs text-zinc-400 min-w-0" aria-label="Breadcrumb">
              <button
                type="button"
                onClick={() => navigate("dashboard")}
                className="hover:text-zinc-200 transition-colors whitespace-nowrap"
              >
                Workspace
              </button>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-zinc-100 truncate">{ROUTE_TITLES[route]}</span>
              {route === "editor" && activeProject && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">
                    /
                  </span>
                  <span className="hidden sm:inline text-zinc-400 truncate max-w-[200px]">
                    {activeProject.name}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {headerAction ?? (
              <button
                type="button"
                onClick={() => setCreateProjectModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5 text-violet-400" />
                <span>New Project</span>
              </button>
            )}
          </div>
        </header>

        {(sessionNotice || lastSaveError) && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="truncate">{sessionNotice || lastSaveError}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {sessionNotice && (
                <button
                  type="button"
                  onClick={() => navigate("auth")}
                  className="rounded border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-500/30"
                >
                  Sign In
                </button>
              )}
              {lastSaveError && (
                <button
                  type="button"
                  onClick={() => {
                    saveTimelineLocally();
                    if (isAuthenticated) {
                      void saveTimelineToMongo();
                    }
                  }}
                  className="rounded border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-500/30"
                >
                  Retry Save
                </button>
              )}
              {sessionNotice && (
                <button
                  type="button"
                  onClick={dismissSessionNotice}
                  className="rounded p-0.5 text-amber-200 hover:bg-amber-500/20 hover:text-white"
                  aria-label="Dismiss notice"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        <main className={fullBleed ? "flex-1 min-h-0 flex flex-col" : "flex-1 p-4 sm:p-6 lg:p-8"}>
          {children}
        </main>
      </div>
    </div>
  );
}
