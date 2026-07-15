// graph-ui/src/components/GraphTab.tsx
// V2 graph view — 2D force-directed canvas with filters, sidebar, and detail panel.
// Replaces V1's 3D Three.js scene with a cleaner 2D approach.

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useGraphData } from "../hooks/useGraphData";
import { useWebSocket, type WsNotification } from "../hooks/useWebSocket";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
import { FilterPanel } from "./FilterPanel";
import { Sidebar } from "./Sidebar";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { NodeTooltip } from "./NodeTooltip";
import { ResizeHandle } from "./ResizeHandle";
import { ErrorBoundary } from "./ErrorBoundary";
import type { GraphNode, GraphData } from "../lib/types";
import { PanelLeftOpen, X } from "lucide-react";

const LAYOUT_EVENTS = new Set([
  "code_graph_changed",
  "graph_reindexed",
  "human_nodes_changed",
  "cbm_links_changed",
]);

function loadWidth(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v) return Math.max(150, Math.min(600, parseInt(v, 10)));
  } catch { /* ignore */ }
  return fallback;
}
function saveWidth(key: string, value: number) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch { /* ignore */ }
}

interface GraphTabProps {
  project: string | null;
  active?: boolean;
}

export function GraphTab({ project, active = true }: GraphTabProps) {
  const { data, loading, error, fetchOverview } = useGraphData();
  const [highlightedIds, setHighlightedIds] = useState<Set<number> | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const firstLoad = useRef(true);
  const wsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R41 (UI-9): imperative handle to the canvas — used by the "Reset view"
  // button to call canvasRef.current?.resetView() without lifting transformRef.
  const canvasRef = useRef<GraphCanvasHandle>(null);
  // R41 (UI-8): removed `showLabels` state — the toggle was dead code
  // (FilterPanel rendered the checkbox but GraphCanvas.draw never rendered
  // any text). Implementing real labels needs collision avoidance on a
  // 2000-node graph, out of scope for a single-round fix.
  const [leftWidth, setLeftWidth] = useState(() => loadWidth("cbm-left-w", 260));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("cbm-right-w", 280));
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  const [enabledLabels, setEnabledLabels] = useState<Set<string>>(new Set());
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Set<string>>(new Set());
  // R32 (B-new-2 fix): track ALL labels/edge-types ever seen, separately from
  // the currently-enabled set. This lets us detect genuinely new labels (to
  // auto-enable them) without re-adding labels the user manually disabled.
  // Previously, the C2 fix compared against enabledLabels, which meant any
  // manually-disabled label was treated as "new" and silently re-enabled.
  const knownLabelsRef = useRef<Set<string>>(new Set());
  const knownEdgeTypesRef = useRef<Set<string>>(new Set());
  const [deadCodeView, setDeadCodeView] = useState(false);
  const [showOnlyDead, setShowOnlyDead] = useState(false);
  const [hideEntryPoints, setHideEntryPoints] = useState(false);
  const [hideTests, setHideTests] = useState(false);

  useEffect(() => {
    if (!data) return;
    const labels = new Set(data.nodes.map((n) => n.label));
    const types = new Set(data.edges.map((e) => e.type));
    if (firstLoad.current) {
      // First load: initialize all labels and edge types as enabled.
      firstLoad.current = false;
      setEnabledLabels(labels);
      setEnabledEdgeTypes(types);
      // R32 (B-new-2 fix): also initialize the known-sets.
      knownLabelsRef.current = new Set(labels);
      knownEdgeTypesRef.current = new Set(types);
    } else {
      // R32 (B-new-2 fix): on subsequent data updates, auto-enable ONLY labels
      // that are genuinely new (never seen before). Compare against knownLabelsRef
      // (all labels ever seen), NOT against enabledLabels (currently enabled).
      // This preserves user filter choices: a manually-disabled label is still
      // in knownLabelsRef, so it won't be re-added.
      const genuinelyNewLabels: string[] = [];
      for (const label of labels) {
        if (!knownLabelsRef.current.has(label)) {
          genuinelyNewLabels.push(label);
          knownLabelsRef.current.add(label);
        }
      }
      if (genuinelyNewLabels.length > 0) {
        setEnabledLabels((prev) => {
          const next = new Set(prev);
          for (const label of genuinelyNewLabels) {
            next.add(label);
          }
          return next;
        });
      }

      const genuinelyNewEdgeTypes: string[] = [];
      for (const type of types) {
        if (!knownEdgeTypesRef.current.has(type)) {
          genuinelyNewEdgeTypes.push(type);
          knownEdgeTypesRef.current.add(type);
        }
      }
      if (genuinelyNewEdgeTypes.length > 0) {
        setEnabledEdgeTypes((prev) => {
          const next = new Set(prev);
          for (const type of genuinelyNewEdgeTypes) {
            next.add(type);
          }
          return next;
        });
      }
    }
  }, [data]);

  const filteredData: GraphData | null = useMemo(() => {
    if (!data) return null;

    const statusOk = (n: GraphNode) => {
      if (showOnlyDead && n.status !== "dead") return false;
      if (hideEntryPoints && n.status === "entry") return false;
      if (hideTests && n.status === "test") return false;
      return true;
    };

    const keep = (n: GraphNode) => enabledLabels.has(n.label) && statusOk(n);
    const nodes = data.nodes.filter(keep);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter(
      (e) => enabledEdgeTypes.has(e.type) && nodeIds.has(e.source) && nodeIds.has(e.target),
    );

    return { nodes, edges, total_nodes: data.total_nodes };
  }, [data, enabledLabels, enabledEdgeTypes, showOnlyDead, hideEntryPoints, hideTests]);

  useEffect(() => {
    if (project) {
      firstLoad.current = true;
      // R32 (B-new-2 fix): reset the known-sets on project change so the
      // next data load re-initializes everything from scratch.
      knownLabelsRef.current = new Set();
      knownEdgeTypesRef.current = new Set();
      setHighlightedIds(null);
      setSelectedPath(null);
      setSelectedNode(null);
    }
  }, [project]);

  // Fetch on first activation and revalidate after the warm graph has been
  // hidden. While inactive, both network work and d3 animation are paused.
  useEffect(() => {
    if (project && active) void fetchOverview(project);
  }, [active, project, fetchOverview]);

  // R25: WebSocket for real-time graph updates. When human_nodes change
  // (notes created/updated/deleted via CLI/MCP/sync), re-fetch the layout.
  const handleGraphNotification = useCallback((notification: WsNotification) => {
    if (!project) return;
    // Human-human edges and sync completion do not change the rendered code
    // topology. Avoid transferring and simulating the full graph for them.
    if (!LAYOUT_EVENTS.has(notification.event)) return;
    // Coalesce mixed note/link notifications into one terminal refresh.
    if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
    wsRefreshTimerRef.current = setTimeout(() => {
      wsRefreshTimerRef.current = null;
      void fetchOverview(project);
    }, 350);
  }, [project, fetchOverview]);
  useWebSocket(active ? project : null, handleGraphNotification);
  useEffect(() => {
    if (!active && wsRefreshTimerRef.current) {
      clearTimeout(wsRefreshTimerRef.current);
      wsRefreshTimerRef.current = null;
    }
  }, [active]);
  useEffect(() => () => {
    if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
  }, []);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (!filteredData) return;
      setSelectedNode(node);

      const connectedIds = new Set([node.id]);
      for (const edge of filteredData.edges) {
        if (edge.source === node.id) connectedIds.add(edge.target);
        if (edge.target === node.id) connectedIds.add(edge.source);
      }
      setHighlightedIds(connectedIds);
      setSelectedPath(node.file_path ?? null);
    },
    [filteredData],
  );

  const toggleLabel = useCallback((label: string) => {
    setEnabledLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggleEdgeType = useCallback((type: string) => {
    setEnabledEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const enableAll = useCallback(() => {
    if (!data) return;
    setEnabledLabels(new Set(data.nodes.map((n) => n.label)));
    setEnabledEdgeTypes(new Set(data.edges.map((e) => e.type)));
  }, [data]);

  const resetFilters = useCallback(() => {
    enableAll();
    setDeadCodeView(false);
    setShowOnlyDead(false);
    setHideEntryPoints(false);
    setHideTests(false);
  }, [enableAll]);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-foreground/30 text-sm">Select a project from the Projects tab</p>
      </div>
    );
  }

  // R43 (C1): only show the full-spinner on INITIAL load (no data yet).
  // Refetches (WS notifications, manual refresh) keep the existing graph
  // visible so GraphCanvas stays mounted and the d3-force simulation is
  // preserved (R40 sim-reuse optimization). Previously, `if (loading)`
  // unmounted the canvas on every refetch, destroying the sim + pan/zoom.
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-foreground/40 text-sm">Computing layout...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <button
            onClick={() => fetchOverview(project)}
            className="px-4 py-2 rounded-lg bg-white/[0.04] text-foreground/60 hover:bg-white/[0.08] text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data || !filteredData || data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-foreground/30 text-sm">No nodes in this project</p>
      </div>
    );
  }

  return (
    <div className="relative h-full flex overflow-hidden">
      {mobilePanelOpen && (
        <button
          className="absolute inset-0 z-20 bg-black/55 backdrop-blur-[2px] lg:hidden"
          aria-label="Close graph filters"
          onClick={() => setMobilePanelOpen(false)}
        />
      )}
      {/* Left sidebar */}
      <div
        className={`absolute inset-y-0 left-0 z-30 flex h-full max-w-[86vw] shrink-0 flex-col border-r border-white/10 bg-[#081720]/97 shadow-2xl backdrop-blur-xl transition-transform duration-200 lg:relative lg:z-auto lg:translate-x-0 lg:bg-[#0b1920]/90 lg:shadow-none ${mobilePanelOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ width: leftWidth }}
      >
        <button
          className="absolute right-2 top-2 z-10 rounded-lg border border-white/10 bg-white/[0.05] p-1.5 text-slate-400 hover:text-slate-100 lg:hidden"
          aria-label="Close graph filters"
          onClick={() => setMobilePanelOpen(false)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <FilterPanel
          data={data}
          enabledLabels={enabledLabels}
          enabledEdgeTypes={enabledEdgeTypes}
          onToggleLabel={toggleLabel}
          onToggleEdgeType={toggleEdgeType}
          onEnableAll={enableAll}
          onDisableAll={() => { setEnabledLabels(new Set()); setEnabledEdgeTypes(new Set()); }}
          deadCodeView={deadCodeView}
          showOnlyDead={showOnlyDead}
          hideEntryPoints={hideEntryPoints}
          hideTests={hideTests}
          onToggleDeadCodeView={() => setDeadCodeView((v) => !v)}
          onToggleShowOnlyDead={() => setShowOnlyDead((v) => !v)}
          onToggleHideEntryPoints={() => setHideEntryPoints((v) => !v)}
          onToggleHideTests={() => setHideTests((v) => !v)}
        />
        <Sidebar
          nodes={filteredData.nodes}
          selectedPath={selectedPath}
          onSelectPath={(path, ids) => {
            setSelectedPath(path);
            setHighlightedIds(ids.size > 0 ? ids : null);
            if (ids.size > 0) setMobilePanelOpen(false);
          }}
        />
      </div>
      <div className="hidden lg:contents">
        <ResizeHandle
          side="left"
          onResize={(d) => {
            setLeftWidth((w) => {
              const nw = Math.max(150, Math.min(500, w + d));
              saveWidth("cbm-left-w", nw);
              return nw;
            });
          }}
        />
      </div>

      {/* Graph canvas */}
      <div className="flex-1 relative overflow-hidden">
        <button
          onClick={() => setMobilePanelOpen(true)}
          className="absolute left-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-[#081720]/85 text-slate-300 shadow-xl backdrop-blur-md lg:hidden"
          aria-label="Open graph filters"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        {/* Keep the canvas mounted even for an empty filtered subset. Its
            simulation retains cached node objects/positions, so Reset Filters
            can restore the settled graph without a cold re-layout. */}
        <ErrorBoundary key={project}>
          <GraphCanvas
            ref={canvasRef}
            data={filteredData}
            active={active}
            highlightedIds={highlightedIds}
            deadCodeView={deadCodeView}
            onNodeClick={handleNodeClick}
            onNodeHover={(node, pos) => {
              setHoveredNode(node);
              if (pos) setTooltipPos(pos);
            }}
          />
        </ErrorBoundary>

        {filteredData.nodes.length === 0 ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#06090f]/80 backdrop-blur-[1px]">
            <div className="text-center">
              <p className="text-foreground/30 text-sm mb-3" aria-live="polite">All nodes filtered out</p>
              <button onClick={resetFilters} className="px-4 py-2 rounded-lg bg-primary/15 text-primary text-sm">
                Reset Filters
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* HUD */}
            <div className="absolute left-14 top-3 rounded-lg border border-white/10 bg-[#071219]/80 px-3 py-2 text-[10px] text-foreground/65 pointer-events-none font-mono backdrop-blur-md lg:left-4 lg:top-4 lg:text-[11px]">
              <p>
                {filteredData.nodes.length.toLocaleString()} nodes shown /{" "}
                {data.total_nodes.toLocaleString()} total
              </p>
              <p className="text-foreground/40 mt-0.5">
                {filteredData.edges.length.toLocaleString()} visible edges
                {data.truncated
                  ? ` · ${data.sampling?.strategy === "balanced-degree-v1" ? "balanced degree sample" : (data.sampling?.strategy ?? "sampled")}`
                  : " · complete graph"}
              </p>
              {highlightedIds && highlightedIds.size > 0 && (
                <p className="text-cyan-400/50 mt-0.5">{highlightedIds.size} selected</p>
              )}
            </div>

            {error && data && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-amber-400/20 bg-amber-950/80 px-3 py-2 text-[11px] text-amber-200 shadow-xl backdrop-blur-md">
                Refresh failed; keeping the last valid graph. {error}
              </div>
            )}

            {/* Actions */}
            <div
              role="toolbar"
              aria-label="Graph actions"
              className="absolute right-3 top-20 z-20 flex flex-col items-end gap-1.5 lg:right-4 lg:top-4 lg:flex-row lg:items-center lg:gap-2"
            >
              {highlightedIds && (
                <button
                  onClick={() => {
                    setHighlightedIds(null);
                    setSelectedPath(null);
                    setSelectedNode(null);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
                >
                  Clear selection
                </button>
              )}
              <button
                onClick={() => fetchOverview(project)}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
              >
                Refresh
              </button>
              {/* R41 (UI-9): reset pan/zoom to origin. Recovers from
                  off-screen pans without a page refresh. */}
              <button
                onClick={() => canvasRef.current?.resetView()}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
                title="Reset pan and zoom to default"
              >
                Reset view
              </button>
            </div>

            {hoveredNode && <NodeTooltip node={hoveredNode} x={tooltipPos.x} y={tooltipPos.y} />}
          </>
        )}
      </div>

      {/* Right detail panel */}
      {selectedNode && filteredData && (
        <>
          <div className="hidden lg:contents">
            <ResizeHandle
              side="right"
              onResize={(d) => {
                setRightWidth((w) => {
                  const nw = Math.max(200, Math.min(500, w + d));
                  saveWidth("cbm-right-w", nw);
                  return nw;
                });
              }}
            />
          </div>
          <div
            className="absolute inset-y-0 right-0 z-30 h-full max-w-[92vw] shrink-0 overflow-hidden border-l border-white/10 bg-[#081720]/98 shadow-2xl lg:relative lg:z-auto lg:bg-transparent lg:shadow-none"
            style={{ width: rightWidth }}
          >
            <NodeDetailPanel
              node={selectedNode}
              allNodes={filteredData.nodes}
              allEdges={filteredData.edges}
              project={project}
              onNavigate={(n) => setSelectedNode(n)}
              onClose={() => {
                setSelectedNode(null);
                setHighlightedIds(null);
                setSelectedPath(null);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
