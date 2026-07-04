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
  onNodeHover: (node: GraphNode | null) => void;
}

interface SimNode extends GraphNode {
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: number;
  target: number;
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
      draw();
    });

    simRef.current = sim;

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Redraw when highlights or dead-code view changes
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedIds, deadCodeView]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    const { x: tx, y: ty, k: tk } = transformRef.current;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2 + tx, height / 2 + ty);
    ctx.scale(tk, tk);

    // Draw edges
    ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
    ctx.lineWidth = 0.5 / tk;
    for (const edge of edgesRef.current) {
      const source = nodesRef.current.find((n) => n.id === edge.source);
      const target = nodesRef.current.find((n) => n.id === edge.target);
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

  // Canvas resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
      draw();
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
      return {
        x: e.clientX - rect.left - canvas.width / 2 - transformRef.current.x,
        y: e.clientY - rect.top - canvas.height / 2 - transformRef.current.y,
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
        draw();
      } else {
        // Hover detection
        const pos = getMousePos(e);
        const node = findNodeAt(pos.x, pos.y);
        onNodeHover(node ?? null);
        canvas.style.cursor = node ? "pointer" : "default";
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (dragRef.current.node) {
        const moved = Math.abs(e.clientX - dragRef.current.startX) + Math.abs(e.clientY - dragRef.current.startY);
        if (moved < 3 && dragRef.current.node) {
          onNodeClick(dragRef.current.node as GraphNode);
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
      const newK = Math.max(0.1, Math.min(10, transformRef.current.k * delta));
      transformRef.current.k = newK;
      draw();
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
  }, [draw, onNodeClick, onNodeHover]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: "#06090f", cursor: "default" }}
    />
  );
}
