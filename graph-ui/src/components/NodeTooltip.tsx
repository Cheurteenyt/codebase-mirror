// V2 NodeTooltip — plain HTML div, no Three.js.
// Positioned via absolute CSS based on mouse position (set by GraphCanvas).
//
// R40 (UI-12): flip the tooltip when near the right/bottom edge of the
// viewport so it doesn't get clipped. Previously the offset was hard-coded
// to (x+12, y+12), which sent the tooltip off-screen when the cursor was
// near the right or bottom of the canvas.

import { useRef, useLayoutEffect, useState } from "react";
import type { GraphNode } from "../lib/types";

interface NodeTooltipProps {
  node: GraphNode;
  x?: number;
  y?: number;
}

export function NodeTooltip({ node, x = 0, y = 0 }: NodeTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Measured size of the tooltip — used to decide whether to flip the offset.
  // Falls back to a conservative estimate (220×64) before the first measurement.
  const [size, setSize] = useState({ w: 220, h: 64 });
  const [bounds, setBounds] = useState({ w: 1920, h: 1080 });

  useLayoutEffect(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
      const parent = ref.current.parentElement?.getBoundingClientRect();
      if (parent && parent.width > 0 && parent.height > 0) {
        setBounds({ w: parent.width, h: parent.height });
      }
    }
  }, [node.name, node.label, node.file_path, node.risk_score, node.notes_count]);

  const OFFSET = 12;
  const MARGIN = 8; // keep at least 8px from the viewport edge
  const flipX = x + OFFSET + size.w > bounds.w - MARGIN;
  const flipY = y + OFFSET + size.h > bounds.h - MARGIN;

  const left = flipX ? x - OFFSET - size.w : x + OFFSET;
  const top = flipY ? y - OFFSET - size.h : y + OFFSET;

  return (
    <div
      ref={ref}
      className="absolute pointer-events-none z-20 bg-[#0b1920] border border-border/50 rounded-lg px-3 py-2 text-[11px] shadow-xl"
      style={{ left, top }}
    >
      <p className="font-medium text-foreground/80">{node.name}</p>
      <p className="text-foreground/40 text-[10px] mt-0.5">
        {node.label} · {node.file_path ?? "unknown"}
      </p>
      {node.risk_score != null && (
        <p className="text-foreground/30 text-[10px] mt-0.5">
          Risk: {(node.risk_score * 100).toFixed(0)}% · Notes: {node.notes_count ?? 0}
        </p>
      )}
    </div>
  );
}
