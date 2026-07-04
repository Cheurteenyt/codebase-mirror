// graph-ui/src/components/GraphTab.tsx
// V2 graph view — 2D force-directed canvas with filters, sidebar, and detail panel.
// Replaces V1's 3D Three.js scene with a cleaner 2D approach.

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useGraphData } from "../hooks/useGraphData";
import { GraphCanvas } from "./GraphCanvas";
import { FilterPanel } from "./FilterPanel";
import { Sidebar } from "./Sidebar";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { NodeTooltip } from "./NodeTooltip";
import { ResizeHandle } from "./ResizeHandle";
import { ErrorBoundary } from "./ErrorBoundary";
import type { GraphNode, GraphData } from "../lib/types";


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
}

export function GraphTab({ project }: GraphTabProps) {
  const { data, loading, error, fetchOverview } = useGraphData();
  const [highlightedIds, setHighlightedIds] = useState<Set<number> | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const firstLoad = useRef(true);
  const [showLabels, setShowLabels] = useState(true);
  const [leftWidth, setLeftWidth] = useState(() => loadWidth("cbm-left-w", 260));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("cbm-right-w", 280));

  const [enabledLabels, setEnabledLabels] = useState<Set<string>>(new Set());
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Set<string>>(new Set());
  const [deadCodeView, setDeadCodeView] = useState(false);
  const [showOnlyDead, setShowOnlyDead] = useState(false);
  const [hideEntryPoints, setHideEntryPoints] = useState(false);
  const [hideTests, setHideTests] = useState(false);

  useEffect(() => {
    if (!data || !firstLoad.current) return;
    firstLoad.current = false;
    const labels = new Set(data.nodes.map((n) => n.label));
    const types = new Set(data.edges.map((e) => e.type));
    setEnabledLabels(labels);
    setEnabledEdgeTypes(types);
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
      fetchOverview(project);
      setHighlightedIds(null);
      setSelectedPath(null);
      setSelectedNode(null);
    }
  }, [project, fetchOverview]);

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

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-foreground/30 text-sm">Select a project from the Projects tab</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-foreground/40 text-sm">Computing layout...</p>
        </div>
      </div>
    );
  }

  if (error) {
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
    <div className="h-full flex">
      {/* Left sidebar */}
      <div
        className="border-r border-border/30 flex flex-col h-full bg-[#0b1920]/90 backdrop-blur-md shrink-0"
        style={{ width: leftWidth }}
      >
        <FilterPanel
          data={data}
          enabledLabels={enabledLabels}
          enabledEdgeTypes={enabledEdgeTypes}
          onToggleLabel={toggleLabel}
          onToggleEdgeType={toggleEdgeType}
          onEnableAll={enableAll}
          onDisableAll={() => { setEnabledLabels(new Set()); setEnabledEdgeTypes(new Set()); }}
          showLabels={showLabels}
          onToggleShowLabels={() => setShowLabels((v) => !v)}
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
            setHighlightedIds(ids);
          }}
        />
      </div>
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

      {/* Graph canvas */}
      <div className="flex-1 relative overflow-hidden">
        {filteredData.nodes.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-foreground/30 text-sm mb-3">All nodes filtered out</p>
              <button onClick={enableAll} className="px-4 py-2 rounded-lg bg-primary/15 text-primary text-sm">
                Reset Filters
              </button>
            </div>
          </div>
        ) : (
          <>
            <ErrorBoundary>
              <GraphCanvas
                data={filteredData}
                highlightedIds={highlightedIds}
                deadCodeView={deadCodeView}
                onNodeClick={handleNodeClick}
                onNodeHover={setHoveredNode}
              />
            </ErrorBoundary>

            {/* HUD */}
            <div className="absolute top-4 left-4 text-[11px] text-foreground/30 pointer-events-none font-mono">
              <p>
                {filteredData.nodes.length.toLocaleString()} nodes /{" "}
                {filteredData.edges.length.toLocaleString()} edges
              </p>
              {highlightedIds && highlightedIds.size > 0 && (
                <p className="text-cyan-400/50 mt-0.5">{highlightedIds.size} selected</p>
              )}
            </div>

            {/* Actions */}
            <div className="absolute top-4 right-4 flex gap-2">
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
            </div>

            {hoveredNode && <NodeTooltip node={hoveredNode} />}
          </>
        )}
      </div>

      {/* Right detail panel */}
      {selectedNode && filteredData && (
        <>
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
          <div
            className="border-l border-border shrink-0 h-full overflow-hidden"
            style={{ width: rightWidth }}
          >
            <NodeDetailPanel
              node={selectedNode}
              allNodes={filteredData.nodes}
              allEdges={filteredData.edges}
              project={project}
              repoInfo={null}
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
