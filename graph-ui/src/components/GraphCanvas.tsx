// graph-ui/src/components/GraphCanvas.tsx
// V2: 2D canvas-based graph renderer using d3-force.
// The bounded overview stays cheap while semantic zoom and exact, on-demand
// neighborhoods preserve the precision that a flat, fully rendered graph lost.

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useId, useMemo } from "react";
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from "d3-force";
import type { GraphData, GraphEdge, GraphNode } from "../lib/types";
import { colorForLabel, colorForStatus } from "../lib/colors";
import {
  stellarNodeColor,
  stellarNodeDegree,
  stellarNodeGlyph,
  type GraphVisualMode,
} from "../lib/graph-visual-mode";
import {
  computeStellarFlowLayout,
  stellarFlowEdgeDepth,
  summarizeStellarConstellation,
  summarizeStellarFlowLanes,
  type StellarFlowTarget,
} from "../lib/graph-stellar-layout";
import {
  stellarFlowLabelAnchors,
  stellarOverviewLabelAnchors,
} from "../lib/graph-flow-labels";
import {
  composeStellarFocusViewport,
  stellarFocusLabelBudget,
  stellarFocusWorldBoxFitsViewport,
} from "../lib/graph-focus-composer";
import {
  GRAPH_EDGE_GROUP_META,
  GRAPH_EDGE_GROUP_ORDER,
  graphEdgeGroup,
  type GraphEdgeGroup,
} from "../lib/graph-flow-semantics";
import {
  GRAPH_TOOLTIP_POSITION_EVENT,
  type GraphTooltipPositionDetail,
} from "../lib/graph-tooltip-position";

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
  /** Center one node without restarting the simulation. */
  focusNode: (nodeId: number) => void;
  /** Fit a selected file/folder subset without disturbing the layout. */
  focusNodes: (nodeIds: Iterable<number>, minimumZoom?: number) => void;
}

export interface GraphScopeSelection {
  kind: "domain" | "community";
  id: number;
  key: string;
  nodeIds: Set<number>;
}

interface GraphCanvasProps {
  data: GraphData;
  active?: boolean;
  visualMode?: GraphVisualMode;
  /** Render a bounded exact scope as raw topology at every zoom level. */
  detailMode?: boolean;
  highlightedIds: Set<number> | null;
  selectedNodeId?: number | null;
  deadCodeView: boolean;
  onNodeClick: (node: GraphNode) => void;
  onScopeSelect?: (scope: GraphScopeSelection) => void;
  onNodeHover: (node: GraphNode | null, pos?: { x: number; y: number }) => void;
}

interface SimNode extends GraphNode {
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  anchorX: number;
  anchorY: number;
  architectureX: number;
  architectureY: number;
  rank: number;
}

interface SimEdge {
  source: number | SimNode;
  target: number | SimNode;
  type: string;
}

interface StellarFlowEdgeBatch {
  direct: SimEdge[];
  transit: SimEdge[];
}

interface CollisionBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function hitsOccupied(box: CollisionBox, occupied: readonly CollisionBox[]): boolean {
  return occupied.some((other) => (
    box.right >= other.left
    && box.left <= other.right
    && box.bottom >= other.top
    && box.top <= other.bottom
  ));
}

const DEFAULT_NODE_RADIUS = 4;
const MIN_NODE_RADIUS = 2;
const MAX_NODE_RADIUS = 12;
// Keep architecture labels inside the viewport as well as the circles. The
// summary line uses a constant screen-space font, so the old 48 px padding
// could clip a small domain parked at the left or right packing extreme.
const FIT_PADDING = 64;
const LOCAL_LINK_DISTANCE = 30;
const CHARGE_STRENGTH = -38;
const CHARGE_DISTANCE_MAX = 220;
const ANCHOR_STRENGTH = 0.24;
const STELLAR_ANCHOR_STRENGTH = 0.38;
const STELLAR_CONTEXT_ANCHOR_STRENGTH = 0.08;
const STELLAR_CHARGE_STRENGTH = -58;
const STELLAR_CHARGE_DISTANCE_MAX = 320;
const STELLAR_LINK_DISTANCE = 54;
const STELLAR_FOCUS_LINK_DISTANCE = 112;
const STELLAR_LAYOUT_ALPHA = 0.52;
const SIMULATION_ALPHA_DECAY = 0.045;
const SETTLED_FIT_DELAY_MS = 700;
const TOUCH_TAP_SLOP_PX = 8;
const MAX_RENDER_DPR = 2;
const MAX_CANVAS_PIXELS = 16_000_000;
const DEFERRED_INITIAL_FIT_NODE_THRESHOLD = 500;
const STELLAR_OVERVIEW_SIMULATION_NODE_THRESHOLD = 500;
const MID_LABEL_LIMIT = 24;
const NEAR_LABEL_LIMIT = 64;
const STELLAR_OVERVIEW_LABEL_LIMIT = 12;
const LOW_INFORMATION_STELLAR_LABEL = /^(?:anonymous#|add$|close(?:sync)?$|get$|handle$|now$|push$|request$|run$|set$|start$|stop$)/iu;
const DEFAULT_LAYOUT_NODE_SPACING = 16;
const DOMAIN_OVERVIEW_MAX_PROJECTED_SPACING = 7;
const RAW_TOPOLOGY_MIN_PROJECTED_SPACING = 18;
const MAX_KEYBOARD_DOMAINS = 32;
const MAX_KEYBOARD_COMMUNITIES = 64;
const MAX_KEYBOARD_NODES = 64;
const MAX_COMMUNITY_BACKBONE_BUNDLES = 16;

function fadeBetween(value: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (value - start) / (end - start)));
}

export function computeSemanticZoomLayers(projectedNodeSpacing: number) {
  const communityReveal = fadeBetween(
    projectedNodeSpacing,
    5.5,
    8.5,
  );
  const rawTopologyReveal = fadeBetween(
    projectedNodeSpacing,
    18,
    22,
  );
  return [
    // Each flow grammar fully leaves the canvas before the next one enters.
    // The quiet frame between them preserves a readable static composition at
    // every zoom value instead of briefly stacking two kinds of topology.
    1 - fadeBetween(
      projectedNodeSpacing,
      5.5,
      DOMAIN_OVERVIEW_MAX_PROJECTED_SPACING,
    ),
    0.72
      * fadeBetween(
        projectedNodeSpacing,
        DOMAIN_OVERVIEW_MAX_PROJECTED_SPACING,
        8.5,
      )
      * (1 - fadeBetween(
        projectedNodeSpacing,
        16,
        18,
      )),
    communityReveal,
    rawTopologyReveal,
  ] as const;
}

type LayoutCluster = NonNullable<GraphData["layout"]>["clusters"][number];
type LayoutDomain = NonNullable<GraphData["layout"]>["domains"][number];
type KeyboardTargetKind = "domain" | "community" | "node";

interface KeyboardTarget {
  kind: KeyboardTargetKind;
  id: number;
  label: string;
  x: number;
  y: number;
  radius: number;
  semanticLabel?: string;
}

type KeyboardTargets = Record<KeyboardTargetKind, KeyboardTarget[]>;

function emptyKeyboardTargets(): KeyboardTargets {
  return { domain: [], community: [], node: [] };
}

const DOMAIN_PALETTE = [
  {
    fill: "rgba(6, 182, 212, 0.034)",
    stroke: "rgba(34, 211, 238, 0.34)",
    clusterFill: "rgba(6, 182, 212, 0.07)",
    clusterStroke: "rgba(103, 232, 249, 0.31)",
    title: "rgba(207, 250, 254, 0.96)",
    meta: "rgba(125, 211, 252, 0.68)",
    hoverFill: "rgba(6, 182, 212, 0.09)",
    hoverStroke: "rgba(103, 232, 249, 0.9)",
  },
  {
    fill: "rgba(99, 102, 241, 0.032)",
    stroke: "rgba(129, 140, 248, 0.32)",
    clusterFill: "rgba(99, 102, 241, 0.066)",
    clusterStroke: "rgba(165, 180, 252, 0.29)",
    title: "rgba(224, 231, 255, 0.96)",
    meta: "rgba(165, 180, 252, 0.68)",
    hoverFill: "rgba(99, 102, 241, 0.09)",
    hoverStroke: "rgba(165, 180, 252, 0.9)",
  },
  {
    fill: "rgba(139, 92, 246, 0.03)",
    stroke: "rgba(167, 139, 250, 0.31)",
    clusterFill: "rgba(139, 92, 246, 0.064)",
    clusterStroke: "rgba(196, 181, 253, 0.28)",
    title: "rgba(237, 233, 254, 0.96)",
    meta: "rgba(196, 181, 253, 0.68)",
    hoverFill: "rgba(139, 92, 246, 0.085)",
    hoverStroke: "rgba(196, 181, 253, 0.9)",
  },
  {
    fill: "rgba(16, 185, 129, 0.028)",
    stroke: "rgba(52, 211, 153, 0.29)",
    clusterFill: "rgba(16, 185, 129, 0.06)",
    clusterStroke: "rgba(110, 231, 183, 0.27)",
    title: "rgba(209, 250, 229, 0.96)",
    meta: "rgba(110, 231, 183, 0.66)",
    hoverFill: "rgba(16, 185, 129, 0.08)",
    hoverStroke: "rgba(110, 231, 183, 0.88)",
  },
  {
    fill: "rgba(245, 158, 11, 0.026)",
    stroke: "rgba(251, 191, 36, 0.28)",
    clusterFill: "rgba(245, 158, 11, 0.058)",
    clusterStroke: "rgba(252, 211, 77, 0.26)",
    title: "rgba(254, 243, 199, 0.96)",
    meta: "rgba(252, 211, 77, 0.64)",
    hoverFill: "rgba(245, 158, 11, 0.075)",
    hoverStroke: "rgba(252, 211, 77, 0.86)",
  },
] as const;

function domainPalette(domainId: number) {
  const index = ((domainId % DOMAIN_PALETTE.length) + DOMAIN_PALETTE.length) % DOMAIN_PALETTE.length;
  return DOMAIN_PALETTE[index];
}

function compactArchitectureCount(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  const units = [
    { threshold: 1_000_000_000, suffix: "b" },
    { threshold: 1_000_000, suffix: "m" },
    { threshold: 1_000, suffix: "k" },
  ] as const;
  const unit = units.find((candidate) => value >= candidate.threshold)!;
  const scaled = value / unit.threshold;
  const precision = scaled < 100 ? 1 : 0;
  return `${scaled.toFixed(precision).replace(/\.0$/u, "")}${unit.suffix}`;
}

interface OverviewBundle {
  sourceId: number;
  targetId: number;
  route: "quadratic" | "corridor";
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
  count: number;
  group: GraphEdgeGroup;
  weight: number;
}

interface ScopeTraffic {
  incoming: number;
  outgoing: number;
}

interface OverviewBundlePlan {
  batches: Map<string, OverviewBundle[]>;
  traffic: Map<number, ScopeTraffic>;
  trafficTiers: Map<number, number>;
}

function simEdgeNodeId(endpoint: number | SimNode): number {
  return typeof endpoint === "number" ? endpoint : endpoint.id;
}

function buildOverviewBundleBatches(
  edges: readonly SimEdge[],
  nodeMap: ReadonlyMap<number, SimNode>,
  centers: ReadonlyMap<number, { id: number; x: number; y: number; radius: number }>,
  scopeIdForNode: (node: SimNode) => number | undefined,
  maxBundles: number,
  routingCenterForScope?: (
    scopeId: number,
  ) => { id: number; x: number; y: number; radius: number } | undefined,
): OverviewBundlePlan {
  interface Accumulator {
    sourceId: number;
    targetId: number;
    count: number;
    groupCounts: Record<GraphEdgeGroup, number>;
  }
  const accumulators = new Map<string, Accumulator>();
  for (const edge of edges) {
    const sourceNode = nodeMap.get(simEdgeNodeId(edge.source));
    const targetNode = nodeMap.get(simEdgeNodeId(edge.target));
    if (!sourceNode || !targetNode) continue;
    const sourceScope = scopeIdForNode(sourceNode);
    const targetScope = scopeIdForNode(targetNode);
    if (sourceScope == null || targetScope == null || sourceScope === targetScope) continue;
    const group = graphEdgeGroup(edge.type);
    const sourceId = sourceScope;
    const targetId = targetScope;
    // A macro connection answers one question: which scope depends on which
    // other scope? Multiple relation kinds on the same directed pair are
    // collapsed into one bundle, colored by its dominant semantic relation.
    // Keeping parallel type-specific curves here made the overview look more
    // precise while actually obscuring the architecture it was meant to show.
    const key = `${sourceId}:${targetId}`;
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = {
        sourceId,
        targetId,
        count: 0,
        groupCounts: {
          calls: 0,
          imports: 0,
          contains: 0,
          data: 0,
          other: 0,
        },
      };
      accumulators.set(key, accumulator);
    }
    accumulator.count += 1;
    accumulator.groupCounts[group] += 1;
  }

  const scopeCenters = [...centers.values()];
  const layoutCenter = { x: 0, y: 0, radius: 0 };
  for (const scope of scopeCenters) {
    layoutCenter.x += scope.x;
    layoutCenter.y += scope.y;
  }
  if (scopeCenters.length > 0) {
    layoutCenter.x /= scopeCenters.length;
    layoutCenter.y /= scopeCenters.length;
    layoutCenter.radius = Math.max(
      ...scopeCenters.map((scope) => (
        Math.hypot(scope.x - layoutCenter.x, scope.y - layoutCenter.y) + scope.radius
      )),
    );
  }
  const routingGroupMembers = new Map<number, typeof scopeCenters>();
  if (routingCenterForScope) {
    for (const scope of scopeCenters) {
      const group = routingCenterForScope(scope.id);
      if (!group) continue;
      const members = routingGroupMembers.get(group.id);
      if (members) members.push(scope);
      else routingGroupMembers.set(group.id, [scope]);
    }
  }

  const rankedAccumulators = [...accumulators.values()]
    .map((accumulator) => ({
      ...accumulator,
      group: [...GRAPH_EDGE_GROUP_ORDER].sort((left, right) => (
        accumulator.groupCounts[right] - accumulator.groupCounts[left]
        || GRAPH_EDGE_GROUP_ORDER.indexOf(left) - GRAPH_EDGE_GROUP_ORDER.indexOf(right)
      ))[0],
    }))
    .sort((left, right) => (
      right.count - left.count
      || left.sourceId - right.sourceId
      || left.targetId - right.targetId
      || GRAPH_EDGE_GROUP_ORDER.indexOf(left.group) - GRAPH_EDGE_GROUP_ORDER.indexOf(right.group)
    ));

  // Traffic keeps every aggregate pair from the bounded response, even though
  // expensive route geometry is prepared only for the visible backbone.
  const traffic = new Map<number, ScopeTraffic>();
  for (const accumulator of rankedAccumulators) {
    const source = traffic.get(accumulator.sourceId) ?? { incoming: 0, outgoing: 0 };
    source.outgoing += accumulator.count;
    traffic.set(accumulator.sourceId, source);
    const target = traffic.get(accumulator.targetId) ?? { incoming: 0, outgoing: 0 };
    target.incoming += accumulator.count;
    traffic.set(accumulator.targetId, target);
  }
  const maxTraffic = Math.max(
    1,
    ...[...traffic.values()].map((scope) => scope.incoming + scope.outgoing),
  );
  const maxLogTraffic = Math.log1p(maxTraffic);
  const trafficTiers = new Map<number, number>();
  for (const [scopeId, scope] of traffic) {
    const total = scope.incoming + scope.outgoing;
    trafficTiers.set(scopeId, Math.max(1, Math.min(4, Math.ceil(
      (Math.log1p(total) / maxLogTraffic) * 4,
    ))));
  }

  const bundles: OverviewBundle[] = [];
  for (const accumulator of rankedAccumulators.slice(0, maxBundles)) {
    const source = centers.get(accumulator.sourceId);
    const target = centers.get(accumulator.targetId);
    if (!source || !target) continue;
    const group = accumulator.group;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const sourceInset = Math.min(source.radius, length * 0.35);
    const targetInset = Math.min(target.radius, length * 0.35);
    let startX = source.x + (dx / length) * sourceInset;
    let startY = source.y + (dy / length) * sourceInset;
    let endX = target.x - (dx / length) * targetInset;
    let endY = target.y - (dy / length) * targetInset;
    const sourceRoutingCenter = routingCenterForScope?.(source.id);
    const targetRoutingCenter = routingCenterForScope?.(target.id);
    const sharedRoutingCenter = sourceRoutingCenter && targetRoutingCenter
      && sourceRoutingCenter.id === targetRoutingCenter.id
      ? sourceRoutingCenter
      : undefined;
    const routingCenter = sharedRoutingCenter ?? layoutCenter;
    const normalX = -dy / length;
    const normalY = dx / length;
    const midpointX = (startX + endX) / 2;
    const midpointY = (startY + endY) / 2;
    const outwardProjection = (midpointX - routingCenter.x) * normalX
      + (midpointY - routingCenter.y) * normalY;
    const pairMin = Math.min(source.id, target.id);
    const pairMax = Math.max(source.id, target.id);
    const fallbackDirection = ((pairMin * 31 + pairMax * 17) & 1) === 0 ? -1 : 1;
    const direction = Math.abs(outwardProjection) > 0.5
      ? Math.sign(outwardProjection)
      : fallbackDirection;
    // The control point must create a real no-route corridor, not merely a
    // decorative curve. A quadratic reaches only half of the control-point
    // offset at t=0.5, so central chords need twice the missing clearance.
    const routingClearance = Math.min(120, Math.max(28, routingCenter.radius * 0.2));
    const clearanceBend = Math.max(
      0,
      (routingClearance - Math.abs(outwardProjection)) * 2,
    );
    const bend = Math.min(
      Math.min(240, Math.max(104, length * 0.45)),
      Math.max(16, length * 0.11, clearanceBend),
    );
    let route: OverviewBundle["route"] = "quadratic";
    let control1X = midpointX + normalX * bend * direction;
    let control1Y = midpointY + normalY * bend * direction;
    let control2X = control1X;
    let control2Y = control1Y;

    if (sharedRoutingCenter) {
      // Intra-domain traffic converges on one of twelve local corridor lanes.
      // Quantizing the direction makes nearby connections share visual spines,
      // while keeping the lane inside the useful half of the domain avoids the
      // large decorative orbits produced by peripheral routing.
      const rawCorridorX = control1X - sharedRoutingCenter.x;
      const rawCorridorY = control1Y - sharedRoutingCenter.y;
      const rawCorridorRadius = Math.hypot(rawCorridorX, rawCorridorY);
      const corridorAngleStep = Math.PI / 6;
      const corridorAngle = Math.round(
        Math.atan2(rawCorridorY, rawCorridorX) / corridorAngleStep,
      ) * corridorAngleStep;
      const corridorRadius = Math.min(
        sharedRoutingCenter.radius * 0.46,
        Math.max(
          Math.min(sharedRoutingCenter.radius * 0.4, routingClearance * 1.05),
          rawCorridorRadius,
        ),
      );
      let bestLane: {
        score: number;
        startX: number;
        startY: number;
        controlX: number;
        controlY: number;
        endX: number;
        endY: number;
      } | undefined;
      const obstacles = routingGroupMembers.get(sharedRoutingCenter.id) ?? [];
      for (const laneOffset of [0, -1, 1, -2, 2]) {
        const candidateAngle = corridorAngle + laneOffset * corridorAngleStep;
        const candidateControlX = sharedRoutingCenter.x + Math.cos(candidateAngle) * corridorRadius;
        const candidateControlY = sharedRoutingCenter.y + Math.sin(candidateAngle) * corridorRadius;
        const sourceToCorridorX = candidateControlX - source.x;
        const sourceToCorridorY = candidateControlY - source.y;
        const sourceToCorridorLength = Math.max(1, Math.hypot(sourceToCorridorX, sourceToCorridorY));
        const targetToCorridorX = candidateControlX - target.x;
        const targetToCorridorY = candidateControlY - target.y;
        const targetToCorridorLength = Math.max(1, Math.hypot(targetToCorridorX, targetToCorridorY));
        const candidateStartX = source.x + (sourceToCorridorX / sourceToCorridorLength) * source.radius;
        const candidateStartY = source.y + (sourceToCorridorY / sourceToCorridorLength) * source.radius;
        const candidateEndX = target.x + (targetToCorridorX / targetToCorridorLength) * target.radius;
        const candidateEndY = target.y + (targetToCorridorY / targetToCorridorLength) * target.radius;
        let clearanceScore = Math.min(
          Math.hypot(candidateControlX - source.x, candidateControlY - source.y) - source.radius,
          Math.hypot(candidateControlX - target.x, candidateControlY - target.y) - target.radius,
        );
        for (const obstacle of obstacles) {
          if (obstacle.id === source.id || obstacle.id === target.id) continue;
          clearanceScore = Math.min(
            clearanceScore,
            Math.hypot(candidateControlX - obstacle.x, candidateControlY - obstacle.y) - obstacle.radius,
          );
          for (const t of [0.25, 0.5, 0.75]) {
            const inverseT = 1 - t;
            const controlWeight = 3 * inverseT * t;
            const pathX = inverseT ** 3 * candidateStartX
              + controlWeight * candidateControlX
              + t ** 3 * candidateEndX;
            const pathY = inverseT ** 3 * candidateStartY
              + controlWeight * candidateControlY
              + t ** 3 * candidateEndY;
            clearanceScore = Math.min(
              clearanceScore,
              Math.hypot(pathX - obstacle.x, pathY - obstacle.y) - obstacle.radius,
            );
          }
        }
        const score = clearanceScore - Math.abs(laneOffset) * routingClearance * 0.04;
        if (!bestLane || score > bestLane.score) {
          bestLane = {
            score,
            startX: candidateStartX,
            startY: candidateStartY,
            controlX: candidateControlX,
            controlY: candidateControlY,
            endX: candidateEndX,
            endY: candidateEndY,
          };
        }
      }
      if (bestLane) {
        startX = bestLane.startX;
        startY = bestLane.startY;
        control1X = bestLane.controlX;
        control1Y = bestLane.controlY;
        control2X = bestLane.controlX;
        control2Y = bestLane.controlY;
        endX = bestLane.endX;
        endY = bestLane.endY;
      }
      route = "corridor";
    }

    bundles.push({
      sourceId: accumulator.sourceId,
      targetId: accumulator.targetId,
      route,
      startX,
      startY,
      control1X,
      control1Y,
      control2X,
      control2Y,
      endX,
      endY,
      count: accumulator.count,
      group,
      weight: Math.min(6, Math.floor(Math.log2(Math.max(1, accumulator.count)))),
    });
  }

  const batches = new Map<string, OverviewBundle[]>();
  for (const bundle of bundles) {
    const key = `${bundle.group}:${bundle.weight}`;
    const batch = batches.get(key);
    if (batch) batch.push(bundle);
    else batches.set(key, [bundle]);
  }
  return { batches, traffic, trafficTiers };
}

interface CanvasBackingStore {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

function boundedCanvasBackingStore(width: number, height: number): CanvasBackingStore {
  const cssWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const cssHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const rawDeviceRatio = window.devicePixelRatio || 1;
  const deviceRatio = Number.isFinite(rawDeviceRatio) && rawDeviceRatio > 0
    ? Math.min(MAX_RENDER_DPR, rawDeviceRatio)
    : 1;
  if (cssWidth === 0 || cssHeight === 0) {
    return { width: 0, height: 0, scaleX: deviceRatio, scaleY: deviceRatio };
  }

  // The physical pixel ceiling is authoritative. Large CSS viewports may
  // therefore render below 1x; clamping the ratio to 1 would allocate more
  // than MAX_CANVAS_PIXELS before the first frame is drawn.
  const budgetRatio = Math.sqrt(MAX_CANVAS_PIXELS / cssWidth / cssHeight);
  const effectiveRatio = Math.min(deviceRatio, budgetRatio);
  let backingWidth = Math.max(1, Math.floor(cssWidth * effectiveRatio));
  let backingHeight = Math.max(1, Math.floor(cssHeight * effectiveRatio));

  // Integer conversion and a very thin viewport can still make one minimum
  // dimension push the product over budget. Cap the larger axis explicitly;
  // separate X/Y scales preserve CSS-coordinate interaction in that edge case.
  if (backingWidth * backingHeight > MAX_CANVAS_PIXELS) {
    if (backingWidth >= backingHeight) {
      backingWidth = Math.max(1, Math.floor(MAX_CANVAS_PIXELS / backingHeight));
      if (backingWidth * backingHeight > MAX_CANVAS_PIXELS) {
        backingHeight = Math.max(1, Math.floor(MAX_CANVAS_PIXELS / backingWidth));
      }
    } else {
      backingHeight = Math.max(1, Math.floor(MAX_CANVAS_PIXELS / backingWidth));
      if (backingWidth * backingHeight > MAX_CANVAS_PIXELS) {
        backingWidth = Math.max(1, Math.floor(MAX_CANVAS_PIXELS / backingHeight));
      }
    }
  }

  return {
    width: backingWidth,
    height: backingHeight,
    scaleX: backingWidth / cssWidth,
    scaleY: backingHeight / cssHeight,
  };
}

function nodeRadius(node: Pick<GraphNode, "size">): number {
  const size = Number(node.size);
  if (!Number.isFinite(size)) return DEFAULT_NODE_RADIUS;
  return Math.max(MIN_NODE_RADIUS, Math.min(MAX_NODE_RADIUS, size));
}

function traceNodePath(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  radius: number,
  visualMode: GraphVisualMode,
): void {
  if (visualMode !== "stellar") {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }

  const glyph = stellarNodeGlyph(node.label);
  if (glyph === "square") {
    const extent = radius * 0.82;
    ctx.rect(x - extent, y - extent, extent * 2, extent * 2);
    return;
  }
  if (glyph === "diamond") {
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y);
    ctx.lineTo(x, y + radius);
    ctx.lineTo(x - radius, y);
    ctx.lineTo(x, y - radius);
    return;
  }
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function traceDirectionMarker(
  ctx: CanvasRenderingContext2D,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  size: number,
): boolean {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy);
  if (length < size * 2) return false;
  const unitX = dx / length;
  const unitY = dy / length;
  const tipX = sourceX + dx * 0.62;
  const tipY = sourceY + dy * 0.62;
  const baseX = tipX - unitX * size;
  const baseY = tipY - unitY * size;
  const wing = size * 0.55;
  ctx.moveTo(baseX - unitY * wing, baseY + unitX * wing);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(baseX + unitY * wing, baseY - unitX * wing);
  return true;
}

function paintStellarFirstHopPreview(
  ctx: CanvasRenderingContext2D,
  focus: SimNode,
  scale: number,
): void {
  const focusX = focus.x ?? 0;
  const focusY = focus.y ?? 0;
  ctx.beginPath();
  ctx.arc(focusX, focusY, nodeRadius(focus) + 5 / scale, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(236, 254, 255, 0.98)";
  ctx.lineWidth = 2 / scale;
  ctx.stroke();
  ctx.font = `650 ${9 / scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(3, 8, 14, 0.94)";
  ctx.lineWidth = 3 / scale;
  const label = "VISIBLE FIRST HOP";
  const labelY = focusY - nodeRadius(focus) - 15 / scale;
  ctx.strokeText(label, focusX, labelY);
  ctx.fillStyle = "rgba(203, 225, 236, 0.9)";
  ctx.fillText(label, focusX, labelY);
}

function traceEdges(
  ctx: CanvasRenderingContext2D,
  edges: SimEdge[],
  nodeMap: Map<number, SimNode>,
  selectedNodeId: number | null,
  selectionOnly = false,
  limit = Number.POSITIVE_INFINITY,
) {
  let count = 0;
  for (const edge of edges) {
    const source = nodeMap.get(simEdgeNodeId(edge.source));
    const target = nodeMap.get(simEdgeNodeId(edge.target));
    if (!source || !target) continue;
    const touchesSelection = selectedNodeId != null
      && (source.id === selectedNodeId || target.id === selectedNodeId);
    if (selectionOnly !== touchesSelection) continue;
    ctx.moveTo(source.x ?? 0, source.y ?? 0);
    ctx.lineTo(target.x ?? 0, target.y ?? 0);
    count += 1;
    if (count >= limit) break;
  }
  return count;
}

function traceSelectedDirectionMarkers(
  ctx: CanvasRenderingContext2D,
  edges: SimEdge[],
  nodeMap: Map<number, SimNode>,
  selectedNodeId: number,
  markerSize: number,
  limit = Number.POSITIVE_INFINITY,
): boolean {
  let hasPath = false;
  let count = 0;
  for (const edge of edges) {
    const source = nodeMap.get(simEdgeNodeId(edge.source));
    const target = nodeMap.get(simEdgeNodeId(edge.target));
    if (!source || !target || (source.id !== selectedNodeId && target.id !== selectedNodeId)) continue;
    hasPath = traceDirectionMarker(
      ctx,
      source.x ?? 0,
      source.y ?? 0,
      target.x ?? 0,
      target.y ?? 0,
      markerSize,
    ) || hasPath;
    count += 1;
    if (count >= limit) break;
  }
  return hasPath;
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
  visualMode = "architecture",
  detailMode = false,
  highlightedIds,
  selectedNodeId = null,
  deadCodeView,
  onNodeClick,
  onScopeSelect,
  onNodeHover,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backingScaleRef = useRef({ x: 1, y: 1 });
  const keyboardInstructionsId = useId();
  const keyboardStatusId = useId();
  const keyboardStatusRef = useRef<HTMLSpanElement>(null);
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
  const topologyRevisionRef = useRef<string | undefined>(undefined);
  const currentNodeIdsRef = useRef<Set<number>>(new Set());
  const currentEdgeKeysRef = useRef<Set<string>>(new Set());
  const drawRef = useRef<(() => void) | null>(null);
  // R40 (UI-2): cache nodeMap in a ref. The draw() function used to rebuild
  // a Map of all nodes on every call (every tick during layout = many times
  // per frame for a 2000-node graph). The map only changes when nodesRef
  // changes, so we rebuild it only on data updates.
  const nodeMapRef = useRef<Map<number, SimNode>>(new Map());
  const stellarFlowTargetsRef = useRef<Map<number, StellarFlowTarget>>(new Map());
  const stellarConstellationRef = useRef<ReturnType<typeof summarizeStellarConstellation>>({
    sectors: [],
    radius: 0,
  });
  const stellarOverviewHubsRef = useRef<SimNode[]>([]);
  const stellarOverviewLabelCandidatesRef = useRef<SimNode[]>([]);
  const stellarOverviewCommunityLabelsRef = useRef<SimNode[]>([]);
  const stellarNodeBatchesRef = useRef<Map<string, SimNode[]>>(new Map());
  const stellarSimulationReducedRef = useRef(false);
  const stellarFlowLanesRef = useRef<ReturnType<typeof summarizeStellarFlowLanes>>({
    layers: [],
    modules: [],
  });
  const stellarFlowLabelCandidatesRef = useRef<SimNode[]>([]);
  const stellarFlowEdgeGroupsRef = useRef<Map<GraphEdgeGroup, StellarFlowEdgeBatch>>(new Map());
  const stellarFlowRelationLabelRef = useRef("");
  const stellarPreviewRef = useRef<number | null>(null);
  const clustersRef = useRef<LayoutCluster[]>([]);
  const clusterMapRef = useRef<Map<number, LayoutCluster>>(new Map());
  const domainsRef = useRef<LayoutDomain[]>([]);
  const domainCatalogRef = useRef<Map<string, { node_count: number; file_count: number }>>(new Map());
  const layoutNodeSpacingRef = useRef(DEFAULT_LAYOUT_NODE_SPACING);
  const localEdgesRef = useRef<SimEdge[]>([]);
  const rawEdgeLayersRef = useRef<[SimEdge[], SimEdge[]]>([[], []]);
  const stellarEdgeLayersRef = useRef<[SimEdge[], SimEdge[]]>([[], []]);
  const crossClusterEdgesRef = useRef<SimEdge[]>([]);
  const clusterBundleBatchesRef = useRef<Map<string, OverviewBundle[]>>(new Map());
  const clusterTrafficRef = useRef<Map<number, ScopeTraffic>>(new Map());
  const clusterTrafficTiersRef = useRef<Map<number, number>>(new Map());
  const domainBundleBatchesRef = useRef<Map<string, OverviewBundle[]>>(new Map());
  const domainTrafficTiersRef = useRef<Map<number, number>>(new Map());
  const labelCandidatesRef = useRef<SimNode[]>([]);
  const edgeGroupsRef = useRef<Map<GraphEdgeGroup, SimEdge[]>>(new Map());
  const hoveredScopeRef = useRef<Omit<GraphScopeSelection, "nodeIds"> | null>(null);
  const keyboardTargetsRef = useRef<KeyboardTargets>(emptyKeyboardTargets());
  const keyboardVisibleCountsRef = useRef<Record<KeyboardTargetKind, number>>({
    domain: 0,
    community: 0,
    node: 0,
  });
  const keyboardFocusRef = useRef<KeyboardTarget | null>(null);
  const lastHoverIdRef = useRef<number | null>(null);
  // R40 (UI-6): rAF-batched tick handler. d3-force ticks much faster than
  // 60fps during initial layout; without batching, draw() runs multiple
  // times per frame, wasting CPU on a canvas redraw that the user never sees.
  const rafIdRef = useRef<number | null>(null);
  const viewAnimationRafRef = useRef<number | null>(null);
  const autoFitRafRef = useRef<number | null>(null);
  const settledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoFitRef = useRef(false);
  const hasUserInteractedRef = useRef(false);
  const activeRef = useRef(active);
  const previousActiveRef = useRef(active);
  const previousDetailModeRef = useRef(detailMode);
  const visualModeRef = useRef(visualMode);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const previousFlowFrameRef = useRef({ visualMode: "architecture" as GraphVisualMode, selectedNodeId: null as number | null });
  const dataRequiresLayoutReheatRef = useRef(false);
  activeRef.current = active;
  visualModeRef.current = visualMode;
  selectedNodeIdRef.current = selectedNodeId;

  // Exact search can select a node that is intentionally absent from the
  // representative canvas, and filters can remove a previously highlighted
  // node. Only a highlight that intersects the currently rendered topology
  // may dim the map or consume the semantic-label budget.
  const visibleHighlightedIds = useMemo(() => {
    if (!highlightedIds || highlightedIds.size === 0) return null;
    const visible = new Set<number>();
    for (const node of data.nodes) {
      if (highlightedIds.has(node.id)) visible.add(node.id);
    }
    return visible.size > 0 ? visible : null;
  }, [data.nodes, highlightedIds]);

  const cancelPendingAutoFit = useCallback(() => {
    if (autoFitRafRef.current != null) {
      cancelAnimationFrame(autoFitRafRef.current);
      autoFitRafRef.current = null;
    }
  }, []);

  const cancelViewAnimation = useCallback(() => {
    if (viewAnimationRafRef.current != null) {
      cancelAnimationFrame(viewAnimationRafRef.current);
      viewAnimationRafRef.current = null;
    }
  }, []);

  const animateToTransform = useCallback((target: { x: number; y: number; k: number }) => {
    cancelViewAnimation();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceMotion) {
      transformRef.current = target;
      drawRef.current?.();
      return;
    }

    const start = { ...transformRef.current };
    let startedAt: number | null = null;
    const step = (timestamp: number) => {
      if (startedAt == null) startedAt = timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / 220);
      const eased = 1 - Math.pow(1 - progress, 3);
      transformRef.current = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        k: start.k + (target.k - start.k) * eased,
      };
      drawRef.current?.();
      if (progress < 1) viewAnimationRafRef.current = requestAnimationFrame(step);
      else viewAnimationRafRef.current = null;
    };
    viewAnimationRafRef.current = requestAnimationFrame(step);
  }, [cancelViewAnimation]);

  /**
   * Compose only the selected directed frame into the usable canvas area.
   * Persistent HUD/control/breadcrumb space is reserved in CSS pixels by the
   * pure composer; no simulation node or renderer is recreated here.
   */
  const fitStellarFocus = useCallback((animate = false): boolean => {
    const canvas = canvasRef.current;
    if (
      !canvas
      || !canvas.style.width
      || visualModeRef.current !== "stellar"
      || selectedNodeIdRef.current == null
    ) return false;

    const rect = canvas.getBoundingClientRect();
    const backingScale = backingScaleRef.current;
    const viewport = {
      width: rect.width || canvas.clientWidth || canvas.width / backingScale.x,
      height: rect.height || canvas.clientHeight || canvas.height / backingScale.y,
    };
    const transform = composeStellarFocusViewport(
      stellarFlowTargetsRef.current.values(),
      viewport,
    );
    if (!transform) return false;

    hasAutoFitRef.current = true;
    if (animate) animateToTransform(transform);
    else {
      transformRef.current = transform;
      drawRef.current?.();
    }
    return true;
  }, [animateToTransform]);

  /**
   * Fit visible node bounds into CSS-pixel canvas bounds. Returns false while
   * the canvas is hidden/unsized so ResizeObserver can retry later.
   */
  const fitVisibleGraph = useCallback((): boolean => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    // React's semantic-layout effect runs before the resize effect on mount.
    // Do not scan all bounds against the browser's disposable 300x150 canvas;
    // resize owns the first fit once the CSS and backing-store sizes agree.
    if (!canvas || !canvas.style.width || nodes.length === 0) return false;

    const rect = canvas.getBoundingClientRect();
    const backingScale = backingScaleRef.current;
    const viewportWidth = rect.width || canvas.clientWidth || canvas.width / backingScale.x;
    const viewportHeight = rect.height || canvas.clientHeight || canvas.height / backingScale.y;
    if (viewportWidth <= 0 || viewportHeight <= 0) return false;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    if (visualModeRef.current !== "stellar" && domainsRef.current.length) {
      for (const domain of domainsRef.current) {
        minX = Math.min(minX, domain.x - domain.radius);
        minY = Math.min(minY, domain.y - domain.radius);
        maxX = Math.max(maxX, domain.x + domain.radius);
        maxY = Math.max(maxY, domain.y + domain.radius);
      }
    } else {
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
  const onScopeSelectRef = useRef(onScopeSelect);
  const onNodeHoverRef = useRef(onNodeHover);
  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);
  useEffect(() => {
    onScopeSelectRef.current = detailMode ? undefined : onScopeSelect;
  }, [detailMode, onScopeSelect]);
  useEffect(() => { onNodeHoverRef.current = onNodeHover; }, [onNodeHover]);

  const dragRef = useRef<{ node: SimNode | null; startX: number; startY: number }>({
    node: null,
    startX: 0,
    startY: 0,
  });
  const setStellarPreviewFocus = useCallback((nodeId: number | null, redraw = true) => {
    const preview = visualModeRef.current === "stellar"
      && selectedNodeIdRef.current == null
      && nodeId != null
      && nodeMapRef.current.has(nodeId)
      ? nodeId
      : null;
    stellarPreviewRef.current = preview;
    if (redraw) drawRef.current?.();
  }, []);

  useEffect(() => {
    const previousFrame = previousFlowFrameRef.current;
    if (
      lastHoverIdRef.current != null
      && (previousFrame.visualMode !== visualMode || previousFrame.selectedNodeId !== selectedNodeId)
    ) {
      lastHoverIdRef.current = null;
      onNodeHoverRef.current(null);
    }
    const keyboardFocus = keyboardFocusRef.current;
    const previewNodeId = lastHoverIdRef.current
      ?? (keyboardFocus?.kind === "node" ? keyboardFocus.id : null);
    setStellarPreviewFocus(previewNodeId);
  }, [selectedNodeId, setStellarPreviewFocus, visualMode]);

  const activateScope = useCallback((scope: Omit<GraphScopeSelection, "nodeIds">) => {
    const clusterDomain = new Map(
      clustersRef.current.map((cluster) => [cluster.id, cluster.domain_id]),
    );
    const nodeIds = new Set<number>();
    for (const node of nodesRef.current) {
      if (scope.kind === "community" && node.cluster_id === scope.id) nodeIds.add(node.id);
      if (
        scope.kind === "domain"
        && node.cluster_id != null
        && clusterDomain.get(node.cluster_id) === scope.id
      ) nodeIds.add(node.id);
    }
    onScopeSelectRef.current?.({ ...scope, nodeIds });
  }, []);

  const focusKeyboardTarget = useCallback((target: KeyboardTarget, index: number) => {
    keyboardFocusRef.current = target;
    hasUserInteractedRef.current = true;
    cancelPendingAutoFit();
    const canvas = canvasRef.current;
    let x = target.x;
    let y = target.y;
    let radius = target.radius;
    if (target.kind === "node") {
      const node = nodeMapRef.current.get(target.id);
      if (node) {
        x = node.x ?? x;
        y = node.y ?? y;
        radius = nodeRadius(node);
      }
      if (lastHoverIdRef.current == null) setStellarPreviewFocus(target.id, false);
    }

    const rect = canvas?.getBoundingClientRect();
    let zoom = target.kind === "node" ? 1.25 : 0.35;
    if (rect && target.kind !== "node") {
      const availableWidth = Math.max(1, rect.width - FIT_PADDING * 2);
      const availableHeight = Math.max(1, rect.height - FIT_PADDING * 2);
      zoom = Math.max(0.1, Math.min(3, availableWidth / (radius * 2), availableHeight / (radius * 2)));
    } else if (target.kind === "node") {
      zoom = Math.max(1.25, Math.min(3, transformRef.current.k));
    }

    // Paint the virtual focus ring immediately; the optional view animation
    // then brings an off-screen target into the center without a React render.
    drawRef.current?.();
    animateToTransform({ x: -x * zoom, y: -y * zoom, k: zoom });

    const targets = keyboardTargetsRef.current[target.kind];
    const visible = keyboardVisibleCountsRef.current[target.kind];
    const kindLabel = target.kind === "domain"
      ? "Domain"
      : target.kind === "community"
        ? "Community"
        : `Node${target.semanticLabel ? ` ${target.semanticLabel}` : ""}`;
    const boundedNote = targets.length < visible
      ? ` ${targets.length} of ${visible} visible ${target.kind} targets are keyboard-browsable.`
      : "";
    if (keyboardStatusRef.current) {
      keyboardStatusRef.current.textContent = `${kindLabel} ${target.label}, ${index + 1} of ${targets.length}.${boundedNote} Press Enter to activate.`;
    }
  }, [animateToTransform, cancelPendingAutoFit, setStellarPreviewFocus]);

  const cycleKeyboardTarget = useCallback((kind: KeyboardTargetKind, direction: 1 | -1) => {
    if (kind !== "node" && visualModeRef.current === "stellar") {
      if (keyboardStatusRef.current) {
        keyboardStatusRef.current.textContent = "Symbols only in this view.";
      }
      return;
    }
    const targets = keyboardTargetsRef.current[kind];
    if (targets.length === 0) {
      if (keyboardStatusRef.current) {
        keyboardStatusRef.current.textContent = `No visible ${kind} targets.`;
      }
      return;
    }
    const current = keyboardFocusRef.current;
    const currentIndex = current?.kind === kind
      ? targets.findIndex((target) => target.id === current.id)
      : -1;
    const index = currentIndex < 0
      ? (direction === 1 ? 0 : targets.length - 1)
      : (currentIndex + direction + targets.length) % targets.length;
    focusKeyboardTarget(targets[index], index);
  }, [focusKeyboardTarget]);

  const activateKeyboardTarget = useCallback((): boolean => {
    const target = keyboardFocusRef.current;
    if (!target) return false;
    if (target.kind === "node") {
      const node = nodeMapRef.current.get(target.id);
      if (!node) return false;
      setStellarPreviewFocus(null);
      onNodeClickRef.current(node as GraphNode);
      return true;
    }
    activateScope({ kind: target.kind, id: target.id, key: target.label });
    return true;
  }, [activateScope, setStellarPreviewFocus]);

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
      stellarFlowTargetsRef.current = new Map();
      stellarConstellationRef.current = { sectors: [], radius: 0 };
      stellarOverviewHubsRef.current = [];
      stellarOverviewLabelCandidatesRef.current = [];
      stellarOverviewCommunityLabelsRef.current = [];
      stellarNodeBatchesRef.current = new Map();
      stellarSimulationReducedRef.current = false;
      stellarFlowLanesRef.current = { layers: [], modules: [] };
      stellarFlowLabelCandidatesRef.current = [];
      stellarFlowEdgeGroupsRef.current = new Map();
      stellarFlowRelationLabelRef.current = "";
      stellarPreviewRef.current = null;
      clustersRef.current = [];
      clusterMapRef.current = new Map();
      domainsRef.current = [];
      domainCatalogRef.current = new Map();
      layoutNodeSpacingRef.current = DEFAULT_LAYOUT_NODE_SPACING;
      localEdgesRef.current = [];
      rawEdgeLayersRef.current = [[], []];
      stellarEdgeLayersRef.current = [[], []];
      crossClusterEdgesRef.current = [];
      clusterBundleBatchesRef.current = new Map();
      clusterTrafficRef.current = new Map();
      clusterTrafficTiersRef.current = new Map();
      domainBundleBatchesRef.current = new Map();
      domainTrafficTiersRef.current = new Map();
      labelCandidatesRef.current = [];
      edgeGroupsRef.current = new Map();
      keyboardTargetsRef.current = emptyKeyboardTargets();
      keyboardVisibleCountsRef.current = { domain: 0, community: 0, node: 0 };
      keyboardFocusRef.current = null;
      if (lastHoverIdRef.current != null) onNodeHoverRef.current(null);
      lastHoverIdRef.current = null;
      if (keyboardStatusRef.current) keyboardStatusRef.current.textContent = "";
      currentNodeIdsRef.current = new Set();
      currentEdgeKeysRef.current = new Set();
      dataRequiresLayoutReheatRef.current = false;
      setStellarPreviewFocus(null, false);
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
    const sameServerTopology = data.topology_revision != null
      && data.topology_revision === topologyRevisionRef.current;
    const serverTopologyChanged = data.topology_revision != null
      && data.topology_revision !== topologyRevisionRef.current;
    // A new server revision is not a client-side filter. Drop retired physics
    // objects and membership keys before accepting it, otherwise repeated
    // reindexes make these caches grow for the lifetime of the mounted tab and
    // can resurrect stale coordinates when an id is later reused.
    if (serverTopologyChanged) {
      nodeStateCacheRef.current.clear();
      knownNodeIdsRef.current.clear();
      knownEdgeKeysRef.current.clear();
    }
    const incomingSubsetWasSeen = [...incomingNodeIds].every((id) => knownNodeIdsRef.current.has(id))
      && [...incomingEdgeKeys].every((key) => knownEdgeKeysRef.current.has(key));
    // Modern responses explicitly distinguish a client-side filter from a
    // removal-only server refresh. Keep the legacy subset heuristic only for
    // old backends that do not expose topology_revision.
    const topologyAlreadyKnown = data.topology_revision != null
      ? sameServerTopology && incomingSubsetWasSeen
      : incomingSubsetWasSeen;
    dataRequiresLayoutReheatRef.current = !topologyAlreadyKnown;
    topologyRevisionRef.current = data.topology_revision;

    // Reuse the cached physics object for every known node. Update semantic
    // metadata in place while preserving d3-owned position/velocity fields.
    const nodes: SimNode[] = data.nodes.map((n) => {
      const cached = nodeStateCacheRef.current.get(n.id);
      if (!cached) {
        const created = {
          ...n,
          anchorX: n.x,
          anchorY: n.y,
          architectureX: n.x,
          architectureY: n.y,
        } as SimNode;
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
      Object.assign(cached, n, {
        architectureX: n.x,
        architectureY: n.y,
        ...(visualModeRef.current === "architecture" ? { anchorX: n.x, anchorY: n.y } : {}),
      }, physics);
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
    for (const n of nodes) {
      n.rank = 0;
      map.set(n.id, n);
    }
    nodeMapRef.current = map;
    const completeLayout = data.layout?.counts_scope === "all_nodes";
    const visibleClusterIds = new Set(nodes.map((node) => node.cluster_id).filter((id): id is number => id != null));
    clustersRef.current = (data.layout?.clusters ?? [])
      .filter((cluster) => completeLayout || visibleClusterIds.has(cluster.id))
      .sort((left, right) => right.node_count - left.node_count || left.id - right.id);
    layoutNodeSpacingRef.current = data.layout?.node_spacing ?? DEFAULT_LAYOUT_NODE_SPACING;
    const visibleDomainIds = new Set<number>();
    for (const cluster of clustersRef.current) {
      if (visibleClusterIds.has(cluster.id)) visibleDomainIds.add(cluster.domain_id);
    }
    domainsRef.current = (data.layout?.domains ?? [])
      .filter((domain) => completeLayout || visibleDomainIds.has(domain.id))
      .sort((left, right) => right.node_count - left.node_count || left.id - right.id);
    domainCatalogRef.current = new Map(
      (data.layout?.domain_catalog?.domains ?? []).map((domain) => [domain.key, domain]),
    );
    const clusterMap = new Map(clustersRef.current.map((cluster) => [cluster.id, cluster]));
    clusterMapRef.current = clusterMap;
    const domainMap = new Map(domainsRef.current.map((domain) => [domain.id, domain]));
    const localEdges: SimEdge[] = [];
    const crossClusterEdges: SimEdge[] = [];
    for (const edge of edges) {
      const source = map.get(simEdgeNodeId(edge.source));
      const target = map.get(simEdgeNodeId(edge.target));
      if (!source || !target) continue;
      source.rank += 1;
      target.rank += 1;
      // Legacy responses without cluster metadata retain their complete force
      // behavior. Hierarchical responses deliberately keep macro links out of
      // d3 so unrelated architecture domains cannot collapse into a hairball.
      const isLocal = source.cluster_id == null
        || target.cluster_id == null
        || source.cluster_id === target.cluster_id;
      (isLocal ? localEdges : crossClusterEdges).push(edge);
    }
    localEdgesRef.current = localEdges;
    let maxDegree = 1;
    for (const node of nodes) maxDegree = Math.max(maxDegree, node.rank);
    for (const node of nodes) node.rank = Math.sqrt(node.rank / maxDegree);
    const stellarNodeBatches = new Map<string, SimNode[]>();
    for (const node of nodes) {
      const key = stellarNodeColor(node) + Math.min(3, Math.floor(node.rank * 4));
      const batch = stellarNodeBatches.get(key);
      if (batch) batch.push(node);
      else stellarNodeBatches.set(key, [node]);
    }
    stellarNodeBatchesRef.current = stellarNodeBatches;
    const localBackboneEdges: SimEdge[] = [];
    const localDetailEdges: SimEdge[] = [];
    for (const edge of localEdges) {
      const source = map.get(simEdgeNodeId(edge.source))!;
      const target = map.get(simEdgeNodeId(edge.target))!;
      (source.rank > 0.51 || target.rank > 0.51
        ? localBackboneEdges
        : localDetailEdges).push(edge);
    }
    rawEdgeLayersRef.current = [localBackboneEdges, localDetailEdges];
    const stellarBackboneEdges: SimEdge[] = [];
    const stellarDetailEdges: SimEdge[] = [];
    for (const edge of edges) {
      const source = map.get(simEdgeNodeId(edge.source))!;
      const target = map.get(simEdgeNodeId(edge.target))!;
      (source.rank > 0.51 || target.rank > 0.51
        ? stellarBackboneEdges
        : stellarDetailEdges).push(edge);
    }
    stellarEdgeLayersRef.current = [stellarBackboneEdges, stellarDetailEdges];
    crossClusterEdgesRef.current = crossClusterEdges;
    const clusterBundlePlan = buildOverviewBundleBatches(
      edges,
      map,
      clusterMap,
      (node) => node.cluster_id,
      Math.min(
        MAX_COMMUNITY_BACKBONE_BUNDLES,
        Math.max(8, Math.ceil(clustersRef.current.length * 0.35)),
      ),
      (clusterId) => {
        const cluster = clusterMap.get(clusterId);
        return cluster ? domainMap.get(cluster.domain_id) : undefined;
      },
    );
    clusterBundleBatchesRef.current = clusterBundlePlan.batches;
    clusterTrafficRef.current = clusterBundlePlan.traffic;
    clusterTrafficTiersRef.current = clusterBundlePlan.trafficTiers;
    const domainBundlePlan = buildOverviewBundleBatches(
      edges,
      map,
      domainMap,
      (node) => node.cluster_id == null ? undefined : clusterMap.get(node.cluster_id)?.domain_id,
      Math.min(28, Math.max(10, domainsRef.current.length * 3)),
    );
    domainBundleBatchesRef.current = domainBundlePlan.batches;
    domainTrafficTiersRef.current = domainBundlePlan.trafficTiers;
    labelCandidatesRef.current = nodes
      // Parser-generated anonymous symbols use the stable `anonymous#N` form.
      .filter((node) => !/^anonymous#/.test(node.name))
      .sort((nodeA, nodeB) => nodeB.rank - nodeA.rank
        || nodeB.size - nodeA.size || nodeA.id - nodeB.id);
    const keyboardDomains = domainsRef.current.filter((domain) => visibleDomainIds.has(domain.id));
    const keyboardClusters = clustersRef.current.filter((cluster) => visibleClusterIds.has(cluster.id));
    keyboardVisibleCountsRef.current = {
      domain: keyboardDomains.length,
      community: keyboardClusters.length,
      node: nodes.length,
    };
    keyboardTargetsRef.current = {
      domain: keyboardDomains
        .slice(0, MAX_KEYBOARD_DOMAINS)
        .map((domain) => ({
          kind: "domain",
          id: domain.id,
          label: domain.key,
          x: domain.x,
          y: domain.y,
          radius: domain.radius,
        })),
      community: keyboardClusters
        .slice(0, MAX_KEYBOARD_COMMUNITIES)
        .map((cluster) => ({
          kind: "community",
          id: cluster.id,
          label: cluster.key,
          x: cluster.x,
          y: cluster.y,
          radius: cluster.radius,
        })),
      node: labelCandidatesRef.current.slice(0, MAX_KEYBOARD_NODES).map((node) => ({
        kind: "node",
        id: node.id,
        label: node.name || node.qualified_name || String(node.id),
        semanticLabel: node.label,
        x: node.x ?? 0,
        y: node.y ?? 0,
        radius: nodeRadius(node),
      })),
    };
    const keyboardFocus = keyboardFocusRef.current;
    if (keyboardFocus) {
      const refreshedFocus = keyboardTargetsRef.current[keyboardFocus.kind]
        .find((target) => target.id === keyboardFocus.id);
      keyboardFocusRef.current = refreshedFocus ?? null;
      if (!refreshedFocus && keyboardStatusRef.current) keyboardStatusRef.current.textContent = "";
    }
    if (lastHoverIdRef.current != null && (serverTopologyChanged || !map.has(lastHoverIdRef.current))) {
      lastHoverIdRef.current = null;
      onNodeHoverRef.current(null);
    }
    const edgeGroups = new Map<GraphEdgeGroup, SimEdge[]>();
    for (const edge of edges) {
      const group = graphEdgeGroup(edge.type);
      const bucket = edgeGroups.get(group);
      if (bucket) bucket.push(edge);
      else edgeGroups.set(group, [edge]);
    }
    edgeGroupsRef.current = edgeGroups;
    const refreshedKeyboardFocus = keyboardFocusRef.current;
    setStellarPreviewFocus(
      lastHoverIdRef.current
        ?? (refreshedKeyboardFocus?.kind === "node" ? refreshedKeyboardFocus.id : null),
      false,
    );

    if (simRef.current) {
      if (!topologyIdentical || serverTopologyChanged) {
        // Swap the active subset while retaining cached node objects. Merely
        // filtering to known topology (or restoring it) does not restart d3.
        // A server revision with the same IDs still reinitializes forceX/Y,
        // whose target arrays are cached by d3 during initialize().
        simRef.current.nodes(nodes);
        stellarSimulationReducedRef.current = false;
        (simRef.current.force("link") as any).links(
          visualModeRef.current === "stellar" ? edges : localEdges,
        );
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
        .alpha(1)
        .alphaDecay(SIMULATION_ALPHA_DECAY);

      // The following visual-mode effect installs Stellar forces directly.
      // Initializing Architecture here first would traverse every node/link
      // twice only to discard those force instances in the same commit.
      if (visualModeRef.current !== "stellar") {
        sim
          .force(
            "charge",
            forceManyBody().strength(CHARGE_STRENGTH).distanceMax(CHARGE_DISTANCE_MAX),
          )
          .force(
            "link",
            forceLink<SimNode, SimEdge>(localEdges)
              .id((d) => d.id)
              .distance(LOCAL_LINK_DISTANCE)
              .strength(0.3),
          )
          // Preserve the server's directory map while allowing gentle local
          // relaxation. This is the key distinction from a global force blob.
          .force("x", forceX<SimNode>((node) => node.anchorX).strength(ANCHOR_STRENGTH))
          .force("y", forceY<SimNode>((node) => node.anchorY).strength(ANCHOR_STRENGTH))
          .force("collide", forceCollide<SimNode>((node) => nodeRadius(node) + 4));
      }

      // R40 (UI-6): batch tick-driven draws via requestAnimationFrame.
      // d3 ticks much faster than 60fps during initial layout; without
      // batching, draw() runs many times per visible frame.
      sim.on("tick", () => {
        // Scope contours and hit targets are server-authored and static. Keep
        // d3's gentle local refinement inside those exact community circles so
        // the rendered node, its clickable scope, and the breadcrumb cannot
        // disagree after settling or a drag/release.
        if (visualModeRef.current !== "stellar") {
          for (const node of nodesRef.current) {
            if (node.cluster_id == null) continue;
            const cluster = clusterMapRef.current.get(node.cluster_id);
            if (!cluster) continue;
            const dx = (node.x ?? cluster.x) - cluster.x;
            const dy = (node.y ?? cluster.y) - cluster.y;
            const distance = Math.hypot(dx, dy);
            const maxDistance = Math.max(0, cluster.radius - nodeRadius(node) - 4);
            if (distance <= maxDistance || distance === 0) continue;
            const scale = maxDistance / distance;
            node.x = cluster.x + dx * scale;
            node.y = cluster.y + dy * scale;
            node.vx = 0;
            node.vy = 0;
          }
        }
        if (rafIdRef.current != null) return;
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          drawRef.current?.();
        });
      });

      simRef.current = sim as any;
    }
    // The visual-mode effect below also depends on `data` and owns the single
    // synchronous repaint after these refs are swapped. Painting here as well
    // doubled every non-empty data refresh, including initial GraphTab setup.
    scheduleInitialFit();
    if (!topologyAlreadyKnown) scheduleSettledFit();
    // No cleanup here — the sim is preserved across data changes. Cleanup is
    // handled by the unmount-only effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scheduleInitialFit, scheduleSettledFit, setStellarPreviewFocus]);

  // Stellar is a task layout, not a second renderer. Reconfigure the existing
  // simulation with deterministic constellation/flow targets while preserving
  // every d3 node object, interaction listener, and canvas allocation. A mode
  // or focus change is a real semantic-frame transition and receives one
  // bounded reheat; known filter subsets keep their settled positions.
  useEffect(() => {
    const sim = simRef.current;
    const nodes = nodesRef.current;
    if (!sim || nodes.length === 0) return;

    const previousFrame = previousFlowFrameRef.current;
    const previousFocusedNodeId = previousFrame.visualMode === "stellar"
      ? previousFrame.selectedNodeId
      : null;
    const modeChanged = previousFrame.visualMode !== visualMode;
    const focusChanged = visualMode === "stellar"
      && previousFrame.selectedNodeId !== selectedNodeId;
    const semanticFrameChanged = modeChanged || focusChanged;
    if (
      previousFocusedNodeId != null
      && (visualMode !== "stellar" || previousFocusedNodeId !== selectedNodeId)
    ) {
      // The previous focus may currently be filtered out of nodesRef. Release
      // its cached physics object as well so restoring that filter cannot
      // resurrect a second invisible pin.
      const previousFocusedNode = nodeStateCacheRef.current.get(previousFocusedNodeId);
      if (previousFocusedNode) {
        previousFocusedNode.fx = null;
        previousFocusedNode.fy = null;
      }
    }
    previousFlowFrameRef.current = { visualMode, selectedNodeId };

    if (visualMode === "stellar") {
      const targets = computeStellarFlowLayout(
        nodes,
        data.edges as readonly GraphEdge[],
        selectedNodeId,
      );
      const reduceOverviewSimulation = selectedNodeId == null
        && nodes.length >= STELLAR_OVERVIEW_SIMULATION_NODE_THRESHOLD;
      stellarFlowTargetsRef.current = targets;
      stellarConstellationRef.current = selectedNodeId == null
        ? summarizeStellarConstellation(targets)
        : { sectors: [], radius: 0 };
      stellarOverviewHubsRef.current = selectedNodeId == null
        ? nodes.filter((node) => targets.get(node.id)?.role === "hub")
        : [];
      stellarOverviewLabelCandidatesRef.current = selectedNodeId == null
        ? nodes
            .filter((node) => !LOW_INFORMATION_STELLAR_LABEL.test(node.name))
            .sort((left, right) => (
              stellarNodeDegree(right) - stellarNodeDegree(left)
              || right.rank - left.rank
              || right.name.length - left.name.length
              || left.id - right.id
            ))
        : [];
      stellarOverviewCommunityLabelsRef.current = selectedNodeId == null
        ? clustersRef.current
            .filter((cluster) => cluster.node_count >= 4)
            .slice(0, 6)
            .flatMap((cluster) => stellarOverviewLabelCandidatesRef.current
              .find((candidate) => candidate.cluster_id === cluster.id) ?? [])
        : [];
      stellarFlowLanesRef.current = summarizeStellarFlowLanes(targets);
      stellarFlowLabelCandidatesRef.current = selectedNodeId == null
        ? []
        : nodes
            .filter((node) => {
              const role = targets.get(node.id)?.role;
              return role != null && role !== "context" && role !== "focus";
            })
            .sort((left, right) => {
              const leftTarget = targets.get(left.id)!;
              const rightTarget = targets.get(right.id)!;
              return (leftTarget.depth ?? 0) - (rightTarget.depth ?? 0)
                || right.rank - left.rank
                || left.id - right.id;
            });
      const flowEdgeGroups = new Map<GraphEdgeGroup, StellarFlowEdgeBatch>();
      for (const edge of edgesRef.current) {
        const depth = stellarFlowEdgeDepth(
          simEdgeNodeId(edge.source),
          simEdgeNodeId(edge.target),
          targets,
        );
        if (depth == null) continue;
        const group = graphEdgeGroup(edge.type);
        let batch = flowEdgeGroups.get(group);
        if (!batch) {
          batch = { direct: [], transit: [] };
          flowEdgeGroups.set(group, batch);
        }
        (depth === 1 ? batch.direct : batch.transit).push(edge);
      }
      stellarFlowEdgeGroupsRef.current = flowEdgeGroups;
      stellarFlowRelationLabelRef.current = GRAPH_EDGE_GROUP_ORDER.flatMap((group) => {
        const batch = flowEdgeGroups.get(group);
        const count = batch?.direct.length ?? 0;
        return count ? [`${GRAPH_EDGE_GROUP_META[group].label} ${count}`] : [];
      }).join(" · ");
      for (const node of nodes) {
        const target = targets.get(node.id);
        if (!target) continue;
        node.anchorX = target.x;
        node.anchorY = target.y;
        if (reduceOverviewSimulation) {
          // The overview layout is already deterministic. Keep micro-symbols
          // on those exact coordinates and spend d3 work only on the hubs that
          // benefit perceptually from local collision/relaxation.
          node.x = target.x;
          node.y = target.y;
          node.vx = 0;
          node.vy = 0;
        } else if (target.role === "focus") {
          // The selected symbol is the semantic origin, not merely a soft
          // suggestion to d3. High fan-out link forces must never pull the
          // focus into an incoming/outgoing lane.
          node.x = 0;
          node.y = 0;
          node.vx = 0;
          node.vy = 0;
          node.fx = 0;
          node.fy = 0;
        } else if (node.id === previousFocusedNodeId) {
          node.fx = null;
          node.fy = null;
        }
      }
      const touchesFocus = (edge: SimEdge) => selectedNodeId != null && (
        simEdgeNodeId(edge.source) === selectedNodeId
        || simEdgeNodeId(edge.target) === selectedNodeId
      );
      let simulationNodes = nodes;
      let simulationEdges = edgesRef.current;
      if (reduceOverviewSimulation) {
        simulationNodes = nodes.filter((node) => targets.get(node.id)?.role === "hub");
        if (simulationNodes.length === 0) {
          simulationNodes = [nodes.reduce((best, node) => node.rank > best.rank ? node : best)];
        }
        const simulationNodeIds = new Set(simulationNodes.map((node) => node.id));
        simulationEdges = edgesRef.current.filter((edge) => (
          simulationNodeIds.has(simEdgeNodeId(edge.source))
          && simulationNodeIds.has(simEdgeNodeId(edge.target))
        ));
      }
      if (reduceOverviewSimulation) {
        sim.nodes(simulationNodes);
        stellarSimulationReducedRef.current = true;
      } else if (stellarSimulationReducedRef.current) {
        sim.nodes(nodes);
        stellarSimulationReducedRef.current = false;
      }
      sim
        .force(
          "charge",
          forceManyBody<SimNode>()
            .strength(STELLAR_CHARGE_STRENGTH)
            .distanceMax(STELLAR_CHARGE_DISTANCE_MAX),
        )
        .force(
          "link",
          forceLink<SimNode, SimEdge>(simulationEdges)
            .id((node) => node.id)
            .distance((edge) => touchesFocus(edge) ? STELLAR_FOCUS_LINK_DISTANCE : STELLAR_LINK_DISTANCE)
            .strength((edge) => touchesFocus(edge) ? 0.34 : 0.075),
        )
        .force(
          "x",
          forceX<SimNode>((node) => node.anchorX).strength((node) => (
            targets.get(node.id)?.role === "context"
              ? STELLAR_CONTEXT_ANCHOR_STRENGTH
              : STELLAR_ANCHOR_STRENGTH
          )),
        )
        .force(
          "y",
          forceY<SimNode>((node) => node.anchorY).strength((node) => (
            targets.get(node.id)?.role === "context"
              ? STELLAR_CONTEXT_ANCHOR_STRENGTH
              : STELLAR_ANCHOR_STRENGTH
          )),
        )
        .force("collide", forceCollide<SimNode>((node) => nodeRadius(node) + 7));
    } else {
      if (stellarSimulationReducedRef.current) {
        sim.nodes(nodes);
        stellarSimulationReducedRef.current = false;
      }
      stellarFlowTargetsRef.current = new Map();
      stellarConstellationRef.current = { sectors: [], radius: 0 };
      stellarOverviewHubsRef.current = [];
      stellarOverviewLabelCandidatesRef.current = [];
      stellarOverviewCommunityLabelsRef.current = [];
      stellarFlowLanesRef.current = { layers: [], modules: [] };
      stellarFlowLabelCandidatesRef.current = [];
      stellarFlowEdgeGroupsRef.current = new Map();
      stellarFlowRelationLabelRef.current = "";
      for (const node of nodes) {
        if (node.id === previousFocusedNodeId) {
          node.fx = null;
          node.fy = null;
        }
        node.anchorX = node.architectureX;
        node.anchorY = node.architectureY;
      }
      sim
        .force(
          "charge",
          forceManyBody<SimNode>().strength(CHARGE_STRENGTH).distanceMax(CHARGE_DISTANCE_MAX),
        )
        .force(
          "link",
          forceLink<SimNode, SimEdge>(localEdgesRef.current)
            .id((node) => node.id)
            .distance(LOCAL_LINK_DISTANCE)
            .strength(0.3),
        )
        .force("x", forceX<SimNode>((node) => node.anchorX).strength(ANCHOR_STRENGTH))
        .force("y", forceY<SimNode>((node) => node.anchorY).strength(ANCHOR_STRENGTH))
        .force("collide", forceCollide<SimNode>((node) => nodeRadius(node) + 4));
    }

    let frameDrawn = false;
    if (semanticFrameChanged) {
      cancelPendingAutoFit();
      cancelViewAnimation();
      hasUserInteractedRef.current = false;
      hasAutoFitRef.current = false;
      sim.alpha(STELLAR_LAYOUT_ALPHA);
      if (activeRef.current) sim.restart();
      if (visualMode === "stellar" && selectedNodeId != null) {
        if (!fitStellarFocus(true)) {
          animateToTransform({
            x: 0,
            y: 0,
            k: Math.max(0.72, Math.min(1.05, transformRef.current.k)),
          });
        }
      } else {
        frameDrawn = fitVisibleGraph();
        scheduleSettledFit();
      }
    } else if (dataRequiresLayoutReheatRef.current && visualMode === "stellar") {
      // The data effect already restarted genuinely new topology. Raise the
      // remaining heat for the newly installed flow forces without a second
      // restart call.
      sim.alpha(0.42);
    }
    dataRequiresLayoutReheatRef.current = false;
    if (!frameDrawn) drawRef.current?.();
  }, [
    animateToTransform,
    cancelPendingAutoFit,
    cancelViewAnimation,
    data,
    fitStellarFocus,
    fitVisibleGraph,
    scheduleSettledFit,
    selectedNodeId,
    visualMode,
  ]);

  // Overview and exact scopes intentionally reuse one canvas and simulation,
  // but they do not share a coordinate frame. Preserve pan/zoom across filters
  // and pagination, then re-fit only when the semantic frame itself changes.
  // Without this boundary an exact scope could inherit an overview transform
  // and look empty until the user pressed Fit.
  useEffect(() => {
    if (previousDetailModeRef.current === detailMode) return;
    previousDetailModeRef.current = detailMode;
    cancelViewAnimation();
    hasUserInteractedRef.current = false;
    hasAutoFitRef.current = fitVisibleGraph();
  }, [
    cancelViewAnimation,
    detailMode,
    fitVisibleGraph,
  ]);

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
      cancelViewAnimation();
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
  }, [cancelPendingAutoFit, cancelViewAnimation]);

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
    const backingScale = backingScaleRef.current;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.scale(backingScale.x, backingScale.y);
    ctx.translate(
      width / (2 * backingScale.x) + tx,
      height / (2 * backingScale.y) + ty,
    );
    ctx.scale(tk, tk);

    // R40 (UI-2): use the cached nodeMap instead of rebuilding it on every draw.
    // R49 (#9): batch edges into two passes (default + highlighted) to minimize
    // canvas state changes. The old code set strokeStyle/lineWidth PER EDGE,
    // forcing a state change each time — the #1 perf killer for large graphs.
    const nodeMap = nodeMapRef.current;
    // An empty Set is semantically the same as no selection. Treating it as
    // truthy used to dim every node and leave a phantom selection state.
    const activeHighlightedIds = visibleHighlightedIds;
    // A folder/community selection is one scope, not dozens of exact node
    // selections. Keep its membership contrast without multiplying rings,
    // radii, and labels beyond the existing mid-LOD attention budget.
    const denseSelection = activeHighlightedIds && activeHighlightedIds.size > MID_LABEL_LIMIT;
    const occupied: CollisionBox[] = [];
    const stellarFlow = visualMode === "stellar";
    const stellarFocused = stellarFlow
      && selectedNodeId != null
      && stellarFlowTargetsRef.current.get(selectedNodeId)?.role === "focus";
    const stellarOverview = stellarFlow && !stellarFocused;
    const stellarPreviewNodeId = stellarOverview ? stellarPreviewRef.current : null;
    const relationFocusId = selectedNodeId ?? stellarPreviewNodeId;

    // Directory communities are precomputed server-side and require only two
    // batched paths here, regardless of the node count. They make overview
    // structure visible before individual labels are readable.
    const projectedNodeSpacing = layoutNodeSpacingRef.current * tk;
    const domainOverview = !stellarFlow
      && projectedNodeSpacing < DOMAIN_OVERVIEW_MAX_PROJECTED_SPACING;
    const rawTopology = stellarFlow || detailMode
      || projectedNodeSpacing >= RAW_TOPOLOGY_MIN_PROJECTED_SPACING;
    const [
      overviewDomainBundleOpacity,
      overviewCommunityBundleOpacity,
      overviewCommunityReveal,
      overviewRawTopologyReveal,
    ] = computeSemanticZoomLayers(projectedNodeSpacing);
    const domainBundleOpacity = detailMode || stellarFlow ? 0 : overviewDomainBundleOpacity;
    const communityBundleOpacity = detailMode || stellarFlow ? 0 : overviewCommunityBundleOpacity;
    const communityReveal = detailMode || stellarFlow ? 0 : overviewCommunityReveal;
    const rawTopologyReveal = detailMode || stellarFlow ? 1 : overviewRawTopologyReveal;
    // Raw topology enters only after the community backbone has fully left.
    // Nodes lead their lower-contrast edges so intermediate frames disclose
    // readable symbols rather than a hairball.
    const rawNodeOpacity = stellarFlow
      ? 0.96
      : rawTopologyReveal * (0.78 + fadeBetween(projectedNodeSpacing, 22, 26) * 0.22);
    const rawDetailReveal = stellarFlow
      ? (stellarFocused ? 1 : fadeBetween(projectedNodeSpacing, 4, 10))
      : fadeBetween(projectedNodeSpacing, 22, 30);
    const localEdgeOpacity = stellarFlow
      ? (stellarFocused ? 0.075 : 0.19)
      : rawTopologyReveal * (0.18 + fadeBetween(projectedNodeSpacing, 22, 32) * 0.42);
    const crossEdgeOpacity = stellarFlow
      ? (stellarFocused ? 0.045 : 0.13)
      : rawTopologyReveal * fadeBetween(projectedNodeSpacing, 24, 36) * 0.45;
    const hoveredScope = hoveredScopeRef.current;
    const keyboardFocus = keyboardFocusRef.current;
    const activeDomainId = hoveredScope?.kind === "domain"
      ? hoveredScope.id
      : keyboardFocus?.kind === "domain"
        ? keyboardFocus.id
        : undefined;
    const activeCommunityId = hoveredScope?.kind === "community"
      ? hoveredScope.id
      : keyboardFocus?.kind === "community"
        ? keyboardFocus.id
        : undefined;

    if (!stellarFlow && domainsRef.current.length > 0) {
      // A small fixed palette makes top-level architecture areas immediately
      // distinguishable. Domains are still batched by palette slot, keeping
      // the number of canvas state changes constant even for large monorepos.
      for (let paletteIndex = 0; paletteIndex < DOMAIN_PALETTE.length; paletteIndex += 1) {
        let hasDomain = false;
        ctx.beginPath();
        for (const domain of domainsRef.current) {
          if (((domain.id % DOMAIN_PALETTE.length) + DOMAIN_PALETTE.length) % DOMAIN_PALETTE.length !== paletteIndex) continue;
          ctx.moveTo(domain.x + domain.radius, domain.y);
          ctx.arc(domain.x, domain.y, domain.radius, 0, Math.PI * 2);
          hasDomain = true;
        }
        if (!hasDomain) continue;
        const palette = DOMAIN_PALETTE[paletteIndex];
        ctx.fillStyle = palette.fill;
        ctx.fill();
        ctx.strokeStyle = palette.stroke;
        ctx.lineWidth = 1.35 / tk;
        ctx.stroke();
      }
    }

    if (!stellarFlow && domainOverview && domainTrafficTiersRef.current.size > 0) {
      // Domain area continues to encode code volume. A second, batched outline
      // adds the missing activity dimension without labels, gradients, or a
      // per-domain drawing state: only real cross-domain traffic can light it.
      for (let tier = 1; tier <= 4; tier += 1) {
        let hasTraffic = false;
        ctx.beginPath();
        for (const domain of domainsRef.current) {
          if (domainTrafficTiersRef.current.get(domain.id) !== tier) continue;
          const trafficRadius = domain.radius + (1.1 + tier * 0.3) / tk;
          ctx.moveTo(domain.x + trafficRadius, domain.y);
          ctx.arc(domain.x, domain.y, trafficRadius, 0, Math.PI * 2);
          hasTraffic = true;
        }
        if (!hasTraffic) continue;
        const trafficRgb = "103,232,249";
        ctx.strokeStyle = `rgba(${trafficRgb},${0.035 + tier * 0.045})`;
        ctx.lineWidth = (0.55 + tier * 0.4) / tk;
        ctx.stroke();
      }
    }

    if (!stellarFlow && clustersRef.current.length) {
      // Community discs replace thousands of unreadable node dots in the two
      // architecture tiers. Their size and position already encode the useful
      // information; domain color preserves nesting without adding a legend.
      // The same surface persists through the raw handoff and simply recedes,
      // keeping spatial context without another palette pass.
      for (let paletteIndex = 0; paletteIndex < DOMAIN_PALETTE.length; paletteIndex += 1) {
        let hasCluster = false;
        ctx.beginPath();
        for (const cluster of clustersRef.current) {
          if (((cluster.domain_id % DOMAIN_PALETTE.length) + DOMAIN_PALETTE.length) % DOMAIN_PALETTE.length !== paletteIndex) continue;
          ctx.moveTo(cluster.x + cluster.radius, cluster.y);
          ctx.arc(cluster.x, cluster.y, cluster.radius, 0, Math.PI * 2);
          hasCluster = true;
        }
        if (!hasCluster) continue;
        const palette = DOMAIN_PALETTE[paletteIndex];
        ctx.fillStyle = palette.clusterFill;
        ctx.fill();
        ctx.strokeStyle = palette.clusterStroke;
        ctx.lineWidth = 1.05 / tk;
        ctx.stroke();
      }
    }

    if (!stellarFlow && !rawTopology && clusterTrafficRef.current.size > 0) {
      // Two batched inner discs per occupied traffic tier create depth without
      // gradients, shadows, or per-community canvas state changes. This is a
      // semantic light source: quiet communities remain visually quiet while
      // high-traffic hubs gain a bounded focal core. At domain scale only the
      // upper tiers survive, providing a few useful beacons rather than noise.
      const minimumVisibleTier = domainOverview ? 3 : 1;
      const overviewScale = domainOverview ? 0.72 : 1;
      const overviewOpacity = domainOverview ? 0.68 : 1;
      const previousCompositeOperation = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";
      for (let tier = minimumVisibleTier; tier <= 4; tier += 1) {
        let hasTraffic = false;
        ctx.beginPath();
        for (const cluster of clustersRef.current) {
          if (clusterTrafficTiersRef.current.get(cluster.id) !== tier) continue;
          const bloomRadius = Math.min(
            cluster.radius * 0.3 * overviewScale,
            Math.max(3 / tk, cluster.radius * (0.12 + tier * 0.035)) * overviewScale,
          );
          ctx.moveTo(cluster.x + bloomRadius, cluster.y);
          ctx.arc(cluster.x, cluster.y, bloomRadius, 0, Math.PI * 2);
          hasTraffic = true;
        }
        if (!hasTraffic) continue;
        const trafficRgb = "103,232,249";
        ctx.fillStyle = `rgba(${trafficRgb},${(0.008 + tier * 0.01) * overviewOpacity})`;
        ctx.fill();

        ctx.beginPath();
        for (const cluster of clustersRef.current) {
          if (clusterTrafficTiersRef.current.get(cluster.id) !== tier) continue;
          const coreRadius = Math.min(
            cluster.radius * 0.14 * overviewScale,
            Math.max(1.5 / tk, cluster.radius * (0.045 + tier * 0.018)) * overviewScale,
          );
          ctx.moveTo(cluster.x + coreRadius, cluster.y);
          ctx.arc(cluster.x, cluster.y, coreRadius, 0, Math.PI * 2);
        }
        ctx.fillStyle = `rgba(207,250,254,${(0.08 + tier * 0.04) * overviewOpacity})`;
        ctx.fill();
      }
      ctx.globalCompositeOperation = previousCompositeOperation;

      // Four batched halo tiers recover the useful V1 "hub at a glance"
      // signal at community scale. The halo represents sampled cross-scope
      // traffic while circle area remains reserved for code volume.
      if (communityBundleOpacity) {
        for (let tier = 1; tier <= 4; tier += 1) {
          let hasTraffic = false;
          ctx.beginPath();
          for (const cluster of clustersRef.current) {
            const trafficTier = clusterTrafficTiersRef.current.get(cluster.id);
            if (trafficTier !== tier) continue;
            ctx.moveTo(cluster.x + cluster.radius + 1.5 / tk, cluster.y);
            ctx.arc(cluster.x, cluster.y, cluster.radius + 1.5 / tk, 0, Math.PI * 2);
            hasTraffic = true;
          }
          if (!hasTraffic) continue;
          const trafficRgb = "103,232,249";
          ctx.strokeStyle = `rgba(${trafficRgb},${0.08 + tier * 0.055})`;
          ctx.lineWidth = (0.7 + tier * 0.48) / tk;
          ctx.stroke();
        }
      }
    }

    const focusedScope = hoveredScope || keyboardFocus;
    if (!stellarFlow && focusedScope && focusedScope.kind !== "node") {
      const focusedCircle = focusedScope.kind === "domain"
        ? domainsRef.current.find((domain) => domain.id === focusedScope.id)
        : clustersRef.current.find((cluster) => cluster.id === focusedScope.id);
      if (focusedCircle) {
        const palette = focusedScope.kind === "domain"
          ? domainPalette(focusedCircle.id)
          : { hoverFill: "rgba(14, 165, 233, 0.075)", hoverStroke: "rgba(125, 211, 252, 0.82)" };
        ctx.beginPath();
        ctx.arc(focusedCircle.x, focusedCircle.y, focusedCircle.radius, 0, Math.PI * 2);
        ctx.fillStyle = palette.hoverFill;
        ctx.fill();
        ctx.strokeStyle = palette.hoverStroke;
        ctx.lineWidth = 2.2 / tk;
        ctx.stroke();
      }
    }

    if (stellarFlow) {
      // The guide is semantic, not decorative: without a focus, concentric
      // bands communicate degree-to-center. With a focus, the single axis
      // makes incoming/selected/outgoing placement readable before labels.
      const targets = stellarFlowTargetsRef.current;
      if (stellarFocused) {
        let minX = 0;
        let maxX = 0;
        let minY = 0;
        for (const target of targets.values()) {
          if (target.role === "context") continue;
          minX = Math.min(minX, target.x);
          maxX = Math.max(maxX, target.x);
          minY = Math.min(minY, target.y);
        }
        ctx.beginPath();
        ctx.moveTo(minX - 24 / tk, 0);
        ctx.lineTo(maxX + 24 / tk, 0);
        ctx.strokeStyle = "rgba(165, 180, 252, 0.15)";
        ctx.lineWidth = 0.8 / tk;
        ctx.stroke();

        // Depth rails turn the starburst into a directed frame. They are
        // precomputed only when the focus changes, so cooled redraws retain a
        // constant amount of work regardless of the project size.
        ctx.setLineDash([3 / tk, 5 / tk]);
        ctx.font = `650 ${8.5 / tk}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const lane of stellarFlowLanesRef.current.layers) {
          const top = lane.minY - 18 / tk;
          const bottom = lane.maxY + 18 / tk;
          ctx.beginPath();
          ctx.moveTo(lane.x, top);
          ctx.lineTo(lane.x, bottom);
          ctx.strokeStyle = lane.role === "incoming"
            ? "rgba(165, 180, 252, 0.12)"
            : lane.role === "outgoing"
              ? "rgba(103, 232, 249, 0.12)"
              : "rgba(216, 180, 254, 0.11)";
          ctx.lineWidth = 0.7 / tk;
          ctx.stroke();
          const direction = lane.role === "incoming" ? "IN" : lane.role === "outgoing" ? "OUT" : "BOTH";
          const label = `${direction} ${lane.depth} · ${lane.count}`;
          const labelY = top - 8 / tk;
          ctx.fillStyle = lane.role === "incoming"
            ? "rgba(165, 180, 252, 0.65)"
            : lane.role === "outgoing"
              ? "rgba(125, 211, 252, 0.65)"
              : "rgba(216, 180, 254, 0.6)";
          ctx.fillText(label, lane.x, labelY);
          const labelWidth = ctx.measureText(label).width;
          occupied.push({
            left: lane.x - labelWidth / 2 - 2 / tk,
            right: lane.x + labelWidth / 2 + 2 / tk,
            top: labelY - 6 / tk,
            bottom: labelY + 6 / tk,
          });
        }
        ctx.setLineDash([]);

        // Only repeated near-focus modules earn a label. This exposes the
        // architectural grouping needed for the task without turning every
        // node path into permanent chrome.
        ctx.font = `600 ${8 / tk}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        for (const module of stellarFlowLanesRef.current.modules
          .filter((candidate) => candidate.depth <= 2 && candidate.count > 1)
          .sort((left, right) => right.count - left.count || left.laneKey.localeCompare(right.laneKey))
          .slice(0, 6)) {
          const label = `${module.laneKey.length > 24 ? `…${module.laneKey.slice(-23)}` : module.laneKey} · ${module.count}`;
          const labelX = module.x;
          const labelY = module.minY - 8 / tk;
          const labelWidth = ctx.measureText(label).width;
          const box = {
            left: labelX - labelWidth / 2 - 2 / tk,
            right: labelX + labelWidth / 2 + 2 / tk,
            top: labelY - 6 / tk,
            bottom: labelY + 6 / tk,
          };
          if (hitsOccupied(box, occupied)) continue;
          occupied.push(box);
          ctx.strokeStyle = "rgba(3, 8, 14, 0.94)";
          ctx.lineWidth = 2.5 / tk;
          ctx.strokeText(label, labelX, labelY);
          ctx.fillStyle = "rgba(148, 197, 218, 0.7)";
          ctx.fillText(label, labelX, labelY);
        }

        const focusLabelY = minY - 42 / tk;
        ctx.font = `650 ${9 / tk}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = "rgba(236, 254, 255, 0.78)";
        const relationLabel = stellarFlowRelationLabelRef.current;
        ctx.fillText(relationLabel ? `VISIBLE · ${relationLabel}` : "FOCUS", 0, focusLabelY);
      } else if (targets.size > 0) {
        const { sectors, radius: maxRadius } = stellarConstellationRef.current;
        if (maxRadius > 0) {
          // Constellation geometry is intentionally elliptical. Paint its
          // guides in the same coordinate grammar instead of surrounding it
          // with unrelated circular decoration.
          ctx.save();
          ctx.scale(1, 0.82);

          for (let index = 0; index < sectors.length; index += 1) {
            const sector = sectors[index];
            const palette = domainPalette(index);
            ctx.beginPath();
            ctx.arc(0, 0, maxRadius * 0.98, sector.start, sector.start + sector.span);
            ctx.strokeStyle = palette.stroke;
            ctx.lineWidth = 1.2 / tk;
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    const drawBundleBatches = (
      batches: ReadonlyMap<string, OverviewBundle[]>,
      widthScale: number,
      opacity: number,
      focusId?: number,
      includeBundle?: (bundle: OverviewBundle) => boolean,
    ) => {
      const appendBundle = (bundle: OverviewBundle) => {
        ctx.moveTo(bundle.startX, bundle.startY);
        if (bundle.route === "corridor") {
          ctx.bezierCurveTo(
            bundle.control1X,
            bundle.control1Y,
            bundle.control2X,
            bundle.control2Y,
            bundle.endX,
            bundle.endY,
          );
        } else {
          ctx.quadraticCurveTo(bundle.control1X, bundle.control1Y, bundle.endX, bundle.endY);
        }
        // A constant-screen-size chevron encodes direction without adding a
        // separate stroke per edge bundle.
        const tangentX = bundle.endX - (
          bundle.route === "corridor" ? bundle.control2X : bundle.control1X
        );
        const tangentY = bundle.endY - (
          bundle.route === "corridor" ? bundle.control2Y : bundle.control1Y
        );
        const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
        const unitX = tangentX / tangentLength;
        const unitY = tangentY / tangentLength;
        const arrowLength = 5.5 / tk;
        const arrowWidth = 3.25 / tk;
        const arrowBaseX = bundle.endX - unitX * arrowLength;
        const arrowBaseY = bundle.endY - unitY * arrowLength;
        ctx.moveTo(arrowBaseX - unitY * arrowWidth, arrowBaseY + unitX * arrowWidth);
        ctx.lineTo(bundle.endX, bundle.endY);
        ctx.lineTo(arrowBaseX + unitY * arrowWidth, arrowBaseY - unitX * arrowWidth);
      };

      for (const bundles of batches.values()) {
        const first = bundles[0];
        if (!first) continue;
        const meta = GRAPH_EDGE_GROUP_META[first.group];
        ctx.strokeStyle = meta.stroke;
        ctx.setLineDash(meta.dash.map((segment) => segment / tk));
        ctx.lineWidth = Math.min(4.5, 0.75 + first.weight * 0.625) * widthScale / tk;
        const paint = (related: boolean, alpha: number) => {
          let hasPath = false;
          ctx.beginPath();
          for (const bundle of bundles) {
            if (includeBundle && !includeBundle(bundle)) continue;
            const isRelated = focusId == null
              || bundle.sourceId === focusId
              || bundle.targetId === focusId;
            if (focusId != null && isRelated !== related) continue;
            appendBundle(bundle);
            hasPath = true;
          }
          if (!hasPath) return;
          ctx.globalAlpha = opacity * alpha * 0.48;
          ctx.stroke();
        };
        if (focusId == null) paint(true, 1);
        else {
          // Keep just enough global context to preserve orientation while the
          // active scope's incoming and outgoing flows become unambiguous.
          paint(false, 0.12);
          paint(true, 1);
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };

    if (domainBundleOpacity && domainBundleBatchesRef.current.size) {
      drawBundleBatches(domainBundleBatchesRef.current, 1.25, domainBundleOpacity, activeDomainId);
    }
    if (communityBundleOpacity && clusterBundleBatchesRef.current.size) {
      const touchesActiveDomain = activeDomainId == null
        ? undefined
        : (bundle: OverviewBundle) => (
            clusterMapRef.current.get(bundle.sourceId)?.domain_id === activeDomainId
            || clusterMapRef.current.get(bundle.targetId)?.domain_id === activeDomainId
          );
      // Keep architecture flows in the negative space between communities.
      // A single even-odd clip masks every disc in one batched operation, so
      // unrelated routes can pass behind scopes without visually cutting
      // through them or adding per-edge obstacle work during redraws.
      ctx.save();
      ctx.beginPath();
      ctx.rect(-10_000_000, -10_000_000, 20_000_000, 20_000_000);
      for (const cluster of clustersRef.current) {
        const maskRadius = cluster.radius + 1.5 / tk;
        ctx.moveTo(cluster.x + maskRadius, cluster.y);
        ctx.arc(cluster.x, cluster.y, maskRadius, 0, Math.PI * 2);
      }
      ctx.clip("evenodd");
      drawBundleBatches(
        clusterBundleBatchesRef.current,
        0.78,
        communityBundleOpacity,
        activeCommunityId,
        touchesActiveDomain,
      );
      ctx.restore();
    }

    // Hub-connected links establish the raw backbone before quiet local
    // links fade in. Each tier remains a single canvas batch.
    if (localEdgeOpacity) {
      const edgeLayers = stellarOverview ? stellarEdgeLayersRef.current : rawEdgeLayersRef.current;
      ctx.strokeStyle = stellarOverview
        ? "rgba(96, 165, 250, 0.34)"
        : rawTopology
          ? "rgba(100, 135, 158, 0.18)"
          : "rgba(100, 135, 158, 0.105)";
      ctx.lineWidth = (stellarOverview ? 0.78 : rawTopology ? 0.65 : 0.5) / tk;
      ctx.globalAlpha = localEdgeOpacity;
      ctx.beginPath();
      traceEdges(ctx, edgeLayers[0], nodeMap, selectedNodeId);
      ctx.stroke();
      if (rawDetailReveal) {
        ctx.strokeStyle = stellarOverview
          ? "rgba(100, 135, 158, 0.18)"
          : ctx.strokeStyle;
        ctx.lineWidth = (stellarOverview ? 0.5 : rawTopology ? 0.65 : 0.5) / tk;
        ctx.globalAlpha *= rawDetailReveal * (stellarOverview ? 0.72 : 1);
        ctx.beginPath();
        traceEdges(ctx, edgeLayers[1], nodeMap, selectedNodeId);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    if (crossEdgeOpacity && !stellarOverview) {
      ctx.globalAlpha = crossEdgeOpacity;
      ctx.strokeStyle = "rgba(100, 135, 158, 0.18)";
      ctx.lineWidth = 0.65 / tk;
      ctx.beginPath();
      traceEdges(ctx, crossClusterEdgesRef.current, nodeMap, selectedNodeId);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Pass 2: highlighted edges — grouped into at most five semantic stroke
    // batches. This restores relation meaning without per-edge style changes.
    if (localEdgeOpacity && relationFocusId != null && (activeHighlightedIds || stellarPreviewNodeId != null)) {
      if (stellarFocused) {
        // Multi-hop flow edges are pre-batched when focus changes. Direct
        // relations lead; depths 2–4 retain the same semantic pattern at a
        // quieter weight instead of falling back to anonymous gray links.
        for (const [group, batch] of stellarFlowEdgeGroupsRef.current) {
          const meta = GRAPH_EDGE_GROUP_META[group];
          ctx.strokeStyle = meta.stroke;
          ctx.setLineDash(meta.dash.map((segment) => segment / tk));
          if (batch.transit.length > 0) {
            ctx.globalAlpha = rawNodeOpacity * 0.42;
            ctx.lineWidth = 0.9 / tk;
            ctx.beginPath();
            traceEdges(ctx, batch.transit, nodeMap, null);
            ctx.stroke();
          }
          if (batch.direct.length > 0) {
            ctx.globalAlpha = rawNodeOpacity;
            ctx.lineWidth = 1.25 / tk;
            ctx.beginPath();
            traceEdges(ctx, batch.direct, nodeMap, null);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            if (traceSelectedDirectionMarkers(ctx, batch.direct, nodeMap, relationFocusId, 4.5 / tk)) {
              ctx.lineWidth = 0.9 / tk;
              ctx.stroke();
            }
          }
        }
      } else {
        ctx.globalAlpha = rawNodeOpacity;
        ctx.lineWidth = 1.2 / tk;
        const limit = stellarPreviewNodeId != null ? 2 : Number.POSITIVE_INFINITY;
        for (const [group, groupedEdges] of edgeGroupsRef.current) {
          const meta = GRAPH_EDGE_GROUP_META[group];
          ctx.setLineDash(meta.dash.map((segment) => segment / tk));
          ctx.beginPath();
          if (!traceEdges(ctx, groupedEdges, nodeMap, relationFocusId, true, limit)) continue;
          ctx.strokeStyle = meta.stroke;
          ctx.stroke();
          if (stellarPreviewNodeId != null) {
            ctx.setLineDash([]);
            ctx.beginPath();
            if (traceSelectedDirectionMarkers(ctx, groupedEdges, nodeMap, relationFocusId, 4.5 / tk, limit)) ctx.stroke();
          }
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    if (stellarPreviewNodeId != null) {
      const previewNode = nodeMap.get(stellarPreviewNodeId);
      if (previewNode) paintStellarFirstHopPreview(ctx, previewNode, tk);
    }

    // One batched additive path recovers the useful V1 hub-at-a-glance signal
    // without gradients, shadows, per-node filters, or any change to the
    // collision radii and simulation state.
    if (stellarOverview && rawNodeOpacity) {
      let hasHub = false;
      ctx.beginPath();
      for (const node of stellarOverviewHubsRef.current) {
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const glowRadius = nodeRadius(node) + 3.5 / tk;
        const obstacleRadius = glowRadius + 1.5 / tk;
        occupied.push({
          left: x - obstacleRadius,
          right: x + obstacleRadius,
          top: y - obstacleRadius,
          bottom: y + obstacleRadius,
        });
        if (activeHighlightedIds && !activeHighlightedIds.has(node.id) && node.id !== selectedNodeId) continue;
        ctx.moveTo(x + glowRadius, y);
        ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
        hasHub = true;
      }
      if (hasHub) {
        const previousCompositeOperation = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgba(128, 160, 255, 0.18)";
        ctx.globalAlpha = rawNodeOpacity;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = previousCompositeOperation;
      }
    }

    // The quiet Stellar overview quantizes rank opacity into four perceptual
    // tiers and batches each spectral color. All symbols remain present, but a
    // 1,000-node frame now needs at most 40 fills instead of 1,000.
    const batchStellarNodes = stellarFlow && !stellarFocused
      && !activeHighlightedIds && !deadCodeView && keyboardFocus?.kind !== "node";
    if (batchStellarNodes) {
      for (const [key, nodes] of stellarNodeBatchesRef.current) {
        ctx.beginPath();
        for (const node of nodes) {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const radius = Math.max(nodeRadius(node), 1.2 / tk);
          if (stellarOverview && nodeRadius(node) * tk < 2.4) {
            ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
          } else {
            ctx.moveTo(x + radius, y);
            traceNodePath(ctx, node, x, y, radius, visualMode);
          }
        }
        ctx.fillStyle = key.slice(0, 7);
        ctx.globalAlpha = rawNodeOpacity * (0.37 + Number(key[7]) * 0.21);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Draw nodes. Semantic fill is never replaced by selection or status;
    // those dimensions use outer rings so the graph remains decodable. Nodes
    // enter before dense edge layers, and are never painted in macro views.
    for (const node of rawNodeOpacity && !batchStellarNodes ? nodesRef.current : []) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const isHighlighted = activeHighlightedIds?.has(node.id);
      const individualHighlight = (isHighlighted && !denseSelection) || node.id === selectedNodeId;
      const isFocused = keyboardFocus?.kind === "node" && keyboardFocus.id === node.id;
      const flowTarget = stellarFlowTargetsRef.current.get(node.id);
      const priorityReveal = stellarFlow
        ? 0.28 + 0.72 * node.rank
        : rawDetailReveal + (1 - rawDetailReveal) * (0.12 + 0.88 * node.rank);
      const nodeOpacity = rawNodeOpacity
        * (isHighlighted || isFocused || node.id === selectedNodeId ? 1 : priorityReveal)
        * (stellarFocused && flowTarget?.role === "context" ? 0.2 : 1);
      // Keep overview dots legible without inflating simulation collision
      // radii. The floor is expressed in screen pixels, so it disappears as
      // soon as semantic zoom makes the real node size readable.
      const baseRadius = Math.max(nodeRadius(node), 1.2 / tk);
      const r = individualHighlight ? baseRadius * 1.5 : baseRadius;

      const color = visualMode === "stellar"
        ? stellarNodeColor(node)
        : colorForLabel(node.label);

      ctx.beginPath();
      traceNodePath(ctx, node, x, y, r, visualMode);
      ctx.fillStyle = color;
      const selectionAttenuation = activeHighlightedIds && !isHighlighted && node.id !== selectedNodeId
        ? stellarFlow
          ? flowTarget?.role === "context" ? 0.2 : 0.58
          : 0.3
        : 1;
      ctx.globalAlpha = nodeOpacity * selectionAttenuation;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (deadCodeView && node.status) {
        ctx.globalAlpha = nodeOpacity;
        ctx.strokeStyle = colorForStatus(node.status);
        ctx.lineWidth = 1.4 / tk;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (individualHighlight) {
        ctx.beginPath();
        ctx.arc(x, y, r + (node.id === selectedNodeId ? 4 : 2.5) / tk, 0, Math.PI * 2);
        ctx.strokeStyle = node.id === selectedNodeId
          ? "rgba(236, 254, 255, 0.98)"
          : "rgba(34, 211, 238, 0.82)";
        ctx.lineWidth = (node.id === selectedNodeId ? 2.2 : 1.2) / tk;
        ctx.globalAlpha = rawNodeOpacity;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (isFocused) {
        ctx.beginPath();
        ctx.arc(x, y, r + 5 / tk, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(236, 254, 255, 0.98)";
        ctx.lineWidth = 2.4 / tk;
        ctx.globalAlpha = rawNodeOpacity;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Labels are painted after edges and nodes so no topology line can cut
    // through them. Domain names remain as dimmed anchors while community and
    // node labels progressively inherit the available attention budget.
    if (!stellarFlow && domainsRef.current.length) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = previousAlpha * (1 - communityReveal * 0.55);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const domain of domainsRef.current) {
        const title = domain.key;
        const exactDomain = domainCatalogRef.current.get(domain.key);
        const groupLabel = domain.cluster_count === 1 ? "group" : "groups";
        const showSummary = activeDomainId === domain.id;
        // Counts are useful when the user asks about one scope, but repeating
        // them across the whole map competes with the architecture. The exact
        // full-domain count therefore appears only for the active scope.
        const summary = exactDomain
          ? `${compactArchitectureCount(exactDomain.node_count)} nodes · ${domain.cluster_count} ${groupLabel}`
          : `${compactArchitectureCount(domain.node_count)} nodes · ${domain.cluster_count} ${groupLabel}`;
        const palette = domainPalette(domain.id);
        const titleY = domain.y - domain.radius + 14 / tk;
        const summaryY = titleY + 16 / tk;
        ctx.font = `750 ${13 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
        const titleWidth = ctx.measureText(title).width;
        ctx.font = `500 ${9.5 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
        const summaryWidth = showSummary ? ctx.measureText(summary).width : 0;
        const boxWidth = Math.max(titleWidth, summaryWidth) + 12 / tk;
        const box = {
          left: domain.x - boxWidth / 2,
          right: domain.x + boxWidth / 2,
          top: titleY - 4 / tk,
          bottom: showSummary ? summaryY + 13 / tk : titleY + 15 / tk,
        };
        const collides = hitsOccupied(box, occupied);
        if (collides) continue;
        occupied.push(box);
        ctx.font = `750 ${13 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
        ctx.strokeStyle = "rgba(3, 8, 14, 0.94)";
        ctx.lineWidth = 4 / tk;
        ctx.strokeText(title, domain.x, titleY);
        ctx.fillStyle = palette.title;
        ctx.fillText(title, domain.x, titleY);
        if (showSummary) {
          ctx.font = `500 ${9.5 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = palette.meta;
          ctx.fillText(summary, domain.x, summaryY);
        }
      }
      ctx.globalAlpha = previousAlpha;
    }

    const structureLabelReveal = detailMode ? 1 : domainOverview ? 0.62 : communityReveal;
    if (!stellarFlow && structureLabelReveal && clustersRef.current.length) {
      const previousAlpha = ctx.globalAlpha;
      ctx.globalAlpha = previousAlpha * structureLabelReveal * (1 - rawTopologyReveal * 0.55);
      const clusterLimit = domainOverview ? 12 : Math.round(28 + (64 - 28) * rawTopologyReveal);
      const activeCluster = activeCommunityId == null
        ? undefined
        : clusterMapRef.current.get(activeCommunityId);
      const clusterFontSize = 10 / tk;
      ctx.font = `650 ${clusterFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      // The plan is already sorted by represented node count. Paint the
      // active community first without cloning, mapping, or sorting per frame.
      for (let order = -1, considered = 0; considered < clusterLimit && order < clustersRef.current.length; order += 1) {
        const cluster = order < 0 ? activeCluster : clustersRef.current[order];
        if (!cluster || (order >= 0 && cluster.id === activeCommunityId)) continue;
        if (activeDomainId != null && cluster.domain_id !== activeDomainId) continue;
        considered += 1;
        if (domainOverview && cluster.radius * tk < 18) continue;
        const domainKey = domainsRef.current.find((domain) => domain.id === cluster.domain_id)?.key;
        const prefix = domainKey && cluster.key.startsWith(`${domainKey}/`) ? `${domainKey}/` : "";
        const label = cluster.key.slice(prefix.length);
        const showSummary = cluster.id === activeCommunityId;
        const traffic = clusterTrafficRef.current.get(cluster.id);
        const countScope = detailMode ? "exact" : "shown";
        const summary = traffic
          ? `${compactArchitectureCount(cluster.node_count)} ${countScope} nodes · ${compactArchitectureCount(traffic.incoming)} in · ${compactArchitectureCount(traffic.outgoing)} out`
          : `${compactArchitectureCount(cluster.node_count)} ${countScope} nodes`;
        const labelX = cluster.x;
        const labelY = cluster.y - cluster.radius + 9 / tk;
        ctx.font = `650 ${clusterFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const labelWidth = ctx.measureText(label).width;
        ctx.font = `500 ${8.5 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
        const summaryWidth = showSummary ? ctx.measureText(summary).width : 0;
        const width = Math.max(labelWidth, summaryWidth);
        const summaryY = labelY + 12 / tk;
        const box = {
          left: labelX - width / 2 - 3 / tk,
          right: labelX + width / 2 + 3 / tk,
          top: labelY - 2 / tk,
          bottom: showSummary ? summaryY + 11 / tk : labelY + 12 / tk,
        };
        const collides = hitsOccupied(box, occupied);
        if (collides) continue;
        occupied.push(box);
        ctx.font = `650 ${clusterFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.strokeStyle = "rgba(3, 8, 14, 0.92)";
        ctx.lineWidth = 3 / tk;
        ctx.strokeText(label, labelX, labelY);
        ctx.fillStyle = "rgba(165, 219, 239, 0.78)";
        ctx.fillText(label, labelX, labelY);
        if (showSummary) {
          ctx.font = `500 ${8.5 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = "rgba(125, 211, 252, 0.82)";
          ctx.fillText(summary, labelX, summaryY);
        }
      }
      ctx.globalAlpha = previousAlpha;
    }

    if (stellarOverview && stellarConstellationRef.current.sectors.length > 1) {
      // Sector and node labels share the hub obstacles recorded by the halo
      // pass instead of constructing a second collision map.
      const { sectors, radius: maxRadius } = stellarConstellationRef.current;
      const captions: [string, number, number, string, boolean][] = [];
      for (let index = 0; index < sectors.length; index += 1) {
        const sector = sectors[index];
        if (sector.key !== "other") captions.push([
          `${sector.key} · ${compactArchitectureCount(sector.count)}`,
          sector.mid,
          0.94,
          domainPalette(index).title,
          true,
        ]);
      }
      for (const node of stellarOverviewCommunityLabelsRef.current) {
        const target = stellarFlowTargetsRef.current.get(node.id)!;
        const community = clusterMapRef.current.get(node.cluster_id!)!;
        const key = community.key;
        captions.push([
          `${key.length > 25 ? `…${key.slice(-24)}` : key} · ${compactArchitectureCount(community.node_count)}`,
          Math.atan2(target.y / 0.82, target.x),
          0.82,
          "rgba(148, 197, 218, 0.7)",
          false,
        ]);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [label, angle, radius, color, major] of captions) {
        ctx.font = `${major ? 700 : 650} ${(major ? 10.5 : 9) / tk}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const labelRadius = maxRadius * radius;
        const labelX = Math.cos(angle) * labelRadius;
        const labelY = Math.sin(angle) * labelRadius * 0.82;
        const labelWidth = ctx.measureText(label).width;
        const padding = (major ? 4 : 3) / tk;
        const halfHeight = (major ? 8 : 7) / tk;
        const box = {
          left: labelX - labelWidth / 2 - padding,
          right: labelX + labelWidth / 2 + padding,
          top: labelY - halfHeight,
          bottom: labelY + halfHeight,
        };
        if (hitsOccupied(box, occupied)) continue;
        occupied.push(box);
        ctx.strokeStyle = "rgba(3, 8, 14, 0.96)";
        ctx.lineWidth = (major ? 4 : 3) / tk;
        ctx.strokeText(label, labelX, labelY);
        ctx.fillStyle = color;
        ctx.fillText(label, labelX, labelY);
      }
    }

    // Zoom-dependent labels with collision avoidance. The selected node is
    // always attempted first, followed by its neighborhood and ranked hubs.
    const viewport = {
      width: width / backingScale.x,
      height: height / backingScale.y,
    };
    const labelLimit = stellarFlow
      ? (stellarFocused ? stellarFocusLabelBudget(viewport) : STELLAR_OVERVIEW_LABEL_LIMIT)
      : rawTopologyReveal
        && (denseSelection
          ? 12
          : projectedNodeSpacing < 32
            ? MID_LABEL_LIMIT
            : NEAR_LABEL_LIMIT);
    const labelNodes: SimNode[] = [];
    const labelKeys = new Set<number | string>();
    // The exact selected node remains first in the raw-topology label budget.
    // Every other label, including a large highlighted neighborhood, shares
    // the same bounded semantic-zoom budget.
    const addLabelNode = (node: SimNode | undefined) => {
      if (!node || labelKeys.has(denseSelection ? node.name : node.id) || labelNodes.length >= labelLimit) return;
      labelKeys.add(denseSelection ? node.name : node.id);
      labelNodes.push(node);
    };
    if (stellarFocused) {
      addLabelNode(selectedNodeId != null ? nodeMap.get(selectedNodeId) : undefined);
      if (activeHighlightedIds) {
        for (const node of stellarFlowLabelCandidatesRef.current) {
          if (activeHighlightedIds.has(node.id)) addLabelNode(node);
        }
      }
      for (const node of stellarFlowLabelCandidatesRef.current) addLabelNode(node);
    } else {
      addLabelNode(rawTopologyReveal && selectedNodeId != null ? nodeMap.get(selectedNodeId) : undefined);
      if (activeHighlightedIds && !denseSelection) {
        for (const id of activeHighlightedIds) addLabelNode(nodeMap.get(id));
      }
    }
    if (!stellarFocused) {
      const candidates = stellarOverview
        ? stellarOverviewLabelCandidatesRef.current
        : labelCandidatesRef.current;
      for (const node of candidates) {
        if (denseSelection && (
          !activeHighlightedIds.has(node.id)
          || Math.abs((node.x ?? 0) * tk + tx) > width / backingScale.x / 2
          || Math.abs((node.y ?? 0) * tk + ty) > height / backingScale.y / 2
        )) continue;
        addLabelNode(node);
        if (labelNodes.length >= labelLimit) break;
      }
    }

    const labelHeight = 13 / tk;
    ctx.font = `500 ${10.5 / tk}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const previousLabelAlpha = ctx.globalAlpha;
    ctx.globalAlpha = previousLabelAlpha * rawTopologyReveal;

    if (stellarFocused) {
      // Labels may move around their own node, but never cover another node in
      // the directed frame. Context dots stay excluded to keep this O(flow).
      for (const node of nodesRef.current) {
        const target = stellarFlowTargetsRef.current.get(node.id);
        if (!target || target.role === "context" || target.role === "hub") continue;
        const radius = nodeRadius(node) + 2 / tk;
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        occupied.push({
          left: x - radius,
          right: x + radius,
          top: y - radius,
          bottom: y + radius,
        });
      }
    }

    for (const node of labelNodes) {
      const rawLabel = node.name || node.qualified_name || String(node.id);
      const label = rawLabel.length > 34 ? `${rawLabel.slice(0, 31)}…` : rawLabel;
      const nodeX = node.x ?? 0;
      const nodeY = node.y ?? 0;
      const textWidth = ctx.measureText(label).width;
      const anchors = stellarFocused
        ? stellarFlowLabelAnchors(
            stellarFlowTargetsRef.current.get(node.id)?.role,
            nodeX,
            nodeY,
            nodeRadius(node),
            1 / tk,
          )
        : stellarOverview
          ? stellarOverviewLabelAnchors(
              nodeX,
              nodeY,
              nodeRadius(node),
              1 / tk,
            )
        : [{ x: nodeX + nodeRadius(node) + 4 / tk, y: nodeY, align: "left" as const }];
      let placement: (typeof anchors)[number] | undefined;
      let placementBox: { left: number; right: number; top: number; bottom: number } | undefined;
      for (const anchor of anchors) {
        const box = {
          left: anchor.align === "left" ? anchor.x - 2 / tk : anchor.x - textWidth - 2 / tk,
          right: anchor.align === "left" ? anchor.x + textWidth + 2 / tk : anchor.x + 2 / tk,
          top: anchor.y - labelHeight / 2,
          bottom: anchor.y + labelHeight / 2,
        };
        if (
          stellarFocused
          && !stellarFocusWorldBoxFitsViewport(box, transformRef.current, viewport)
        ) continue;
        const collides = hitsOccupied(box, occupied);
        if (!collides || node.id === selectedNodeId) {
          placement = anchor;
          placementBox = box;
          break;
        }
      }
      if (!placement || !placementBox) continue;
      occupied.push(placementBox);
      ctx.textAlign = placement.align;
      ctx.strokeStyle = "rgba(3, 8, 14, 0.94)";
      ctx.lineWidth = 3 / tk;
      ctx.strokeText(label, placement.x, placement.y);
      ctx.fillStyle = node.id === selectedNodeId
        ? "rgba(236, 254, 255, 0.98)"
        : "rgba(203, 225, 236, 0.88)";
      ctx.fillText(label, placement.x, placement.y);
    }
    ctx.globalAlpha = previousLabelAlpha;

    ctx.restore();
  }, [visibleHighlightedIds, selectedNodeId, deadCodeView, detailMode, visualMode]);

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
    // The browser creates canvases at 300x150. The resize effect below sizes
    // the backing store and performs the first real paint; drawing here before
    // that point traversed the complete graph into a frame that was discarded.
    if (canvasRef.current?.style.width) draw();
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
      const backingStore = boundedCanvasBackingStore(parent.clientWidth, parent.clientHeight);
      const cssWidth = parent.clientWidth + 'px';
      const cssHeight = parent.clientHeight + 'px';
      if (
        canvas.width === backingStore.width
        && canvas.height === backingStore.height
        && canvas.style.width === cssWidth
        && canvas.style.height === cssHeight
      ) return;
      backingScaleRef.current = { x: backingStore.scaleX, y: backingStore.scaleY };
      canvas.width = backingStore.width;
      canvas.height = backingStore.height;
      canvas.style.width = cssWidth;
      canvas.style.height = cssHeight;
      if (!hasUserInteractedRef.current && fitStellarFocus()) {
        cancelPendingAutoFit();
      } else if (!hasAutoFitRef.current && !hasUserInteractedRef.current) {
        if (nodesRef.current.length >= DEFERRED_INITIAL_FIT_NODE_THRESHOLD) {
          // Sizing is part of React's passive-effect flush. Keep a large O(n)
          // bounds scan out of that already busy task and fit on the next
          // visual frame. This coalesces with the data effect's pending fit.
          scheduleInitialFit();
        } else if (fitVisibleGraph()) {
          hasAutoFitRef.current = true;
          cancelPendingAutoFit();
        }
      } else {
        drawRef.current?.();
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, [cancelPendingAutoFit, fitStellarFocus, fitVisibleGraph, scheduleInitialFit]);

  // Mouse and touch interaction (pan, zoom, click/tap, drag, pinch)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let pointerStart = { x: 0, y: 0 };
    let tooltipPositionRaf: number | null = null;
    let pendingTooltipPosition: GraphTooltipPositionDetail | null = null;

    const cancelTooltipPosition = () => {
      pendingTooltipPosition = null;
      if (tooltipPositionRaf != null) {
        cancelAnimationFrame(tooltipPositionRaf);
        tooltipPositionRaf = null;
      }
    };

    const queueTooltipPosition = (position: GraphTooltipPositionDetail) => {
      pendingTooltipPosition = position;
      if (tooltipPositionRaf != null) return;
      tooltipPositionRaf = requestAnimationFrame(() => {
        tooltipPositionRaf = null;
        const detail = pendingTooltipPosition;
        pendingTooltipPosition = null;
        if (!detail) return;
        canvas.parentElement?.dispatchEvent(new CustomEvent<GraphTooltipPositionDetail>(
          GRAPH_TOOLTIP_POSITION_EVENT,
          { detail },
        ));
      });
    };

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
      let closest: SimNode | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const node of nodesRef.current) {
        const dx = (node.x ?? 0) - scaledX;
        const dy = (node.y ?? 0) - scaledY;
        // Keep a usable 20px diameter hit target at overview scale and choose
        // the closest candidate when projected hit areas overlap.
        const hitRadius = Math.max(nodeRadius(node) * 1.5, 10 / k);
        const distance = dx * dx + dy * dy;
        if (distance < hitRadius ** 2 && distance < closestDistance) {
          closest = node;
          closestDistance = distance;
        }
      }
      return closest;
    };

    const findScopeAt = (mx: number, my: number): Omit<GraphScopeSelection, "nodeIds"> | null => {
      if (!onScopeSelectRef.current || visualModeRef.current === "stellar") return null;
      const k = transformRef.current.k;
      const projectedNodeSpacing = layoutNodeSpacingRef.current * k;
      if (projectedNodeSpacing >= RAW_TOPOLOGY_MIN_PROJECTED_SPACING) return null;
      const scaledX = mx / k;
      const scaledY = my / k;
      const candidates = projectedNodeSpacing < DOMAIN_OVERVIEW_MAX_PROJECTED_SPACING
        ? domainsRef.current.map((scope) => ({ ...scope, kind: "domain" as const }))
        : clustersRef.current.map((scope) => ({ ...scope, kind: "community" as const }));
      let closest: (typeof candidates)[number] | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const scope of candidates) {
        const dx = scope.x - scaledX;
        const dy = scope.y - scaledY;
        const distance = dx * dx + dy * dy;
        if (distance <= scope.radius ** 2 && distance < closestDistance) {
          closest = scope;
          closestDistance = distance;
        }
      }
      return closest ? { kind: closest.kind, id: closest.id, key: closest.key } : null;
    };

    const selectScopeAt = (mx: number, my: number): boolean => {
      const scope = findScopeAt(mx, my);
      if (!scope) return false;
      activateScope(scope);
      return true;
    };

    const updateHoveredScope = (scope: Omit<GraphScopeSelection, "nodeIds"> | null) => {
      const previous = hoveredScopeRef.current;
      if (previous?.kind === scope?.kind && previous?.id === scope?.id) return;
      hoveredScopeRef.current = scope;
      drawRef.current?.();
    };

    const onMouseDown = (e: MouseEvent) => {
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      cancelViewAnimation();
      updateHoveredScope(null);
      pointerStart = { x: e.clientX, y: e.clientY };
      const pos = getGraphPos(e.clientX, e.clientY);
      // At domain/community LOD, projected node spacing is smaller than the
      // minimum node hit target. Resolve the visible architecture scope first
      // so dense node hit-discs cannot make drill-down unreachable. At raw LOD
      // findScopeAt returns null and node interaction keeps its precedence.
      const scope = findScopeAt(pos.x, pos.y);
      const node = scope ? null : findNodeAt(pos.x, pos.y);
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
        const scope = findScopeAt(pos.x, pos.y);
        const node = scope ? null : findNodeAt(pos.x, pos.y);
        updateHoveredScope(scope);
        const hoverId = node?.id ?? null;
        if (hoverId !== lastHoverIdRef.current) {
          lastHoverIdRef.current = hoverId;
          const keyboardFocus = keyboardFocusRef.current;
          setStellarPreviewFocus(
            hoverId ?? (keyboardFocus?.kind === "node" ? keyboardFocus.id : null),
          );
          onNodeHoverRef.current(node ?? null, screenPos);
        }
        if (node) queueTooltipPosition(screenPos);
        else cancelTooltipPosition();
        canvas.style.cursor = node || scope ? "pointer" : "default";
      }
    };

    const onMouseLeave = () => {
      cancelTooltipPosition();
      updateHoveredScope(null);
      if (lastHoverIdRef.current != null) {
        lastHoverIdRef.current = null;
        const keyboardFocus = keyboardFocusRef.current;
        setStellarPreviewFocus(keyboardFocus?.kind === "node" ? keyboardFocus.id : null);
        onNodeHoverRef.current(null);
      }
      canvas.style.cursor = "default";
    };

    const onMouseUp = (e: MouseEvent) => {
      const moved = Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y);
      if (dragRef.current.node) {
        if (moved < 3 && dragRef.current.node) {
          setStellarPreviewFocus(null);
          onNodeClickRef.current(dragRef.current.node as GraphNode);
        }
        const keepAtOrigin = visualModeRef.current === "stellar"
          && dragRef.current.node.id === selectedNodeIdRef.current;
        dragRef.current.node.fx = keepAtOrigin ? 0 : null;
        dragRef.current.node.fy = keepAtOrigin ? 0 : null;
        simRef.current?.alphaTarget(0);
      } else if (isPanning && moved < 3) {
        const pos = getGraphPos(e.clientX, e.clientY);
        selectScopeAt(pos.x, pos.y);
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
      cancelViewAnimation();
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
        const keepAtOrigin = visualModeRef.current === "stellar"
          && node.id === selectedNodeIdRef.current;
        node.fx = keepAtOrigin ? 0 : null;
        node.fy = keepAtOrigin ? 0 : null;
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
      cancelViewAnimation();

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
      const scope = findScopeAt(pos.x, pos.y);
      const node = scope ? null : findNodeAt(pos.x, pos.y);
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
          setStellarPreviewFocus(null);
          onNodeClickRef.current(node as GraphNode);
        }
        releaseDraggedNode();
      } else if (touchMode === "pan" && touchMaxMovement <= TOUCH_TAP_SLOP_PX) {
        const endedTouch = getTouch(e.changedTouches, primaryTouchId);
        if (endedTouch) {
          const pos = getGraphPos(endedTouch.clientX, endedTouch.clientY);
          selectScopeAt(pos.x, pos.y);
        }
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
    canvas.addEventListener("mouseleave", onMouseLeave);
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
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("mouseup", onMouseUp);
      cancelTooltipPosition();
      releaseDraggedNode();
      resetTouchState();
    };
  }, [activateScope, cancelPendingAutoFit, cancelViewAnimation, setStellarPreviewFocus]); // callbacks are accessed via refs

  // Expose fit/reset/zoom without lifting transformRef out of the canvas.
  useImperativeHandle(ref, () => ({
    fitView: () => {
      hasUserInteractedRef.current = true;
      hasAutoFitRef.current = true;
      cancelPendingAutoFit();
      cancelViewAnimation();
      if (!fitStellarFocus() && !fitVisibleGraph()) {
        transformRef.current = { x: 0, y: 0, k: 1 };
        drawRef.current?.();
      }
    },
    resetView: () => {
      hasUserInteractedRef.current = true;
      hasAutoFitRef.current = true;
      cancelPendingAutoFit();
      cancelViewAnimation();
      if (!fitStellarFocus() && !fitVisibleGraph()) {
        transformRef.current = { x: 0, y: 0, k: 1 };
        drawRef.current?.();
      }
    },
    zoomBy: (factor: number) => {
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      cancelViewAnimation();
      const newK = Math.max(0.1, Math.min(10, transformRef.current.k * factor));
      transformRef.current.k = newK;
      drawRef.current?.();
    },
    focusNode: (nodeId: number) => {
      const node = nodeMapRef.current.get(nodeId);
      if (!node) return;
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      const k = Math.max(1.25, transformRef.current.k);
      animateToTransform({
        x: -(node.x ?? 0) * k,
        y: -(node.y ?? 0) * k,
        k,
      });
    },
    focusNodes: (nodeIds: Iterable<number>, minimumZoom = 0.25) => {
      const idSet = new Set(nodeIds);
      const nodes = nodesRef.current.filter((node) => idSet.has(node.id));
      const canvas = canvasRef.current;
      if (!canvas || nodes.length === 0) return;
      hasUserInteractedRef.current = true;
      cancelPendingAutoFit();
      if (nodes.length === 1) {
        const node = nodes[0];
        const k = Math.max(1.25, minimumZoom, transformRef.current.k);
        animateToTransform({ x: -(node.x ?? 0) * k, y: -(node.y ?? 0) * k, k });
        return;
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        const radius = nodeRadius(node);
        minX = Math.min(minX, (node.x ?? 0) - radius);
        minY = Math.min(minY, (node.y ?? 0) - radius);
        maxX = Math.max(maxX, (node.x ?? 0) + radius);
        maxY = Math.max(maxY, (node.y ?? 0) + radius);
      }
      const rect = canvas.getBoundingClientRect();
      const availableWidth = Math.max(1, rect.width - FIT_PADDING * 2);
      const availableHeight = Math.max(1, rect.height - FIT_PADDING * 2);
      const graphWidth = Math.max(1, maxX - minX);
      const graphHeight = Math.max(1, maxY - minY);
      const k = Math.max(minimumZoom, Math.min(3, availableWidth / graphWidth, availableHeight / graphHeight));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      animateToTransform({ x: -centerX * k, y: -centerY * k, k });
    },
  }), [animateToTransform, cancelPendingAutoFit, cancelViewAnimation, fitStellarFocus, fitVisibleGraph]);

  return (
    <>
      <canvas
        ref={canvasRef}
        data-visual-mode={visualMode}
        data-layout-policy={visualMode === "stellar"
          ? selectedNodeId == null ? "hub-orbit" : "directed-focus"
          : "architecture-map"}
        data-flow-lens={visualMode === "stellar" && selectedNodeId != null
          ? "semantic-depth-v2"
          : "off"}
        className="w-full h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-inset"
        style={{
          background: visualMode === "stellar"
            ? "radial-gradient(circle at 50% 46%, rgba(40, 46, 105, 0.28) 0%, rgba(8, 12, 28, 0.97) 48%, #03050b 100%)"
            : "radial-gradient(circle at 50% 46%, rgba(12, 74, 110, 0.24) 0%, rgba(6, 11, 18, 0.97) 48%, #04070c 100%)",
          cursor: "default",
          touchAction: "none",
        }}
        role="application"
        aria-roledescription="interactive code graph"
        aria-label={`${visualMode === "stellar" ? "Dependencies" : "Structure map"}: ${data?.nodes.length ?? 0} nodes and ${data?.edges.length ?? 0} edges`}
        aria-describedby={keyboardInstructionsId}
        aria-keyshortcuts="D Shift+D C Shift+C N Shift+N Enter Space"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const lowerKey = event.key.toLowerCase();
          const targetKind = lowerKey === "d"
            ? "domain"
            : lowerKey === "c"
              ? "community"
              : lowerKey === "n"
                ? "node"
                : null;
          if (targetKind) {
            event.preventDefault();
            cycleKeyboardTarget(targetKind, event.shiftKey ? -1 : 1);
            return;
          }
          if ((event.key === "Enter" || event.key === " " || event.key === "Spacebar") && activateKeyboardTarget()) {
            event.preventDefault();
            return;
          }

          const transform = transformRef.current;
          let handled = true;
          if (event.key === "+" || event.key === "=") {
            transform.k = Math.min(10, transform.k * 1.15);
          } else if (event.key === "-" || event.key === "_") {
            transform.k = Math.max(0.1, transform.k / 1.15);
          } else if (event.key === "0") {
            if (!fitStellarFocus()) fitVisibleGraph();
          } else if (event.key === "ArrowLeft") {
            transform.x += 40;
          } else if (event.key === "ArrowRight") {
            transform.x -= 40;
          } else if (event.key === "ArrowUp") {
            transform.y += 40;
          } else if (event.key === "ArrowDown") {
            transform.y -= 40;
          } else {
            handled = false;
          }
          if (!handled) return;
          event.preventDefault();
          hasUserInteractedRef.current = true;
          cancelPendingAutoFit();
          cancelViewAnimation();
          drawRef.current?.();
        }}
      />
      <span id={keyboardInstructionsId} className="sr-only">
        {visualMode === "stellar"
          ? "Dependencies graph. Hover a symbol or press N or Shift+N to preview its visible first hop without graph changes. Activate it for the complete visible flow: incoming left, outgoing right. Numbered rails show hop depth and the focus label names relation types. "
          : detailMode
            ? "Exact Structure. N browses symbols. "
            : "Structure map. Press D or Shift+D to browse up to 32 visible domains, C or Shift+C for up to 64 communities, and N or Shift+N for up to 64 representative nodes. "}
        Press Enter or Space to activate the announced target.
        Arrow keys pan, plus and minus zoom, zero fits the active frame, and Escape goes up.
      </span>
      <span
        id={keyboardStatusId}
        ref={keyboardStatusRef}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    </>
  );
});
