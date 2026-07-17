import type { StellarFlowRole } from "./graph-stellar-layout";

export interface StellarFlowLabelAnchor {
  x: number;
  y: number;
  align: "left" | "right";
}

/**
 * Reserve the project-overview attention budget for names that carry context.
 * Generic operation identifiers remain available through search, zoom and
 * focus, but do not displace specific names in the initial constellation.
 */
export const LOW_CONTEXT_STELLAR_OVERVIEW_LABEL = /^(?:anonymous.*|add|close(?:sync)?|commit|[gs]et|handle|now|option|push|request|run|st(?:art|op))$/i;

/**
 * Put overview labels on the outside of the constellation. The radial anchor
 * makes the node-to-name relationship immediate; stable vertical
 * fallbacks resolve nearby hubs without running a label optimizer per frame.
 */
export function stellarOverviewLabelAnchors(
  x: number,
  y: number,
  radius: number,
  screenUnit: number,
): StellarFlowLabelAnchor[] {
  const length = Math.hypot(x, y / 0.82) || 1;
  // High-degree hubs deliberately occupy the center, but their names should
  // not recreate the same dense knot in text. Keep those labels on a quiet
  // screen-space orbit while preserving the natural radial anchor of nodes
  // that are already farther out in the constellation.
  const radialScale = Math.max(
    length + radius + 7 * screenUnit,
    72 * screenUnit,
  ) / length;
  const anchorX = x * radialScale;
  const anchorY = y * radialScale;
  const align = x < 0 ? "right" : "left";
  return [
    { x: anchorX, y: anchorY, align },
    { x: anchorX, y: anchorY - 14 * screenUnit, align },
  ];
}

/**
 * Keep labels on the outside of the directed frame. Three stable anchors are
 * enough to resolve nearby collisions without a per-frame optimization pass.
 */
export function stellarFlowLabelAnchors(
  role: StellarFlowRole | undefined,
  x: number,
  y: number,
  radius: number,
  screenUnit: number,
): StellarFlowLabelAnchor[] {
  const direction = role === "incoming" || (role !== "outgoing" && x < 0) ? -1 : 1;
  const anchorX = x + direction * (radius + 6 * screenUnit);
  const verticalOffset = 14 * screenUnit;
  const align = direction < 0 ? "right" : "left";
  return [
    { x: anchorX, y, align },
    { x: anchorX, y: y - verticalOffset, align },
    { x: anchorX, y: y + verticalOffset, align },
  ];
}
