// V2 NodeTooltip — plain HTML div, no Three.js.
// Positioned via absolute CSS based on mouse position (set by GraphCanvas).

import type { GraphNode } from "../lib/types";

interface NodeTooltipProps {
  node: GraphNode;
  x?: number;
  y?: number;
}

export function NodeTooltip({ node, x = 0, y = 0 }: NodeTooltipProps) {
  return (
    <div
      className="absolute pointer-events-none z-20 bg-[#0b1920] border border-border/50 rounded-lg px-3 py-2 text-[11px] shadow-xl"
      style={{ left: x + 12, top: y + 12 }}
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
