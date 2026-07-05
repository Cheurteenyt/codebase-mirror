// graph-ui/src/components/GraphCanvas.tsx
// V2: 2D canvas-based graph renderer using d3-force.
// Replaces V1's 3D Three.js scene with a cleaner, more readable 2D layout.
// Advantages: no GPU needed, handles 5000+ nodes, simpler interaction.

import { useEffect, useRef, useCallback } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from "d3-force";
import type { GraphData, GraphNode } from "../lib/types";
import { colorForLabel, colorForStatus } from "../lib/colors";

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

export function GraphCanvas({
  data,
  highlightedIds,
  deadCodeView,
  onNodeClick,
  onNodeHover,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const drawRef = useRef<(() => void) | null>(null);

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

  // Initialize simulation when data changes
  useEffect(() => {
    if (!data || data.nodes.length === 0) return;

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const edges: SimEdge[] = data.edges.map((e) => ({ ...e }));

    nodesRef.current = nodes;
    edgesRef.current = edges;

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

    sim.on("tick", () => {
      drawRef.current?.();
    });

    simRef.current = sim as any;

    return () => {
      sim.on("tick", null);
      sim.stop();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Redraw when highlights or dead-code view changes
  useEffect(() => {
    drawRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedIds, deadCodeView]);

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

    // Draw edges — forceLink mutates source/target into object refs, so handle both.
    const nodeMap = new Map<number, SimNode>();
    for (const n of nodesRef.current) nodeMap.set(n.id, n);
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

  // Sync drawRef AFTER draw is declared (avoids TDZ — draw is a block-scoped
  // const that can't be referenced before its declaration line).
  useEffect(() => { drawRef.current = draw; }, [draw]);

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
    };

    const onMouseMove = (e: MouseEvent) => {
      if (dragRef.current.node) {
        const k = transformRef.current.k;
        const pos = getMousePos(e);
        dragRef.current.node.fx = pos.x / k;
        dragRef.current.node.fy = pos.y / k;
        simRef.current?.alphaTarget(0.3).restart();
      } else if (isPanning) {
        transformRef.current.x = e.clientX - panStart.x;
        transformRef.current.y = e.clientY - panStart.y;
        drawRef.current?.();
      } else {
        // Hover detection — pass the mouse position (relative to canvas) to the
        // parent so the tooltip can follow the cursor instead of being stuck at (12,12).
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const pos = getMousePos(e);
        const node = findNodeAt(pos.x, pos.y);
        onNodeHoverRef.current(node ?? null, screenPos);
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
      // World point under the mouse BEFORE zoom:
      //   worldX = (mouseX - width/2 - tx) / oldK
      // After zoom, we want:  mouseX - width/2 = worldX * newK + tx_new
      // Solving for tx_new:   tx_new = mouseX - width/2 - worldX * newK
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const worldX = (mouseX - cx - transformRef.current.x) / oldK;
      const worldY = (mouseY - cy - transformRef.current.y) / oldK;
      transformRef.current.k = newK;
      transformRef.current.x = mouseX - cx - worldX * newK;
      transformRef.current.y = mouseY - cy - worldY * newK;
      drawRef.current?.();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — callbacks accessed via refs, no re-binding needed

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: "#06090f", cursor: "default" }}
    />
  );
}
