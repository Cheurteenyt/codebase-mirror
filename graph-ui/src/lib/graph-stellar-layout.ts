import { stellarNodeDegree } from "./graph-visual-mode";
import type { GraphEdge, GraphNode } from "./types";

export type StellarFlowRole =
  | "focus"
  | "incoming"
  | "outgoing"
  | "bidirectional"
  | "hub"
  | "context";

export interface StellarFlowTarget {
  x: number;
  y: number;
  role: StellarFlowRole;
  depth: number | null;
}

const GOLDEN_FRACTION = 0.6180339887498949;
const FLOW_COLUMN_GAP = 180;
const MAX_FLOW_DEPTH = 4;
const MIN_CONTEXT_RADIUS = 520;

function groupKey(node: GraphNode): string {
  if (node.cluster_id != null) return `cluster:${node.cluster_id}`;
  const path = node.file_path?.replaceAll("\\", "/");
  const topLevel = path?.split("/").find(Boolean);
  return topLevel ? `path:${topLevel}` : `type:${node.label}`;
}

function stableFraction(value: number): number {
  // Integer multiplication keeps the fallback angle stable without allocating
  // a PRNG or depending on array insertion order.
  return ((Math.imul(value, 2_654_435_761) >>> 0) / 4_294_967_296);
}

function byImportance(left: GraphNode, right: GraphNode): number {
  return stellarNodeDegree(right) - stellarNodeDegree(left) || left.id - right.id;
}

function computeConstellation(nodes: readonly GraphNode[]): Map<number, StellarFlowTarget> {
  const targets = new Map<number, StellarFlowTarget>();
  if (nodes.length === 0) return targets;

  const maxDegree = nodes.reduce(
    (maximum, node) => Math.max(maximum, stellarNodeDegree(node)),
    1,
  );
  const maxRadius = Math.max(360, Math.min(760, 340 + Math.sqrt(nodes.length) * 12));
  const hubThreshold = Math.max(18, maxDegree * 0.18);
  const grouped = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = groupKey(node);
    const group = grouped.get(key);
    if (group) group.push(node);
    else grouped.set(key, [node]);
  }

  const groups = [...grouped.entries()]
    .map(([key, members]) => ({
      key,
      members: members.sort(byImportance),
      peakDegree: members.reduce(
        (maximum, member) => Math.max(maximum, stellarNodeDegree(member)),
        0,
      ),
      weight: Math.sqrt(members.length),
    }))
    .sort((left, right) => (
      right.peakDegree - left.peakDegree
      || right.members.length - left.members.length
      || left.key.localeCompare(right.key)
    ));
  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
  let sectorStart = -Math.PI / 2;

  for (const group of groups) {
    const sectorSpan = Math.PI * 2 * group.weight / totalWeight;
    for (let index = 0; index < group.members.length; index += 1) {
      const node = group.members[index];
      const degree = stellarNodeDegree(node);
      const importance = Math.log1p(degree) / Math.log1p(maxDegree);
      const radius = 48
        + Math.pow(1 - importance, 1.35) * (maxRadius - 48)
        + ((index % 5) - 2) * 4;
      const withinSector = 0.1 + 0.8 * ((index * GOLDEN_FRACTION + stableFraction(node.id)) % 1);
      const angle = sectorStart + sectorSpan * withinSector;
      targets.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.82,
        role: degree >= hubThreshold ? "hub" : "context",
        depth: null,
      });
    }
    sectorStart += sectorSpan;
  }

  return targets;
}

function breadthFirstDepths(
  startId: number,
  adjacency: ReadonlyMap<number, readonly number[]>,
): Map<number, number> {
  const depths = new Map<number, number>([[startId, 0]]);
  let frontier = [startId];
  for (let depth = 1; depth <= MAX_FLOW_DEPTH && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const neighbor of adjacency.get(current) ?? []) {
        if (depths.has(neighbor)) continue;
        depths.set(neighbor, depth);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return depths;
}

function lanePosition(index: number, count: number): { x: number; y: number } {
  // A single high-fanout column can otherwise become tens of thousands of
  // pixels tall. Pack each directed depth into a bounded grid while preserving
  // its left/right ordering; d3 collision performs the final local relaxation.
  const columns = Math.max(1, Math.ceil(Math.sqrt(count / 2)));
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const columnSpacing = columns <= 1 ? 0 : Math.min(30, 130 / (columns - 1));
  const rowSpacing = rows <= 1 ? 0 : Math.max(18, Math.min(48, 760 / (rows - 1)));
  return {
    x: (column - (columns - 1) / 2) * columnSpacing,
    y: (row - (rows - 1) / 2) * rowSpacing,
  };
}

/**
 * Produce stable target coordinates for the shared d3 simulation.
 *
 * With no focus, exact-degree hubs occupy the center and directory communities
 * retain angular sectors. With a selected node, visible directed distances are
 * unfolded into incoming (left) and outgoing (right) layers; unrelated nodes
 * remain as a dim outer context instead of disappearing.
 */
export function computeStellarFlowLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  selectedNodeId: number | null,
): Map<number, StellarFlowTarget> {
  const constellation = computeConstellation(nodes);
  if (selectedNodeId == null || !constellation.has(selectedNodeId)) return constellation;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue;
    const outgoingNeighbors = outgoing.get(edge.source);
    if (outgoingNeighbors) outgoingNeighbors.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
    const incomingNeighbors = incoming.get(edge.target);
    if (incomingNeighbors) incomingNeighbors.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
  }

  const incomingDepths = breadthFirstDepths(selectedNodeId, incoming);
  const outgoingDepths = breadthFirstDepths(selectedNodeId, outgoing);
  const layers = new Map<string, GraphNode[]>();
  const roles = new Map<number, { role: StellarFlowRole; depth: number }>();

  for (const node of nodes) {
    if (node.id === selectedNodeId) continue;
    const incomingDepth = incomingDepths.get(node.id);
    const outgoingDepth = outgoingDepths.get(node.id);
    let role: StellarFlowRole | null = null;
    let depth = 0;
    if (incomingDepth != null && outgoingDepth != null) {
      if (incomingDepth === outgoingDepth) {
        role = "bidirectional";
        depth = incomingDepth;
      } else if (incomingDepth < outgoingDepth) {
        role = "incoming";
        depth = incomingDepth;
      } else {
        role = "outgoing";
        depth = outgoingDepth;
      }
    } else if (incomingDepth != null) {
      role = "incoming";
      depth = incomingDepth;
    } else if (outgoingDepth != null) {
      role = "outgoing";
      depth = outgoingDepth;
    }
    if (!role || depth === 0) continue;
    roles.set(node.id, { role, depth });
    const key = `${role}:${depth}`;
    const layer = layers.get(key);
    if (layer) layer.push(node);
    else layers.set(key, [node]);
  }

  for (const [key, layer] of layers) {
    layer.sort(byImportance);
    const [role, rawDepth] = key.split(":") as [StellarFlowRole, string];
    const depth = Number(rawDepth);
    for (let index = 0; index < layer.length; index += 1) {
      const node = layer[index];
      const side = role === "incoming" ? -1 : role === "outgoing" ? 1 : 0;
      const lane = lanePosition(index, layer.length);
      const bidirectionalOffset = role === "bidirectional"
        ? (index % 2 === 0 ? -1 : 1) * (80 + depth * 28)
        : 0;
      constellation.set(node.id, {
        x: side * depth * FLOW_COLUMN_GAP + bidirectionalOffset + lane.x,
        y: lane.y,
        role,
        depth,
      });
    }
  }

  for (const node of nodes) {
    if (node.id === selectedNodeId || roles.has(node.id)) continue;
    const current = constellation.get(node.id)!;
    const currentRadius = Math.hypot(current.x, current.y);
    const angle = currentRadius > 0
      ? Math.atan2(current.y, current.x)
      : stableFraction(node.id) * Math.PI * 2;
    const radius = Math.max(MIN_CONTEXT_RADIUS, currentRadius * 1.16);
    constellation.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.82,
      role: "context",
      depth: null,
    });
  }

  constellation.set(selectedNodeId, { x: 0, y: 0, role: "focus", depth: 0 });
  return constellation;
}
