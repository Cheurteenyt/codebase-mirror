// graph-ui/src/App.tsx
// V2 main application — 4 tabs: dashboard (default), graph, stats, control.
// Routing via URL query string (survives refresh, bookmarkable).

import { useCallback, useEffect, useState } from "react";
import { DashboardTab } from "./components/DashboardTab";
import { GraphTab } from "./components/GraphTab";
import { StatsTab } from "./components/StatsTab";
import { ControlTab } from "./components/ControlTab";
import type { TabId } from "./lib/types";
import { cn } from "./lib/utils";

const TAB_IDS: TabId[] = ["dashboard", "graph", "stats", "control"];
const TAB_LABELS: Record<TabId, string> = {
  dashboard: "Dashboard",
  graph: "Graph",
  stats: "Projects",
  control: "Control",
};

interface RouteState {
  tab: TabId;
  project: string | null;
}

function readRoute(): RouteState {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get("tab");
  const tab = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : "stats";
  const project = params.get("project");
  return { tab, project: project ?? null };
}

function routeUrl(tab: TabId, project: string | null): string {
  const params = new URLSearchParams();
  params.set("tab", tab);
  if (project) params.set("project", project);
  return `${window.location.pathname}?${params.toString()}${window.location.hash}`;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(readRoute);
  const { tab: activeTab, project: selectedProject } = route;

  useEffect(() => {
    const initial = readRoute();
    window.history.replaceState(null, "", routeUrl(initial.tab, initial.project));
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((tab: TabId, project: string | null) => {
    const url = routeUrl(tab, project);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (url === current) return;
    window.history.pushState(null, "", url);
    setRoute({ tab, project });
  }, []);

  const tabs: { id: TabId; label: string }[] = TAB_IDS.map((id) => ({
    id,
    label: TAB_LABELS[id],
  }));

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between px-5 h-12 border-b border-border bg-[#0b1920]/80 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-[7px] h-[7px] rounded-full bg-primary" />
            <span className="text-[13px] font-semibold text-foreground/90 tracking-tight">
              Codebase Memory V2
            </span>
          </div>

          {/* Tabs */}
          {/* R41 (UI-10): ARIA tablist — role="tablist" on the nav, role="tab" /
              aria-selected / aria-controls / tabIndex roving on each button so
              screen readers announce the tab structure and keyboard users can
              arrow-navigate. */}
          <nav className="flex items-center gap-0.5" role="tablist" aria-label="Main views">
            {tabs.map((tab) => {
              const disabled = (tab.id === "graph" || tab.id === "dashboard") && !selectedProject;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`tabpanel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => navigate(tab.id, tab.id === "stats" ? null : selectedProject)}
                  disabled={disabled}
                  title={disabled ? "Select a project first" : undefined}
                  className={cn(
                    "px-3 py-1 rounded-md text-[12px] font-medium transition-all",
                    disabled
                      ? "text-muted/30 cursor-not-allowed"
                      : active
                        ? "bg-primary/15 text-primary"
                        : "text-muted hover:text-foreground hover:bg-white/[0.04]",
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {selectedProject && (
          <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-white/[0.04] border border-border/30">
            <span className="text-[10px] text-foreground/30 uppercase tracking-wider">
              Project
            </span>
            <span className="text-[11px] text-primary font-mono truncate max-w-[300px]">
              {selectedProject}
            </span>
            <button
              onClick={() => navigate("stats", null)}
              aria-label="Close project"
              className="text-foreground/20 hover:text-foreground/50 text-[12px] ml-1 transition-colors"
            >
              ×
            </button>
          </div>
        )}
      </header>

      {/* Content */}
      {/* R41 (UI-10): role="tabpanel" + id + aria-labelledby wiring so screen
          readers announce the tab ↔ panel relationship. The id matches the
          aria-controls on the corresponding tab button. */}
      <main
        className="flex-1 min-h-0"
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === "dashboard" && selectedProject ? (
          <DashboardTab project={selectedProject} onNavigateToGraph={() => navigate("graph", selectedProject)} />
        ) : activeTab === "graph" && selectedProject ? (
          <GraphTab project={selectedProject} />
        ) : activeTab === "control" ? (
          <ControlTab />
        ) : (
          <StatsTab onSelectProject={(p) => navigate("dashboard", p)} />
        )}
      </main>
    </div>
  );
}
