// graph-ui/src/components/GraphCanvas.tsx
// V2: 2D canvas-based graph renderer using d3-force.
// Replaces V1's 3D Three.js scene with a cleaner, more readable 2D layout.
// Advantages: no GPU needed, handles 5000+ nodes, simpler interaction.

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY } from "d3-force";
import type { GraphData, GraphNode } from "../lib/types";
import { colorForLabel, colorForStatus } from "../lib/colors";

/**
 * R41 (UI-9): imperative handle exposed by GraphCanvas. Lets the parent
 * (GraphTab) wire a "Reset view" button without lifting transformRef out
 * of the canvas (which would break encapsulation and re-introduce re-renders).
 */
export interface GraphCanvasHandle {
  /** Fit the currently visible graph inside the canvas bounds. */
  fitView: () => void;
  /** Reset pan/zoom by fitting the currently visible graph. */
  resetView: () => void;
  /** Zoom in/out by a factor (e.g. 1.2 to zoom in, 0.83 to zoom out). */
  zoomBy: (factor: number) => void;
}

interface GraphCanvasProps {
  data: GraphData;
  active?: boolean;
  highlightedIds: Set<number> | null;
  deadCodeView: boolean;
  onNodeClick: (node: GraphNode) => void;
  onNodeHover: (node: GraphNode | null, pos?: { x: number; y: number }) => void;
}

interface SimNode extends GraphNode {
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: number | SimNode;
  target: number | SimNode;
  type: string;
}

const DEFAULT_NODE_RADIUS = 4;
const MIN_NODE_RADIUS = 2;
const MAX_NODE_RADIUS = 12;
const HIGHLIGHT_SCALE = 1.5;
const FIT_PADDING = 48;
const LINK_DISTANCE = 30;
const CHARGE_STRENGTH = -45;
const CHARGE_DISTANCE_MAX = 260;
const CENTERING_STRENGTH = 0.025;
const SETTLED_FIT_DELAY_MS = 700;
const TOUCH_TAP_SLOP_PX = 8;

function nodeRadius(node: Pick<GraphNode, "size">): number {
  const size = Number(node.size);
  if (!Number.isFinite(size)) return DEFAULT_NODE_RADIUS;
  return Math.max(MIN_NODE_RADIUS, Math.min(MAX_NODE_RADIUS, size));
}

function edgeKey(edge: { source: number; target: number; type: string }): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas({
  data,
  active = true,
  highlightedIds,
  deadCodeView,
  onNodeClick,
  onNodeHover,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  // Keep the physics object for every node seen during this mount. Filter
  // toggles pass subsets of the same graph, so removing a node from the
  // simulation must not discard its settled position. Reusing the same object
  // also avoids resetting d3's velocity/index state when the node reappears.
  const nodeStateCacheRef = useRef<Map<number, SimNode>>(new Map());
  const knownNodeIdsRef = useRef<Set<number>>(new Set());
  const knownEdgeKeysRef = useRef<Set<string>>(new Set());
  const currentNodeIdsRef = useRef<Set<number>>(new Set());
  const currentEdgeKeysRef = useRef<Set<string>>(new Set());
  const drawRef = useRef<(() => void) | null>(null);
  // R40 (UI-2): cache nodeMap in a ref. The draw() function used to rebuild
  // a Map of all nodes on every call (every tick during layout = many times
  // per frame for a 2000-node graph). The map only changes when nodesRef
  // changes, so we rebuild it only on data updates.
  const nodeMapRef = useRef<Map<number, SimNode>>(new Map());
  // R40 (UI-6): rAF-batched tick handler. d3-force ticks much faster than
  // 60fps during initial layout; without batching, draw() runs multiple
  // times per frame, wasting CPU on a canvas redraw that the user never sees.
  const rafIdRef = useRef<number | null>(null);
  const autoFitRafRef = useRef<number | null>(null);
  const settledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoFitRef = useRef(false);
  const hasUserInteractedRef = useRef(false);
  const activeRef = useRef(active);
  const previousActiveRef = useRef(active);
  activeRef.current = active;

  const cancelPendingAutoFit = useCallback(() => {
    if (autoFitRafRef.current != null) {
      cancelAnimationFrame(autoFitRafRef.current);
      autoFitRafRef.current = null;
    }
  }, []);

  /**
   * Fit visible node bounds into CSS-pixel canvas bounds. Returns false while
   * the canvas is hidden/unsized so ResizeObserver can retry later.
   */
  const fitVisibleGraph = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || nodes.length === 0) return false;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const viewportWidth = rect.width || canvas.clientWidth || canvas.width / dpr;
    const viewportHeight = rect.height || canvas.clientHeight || canvas.height / dpr;
    if (viewportWidth <= 0 || viewportHeight <= 0) return false;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      const x = node.x;
      const y = node.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const radius = nodeRadius(node);
      minX = Math.min(minX, x - radius);
      minY = Math.min(minY, y - radius);
      maxX = Math.max(maxX, x + radius);
      maxY = Math.max(maxY, y + radius);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false;

    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const availableWidth = Math.max(1, viewportWidth - FIT_PADDING * 2);
    const availableHeight = Math.max(1, viewportHeight - FIT_PADDING * 2);
    const k = Math.max(0.1, Math.min(10, availableWidth / graphWidth, availableHeight / graphHeight));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    transformRef.current = { x: -centerX * k, y: -centerY * k, k };
    drawRef.current?.();
    return true;
  }, []);

  const scheduleInitialFit = useCallback(() => {
    if (hasAutoFitRef.current || hasUserInteractedRef.current || autoFitRafRef.current != null) return;
    autoFitRafRef.current = requestAnimationFrame(() => {
      autoFitRafRef.current = null;
      if (hasAutoFitRef.current || hasUserInteractedRef.current) return;
      if (fitVisibleGraph()) hasAutoFitRef.current = true;
    });
  }, [fitVisibleGraph]);

  const scheduleSettledFit = useCallback(() => {
    if (settledFitTimerRef.current != null) clearTimeout(settledFitTimerRef.current);
    settledFitTimerRef.current = setTimeout(() => {
      settledFitTimerRef.current = null;
      if (!activeRef.current || hasUserInteractedRef.current) return;
      if (fitVisibleGraph()) hasAutoFitRef.current = true;
    }, SETTLED_FIT_DELAY_MS);
  }, [fitVisibleGraph]);

  // Stable refs for callbacks so the mouse-interaction useEffect doesn't re-bind
  // listeners on every render. Without this, toggling filters recreates all
  // event listeners (mousedown/mousemove/mouseup/wheel) — wasteful and can
  // cause missed events during the rebind window.
  const onNodeClickRef = useRef(onNodeClick);
  const onNodeHoverRef = useRef(onNodeHover);
  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);
  useEffect(() => { onNodeHoverRef.current = onNodeHover; }, [onNodeHover]);

  const dragRef = useRef<{ node: SimNode | null; startX: number; startY: number }>({
    node: null,
    startX: 0,
    startY: 0,
  });
  // R40 (UI-4): track the last hovered node id to avoid calling onNodeHover
  // (which calls setState in the parent) on every mouse move. The previous
  // code called onNodeHover on every mousemove event even when the hovered
  // node was unchanged, causing the whole GraphTab tree to re-render
  // continuously while the cursor was over the canvas.
  const lastHoverIdRef = useRef<number | null>(null);

  // Update simulation when data changes.
  // R40 (UI-2): previously this effect tore down the entire simulation and
  // rebuilt it from scratch whenever `data` changed (which happens on every
  // filter toggle, since GraphTab creates a new filteredData object). Every
  // node lost its position and the graph "exploded" and re-flowed — a visual
  // jolt and several seconds of CPU on a 2000-node graph.
  // Reuse the existing simulation and cache physics objects for every node
  // seen during this mount. Known filter subsets/restorations never reheat;
  // only genuinely new topology restarts at alpha=0.3.
  useEffect(() => {
    if (!data || data.nodes.length === 0) {
      // No data — stop the sim but keep it around for the next non-empty data
      if (simRef.current) {
        simRef.current.stop();
        simRef.current.alpha(0);
      }
      nodesRef.current = [];
      edgesRef.current = [];
      nodeMapRef.current = new Map();
      currentNodeIdsRef.current = new Set();
      currentEdgeKeysRef.current = new Set();
      drawRef.current?.();
      return;
    }

    const incomingNodeIds = new Set(data.nodes.map((node) => node.id));
    const incomingEdgeKeys = new Set(data.edges.map(edgeKey));
    const topologyIdentical = setsEqual(incomingNodeIds, currentNodeIdsRef.current)
      && setsEqual(incomingEdgeKeys, currentEdgeKeysRef.current);
    // A filter may remove nodes/edges and later re-add them. As long as every
    // incoming topology element has been seen during this mount, it is a view
    // change rather than new graph topology and must not reheat d3.
    const topologyAlreadyKnown = [...incomingNodeIds].every((id) => knownNodeIdsRef.current.has(id))
      && [...incomingEdgeKeys].every((key) => knownEdgeKeysRef.current.has(key));

    // Reuse the cached physics object for every known node. Update semantic
    // metadata in place while preserving d3-owned position/velocity fields.
    const nodes: SimNode[] = data.nodes.map((n) => {
      const cached = nodeStateCacheRef.current.get(n.id);
      if (!cached) {
        const created = { ...n } as SimNode;
        nodeStateCacheRef.current.set(n.id, created);
        return created;
      }
      const physics = {
        x: cached.x,
        y: cached.y,
        vx: cached.vx,
        vy: cached.vy,
        fx: cached.fx,
        fy: cached.fy,
      };
      Object.assign(cached, n, physics);
      return cached;
    });
    const edges: SimEdge[] = data.edges.map((e) => ({ ...e }));

    nodesRef.current = nodes;
    edgesRef.current = edges;
    currentNodeIdsRef.current = incomingNodeIds;
    currentEdgeKeysRef.current = incomingEdgeKeys;
    for (const id of incomingNodeIds) knownNodeIdsRef.current.add(id);
    for (const key of incomingEdgeKeys) knownEdgeKeysRef.current.add(key);
    // Rebuild the nodeMap cache (used by draw()).
    const map = new Map<number, SimNode>();
    for (const n of nodes) map.set(n.id, n);
    nodeMapRef.current = map;

    if (simRef.current) {
      if (!topologyIdentical) {
        // Swap the active subset while retaining cached node objects. Merely
        // filtering to known topology (or restoring it) does not restart d3.
        simRef.current.nodes(nodes);
        (simRef.current.force("link") as any).links(edges);
      }
      if (!topologyAlreadyKnown) {
        // Only genuinely new nodes/edges need a gentle topology re-layout.
        simRef.current.alpha(0.3);
        // Setting alpha does not wake a stopped d3 timer. Defer the restart
        // while this warm canvas is hidden.
        if (activeRef.current && previousActiveRef.current) simRef.current.restart();
      }
    } else {
      const sim = forceSimulation(nodes)
        .force(
          "charge",
          forceManyBody().strength(CHARGE_STRENGTH).distanceMax(CHARGE_DISTANCE_MAX),
        )
        .force(
          "link",
          forceLink<SimNode, SimEdge>(edges)
            .id((d) => d.id)
            .distance(LINK_DISTANCE)
            .strength(0.3),
        )
        .force("center", forceCenter(0, 0))
        // forceCenter only translates the centroid; it does not pull isolated
        // nodes back. Weak axis forces keep disconnected components inside a
        // readable overview and cap the area d3 must continuously traverse.
        .force("x", forceX<SimNode>(0).strength(CENTERING_STRENGTH))
        .force("y", forceY<SimNode>(0).strength(CENTERING_STRENGTH))
        .force("collide", forceCollide<SimNode>((node) => nodeRadius(node) + 4))
        .alpha(1)
        .alphaDecay(0.02);

      // R40 (UI-6): batch tick-driven draws via requestAnimationFrame.
      // d3 ticks much faster than 60fps during initial layout; without
      // batching, draw() runs many times per visible frame.
      sim.on("tick", () => {
        if (rafIdRef.current != null) return;
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          drawRef.current?.();
        });
      });

      simRef.current = sim as any;
    }
    // A known filter restoration deliberately does not reheat/restart d3. If
    // the previous view was empty, however, the simulation is stopped and no
    // future tick will repaint the restored topology. Draw explicitly after
    // swapping refs so every non-empty view change is immediately visible.
    drawRef.current?.();
    scheduleInitialFit();
    if (!topologyAlreadyKnown) scheduleSettledFit();
    // No cleanup here — the sim is preserved across data changes. Cleanup is
    // handled by the unmount-only effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scheduleInitialFit, scheduleSettledFit]);

  // App keeps a visited graph mounted so filters and positions survive tab
  // switches. Stop d3 while the panel is hidden, then resume only the remaining
  // cooling work when the user returns; do not force a new alpha/re-layout.
  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    const sim = simRef.current;

    if (!active) {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      sim?.stop();
      return;
    }

    if (!wasActive) {
      if (sim && sim.alpha() > sim.alphaMin()) sim.restart();
      scheduleInitialFit();
      drawRef.current?.();
    }
  }, [active, scheduleInitialFit]);

  // R40 (UI-2): unmount-only cleanup. Stop the simulation and cancel any
  // pending rAF when the component unmounts. Previously the data-effect's
  // cleanup stopped the sim on every data change, which defeated the
  // simulation-reuse optimization.
  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      cancelPendingAutoFit();
      if (settledFitTimerRef.current != null) {
        clearTimeout(settledFitTimerRef.current);
        settledFitTimerRef.current = null;
      }
      if (simRef.current) {
        simRef.current.on("tick", null);
        simRef.current.stop();
        simRef.current = null;
      }
    };
  }, [cancelPendingAutoFit]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    const { x: tx, y: ty, k: tk } = transformRef.current;
    // R31 (C1 fix): apply devicePixelRatio scaling so the canvas renders at
    // full resolution on HiDPI/Retina displays. The canvas backing store is
    // already sized to clientWidth * dpr in the resize handler, so we just
    // need to scale the context by dpr before applying the pan/zoom transform.
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(width / (2 * dpr) + tx, height / (2 * dpr) + ty);
    ctx.scale(tk, tk);

    // R40 (UI-2): use the cached nodeMap instead of rebuilding it on every draw.
    // R49 (#9): batch edges into two passes (default + highlighted) to minimize
    // canvas state changes. The old code set strokeStyle/lineWidth PER EDGE,
    // forcing a state change each time — the #1 perf killer for large graphs.
    const nodeMap = nodeMapRef.current;
    // An empty Set is semantically the same as no selection. Treating it as
    // truthy used to dim every node and leave a phantom selection state.
    const activeHighlightedIds = highlightedIds && highlightedIds.size > 0
      ? highlightedIds
      : null;

    // Pass 1: default (non-highlighted) edges — single path, single stroke.
    ctx.strokeStyle = "rgba(100, 116, 139, 0.1)";
    ctx.lineWidth = 0.5 / tk;
    ctx.beginPath();
    for (const edge of edgesRef.current) {
      const sId = typeof edge.source === "number" ? edge.source : edge.source.id;
      const tId = typeof edge.target === "number" ? edge.target : edge.target.id;
      const source = nodeMap.get(sId);
      const target = nodeMap.get(tId);
      if (!source || !target) continue;
      if (activeHighlightedIds && (activeHighlightedIds.has(source.id) || activeHighlightedIds.has(target.id))) continue;
      ctx.moveTo(source.x ?? 0, source.y ?? 0);
      ctx.lineTo(target.x ?? 0, target.y ?? 0);
    }
    ctx.stroke();

    // Pass 2: highlighted edges — single path, single stroke.
    if (activeHighlightedIds) {
      ctx.strokeStyle = "rgba(6, 182, 212, 0.4)";
      ctx.lineWidth = 1 / tk;
      ctx.beginPath();
      for (const edge of edgesRef.current) {
        const sId = typeof edge.source === "number" ? edge.source : edge.source.id;
        const tId = typeof edge.target === "number" ? edge.target : edge.target.id;
        const source = nodeMap.get(sId);
        const target = nodeMap.get(tId);
        if (!source || !target) continue;
        if (!activeHighlightedIds.has(source.id) && !activeHighlightedIds.has(target.id)) continue;
        ctx.moveTo(source.x ?? 0, source.y ?? 0);
        ctx.lineTo(target.x ?? 0, target.y ?? 0);
      }
      ctx.stroke();
    }

    // Draw nodes
    for (const node of nodesRef.current) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const isHighlighted = activeHighlightedIds?.has(node.id) ?? false;
      const baseRadius = nodeRadius(node);
      const r = isHighlighted ? baseRadius * HIGHLIGHT_SCALE : baseRadius;

      const color = deadCodeView
        ? colorForStatus(node.status)
        : colorForLabel(node.label);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHighlighted ? "#06b6d4" : color;
      ctx.globalAlpha = activeHighlightedIds && !isHighlighted ? 0.3 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, [highlightedIds, deadCodeView]);

  // R40 (UI-3): sync drawRef AND immediately call the new draw. Previously
  // this was split into two effects: one to set drawRef.current, and a
  // separate one to call drawRef.current?.() when highlightedIds changed.
  // React runs effects in declaration order, so the redraw effect ran FIRST
  // (with the OLD drawRef) and the drawRef sync ran SECOND — too late. The
  // canvas was painted with stale highlights, and once the simulation cooled
  // down (no more ticks) the stale paint stayed until the next pan/zoom.
  // The fix: merge the redraw into the drawRef sync so the new draw is
  // always called AFTER being installed.
  useEffect(() => {
    drawRef.current = draw;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  // Canvas resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      // R31 (C1 fix): scale the backing store by devicePixelRatio for crisp
      // rendering on HiDPI/Retina displays. Without this, the canvas renders
      // at 1x and the browser stretches it to fill the CSS box, producing
      // blurry nodes and edges.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width = parent.clientWidth + 'px';
      canvas.style.height = parent.clientHeight + 'px';
      if (!hasAutoFitRef.current && !hasUserInteractedRef.current && fitVisibleGraph()) {
        hasAutoFitRef.current = true;
        cancelPendingAutoFit();
      } else {
        drawRef.current?.();
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, [cancelPendingAutoFit, fitVisibleGraph]);

  // Mouse and touch interaction (pan, zoom, click/tap, drag, pinch)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isPanning = false;
    let panStart = { x: 0, y: 0 };

    const getGraphPos = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      // R31 (C1 fix): use CSS pixels (rect dimensions) for mouse position,
      // not device pixels (canvas.width/height which are scaled by DPR).
      // The draw function already applies ctx.scale(dpr, dpr), so the
      // transform coordinates are in CSS pixel space.
      return {
        x: clientX - rect.left - rect.width / 2 - transformRef.current.x,
        y: clientY - rect.top - rect.height / 2 - transformRef.current.y,
      };
    };

    const findNodeAt = (mx: number, my: number): SimNode | null => {
      const k = transformRef.current.k;
      const scaledX = mx / k;
      const scaledY = my / k;
      for (const node of nodesRef.current) {
        const dx = (node.x ?? 0) - scaledX;
        const dy = (node.y ?? 0) - scaledY;
        const hitRadius = nodeRadius(node) * HIGHLIGHT_SCALE;
        if (dx * dx + dy * dy < hitRadius ** 2) return node;
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      const pos = getGraphPos(e.clientX, e.clientY);
      const node = findNodeAt(pos.x, pos.y);
      if (node) {
        dragRef.current = { node, startX: e.clientX, startY: e.clientY };
      } else {
        isPanning = true;
        panStart = { x: e.clientX - transformRef.current.x, y: e.clientY - transformRef.current.y };
      }
      // R40 (UI-5): bind mouseup to window for the duration of this drag/pan.
      // If the user releases the button off-canvas, the canvas never sees the
      // mouseup event, the drag never ends, and the simulation keeps running
      // at alphaTarget(0.3) forever (CPU leak). The window listener is removed
      // in onMouseUp.
      window.addEventListener("mouseup", onMouseUp);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (dragRef.current.node) {
        const k = transformRef.current.k;
        const pos = getGraphPos(e.clientX, e.clientY);
        dragRef.current.node.fx = pos.x / k;
        dragRef.current.node.fy = pos.y / k;
        simRef.current?.alphaTarget(0.3).restart();
      } else if (isPanning) {
        // R41 (UI-9): clamp pan to ±10× viewport so the graph can't be
        // dragged entirely off-screen with no recovery. 10× is generous
        // enough for legitimate deep-pan exploration but prevents the
        // "lost graph" UX where the only recovery was a page refresh.
        const rect = canvas.getBoundingClientRect();
        const maxX = rect.width * 10;
        const maxY = rect.height * 10;
        const rawX = e.clientX - panStart.x;
        const rawY = e.clientY - panStart.y;
        transformRef.current.x = Math.max(-maxX, Math.min(maxX, rawX));
        transformRef.current.y = Math.max(-maxY, Math.min(maxY, rawY));
        drawRef.current?.();
      } else {
        // Hover detection — pass the mouse position (relative to canvas) to the
        // parent so the tooltip can follow the cursor instead of being stuck at (12,12).
        // R40 (UI-4): only call onNodeHover when the hovered node id actually
        // changes. The previous code called onNodeHover on every mousemove,
        // which triggered setState in the parent (GraphTab) and re-rendered
        // the whole subtree (FilterPanel, Sidebar, NodeDetailPanel) on every
        // mouse move event — a continuous CPU drain.
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const pos = getGraphPos(e.clientX, e.clientY);
        const node = findNodeAt(pos.x, pos.y);
        const hoverId = node?.id ?? null;
        if (hoverId !== lastHoverIdRef.current) {
          lastHoverIdRef.current = hoverId;
          onNodeHoverRef.current(node ?? null, screenPos);
        }
        canvas.style.cursor = node ? "pointer" : "default";
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (dragRef.current.node) {
        const moved = Math.abs(e.clientX - dragRef.current.startX) + Math.abs(e.clientY - dragRef.current.startY);
        if (moved < 3 && dragRef.current.node) {
          onNodeClickRef.current(dragRef.current.node as GraphNode);
        }
        dragRef.current.node.fx = null;
        dragRef.current.node.fy = null;
        simRef.current?.alphaTarget(0);
      }
      dragRef.current.node = null;
      isPanning = false;
      // R40 (UI-5): remove the window-level mouseup listener added in
      // onMouseDown. Without this, listeners accumulate across drag sessions.
      window.removeEventListener("mouseup", onMouseUp);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const oldK = transformRef.current.k;
      const newK = Math.max(0.1, Math.min(10, oldK * delta));
      if (newK === oldK) return;

      // Zoom toward the mouse position so the point under the cursor stays fixed.
      // Without this, zooming is centered on the origin (0,0) which feels unnatural.
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      // R32 (B-new-1 fix): use rect.width/height (CSS pixels) instead of
      // canvas.width/height (device pixels = CSS * dpr). On HiDPI/Retina,
      // canvas.width is dpr× too large, throwing off the zoom-to-cursor math.
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const worldX = (mouseX - cx - transformRef.current.x) / oldK;
      const worldY = (mouseY - cy - transformRef.current.y) / oldK;
      transformRef.current.k = newK;
      transformRef.current.x = mouseX - cx - worldX * newK;
      transformRef.current.y = mouseY - cy - worldY * newK;
      drawRef.current?.();
    };

    type TouchMode = "none" | "node" | "pan" | "pinch";
    let touchMode: TouchMode = "none";
    let primaryTouchId: number | null = null;
    let touchStart = { x: 0, y: 0 };
    let touchMaxMovement = 0;
    let touchPanStart = { x: 0, y: 0 };
    let pinchStart: {
      distance: number;
      centerX: number;
      centerY: number;
      transform: { x: number; y: number; k: number };
    } | null = null;

    const releaseDraggedNode = () => {
      const node = dragRef.current.node;
      if (node) {
        node.fx = null;
        node.fy = null;
        simRef.current?.alphaTarget(0);
      }
      dragRef.current.node = null;
    };

    const getTouch = (touches: TouchList, identifier: number | null): Touch | null => {
      if (identifier == null) return null;
      for (let i = 0; i < touches.length; i += 1) {
        if (touches[i].identifier === identifier) return touches[i];
      }
      return null;
    };

    const getTouchPair = (touches: TouchList): [Touch, Touch] | null => {
      if (touches.length < 2) return null;
      return [touches[0], touches[1]];
    };

    const beginPanTouch = (touch: Touch) => {
      touchMode = "pan";
      primaryTouchId = touch.identifier;
      touchStart = { x: touch.clientX, y: touch.clientY };
      touchMaxMovement = 0;
      touchPanStart = {
        x: touch.clientX - transformRef.current.x,
        y: touch.clientY - transformRef.current.y,
      };
      pinchStart = null;
    };

    const beginPinch = (touches: TouchList) => {
      const pair = getTouchPair(touches);
      if (!pair) return;
      releaseDraggedNode();
      isPanning = false;
      const [first, second] = pair;
      const dx = second.clientX - first.clientX;
      const dy = second.clientY - first.clientY;
      touchMode = "pinch";
      primaryTouchId = null;
      pinchStart = {
        distance: Math.max(1, Math.hypot(dx, dy)),
        centerX: (first.clientX + second.clientX) / 2,
        centerY: (first.clientY + second.clientY) / 2,
        transform: { ...transformRef.current },
      };
    };

    const resetTouchState = () => {
      touchMode = "none";
      primaryTouchId = null;
      touchMaxMovement = 0;
      pinchStart = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();

      if (e.touches.length >= 2) {
        beginPinch(e.touches);
        return;
      }

      const touch = e.changedTouches[0] ?? e.touches[0];
      if (!touch) return;
      primaryTouchId = touch.identifier;
      touchStart = { x: touch.clientX, y: touch.clientY };
      touchMaxMovement = 0;
      const pos = getGraphPos(touch.clientX, touch.clientY);
      const node = findNodeAt(pos.x, pos.y);
      if (node) {
        touchMode = "node";
        dragRef.current = { node, startX: touch.clientX, startY: touch.clientY };
      } else {
        beginPanTouch(touch);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        if (touchMode !== "pinch" || !pinchStart) beginPinch(e.touches);
        const pair = getTouchPair(e.touches);
        if (!pair || !pinchStart) return;

        const [first, second] = pair;
        const distance = Math.max(1, Math.hypot(
          second.clientX - first.clientX,
          second.clientY - first.clientY,
        ));
        const centerX = (first.clientX + second.clientX) / 2;
        const centerY = (first.clientY + second.clientY) / 2;
        const rect = canvas.getBoundingClientRect();
        const canvasStartX = pinchStart.centerX - rect.left;
        const canvasStartY = pinchStart.centerY - rect.top;
        const canvasCenterX = centerX - rect.left;
        const canvasCenterY = centerY - rect.top;
        const viewportCenterX = rect.width / 2;
        const viewportCenterY = rect.height / 2;
        const startTransform = pinchStart.transform;
        const newK = Math.max(0.1, Math.min(10, startTransform.k * distance / pinchStart.distance));
        const worldX = (canvasStartX - viewportCenterX - startTransform.x) / startTransform.k;
        const worldY = (canvasStartY - viewportCenterY - startTransform.y) / startTransform.k;

        transformRef.current = {
          x: canvasCenterX - viewportCenterX - worldX * newK,
          y: canvasCenterY - viewportCenterY - worldY * newK,
          k: newK,
        };
        drawRef.current?.();
        return;
      }

      const touch = getTouch(e.touches, primaryTouchId);
      if (!touch) return;
      touchMaxMovement = Math.max(
        touchMaxMovement,
        Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y),
      );

      if (touchMode === "node" && dragRef.current.node) {
        const pos = getGraphPos(touch.clientX, touch.clientY);
        const k = transformRef.current.k;
        dragRef.current.node.fx = pos.x / k;
        dragRef.current.node.fy = pos.y / k;
        simRef.current?.alphaTarget(0.3).restart();
      } else if (touchMode === "pan") {
        const rect = canvas.getBoundingClientRect();
        const maxX = rect.width * 10;
        const maxY = rect.height * 10;
        const rawX = touch.clientX - touchPanStart.x;
        const rawY = touch.clientY - touchPanStart.y;
        transformRef.current.x = Math.max(-maxX, Math.min(maxX, rawX));
        transformRef.current.y = Math.max(-maxY, Math.min(maxY, rawY));
        drawRef.current?.();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (touchMode === "pinch") {
        if (e.touches.length >= 2) {
          beginPinch(e.touches);
        } else if (e.touches.length === 1) {
          // Continue naturally as a one-finger pan after one finger lifts.
          beginPanTouch(e.touches[0]);
        } else {
          resetTouchState();
        }
        return;
      }

      if (touchMode === "node") {
        const endedTouch = getTouch(e.changedTouches, primaryTouchId);
        if (!endedTouch && getTouch(e.touches, primaryTouchId)) return;
        if (endedTouch) {
          touchMaxMovement = Math.max(
            touchMaxMovement,
            Math.hypot(endedTouch.clientX - touchStart.x, endedTouch.clientY - touchStart.y),
          );
        }
        const node = dragRef.current.node;
        if (node && touchMaxMovement <= TOUCH_TAP_SLOP_PX) {
          onNodeClickRef.current(node as GraphNode);
        }
        releaseDraggedNode();
      }

      if (e.touches.length === 1) beginPanTouch(e.touches[0]);
      else resetTouchState();
    };

    const onTouchCancel = (e: TouchEvent) => {
      e.preventDefault();
      releaseDraggedNode();
      resetTouchState();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });
    canvas.addEventListener("touchcancel", onTouchCancel, { passive: false });
    // R40 (UI-5): do NOT bind mouseup to the canvas. If the user releases the
    // mouse button outside the canvas (common when dragging a node toward the
    // edge), the canvas never sees mouseup, the drag never ends, and the
    // simulation keeps running at alphaTarget(0.3) forever — a permanent CPU
    // drain. Instead, onMouseDown binds a one-shot window-level mouseup that
    // fires regardless of where the cursor is when the button is released.

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("mouseup", onMouseUp);
      releaseDraggedNode();
      resetTouchState();
    };
  }, [cancelPendingAutoFit]); // callbacks are accessed via refs; only the stable cancel helper is captured

  // Expose fit/reset/zoom without lifting transformRef out of the canvas.
  useImperativeHandle(ref, () => ({
    fitView: () => {
      hasUserInteractedRef.current = true;
      hasAutoFitRef.current = true;
      cancelPendingAutoFit();
      if (!fitVisibleGraph()) {
        transformRef.current = { x: 0, y: 0, k: 1 };
        drawRef.current?.();
      }
    },
    resetView: () => {
      hasUserInteractedRef.current = true;
      hasAutoFitRef.current = true;
      cancelPendingAutoFit();
      if (!fitVisibleGraph()) {
        transformRef.current = { x: 0, y: 0, k: 1 };
        drawRef.current?.();
      }
    },
    zoomBy: (factor: number) => {
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      const newK = Math.max(0.1, Math.min(10, transformRef.current.k * factor));
      transformRef.current.k = newK;
      drawRef.current?.();
    },
  }), [cancelPendingAutoFit, fitVisibleGraph]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: "#06090f", cursor: "default", touchAction: "none" }}
      role="img"
      aria-label={`Code graph: ${data?.nodes.length ?? 0} nodes, ${data?.edges.length ?? 0} edges. Drag to pan, scroll or pinch to zoom, click or tap a node for details.`}
    />
  );
});
