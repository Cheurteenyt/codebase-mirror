// graph-ui/src/components/GraphCanvas.tsx
// V2: 2D canvas-based graph renderer using d3-force.
// Replaces V1's 3D Three.js scene with a cleaner, more readable 2D layout.
// Advantages: no GPU needed, handles 5000+ nodes, simpler interaction.

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from "d3-force";
import type { GraphData, GraphNode } from "../lib/types";
import { colorForLabel, colorForStatus } from "../lib/colors";

/**
 * R41 (UI-9): imperative handle exposed by GraphCanvas. Lets the parent
 * (GraphTab) wire a "Reset view" button without lifting transformRef out
 * of the canvas (which would break encapsulation and re-introduce re-renders).
 */
export interface GraphCanvasHandle {
  /** Reset pan to (0,0) and zoom to 1×. */
  resetView: () => void;
  /** Zoom in/out by a factor (e.g. 1.2 to zoom in, 0.83 to zoom out). */
  zoomBy: (factor: number) => void;
}

interface GraphCanvasProps {
  data: GraphData;
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

const NODE_RADIUS = 4;
const LINK_DISTANCE = 30;
const CHARGE_STRENGTH = -80;
const COLLIDE_RADIUS = 8;

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas({
  data,
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
  // The fix: reuse the existing simulation. Preserve x/y/vx/vy for nodes
  // that already exist (so they keep their layout positions), feed the new
  // nodes/edges to the existing sim, and reheat with alpha=0.3 (gentle
  // re-layout) instead of alpha=1 (full restart).
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
      drawRef.current?.();
      return;
    }

    // Preserve positions for nodes that already exist in the previous array.
    const prev = new Map<number, SimNode>();
    for (const n of nodesRef.current) prev.set(n.id, n);
    const nodes: SimNode[] = data.nodes.map((n) => {
      const p = prev.get(n.id);
      // Keep physics state (x/y/vx/vy) and any drag-anchored fx/fy.
      if (p) return { ...n, x: p.x, y: p.y, vx: p.vx, vy: p.vy, fx: p.fx, fy: p.fy };
      return { ...n };
    });
    const edges: SimEdge[] = data.edges.map((e) => ({ ...e }));

    nodesRef.current = nodes;
    edgesRef.current = edges;
    // Rebuild the nodeMap cache (used by draw()).
    const map = new Map<number, SimNode>();
    for (const n of nodes) map.set(n.id, n);
    nodeMapRef.current = map;

    if (simRef.current) {
      // Reuse existing simulation — swap nodes/edges and reheat gently.
      simRef.current.nodes(nodes);
      (simRef.current.force("link") as any).links(edges);
      simRef.current.alpha(0.3).restart();
    } else {
      const sim = forceSimulation(nodes)
        .force("charge", forceManyBody().strength(CHARGE_STRENGTH))
        .force(
          "link",
          forceLink<SimNode, SimEdge>(edges)
            .id((d) => d.id)
            .distance(LINK_DISTANCE)
            .strength(0.3),
        )
        .force("center", forceCenter(0, 0))
        .force("collide", forceCollide(COLLIDE_RADIUS))
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
    // No cleanup here — the sim is preserved across data changes. Cleanup is
    // handled by the unmount-only effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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
      if (simRef.current) {
        simRef.current.on("tick", null);
        simRef.current.stop();
        simRef.current = null;
      }
    };
  }, []);

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
    const nodeMap = nodeMapRef.current;
    ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
    ctx.lineWidth = 0.5 / tk;
    for (const edge of edgesRef.current) {
      const sId = typeof edge.source === "number" ? edge.source : edge.source.id;
      const tId = typeof edge.target === "number" ? edge.target : edge.target.id;
      const source = nodeMap.get(sId);
      const target = nodeMap.get(tId);
      if (!source || !target) continue;

      // Highlight edges connected to highlighted nodes
      if (highlightedIds && (highlightedIds.has(source.id) || highlightedIds.has(target.id))) {
        ctx.strokeStyle = "rgba(6, 182, 212, 0.4)";
        ctx.lineWidth = 1 / tk;
      } else {
        ctx.strokeStyle = "rgba(100, 116, 139, 0.1)";
        ctx.lineWidth = 0.5 / tk;
      }

      ctx.beginPath();
      ctx.moveTo(source.x ?? 0, source.y ?? 0);
      ctx.lineTo(target.x ?? 0, target.y ?? 0);
      ctx.stroke();
    }

    // Draw nodes
    for (const node of nodesRef.current) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const isHighlighted = highlightedIds?.has(node.id) ?? false;
      const r = isHighlighted ? NODE_RADIUS * 1.5 : NODE_RADIUS;

      const color = deadCodeView
        ? colorForStatus(node.status)
        : colorForLabel(node.label);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHighlighted ? "#06b6d4" : color;
      ctx.globalAlpha = highlightedIds && !isHighlighted ? 0.3 : 1;
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
      drawRef.current?.();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse interaction (pan, zoom, click, drag)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isPanning = false;
    let panStart = { x: 0, y: 0 };

    const getMousePos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      // R31 (C1 fix): use CSS pixels (rect dimensions) for mouse position,
      // not device pixels (canvas.width/height which are scaled by DPR).
      // The draw function already applies ctx.scale(dpr, dpr), so the
      // transform coordinates are in CSS pixel space.
      return {
        x: e.clientX - rect.left - rect.width / 2 - transformRef.current.x,
        y: e.clientY - rect.top - rect.height / 2 - transformRef.current.y,
      };
    };

    const findNodeAt = (mx: number, my: number): SimNode | null => {
      const k = transformRef.current.k;
      const scaledX = mx / k;
      const scaledY = my / k;
      for (const node of nodesRef.current) {
        const dx = (node.x ?? 0) - scaledX;
        const dy = (node.y ?? 0) - scaledY;
        if (dx * dx + dy * dy < (NODE_RADIUS * 1.5) ** 2) return node;
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      const pos = getMousePos(e);
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
        const pos = getMousePos(e);
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
        const pos = getMousePos(e);
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

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("wheel", onWheel, { passive: false });
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
      window.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — callbacks accessed via refs, no re-binding needed

  // R41 (UI-9): expose imperative resetView/zoomBy so GraphTab can wire a
  // "Reset view" button without lifting transformRef out of the canvas.
  useImperativeHandle(ref, () => ({
    resetView: () => {
      transformRef.current = { x: 0, y: 0, k: 1 };
      drawRef.current?.();
    },
    zoomBy: (factor: number) => {
      const newK = Math.max(0.1, Math.min(10, transformRef.current.k * factor));
      transformRef.current.k = newK;
      drawRef.current?.();
    },
  }), []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: "#06090f", cursor: "default" }}
      role="img"
      aria-label={`Code graph: ${data?.nodes.length ?? 0} nodes, ${data?.edges.length ?? 0} edges. Drag to pan, scroll to zoom, click a node for details.`}
    />
  );
});
