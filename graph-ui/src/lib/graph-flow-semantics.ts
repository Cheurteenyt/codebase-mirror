import type { GraphEdge } from "./types";

export const GRAPH_EDGE_GROUP_ORDER = ["calls", "imports", "contains", "data", "other"] as const;
export type GraphEdgeGroup = (typeof GRAPH_EDGE_GROUP_ORDER)[number];

/**
 * One bounded grammar shared by Canvas and the DOM legend. Color is only one
 * channel: every group also owns a distinct dash pattern and text glyph.
 */
export const GRAPH_EDGE_GROUP_META: Record<GraphEdgeGroup, {
  label: string;
  stroke: string;
  dash: readonly number[];
}> = {
  calls: {
    label: "Calls",
    stroke: "rgba(34, 211, 238, 0.72)",
    dash: [],
  },
  imports: {
    label: "Imports",
    stroke: "rgba(251, 191, 36, 0.68)",
    dash: [7, 4],
  },
  contains: {
    label: "Contains",
    stroke: "rgba(167, 139, 250, 0.7)",
    dash: [2, 4],
  },
  data: {
    label: "Data",
    stroke: "rgba(52, 211, 153, 0.68)",
    dash: [8, 3, 2, 3],
  },
  other: {
    label: "Other",
    stroke: "rgba(148, 163, 184, 0.62)",
    dash: [1, 5],
  },
};

export function graphEdgeGroup(type: string): GraphEdgeGroup {
  const normalized = type.toLowerCase();
  if (normalized.includes("call")) return "calls";
  if (normalized.includes("contain") || normalized.includes("define") || normalized.includes("member")) return "contains";
  if (normalized.includes("import") || normalized.includes("use") || normalized.includes("depend")) return "imports";
  if (normalized.includes("read") || normalized.includes("write") || normalized.includes("data")) return "data";
  return "other";
}

export function summarizeSelectedEdgeGroups(
  edges: readonly GraphEdge[],
  selectedNodeId: number | null,
): Array<{ group: GraphEdgeGroup; count: number }> {
  if (selectedNodeId == null) return [];
  const counts = new Map<GraphEdgeGroup, number>();
  for (const edge of edges) {
    if (edge.source !== selectedNodeId && edge.target !== selectedNodeId) continue;
    const group = graphEdgeGroup(edge.type);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return GRAPH_EDGE_GROUP_ORDER.flatMap((group) => {
    const count = counts.get(group);
    return count ? [{ group, count }] : [];
  });
}
