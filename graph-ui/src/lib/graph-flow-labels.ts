import type { StellarFlowRole } from "./graph-stellar-layout";

export interface StellarFlowLabelAnchor {
  x: number;
  y: number;
  align: "left" | "right";
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
  const direction = role === "incoming"
    ? -1
    : role === "outgoing"
      ? 1
      : role === "bidirectional" && x < 0
        ? -1
        : 1;
  const anchorX = x + direction * (radius + 6 * screenUnit);
  const verticalOffset = 14 * screenUnit;
  return [
    { x: anchorX, y, align: direction < 0 ? "right" : "left" },
    { x: anchorX, y: y - verticalOffset, align: direction < 0 ? "right" : "left" },
    { x: anchorX, y: y + verticalOffset, align: direction < 0 ? "right" : "left" },
  ];
}
