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
  /** Stable directory lane used only by the focused flow disclosure. */
  laneKey: string | null;
  /** Shared top-level sector; rendering can summarize it without regrouping nodes. */
  sector: { key: string; start: number; span: number } | null;
}

export interface StellarConstellationSummary {
  key: string;
  start: number;
  span: number;
  mid: number;
  count: number;
}

type DirectedFlowRole = Extract<StellarFlowRole, "incoming" | "outgoing" | "bidirectional">;

export interface StellarFlowLaneSummary {
  role: DirectedFlowRole;
  depth: number;
  count: number;
  x: number;
  minY: number;
  maxY: number;
}

export interface StellarFlowModuleSummary extends StellarFlowLaneSummary {
  laneKey: string;
}

const FLOW_COLUMN_GAP = 180;
const MAX_FLOW_DEPTH = 4;
const MIN_CONTEXT_RADIUS = 520;
const CONSTELLATION_Y_SCALE = 0.82;
const CONSTELLATION_FAMILY_GAP = 0.13;

function rawConstellationKey(node: GraphNode): string {
  const path = node.file_path?.replaceAll("\\", "/");
  const topLevel = path?.split("/").find(Boolean);
  return topLevel ?? "unmapped";
}

function constellationGroupKey(node: GraphNode): string {
  return node.cluster_id != null ? `cluster:${node.cluster_id}` : `type:${node.label}`;
}

function flowLaneKey(node: GraphNode): string {
  const parts = node.file_path?.replaceAll("\\", "/").split("/").filter(Boolean) ?? [];
  if (parts.length <= 1) return parts[0] ?? node.label;
  return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
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
  const rawFamilyCounts = new Map<string, number>();
  for (const node of nodes) {
    const key = rawConstellationKey(node);
    rawFamilyCounts.set(key, (rawFamilyCounts.get(key) ?? 0) + 1);
  }
  const minimumFamilySize = Math.max(4, Math.ceil(nodes.length * 0.015));
  const collapseSmallFamilies = rawFamilyCounts.size > 1;
  const groupedFamilies = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const rawFamily = rawConstellationKey(node);
    const familyKey = collapseSmallFamilies
      && (rawFamilyCounts.get(rawFamily) ?? 0) < minimumFamilySize
      ? "other"
      : rawFamily;
    const family = groupedFamilies.get(familyKey);
    if (family) family.push(node);
    else groupedFamilies.set(familyKey, [node]);
  }

  const families = [...groupedFamilies.entries()]
    .map(([key, members]) => ({
      key,
      members: members.sort((left, right) => (
        constellationGroupKey(left).localeCompare(constellationGroupKey(right))
        || byImportance(left, right)
      )),
      weight: Math.sqrt(members.length),
    }))
    .sort((left, right) => (
      Number(left.key === "other") - Number(right.key === "other")
      || right.members.length - left.members.length
      || left.key.localeCompare(right.key)
    ));
  const totalWeight = families.reduce((sum, family) => sum + family.weight, 0);
  const familyGap = families.length > 1
    ? Math.min(CONSTELLATION_FAMILY_GAP, Math.PI / (families.length * 3))
    : 0;
  const drawableSpan = Math.PI * 2 - familyGap * families.length;
  let familyStart = -Math.PI / 2 + familyGap / 2;

  for (const family of families) {
    const familySpan = drawableSpan * family.weight / totalWeight;
    const sector = { key: family.key, start: familyStart, span: familySpan };
    for (let index = 0; index < family.members.length; index += 1) {
      const node = family.members[index];
      const degree = stellarNodeDegree(node);
      const importance = Math.log1p(degree) / Math.log1p(maxDegree);
      const radius = 48
        + Math.pow(1 - importance, 1.35) * (maxRadius - 48)
        + ((index % 5) - 2) * 4;
      const orderedPosition = (index + 0.5) / family.members.length;
      const jitter = (stableFraction(node.id) - 0.5)
        * Math.min(0.015, 0.5 / family.members.length);
      const angle = familyStart + familySpan * (0.06 + 0.88 * (orderedPosition + jitter));
      targets.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * CONSTELLATION_Y_SCALE,
        role: degree >= hubThreshold ? "hub" : "context",
        depth: null,
        laneKey: null,
        sector,
      });
    }
    familyStart += familySpan + familyGap;
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
    layer.sort((left, right) => (
      flowLaneKey(left).localeCompare(flowLaneKey(right))
      || byImportance(left, right)
    ));
    const [role, rawDepth] = key.split(":") as [StellarFlowRole, string];
    const depth = Number(rawDepth);
    for (let index = 0; index < layer.length; index += 1) {
      const node = layer[index];
      const current = constellation.get(node.id)!;
      const side = role === "incoming" ? -1 : role === "outgoing" ? 1 : 0;
      const lane = lanePosition(index, layer.length);
      const bidirectionalOffset = role === "bidirectional"
        ? (index % 2 === 0 ? -1 : 1) * (80 + depth * 28)
        : 0;
      constellation.set(node.id, {
        // Preserve the first-hop separation, then compress distant depths so
        // a four-hop frame stays legible beside the detail panel.
        x: side * depth ** 0.82 * FLOW_COLUMN_GAP + bidirectionalOffset + lane.x,
        y: lane.y,
        role,
        depth,
        laneKey: flowLaneKey(node),
        sector: current.sector,
      });
    }
  }

  for (const node of nodes) {
    if (node.id === selectedNodeId || roles.has(node.id)) continue;
    const current = constellation.get(node.id)!;
    const currentRadius = Math.hypot(current.x, current.y / CONSTELLATION_Y_SCALE);
    const angle = currentRadius > 0
      ? Math.atan2(current.y / CONSTELLATION_Y_SCALE, current.x)
      : stableFraction(node.id) * Math.PI * 2;
    const radius = Math.max(MIN_CONTEXT_RADIUS, currentRadius * 1.16);
    constellation.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * CONSTELLATION_Y_SCALE,
      role: "context",
      depth: null,
      laneKey: null,
      sector: current.sector,
    });
  }

  const selectedConstellation = constellation.get(selectedNodeId)!;
  constellation.set(selectedNodeId, {
    x: 0,
    y: 0,
    role: "focus",
    depth: 0,
    laneKey: null,
    sector: selectedConstellation.sector,
  });
  return constellation;
}

/** Summarize precomputed top-level sectors without regrouping graph nodes. */
export function summarizeStellarConstellation(
  targets: ReadonlyMap<number, StellarFlowTarget>,
): { sectors: StellarConstellationSummary[]; radius: number } {
  const summaries = new Map<string, StellarConstellationSummary>();
  let maxRadius = 0;
  for (const target of targets.values()) {
    if (!target.sector) continue;
    const radius = Math.hypot(target.x, target.y / CONSTELLATION_Y_SCALE);
    maxRadius = Math.max(maxRadius, radius);
    const current = summaries.get(target.sector.key);
    if (current) {
      current.count += 1;
      continue;
    }
    summaries.set(target.sector.key, {
      ...target.sector,
      mid: target.sector.start + target.sector.span / 2,
      count: 1,
    });
  }
  return {
    sectors: [...summaries.values()].sort((left, right) => left.start - right.start),
    radius: maxRadius,
  };
}

/** Return the visible directed depth for one real edge, or null for cross-links. */
export function stellarFlowEdgeDepth(
  sourceId: number,
  targetId: number,
  targets: ReadonlyMap<number, StellarFlowTarget>,
): number | null {
  const source = targets.get(sourceId);
  const target = targets.get(targetId);
  if (!source || !target) return null;
  if (source.role === "focus") {
    return target.depth === 1 && (target.role === "outgoing" || target.role === "bidirectional")
      ? 1
      : null;
  }
  if (target.role === "focus") {
    return source.depth === 1 && (source.role === "incoming" || source.role === "bidirectional")
      ? 1
      : null;
  }
  if (source.depth == null || target.depth == null) return null;
  if (
    (source.role === "outgoing" || source.role === "bidirectional")
    && (target.role === "outgoing" || target.role === "bidirectional")
    && target.depth === source.depth + 1
  ) return target.depth;
  if (
    (source.role === "incoming" || source.role === "bidirectional")
    && (target.role === "incoming" || target.role === "bidirectional")
    && source.depth === target.depth + 1
  ) return source.depth;
  return null;
}

interface MutableLaneSummary {
  role: DirectedFlowRole;
  depth: number;
  count: number;
  sumX: number;
  minY: number;
  maxY: number;
}

function addLaneTarget(
  summaries: Map<string, MutableLaneSummary>,
  key: string,
  target: StellarFlowTarget,
): void {
  const role = target.role as DirectedFlowRole;
  const depth = target.depth!;
  const current = summaries.get(key);
  if (current) {
    current.count += 1;
    current.sumX += target.x;
    current.minY = Math.min(current.minY, target.y);
    current.maxY = Math.max(current.maxY, target.y);
  } else {
    summaries.set(key, {
      role,
      depth,
      count: 1,
      sumX: target.x,
      minY: target.y,
      maxY: target.y,
    });
  }
}

/** Precompute the at-most-eight depth rails and bounded module labels. */
export function summarizeStellarFlowLanes(
  targets: ReadonlyMap<number, StellarFlowTarget>,
): { layers: StellarFlowLaneSummary[]; modules: StellarFlowModuleSummary[] } {
  const layerMap = new Map<string, MutableLaneSummary>();
  const moduleMap = new Map<string, MutableLaneSummary>();
  for (const target of targets.values()) {
    if (
      target.depth == null
      || !["incoming", "outgoing", "bidirectional"].includes(target.role)
    ) continue;
    addLaneTarget(layerMap, `${target.role}:${target.depth}`, target);
    if (target.laneKey) {
      addLaneTarget(moduleMap, `${target.role}:${target.depth}:${target.laneKey}`, target);
    }
  }
  const roleOrder: Record<DirectedFlowRole, number> = {
    incoming: 0,
    bidirectional: 1,
    outgoing: 2,
  };
  const finish = (summary: MutableLaneSummary): StellarFlowLaneSummary => ({
    role: summary.role,
    depth: summary.depth,
    count: summary.count,
    x: summary.sumX / summary.count,
    minY: summary.minY,
    maxY: summary.maxY,
  });
  const byLane = (left: MutableLaneSummary, right: MutableLaneSummary) => (
    left.depth - right.depth
    || roleOrder[left.role] - roleOrder[right.role]
  );
  const layers = [...layerMap.values()].sort(byLane).map(finish);
  const modules = [...moduleMap.entries()]
    .sort((left, right) => byLane(left[1], right[1]) || left[0].localeCompare(right[0]))
    .map(([key, summary]) => ({
      ...finish(summary),
      laneKey: key.slice(key.indexOf(":", key.indexOf(":") + 1) + 1),
    }));
  return { layers, modules };
}
