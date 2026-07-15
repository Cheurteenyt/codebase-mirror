// V2 main application — responsive, bookmarkable, and lazy by view.

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";
import { Activity, FolderKanban, LayoutDashboard, Network, Orbit, X } from "lucide-react";
import { DashboardTab } from "./components/DashboardTab";
import { StatsTab } from "./components/StatsTab";
import type { TabId } from "./lib/types";
import { cn } from "./lib/utils";

const GraphTab = lazy(() =>
  import("./components/GraphTab").then((module) => ({ default: module.GraphTab })),
);
const ControlTab = lazy(() =>
  import("./components/ControlTab").then((module) => ({ default: module.ControlTab })),
);

const TAB_IDS: TabId[] = ["dashboard", "graph", "stats", "control"];
const TAB_LABELS: Record<TabId, string> = {
  dashboard: "Dashboard",
  graph: "Graph",
  stats: "Projects",
  control: "Control",
};
const TABS = TAB_IDS.map((id) => ({ id, label: TAB_LABELS[id] }));
const TAB_ICONS = {
  dashboard: LayoutDashboard,
  graph: Network,
  stats: FolderKanban,
  control: Activity,
} satisfies Record<TabId, typeof LayoutDashboard>;

interface RouteState {
  tab: TabId;
  project: string | null;
}

function readRoute(): RouteState {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get("tab");
  const requestedTab = TAB_IDS.includes(rawTab as TabId) ? (rawTab as TabId) : "stats";
  const project = params.get("project") ?? null;
  // A project-scoped deep link without a project otherwise leaves a disabled
  // active tab and an empty page with no keyboard-focusable active tab.
  const tab = !project && (requestedTab === "dashboard" || requestedTab === "graph")
    ? "stats"
    : requestedTab;
  return { tab, project };
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
  // Keep the expensive graph warm only for the project where it was opened.
  // A global boolean accidentally preloaded GraphTab for every later project.
  const [graphVisitedProject, setGraphVisitedProject] = useState<string | null>(
    activeTab === "graph" ? selectedProject : null,
  );

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
    if (url !== current) window.history.pushState(null, "", url);
    setRoute({ tab, project });
    if (tab === "graph") setGraphVisitedProject(project);
  }, []);

  useEffect(() => {
    if (activeTab === "graph") setGraphVisitedProject(selectedProject);
  }, [activeTab, selectedProject]);

  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const available = TABS.filter(
      (candidate) => !((candidate.id === "graph" || candidate.id === "dashboard") && !selectedProject),
    );
    const current = available.findIndex((candidate) => candidate.id === TABS[tabIndex].id);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = available.length - 1;
    else if (event.key === "ArrowRight") next = (current + 1) % available.length;
    else next = (current - 1 + available.length) % available.length;
    const target = available[next];
    navigate(target.id, target.id === "stats" ? null : selectedProject);
    requestAnimationFrame(() => document.getElementById(`tab-${target.id}`)?.focus());
  }, [navigate, selectedProject]);

  return (
    <div className="app-shell flex h-screen flex-col bg-background text-foreground">
      <header className="relative z-30 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-[#07131b]/88 px-3 shadow-[0_12px_40px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:px-5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-5">
          <div className="flex shrink-0 items-center gap-2.5" aria-label="Codebase Memory">
            <div className="relative grid h-8 w-8 place-items-center rounded-xl border border-cyan-300/20 bg-gradient-to-br from-cyan-400/20 via-sky-500/10 to-indigo-500/20 shadow-[0_0_26px_rgba(34,211,238,0.13)]">
              <Orbit className="h-4 w-4 text-cyan-200" strokeWidth={1.7} />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-[#07131b] bg-emerald-400" />
            </div>
            <div className="hidden lg:block">
              <span className="block text-[12px] font-semibold tracking-[0.01em] text-slate-100">Codebase Memory</span>
              <span className="block text-[9px] font-medium uppercase tracking-[0.2em] text-cyan-300/65">V2 Intelligence</span>
            </div>
          </div>

          <nav
            className="flex items-center gap-1 rounded-xl border border-white/[0.06] bg-black/15 p-1"
            role="tablist"
            aria-label="Main views"
          >
            {TABS.map((tab, index) => {
              const disabled = (tab.id === "graph" || tab.id === "dashboard") && !selectedProject;
              const active = activeTab === tab.id;
              const Icon = TAB_ICONS[tab.id];
              return (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`tabpanel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => navigate(tab.id, tab.id === "stats" ? null : selectedProject)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  disabled={disabled}
                  title={disabled ? "Select a project first" : tab.label}
                  className={cn(
                    "group relative flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[11px] font-medium transition-all duration-200 sm:px-3",
                    disabled
                      ? "cursor-not-allowed border-transparent text-slate-600"
                      : active
                        ? "border-cyan-300/20 bg-cyan-300/[0.10] text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.08)]"
                        : "border-transparent text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5",
                      active ? "text-cyan-300" : "text-slate-500 group-hover:text-slate-300",
                    )}
                    strokeWidth={1.8}
                  />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {selectedProject && (
          <div className="hidden min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-1.5 shadow-inner shadow-white/[0.02] sm:flex">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
            <span className="hidden text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500 md:inline">Project</span>
            <span className="max-w-[120px] truncate font-mono text-[10px] text-cyan-100 md:max-w-[260px]">{selectedProject}</span>
            <button
              onClick={() => navigate("stats", null)}
              aria-label="Close project"
              className="ml-1 rounded-md p-0.5 text-slate-600 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </header>

      <main className="relative z-10 min-h-0 flex-1">
        <section
          className="h-full"
          hidden={activeTab !== "dashboard"}
          role="tabpanel"
          id="tabpanel-dashboard"
          aria-labelledby="tab-dashboard"
        >
          {selectedProject && (
            <DashboardTab
              project={selectedProject}
              active={activeTab === "dashboard"}
              onNavigateToGraph={() => navigate("graph", selectedProject)}
            />
          )}
        </section>

        <section
          className="h-full"
          hidden={activeTab !== "graph"}
          role="tabpanel"
          id="tabpanel-graph"
          aria-labelledby="tab-graph"
        >
          {selectedProject && graphVisitedProject === selectedProject && (
            <Suspense fallback={<PanelLoader label="Loading graph engine…" />}>
              <GraphTab project={selectedProject} active={activeTab === "graph"} />
            </Suspense>
          )}
        </section>

        <section
          className="h-full"
          hidden={activeTab !== "control"}
          role="tabpanel"
          id="tabpanel-control"
          aria-labelledby="tab-control"
        >
          {activeTab === "control" && (
            <Suspense fallback={<PanelLoader label="Loading controls…" />}>
              <ControlTab />
            </Suspense>
          )}
        </section>

        <section
          className="h-full"
          hidden={activeTab !== "stats"}
          role="tabpanel"
          id="tabpanel-stats"
          aria-labelledby="tab-stats"
        >
          {activeTab === "stats" && (
            <StatsTab onSelectProject={(project) => navigate("dashboard", project)} />
          )}
        </section>
      </main>
    </div>
  );
}

function PanelLoader({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0a1720]/80 px-4 py-3 text-[12px] text-slate-400 shadow-2xl backdrop-blur-xl">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-300/25 border-t-cyan-300" />
        {label}
      </div>
    </div>
  );
}
