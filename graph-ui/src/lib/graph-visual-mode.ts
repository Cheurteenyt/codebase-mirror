import type { GraphNode } from "./types";

export type GraphVisualMode = "architecture" | "stellar";
export type StellarNodeGlyph = "circle" | "diamond" | "square";

export const GRAPH_VISUAL_MODE_STORAGE_KEY = "cbm-graph-visual-mode";

export function loadGraphVisualMode(): GraphVisualMode {
  try {
    return localStorage.getItem(GRAPH_VISUAL_MODE_STORAGE_KEY) === "stellar"
      ? "stellar"
      : "architecture";
  } catch {
    return "architecture";
  }
}

export function saveGraphVisualMode(mode: GraphVisualMode): void {
  try {
    localStorage.setItem(GRAPH_VISUAL_MODE_STORAGE_KEY, mode);
  } catch {
    // Persistence is optional; rendering still works with restricted storage.
  }
}

export function stellarNodeDegree(node: Pick<GraphNode, "in_degree" | "out_degree" | "size">): number {
  const hasExactDegree = Number.isFinite(node.in_degree) || Number.isFinite(node.out_degree);
  if (hasExactDegree) {
    const incoming = Number.isFinite(node.in_degree) ? node.in_degree! : 0;
    const outgoing = Number.isFinite(node.out_degree) ? node.out_degree! : 0;
    return Math.max(0, incoming + outgoing);
  }

  // Compatibility fallback for older layout producers. Current V2 responses
  // provide exact split degrees and derive size as sqrt(degree) + 3.
  const size = Number(node.size);
  return Number.isFinite(size) ? Math.round(Math.max(0, size - 3) ** 2) : 0;
}

/**
 * V1's useful degree-at-a-glance signal, retained inside the V2 task view.
 * The thresholds match the reference spectral scale, while topology,
 * selection, status and exactness remain V2 contracts.
 */
export function stellarNodeColor(node: Pick<GraphNode, "in_degree" | "out_degree" | "size">): string {
  const degree = stellarNodeDegree(node);
  if (degree <= 1) return "#ff6050";
  if (degree <= 3) return "#ff8855";
  if (degree <= 5) return "#ffa060";
  if (degree <= 8) return "#ffc070";
  if (degree <= 12) return "#ffe080";
  if (degree <= 18) return "#fff0c0";
  if (degree <= 25) return "#fff8e8";
  if (degree <= 35) return "#e8e8ff";
  if (degree <= 50) return "#c0d0ff";
  return "#80a0ff";
}

export function stellarNodeGlyph(label: string): StellarNodeGlyph {
  if (/^(?:class|interface|type|enum|trait)$/iu.test(label)) return "diamond";
  if (/^(?:file|folder|module|section|project|package)$/iu.test(label)) return "square";
  return "circle";
}
