// graph-ui/src/components/GraphTab.tsx
// V2 graph view — 2D force-directed canvas with filters, sidebar, and detail panel.
// Replaces V1's 3D Three.js scene with a cleaner 2D approach.

import { lazy, Suspense, useEffect, useState, useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import { useGraphData } from "../hooks/useGraphData";
import { useExactScope } from "../hooks/useExactScope";
import { useWebSocket, type WsNotification } from "../hooks/useWebSocket";
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type GraphScopeSelection,
} from "./GraphCanvas";
import { FilterPanel } from "./FilterPanel";
import { Sidebar } from "./Sidebar";
import { NodeTooltip } from "./NodeTooltip";
import { ResizeHandle } from "./ResizeHandle";
import { ErrorBoundary } from "./ErrorBoundary";
import type { GraphNode, GraphData, GraphScopeData, GraphScopeKind } from "../lib/types";
import {
  loadGraphVisualMode,
  saveGraphVisualMode,
  type GraphVisualMode,
} from "../lib/graph-visual-mode";
import {
  GRAPH_EDGE_GROUP_META,
  summarizeSelectedEdgeGroups,
} from "../lib/graph-flow-semantics";
import { PanelLeftOpen, X } from "lucide-react";

const NodeDetailPanel = lazy(() => import("./NodeDetailPanel"));
const ExactScopeControls = lazy(() => import("./ExactScopeControls"));

const LAYOUT_EVENTS = new Set([
  "code_graph_changed",
  "graph_reindexed",
  "human_nodes_changed",
  "cbm_links_changed",
]);

const EXACT_INVALIDATION_EVENTS = new Set([
  "code_graph_changed",
  "graph_reindexed",
]);
const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";
const DRAWER_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected
    && !element.closest("[inert]")
    && !element.closest('[aria-hidden="true"]'),
  );
}

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

type GraphTrailItem = { kind: GraphScopeKind; key: string };

function sameNodeIds(left: ReadonlySet<number> | null, right: ReadonlySet<number>): boolean {
  if (!left || left.size !== right.size) return false;
  for (const id of right) if (!left.has(id)) return false;
  return true;
}

function visibleNeighborhood(data: GraphData, nodeId: number): Set<number> | null {
  const visibleNodeIds = new Set(data.nodes.map((node) => node.id));
  if (!visibleNodeIds.has(nodeId)) return null;

  const connectedIds = new Set([nodeId]);
  for (const edge of data.edges) {
    if (edge.source === nodeId) connectedIds.add(edge.target);
    if (edge.target === nodeId) connectedIds.add(edge.source);
  }
  return connectedIds;
}

function exactScopeGraphData(scope: GraphScopeData): GraphData {
  return {
    nodes: scope.nodes,
    edges: scope.edges,
    total_nodes: scope.scope.total_nodes,
    graph_revision: scope.graph_revision,
    // Stable across pages in one scope so GraphCanvas retains the settled
    // physics objects while genuinely new nodes gently join the simulation.
    topology_revision: `scope:${scope.graph_revision}:${scope.scope.kind}:${scope.scope.key}`,
    layout: scope.layout,
  };
}

export function GraphTab({ project, active = true }: GraphTabProps) {
  const { data, loading, error, fetchOverview } = useGraphData();
  const [highlightedIds, setHighlightedIds] = useState<Set<number> | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  // A project-wide search or exact neighborhood can open a node that is not
  // part of the representative overview. Its absence from the next layout is
  // not evidence that it was deleted.
  const selectedNodeOutsideOverviewRef = useRef(false);
  const [selectedNodeExactRefreshKey, setSelectedNodeExactRefreshKey] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  // Breadcrumb identity is path-based. Numeric layout ids are local to one
  // response and can be renumbered when a directory appears or disappears.
  const [navigationHistory, setNavigationHistory] = useState<GraphTrailItem[]>([]);
  const [exactScopeRequest, setExactScopeRequest] = useState<GraphTrailItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const firstLoad = useRef(true);
  const wsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRefreshGenerationRef = useRef(0);
  const exactInvalidationPendingRef = useRef(false);
  const activeProjectRef = useRef(project);
  activeProjectRef.current = project;
  const [exactRefreshEpoch, setExactRefreshEpoch] = useState(0);
  // R41 (UI-9): imperative handle to the canvas — used by the "Reset view"
  // button to call canvasRef.current?.resetView() without lifting transformRef.
  const canvasRef = useRef<GraphCanvasHandle>(null);
  const graphRegionRef = useRef<HTMLDivElement>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const suppressDrawerFocusRestoreRef = useRef(false);
  const mobileDrawerWasOpenRef = useRef(false);
  const [leftWidth, setLeftWidth] = useState(() => loadWidth("cbm-left-w", 260));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("cbm-right-w", 280));
  const [visualMode, setVisualMode] = useState<GraphVisualMode>(loadGraphVisualMode);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia(DESKTOP_MEDIA_QUERY).matches || window.innerWidth >= 1024;
  });

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

    return { ...data, nodes, edges };
  }, [data, enabledLabels, enabledEdgeTypes, showOnlyDead, hideEntryPoints, hideTests]);

  // The full Code DB revision is authoritative. The WS epoch invalidates exact
  // requests immediately, including when an overview refresh fails or its
  // representative topology hash stays unchanged for an off-sample mutation.
  const exactRefreshKey = `${project ?? "none"}:${data?.graph_revision ?? data?.topology_revision ?? "unloaded"}:${exactRefreshEpoch}`;
  const activeTrail = navigationHistory.at(-1) ?? null;
  const exactScopeActive = Boolean(
    exactScopeRequest
    && activeTrail
    && exactScopeRequest.kind === activeTrail.kind
    && exactScopeRequest.key === activeTrail.key,
  );
  const exactScope = useExactScope(
    project,
    exactScopeRequest?.kind ?? "domain",
    exactScopeRequest?.key ?? "",
    exactScopeActive,
    exactRefreshKey,
  );
  const exactGraphData = useMemo(
    () => exactScopeActive && exactScope.data ? exactScopeGraphData(exactScope.data) : null,
    [exactScope.data, exactScopeActive],
  );
  const exactFilteredData = useMemo(() => {
    if (!exactGraphData) return null;
    const statusOk = (node: GraphNode) => {
      if (showOnlyDead && node.status !== "dead") return false;
      if (hideEntryPoints && node.status === "entry") return false;
      if (hideTests && node.status === "test") return false;
      return true;
    };
    const nodes = exactGraphData.nodes.filter(
      (node) => enabledLabels.has(node.label) && statusOk(node),
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = exactGraphData.edges.filter(
      (edge) => enabledEdgeTypes.has(edge.type)
        && nodeIds.has(edge.source)
        && nodeIds.has(edge.target),
    );
    return { ...exactGraphData, nodes, edges };
  }, [enabledEdgeTypes, enabledLabels, exactGraphData, hideEntryPoints, hideTests, showOnlyDead]);
  const canvasData = exactFilteredData ?? filteredData;
  const filterPanelData = exactGraphData ?? data;
  const stellarRelationSummary = useMemo(
    () => summarizeSelectedEdgeGroups(canvasData?.edges ?? [], selectedNode?.id ?? null),
    [canvasData?.edges, selectedNode?.id],
  );
  const selectedNodeRequiresExactValidation = Boolean(
    selectedNode
    && selectedNodeOutsideOverviewRef.current
    && selectedNodeExactRefreshKey !== exactRefreshKey,
  );

  // Exact pages can disclose labels/edge types absent from the representative
  // overview. Enable only genuinely new values and preserve explicit filters.
  useEffect(() => {
    if (!exactGraphData) return;
    const newLabels = exactGraphData.nodes
      .map((node) => node.label)
      .filter((label) => !knownLabelsRef.current.has(label));
    const newEdgeTypes = exactGraphData.edges
      .map((edge) => edge.type)
      .filter((type) => !knownEdgeTypesRef.current.has(type));
    if (newLabels.length > 0) {
      for (const label of newLabels) knownLabelsRef.current.add(label);
      setEnabledLabels((previous) => new Set([...previous, ...newLabels]));
    }
    if (newEdgeTypes.length > 0) {
      for (const type of newEdgeTypes) knownEdgeTypesRef.current.add(type);
      setEnabledEdgeTypes((previous) => new Set([...previous, ...newEdgeTypes]));
    }
  }, [exactGraphData]);

  const restoreDetailFocus = useCallback(() => {
    if (detailFocusTimerRef.current) clearTimeout(detailFocusTimerRef.current);
    detailFocusTimerRef.current = setTimeout(() => {
      detailFocusTimerRef.current = null;
      const requestedTarget = detailReturnFocusRef.current;
      const target = canRestoreFocus(requestedTarget)
        ? requestedTarget
        : graphRegionRef.current;
      target?.focus({ preventScroll: true });
      detailReturnFocusRef.current = null;
    }, 0);
  }, []);

  const closeMobilePanel = useCallback((restoreFocus = true) => {
    suppressDrawerFocusRestoreRef.current = !restoreFocus;
    setMobilePanelOpen(false);
  }, []);

  const handleMobileDrawerKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (isDesktop || !mobilePanelOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMobilePanel(true);
      return;
    }
    if (event.key !== "Tab") return;
    const drawer = mobileDrawerRef.current;
    if (!drawer) return;
    const focusable = [...drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR)]
      .filter((element) => !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      drawer.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeMobilePanel, isDesktop, mobilePanelOpen]);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const update = () => setIsDesktop(media.matches || window.innerWidth >= 1024);
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (isDesktop) {
      mobileDrawerWasOpenRef.current = false;
      suppressDrawerFocusRestoreRef.current = false;
      return;
    }
    if (mobilePanelOpen) {
      mobileDrawerWasOpenRef.current = true;
      const timer = setTimeout(() => mobileCloseButtonRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    if (!mobileDrawerWasOpenRef.current) return;
    mobileDrawerWasOpenRef.current = false;
    if (suppressDrawerFocusRestoreRef.current) {
      suppressDrawerFocusRestoreRef.current = false;
      return;
    }
    mobileTriggerRef.current?.focus({ preventScroll: true });
  }, [isDesktop, mobilePanelOpen]);

  // Reconcile object references after every server response. A removal-only
  // topology refresh must close stale detail/tooltip state; metadata-only
  // refreshes replace the selected object without disturbing the viewport.
  useEffect(() => {
    if (!data) return;
    if (selectedNode) {
      const refreshed = data.nodes.find((node) => node.id === selectedNode.id);
      if (!refreshed && !selectedNodeOutsideOverviewRef.current) {
        setSelectedNode(null);
        setSelectedNodeExactRefreshKey(null);
        selectedNodeOutsideOverviewRef.current = false;
        setHighlightedIds(null);
        setSelectedPath(null);
        restoreDetailFocus();
      } else if (refreshed && refreshed !== selectedNode) {
        selectedNodeOutsideOverviewRef.current = false;
        setSelectedNodeExactRefreshKey(null);
        setSelectedNode(refreshed);
        setSelectedPath(refreshed.file_path ?? null);
        setHighlightedIds(canvasData ? visibleNeighborhood(canvasData, refreshed.id) : null);
      }
    }
    if (hoveredNode) {
      const refreshedHover = data.nodes.find((node) => node.id === hoveredNode.id) ?? null;
      if (refreshedHover !== hoveredNode) setHoveredNode(refreshedHover);
    }
  }, [data, restoreDetailFocus]);

  // A selected node's visual neighborhood is a projection of the currently
  // rendered topology, not of the last click. Recompute it after label or edge
  // filters change, and do not dim the whole overview for an exact node that is
  // intentionally outside the representative map.
  useEffect(() => {
    if (!canvasData || !selectedNode) return;
    const next = visibleNeighborhood(canvasData, selectedNode.id);
    if (next) {
      if (!sameNodeIds(highlightedIds, next)) setHighlightedIds(next);
    } else if (highlightedIds !== null) {
      setHighlightedIds(null);
    }
  }, [canvasData, highlightedIds, selectedNode]);

  useEffect(() => {
    wsRefreshGenerationRef.current += 1;
    exactInvalidationPendingRef.current = false;
    if (wsRefreshTimerRef.current) {
      clearTimeout(wsRefreshTimerRef.current);
      wsRefreshTimerRef.current = null;
    }
    if (detailFocusTimerRef.current) {
      clearTimeout(detailFocusTimerRef.current);
      detailFocusTimerRef.current = null;
    }
    detailReturnFocusRef.current = null;
    setMobilePanelOpen(false);
    setSelectedNodeExactRefreshKey(null);
    if (project) {
      firstLoad.current = true;
      // R32 (B-new-2 fix): reset the known-sets on project change so the
      // next data load re-initializes everything from scratch.
      knownLabelsRef.current = new Set();
      knownEdgeTypesRef.current = new Set();
      setHighlightedIds(null);
      setSelectedPath(null);
      setSelectedNode(null);
      selectedNodeOutsideOverviewRef.current = false;
      setNavigationHistory([]);
      setExactScopeRequest(null);
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
    if (activeProjectRef.current !== project) return;
    if (notification.project !== project) return;
    // Human-human edges and sync completion do not change the rendered code
    // topology. Avoid transferring and simulating the full graph for them.
    if (!LAYOUT_EVENTS.has(notification.event)) return;
    if (EXACT_INVALIDATION_EVENTS.has(notification.event)
      && !exactInvalidationPendingRef.current) {
      exactInvalidationPendingRef.current = true;
      setExactRefreshEpoch((value) => value + 1);
    }
    // Coalesce mixed note/link notifications into one terminal refresh.
    if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
    const scheduledProject = project;
    const scheduledGeneration = ++wsRefreshGenerationRef.current;
    wsRefreshTimerRef.current = setTimeout(() => {
      wsRefreshTimerRef.current = null;
      if (scheduledGeneration !== wsRefreshGenerationRef.current
        || activeProjectRef.current !== scheduledProject) return;
      exactInvalidationPendingRef.current = false;
      void fetchOverview(scheduledProject);
    }, 350);
  }, [project, fetchOverview]);
  useWebSocket(active ? project : null, handleGraphNotification);
  useEffect(() => {
    if (!active && wsRefreshTimerRef.current) {
      clearTimeout(wsRefreshTimerRef.current);
      wsRefreshTimerRef.current = null;
      wsRefreshGenerationRef.current += 1;
      exactInvalidationPendingRef.current = false;
    }
  }, [active]);
  useEffect(() => () => {
    if (wsRefreshTimerRef.current) clearTimeout(wsRefreshTimerRef.current);
    if (detailFocusTimerRef.current) clearTimeout(detailFocusTimerRef.current);
    wsRefreshGenerationRef.current += 1;
  }, []);

  const makeScope = useCallback((kind: GraphScopeSelection["kind"], id: number) => {
    if (!filteredData?.layout) return null;
    if (kind === "domain") {
      const domain = filteredData.layout.domains.find((candidate) => candidate.id === id);
      if (!domain) return null;
      const clusterIds = new Set(filteredData.layout.clusters
        .filter((cluster) => cluster.domain_id === id)
        .map((cluster) => cluster.id));
      return {
        kind,
        id,
        key: domain.key,
        nodeIds: new Set(filteredData.nodes
          .filter((node) => node.cluster_id != null && clusterIds.has(node.cluster_id))
          .map((node) => node.id)),
      } satisfies GraphScopeSelection;
    }
    const community = filteredData.layout.clusters.find((candidate) => candidate.id === id);
    if (!community) return null;
    return {
      kind,
      id,
      key: community.key,
      nodeIds: new Set(filteredData.nodes
        .filter((node) => node.cluster_id === id)
        .map((node) => node.id)),
    } satisfies GraphScopeSelection;
  }, [filteredData]);

  const makeScopeByKey = useCallback((trailItem: GraphTrailItem) => {
    if (!filteredData?.layout || trailItem.kind === "directory") return null;
    const match = trailItem.kind === "domain"
      ? filteredData.layout.domains.find((candidate) => candidate.key === trailItem.key)
      : filteredData.layout.clusters.find((candidate) => candidate.key === trailItem.key);
    return match ? makeScope(trailItem.kind, match.id) : null;
  }, [filteredData, makeScope]);

  const showScope = useCallback((scope: GraphScopeSelection) => {
    const shouldRestoreDetailFocus = selectedNode != null;
    setSelectedNode(null);
    setSelectedNodeExactRefreshKey(null);
    selectedNodeOutsideOverviewRef.current = false;
    setHoveredNode(null);
    setExactScopeRequest(scope.kind === "community" ? scope : null);
    setHighlightedIds(scope.nodeIds.size > 0 ? scope.nodeIds : null);
    setSelectedPath(scope.key);
    canvasRef.current?.focusNodes(scope.nodeIds, scope.kind === "domain" ? 0.52 : 1.2);
    if (shouldRestoreDetailFocus) restoreDetailFocus();
  }, [restoreDetailFocus, selectedNode]);

  const handleScopeSelect = useCallback((incoming: GraphScopeSelection) => {
    const scope = makeScope(incoming.kind, incoming.id) ?? incoming;
    const trail: GraphTrailItem[] = [];
    if (scope.kind === "community" && filteredData?.layout) {
      const community = filteredData.layout.clusters.find((candidate) => candidate.id === scope.id);
      const parent = community
        ? filteredData.layout.domains.find((candidate) => candidate.id === community.domain_id)
        : null;
      if (parent) trail.push({ kind: "domain", key: parent.key });
    }
    trail.push({ kind: scope.kind, key: scope.key });
    setNavigationHistory(trail);
    showScope(scope);
  }, [filteredData, makeScope, showScope]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (!canvasData || !filteredData) return;
      const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (!detailPanelRef.current?.contains(activeElement)) {
        detailReturnFocusRef.current = mobilePanelOpen && !isDesktop
          ? graphRegionRef.current
          : (activeElement && activeElement !== document.body
              ? activeElement
              : graphRegionRef.current);
      }
      const overviewNode = data?.nodes.find((candidate) => candidate.id === node.id);
      const resolvedNode = exactScopeActive ? node : overviewNode ?? node;
      selectedNodeOutsideOverviewRef.current = overviewNode == null;
      setSelectedNodeExactRefreshKey(overviewNode == null ? exactRefreshKey : null);
      setSelectedNode(resolvedNode);

      setHighlightedIds(visibleNeighborhood(canvasData, resolvedNode.id));
      setSelectedPath(resolvedNode.file_path ?? null);
      if (!exactScopeActive && resolvedNode.cluster_id != null && filteredData.layout) {
        const community = makeScope("community", resolvedNode.cluster_id);
        const cluster = filteredData.layout.clusters.find((candidate) => candidate.id === resolvedNode.cluster_id);
        const domain = cluster ? makeScope("domain", cluster.domain_id) : null;
        setNavigationHistory(
          [...(domain ? [domain] : []), ...(community ? [community] : [])]
            .map(({ kind, key }) => ({ kind, key })),
        );
      } else if (!exactScopeActive) {
        // Exact project search may open a node that is intentionally absent
        // from the representative overview. Do not leave an unrelated scope
        // breadcrumb attached to that globally resolved result.
        setNavigationHistory([]);
      }
      canvasRef.current?.focusNode(resolvedNode.id);
    },
    [canvasData, data, exactRefreshKey, exactScopeActive, filteredData, isDesktop, makeScope, mobilePanelOpen],
  );

  const handleSidebarNodeSelect = useCallback((node: GraphNode) => {
    handleNodeClick(node);
    // The sidebar is a modal drawer below the desktop breakpoint. Leaving it
    // open beside the detail panel reduced the actual graph to a narrow strip
    // after an exact-search result was opened. On desktop this state does not
    // hide the persistent sidebar, so the same callback works for both modes.
    closeMobilePanel(false);
  }, [closeMobilePanel, handleNodeClick]);

  const navigateHome = useCallback(() => {
    const shouldRestoreDetailFocus = selectedNode != null;
    setNavigationHistory([]);
    setExactScopeRequest(null);
    setHighlightedIds(null);
    setSelectedPath(null);
    setSelectedNode(null);
    setSelectedNodeExactRefreshKey(null);
    selectedNodeOutsideOverviewRef.current = false;
    setHoveredNode(null);
    canvasRef.current?.resetView();
    if (shouldRestoreDetailFocus) restoreDetailFocus();
  }, [restoreDetailFocus, selectedNode]);

  const navigateToHistoryIndex = useCallback((index: number) => {
    const item = navigationHistory[index];
    const scope = item ? makeScopeByKey(item) : null;
    if (!scope) return;
    setNavigationHistory((previous) => previous.slice(0, index + 1));
    showScope(scope);
  }, [makeScopeByKey, navigationHistory, showScope]);

  const navigateUp = useCallback(() => {
    if (selectedNode) {
      setSelectedNode(null);
      setSelectedNodeExactRefreshKey(null);
      selectedNodeOutsideOverviewRef.current = false;
      if (exactScopeActive && exactScope.data) {
        setHoveredNode(null);
        setHighlightedIds(null);
        setSelectedPath(exactScope.data.scope.key);
        canvasRef.current?.focusNodes(exactScope.data.nodes.map((node) => node.id), 0.9);
        restoreDetailFocus();
        return;
      }
      const parentItem = navigationHistory.at(-1);
      const parent = parentItem ? makeScopeByKey(parentItem) : null;
      if (parent) {
        showScope(parent);
      } else navigateHome();
      return;
    }
    if (navigationHistory.length <= 1) {
      navigateHome();
      return;
    }
    const parentItem = navigationHistory[navigationHistory.length - 2];
    const parent = makeScopeByKey(parentItem);
    setNavigationHistory((previous) => previous.slice(0, -1));
    if (parent) showScope(parent);
    else navigateHome();
  }, [exactScope.data, exactScopeActive, makeScopeByKey, navigateHome, navigationHistory, restoreDetailFocus, selectedNode, showScope]);

  const handleExactValidation = useCallback((
    nodeId: number,
    refreshKey: string | number | undefined,
    valid: boolean,
  ) => {
    if (!selectedNode
      || selectedNode.id !== nodeId
      || refreshKey !== exactRefreshKey
      || !selectedNodeOutsideOverviewRef.current) return;
    if (valid) {
      setSelectedNodeExactRefreshKey(exactRefreshKey);
      return;
    }
    setSelectedNode(null);
    setSelectedNodeExactRefreshKey(null);
    selectedNodeOutsideOverviewRef.current = false;
    setHighlightedIds(null);
    setSelectedPath(null);
    setNavigationHistory([]);
    restoreDetailFocus();
  }, [exactRefreshKey, restoreDetailFocus, selectedNode]);

  // Resolve every breadcrumb against the latest response instead of keeping
  // response-local numeric ids and node snapshots. This makes refreshes and
  // directory additions safe: the same key stays selected, while a removed
  // path is truncated cleanly rather than silently pointing at another scope.
  useEffect(() => {
    if (navigationHistory.length === 0 || !filteredData?.layout) return;
    // Exact directory breadcrumbs are independent of response-local layout
    // ids. The revision-bound scope hook owns their reconciliation.
    if (activeTrail?.kind === "directory") return;
    const resolved: GraphScopeSelection[] = [];
    for (const item of navigationHistory) {
      const scope = makeScopeByKey(item);
      if (!scope) break;
      resolved.push(scope);
    }

    if (resolved.length !== navigationHistory.length) {
      setNavigationHistory((previous) => previous.slice(0, resolved.length));
    }
    if (selectedNode) return;

    const activeScope = resolved.at(-1);
    if (!activeScope) {
      setHighlightedIds(null);
      setSelectedPath(null);
      canvasRef.current?.resetView();
      return;
    }
    if (!sameNodeIds(highlightedIds, activeScope.nodeIds)) {
      setHighlightedIds(activeScope.nodeIds.size > 0 ? activeScope.nodeIds : null);
    }
    if (selectedPath !== activeScope.key) setSelectedPath(activeScope.key);
  }, [filteredData, highlightedIds, makeScopeByKey, navigationHistory, selectedNode, selectedPath]);

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
    if (!filterPanelData) return;
    setEnabledLabels(new Set(filterPanelData.nodes.map((n) => n.label)));
    setEnabledEdgeTypes(new Set(filterPanelData.edges.map((e) => e.type)));
  }, [filterPanelData]);

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
          <p className="text-foreground/60 text-sm" role="status" aria-live="polite">Computing layout...</p>
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

  if (!data || !filteredData || !canvasData || !filterPanelData || data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-foreground/30 text-sm">No nodes in this project</p>
      </div>
    );
  }

  return (
    <div
      className="relative h-full flex overflow-hidden"
      onKeyDown={(event) => {
        if (event.key === "Escape" && mobilePanelOpen && !isDesktop) {
          event.preventDefault();
          event.stopPropagation();
          closeMobilePanel(true);
          return;
        }
        if (event.key !== "Escape" || (navigationHistory.length === 0 && !selectedNode)) return;
        event.preventDefault();
        event.stopPropagation();
        navigateUp();
      }}
    >
      {mobilePanelOpen && (
        <button
          className="absolute inset-0 z-20 bg-black/55 backdrop-blur-[2px] lg:hidden"
          aria-label="Dismiss graph filters"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => closeMobilePanel(true)}
        />
      )}
      {/* Left sidebar */}
      <div
        ref={mobileDrawerRef}
        role={!isDesktop && mobilePanelOpen ? "dialog" : undefined}
        aria-modal={!isDesktop && mobilePanelOpen ? true : undefined}
        aria-label={!isDesktop && mobilePanelOpen ? "Graph filters and structure search" : undefined}
        aria-hidden={!isDesktop && !mobilePanelOpen ? true : undefined}
        inert={!isDesktop && !mobilePanelOpen ? true : undefined}
        tabIndex={!isDesktop && mobilePanelOpen ? -1 : undefined}
        onKeyDown={handleMobileDrawerKeyDown}
        className={`absolute inset-y-0 left-0 z-30 flex h-full max-w-[86vw] shrink-0 flex-col border-r border-white/10 bg-[#081720]/97 shadow-2xl backdrop-blur-xl transition-transform duration-200 lg:relative lg:z-auto lg:translate-x-0 lg:bg-[#0b1920]/90 lg:shadow-none ${mobilePanelOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ width: leftWidth }}
      >
        <button
          ref={mobileCloseButtonRef}
          className="absolute right-2 top-2 z-10 rounded-lg border border-white/10 bg-white/[0.05] p-1.5 text-slate-400 hover:text-slate-100 lg:hidden"
          aria-label="Close graph filters"
          onClick={() => closeMobilePanel(true)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <FilterPanel
          data={filterPanelData}
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
          project={project}
          exactRefreshKey={exactRefreshKey}
          nodes={canvasData.nodes}
          selectedPath={selectedPath}
          selectedNodeId={selectedNode?.id ?? null}
          onSelectNode={handleSidebarNodeSelect}
          onSelectPath={(path, ids) => {
             if (ids.size === 0) {
               navigateHome();
               return;
             }
             const domain = filteredData.layout?.domains.find((candidate) => candidate.key === path);
             if (domain) handleScopeSelect({
               kind: "domain",
               id: domain.id,
               key: domain.key,
               nodeIds: ids,
             });
             else {
               const request = { kind: "directory" as const, key: path };
               setNavigationHistory([
                 { kind: "domain", key: path.split("/", 1)[0] },
                 request,
               ]);
               setSelectedNode(null);
               setHoveredNode(null);
               setHighlightedIds(null);
               setSelectedPath(path);
               setExactScopeRequest(request);
             }
             closeMobilePanel(false);
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
      <div
        ref={graphRegionRef}
        tabIndex={-1}
        aria-label="Graph canvas region"
        inert={!isDesktop && mobilePanelOpen ? true : undefined}
        className="flex-1 relative overflow-hidden focus:outline-none"
      >
        <button
          ref={mobileTriggerRef}
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
            data={canvasData}
            active={active}
            visualMode={visualMode}
            detailMode={Boolean(exactGraphData)}
            highlightedIds={highlightedIds}
            selectedNodeId={selectedNode?.id ?? null}
            deadCodeView={deadCodeView}
            onNodeClick={handleNodeClick}
            onScopeSelect={handleScopeSelect}
            onNodeHover={(node, pos) => {
              setHoveredNode(node);
              if (pos) setTooltipPos(pos);
            }}
          />
        </ErrorBoundary>

        {canvasData.nodes.length === 0 ? (
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
            {/* Compact fidelity HUD. The previous five-line fixed panel hid a
                meaningful part of the architecture map. Keep the sampling
                truth visible in one row and reveal diagnostics on demand. */}
            {!exactGraphData && (
              <details className="group absolute left-14 top-3 z-20 max-w-[calc(100%-8rem)] overflow-hidden rounded-xl border border-white/10 bg-[#071219]/88 text-[10px] text-foreground/70 shadow-xl backdrop-blur-md lg:left-4 lg:top-4 lg:max-w-[min(760px,calc(100%-16rem))] lg:text-[11px]">
                <summary
                  className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/70"
                  title="Toggle graph fidelity details"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" />
                  <span className="whitespace-nowrap">
                    <strong className="font-semibold text-cyan-50">{canvasData.nodes.length.toLocaleString()}</strong>
                    <span className="text-foreground/45"> / {data.total_nodes.toLocaleString()} nodes</span>
                  </span>
                  {data.layout?.domains && (
                    <span className="hidden whitespace-nowrap text-sky-200/70 sm:inline">
                      {(data.layout.domain_catalog?.total_domains ?? data.layout.domains.length).toLocaleString()} domains
                      {data.layout.domain_catalog?.exact ? " exact" : ""}
                      {" · "}{data.layout.clusters.length.toLocaleString()} represented communities
                    </span>
                  )}
                  <span className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-[0.12em] ${data.truncated ? "border-amber-300/15 bg-amber-300/[0.06] text-amber-100/75" : "border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100/75"}`}>
                    {data.truncated ? "covered sample" : "complete"}
                  </span>
                  {highlightedIds && highlightedIds.size > 0 && (
                    <span className="hidden whitespace-nowrap text-cyan-300/65 md:inline">
                      {highlightedIds.size.toLocaleString()} selected
                    </span>
                  )}
                </summary>
                <div className="border-t border-white/[0.07] px-3 py-2 font-mono leading-relaxed text-foreground/48">
                  <p>
                    {canvasData.edges.length.toLocaleString()} visible edges
                    {data.truncated
                      ? ` · ${data.sampling?.strategy === "architecture-coverage-v1" ? "structure-covered representatives" : (data.sampling?.strategy ?? "sampled")}`
                      : " · complete graph"}
                  </p>
                  {data.edge_sampling?.edges_truncated && (
                    <p className="text-amber-100/65">
                      {data.edge_sampling.returned_edges.toLocaleString()} /{" "}
                      {data.edge_sampling.total_induced_edges.toLocaleString()} induced edges retained
                      {` · max ${data.edge_sampling.limit_per_direction} in/out per shown node`}
                    </p>
                  )}
                  <p className="text-sky-200/45">
                    {`Directed bundles at overview · retained raw links appear with zoom${data.layout?.domain_catalog?.exact ? " · domain totals cover all project nodes" : ""}${data.truncated ? " · community geometry and flows describe representatives" : ""}`}
                  </p>
                </div>
              </details>
            )}

            {activeTrail && !selectedNode && (
              <Suspense fallback={null}>
                <ExactScopeControls
                  hud={exactGraphData && exactScope.data ? {
                    returnedNodes: canvasData.nodes.length,
                    totalNodes: exactScope.data.scope.total_nodes,
                    visibleEdges: canvasData.edges.length,
                    totalInternalEdges: exactScope.data.scope.total_internal_edges,
                    complete: exactScope.data.complete,
                    selectedCount: highlightedIds?.size ?? 0,
                  } : null}
                  active={exactScopeActive}
                  loading={exactScope.loading && !exactScope.data}
                  loadingMore={exactScope.loadingMore}
                  error={exactScope.error}
                  hasMore={Boolean(exactScope.data?.page.next_cursor)}
                  onOpen={() => {
                    setHoveredNode(null);
                    setHighlightedIds(null);
                    setExactScopeRequest(activeTrail);
                  }}
                  onLoadMore={exactScope.loadMore}
                  onRetry={exactScope.retry}
                  onClose={() => {
                    if (activeTrail.kind === "directory") {
                      navigateUp();
                      return;
                    }
                    const overviewScope = makeScopeByKey(activeTrail);
                    if (overviewScope) showScope(overviewScope);
                    setExactScopeRequest(null);
                  }}
                />
              </Suspense>
            )}

            {(navigationHistory.length > 0 || selectedNode) && (
              <nav
                aria-label="Graph navigation"
                className="absolute bottom-4 left-4 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 overflow-hidden rounded-xl border border-white/10 bg-[#071219]/90 p-1.5 text-[12px] text-slate-300 shadow-xl backdrop-blur-md"
              >
                <button
                  onClick={navigateUp}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-cyan-200/75 hover:bg-white/[0.08] hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                  aria-label="Go up one structure level"
                  title="Go up (Escape)"
                >
                  ←
                </button>
                <button
                  onClick={navigateHome}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                >
                  Structure
                </button>
                {navigationHistory.map((scope, index) => (
                  <span key={`${scope.kind}:${scope.key}`} className="flex min-w-0 items-center gap-1">
                    <span className="text-slate-600">/</span>
                    <button
                      onClick={() => navigateToHistoryIndex(index)}
                      aria-current={index === navigationHistory.length - 1 && !selectedNode ? "page" : undefined}
                      className="max-w-48 truncate rounded-lg px-2 py-1.5 text-sky-200/70 hover:bg-white/[0.06] hover:text-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                      title={scope.key}
                    >
                      {scope.kind === "domain" ? scope.key : scope.key.split("/").slice(1).join("/") || scope.key}
                    </button>
                  </span>
                ))}
                {selectedNode && (
                  <span className="flex min-w-0 items-center gap-1" aria-current="page">
                    <span className="text-slate-600">/</span>
                    <span className="max-w-52 truncate px-2 py-1.5 text-cyan-100" title={selectedNode.name}>
                      {selectedNode.name}
                    </span>
                  </span>
                )}
              </nav>
            )}

            {error && data && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-amber-400/20 bg-amber-950/80 px-3 py-2 text-[11px] text-amber-200 shadow-xl backdrop-blur-md">
                Refresh failed; keeping the last valid graph. {error}
              </div>
            )}

            {/* Actions */}
            <div
              role="toolbar"
              aria-label="Graph actions"
              className={`absolute right-3 top-20 z-20 flex flex-col items-end gap-1.5 ${selectedNode ? "2xl:right-4 2xl:top-4 2xl:flex-row 2xl:items-center 2xl:gap-2" : "xl:right-4 xl:top-4 xl:flex-row xl:items-center xl:gap-2"}`}
            >
              <div
                role="group"
                aria-label="Graph view"
                className="flex h-8 items-center rounded-lg border border-white/[0.07] bg-[#070d15]/82 p-0.5 shadow-lg backdrop-blur-md"
              >
                <button
                  onClick={() => {
                    saveGraphVisualMode("architecture");
                    setVisualMode("architecture");
                  }}
                  className={`h-7 rounded-md px-2.5 text-[10px] font-semibold tracking-wide transition-colors ${visualMode === "architecture" ? "bg-cyan-300/[0.12] text-cyan-50 shadow-sm" : "text-foreground/42 hover:text-foreground/70"}`}
                  aria-pressed={visualMode === "architecture"}
                >
                  Structure
                </button>
                <button
                  onClick={() => {
                    saveGraphVisualMode("stellar");
                    setVisualMode("stellar");
                  }}
                  className={`h-7 rounded-md px-2.5 text-[10px] font-semibold tracking-wide transition-colors ${visualMode === "stellar" ? "bg-indigo-300/[0.12] text-indigo-50 shadow-sm" : "text-foreground/42 hover:text-foreground/70"}`}
                  aria-pressed={visualMode === "stellar"}
                >
                  Dependencies
                </button>
              </div>
              <button
                onClick={() => fetchOverview(project)}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground/50 hover:bg-white/[0.08] text-[12px]"
              >
                Refresh
              </button>
              <button
                onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.05] text-sm text-foreground/70 hover:bg-white/[0.1]"
                title="Zoom out"
                aria-label="Zoom out"
              >
                −
              </button>
              <button
                onClick={() => canvasRef.current?.resetView()}
                className="px-3 py-1.5 rounded-lg bg-white/[0.05] text-foreground/70 hover:bg-white/[0.1] text-[12px]"
                title="Fit the complete graph"
              >
                Fit
              </button>
              <button
                onClick={() => canvasRef.current?.zoomBy(1.2)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.05] text-sm text-foreground/70 hover:bg-white/[0.1]"
                title="Zoom in"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>

            <div
              role="status"
              aria-label="Graph view guide"
              aria-live="polite"
              className={`pointer-events-none absolute left-1/2 z-20 flex max-w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 items-center border border-white/10 bg-[#071219]/86 px-3 py-1.5 text-[10px] font-medium tracking-wide text-slate-300/70 shadow-lg backdrop-blur-md ${visualMode === "stellar" && selectedNode ? "bottom-16 flex-col gap-1 rounded-xl" : "bottom-4 gap-2 rounded-full"}`}
            >
              {visualMode === "stellar" && selectedNode ? (
                  <>
                    <span className="flex items-center gap-2">
                      <span className="text-indigo-200/65">Incoming</span>
                      <span aria-hidden="true">&larr;</span>
                      <strong className="max-w-52 truncate font-semibold text-cyan-50" title={selectedNode.name}>
                        {selectedNode.name}
                      </strong>
                      <span aria-hidden="true">&rarr;</span>
                      <span className="text-cyan-200/65">Outgoing</span>
                    </span>
                    {stellarRelationSummary.length > 0 && (
                      <ul aria-label="Visible relation types" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 font-mono text-[9px] tracking-normal">
                        {stellarRelationSummary.map(({ group, count }) => {
                          const meta = GRAPH_EDGE_GROUP_META[group];
                          return (
                            <li
                              key={group}
                              className="flex items-center gap-1 whitespace-nowrap"
                              aria-label={`${meta.label}: ${count.toLocaleString()}; ${meta.pattern} line`}
                              title={`${meta.label}: ${meta.pattern} line`}
                            >
                              <span aria-hidden="true" style={{ color: meta.stroke }}>{meta.glyph}</span>
                              <span>{meta.label} {count.toLocaleString()}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
              ) : (
                <span>{visualMode === "stellar"
                  ? "Dependencies · select a symbol · incoming ← focus → outgoing"
                  : "Structure · domains → communities → symbols"}</span>
              )}
            </div>

            {hoveredNode && <NodeTooltip node={hoveredNode} x={tooltipPos.x} y={tooltipPos.y} />}
          </>
        )}
      </div>

      {/* Right detail panel */}
      {selectedNode && canvasData && (
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
            ref={detailPanelRef}
            inert={!isDesktop && mobilePanelOpen ? true : undefined}
            className="absolute inset-y-0 right-0 z-30 h-full max-w-[92vw] shrink-0 overflow-hidden border-l border-white/10 bg-[#081720]/98 shadow-2xl lg:relative lg:z-auto lg:bg-transparent lg:shadow-none"
            style={{ width: rightWidth }}
          >
            <Suspense fallback={<p role="status" className="p-4 text-xs text-foreground/40">Loading node details…</p>}>
              <NodeDetailPanel
                node={selectedNode}
                overviewNodes={data.nodes}
                allNodes={canvasData.nodes}
                allEdges={canvasData.edges}
                project={project}
                exactRefreshKey={exactRefreshKey}
                requiresExactValidation={selectedNodeRequiresExactValidation}
                onExactValidation={handleExactValidation}
                onNavigate={handleNodeClick}
                onClose={() => {
                  navigateUp();
                }}
              />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
