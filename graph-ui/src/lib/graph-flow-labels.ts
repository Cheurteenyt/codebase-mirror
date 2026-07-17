import type { StellarFlowRole } from "./graph-stellar-layout";

export interface StellarFlowLabelAnchor {
  x: number;
  y: number;
  align: "left" | "right";
}

/**
 * Put overview labels on the outside of the constellation. The radial anchor
 * makes the node-to-name relationship immediate; two stable vertical
 * fallbacks resolve nearby hubs without running a label optimizer per frame.
 */
export function stellarOverviewLabelAnchors(
  x: number,
  y: number,
  radius: number,
  screenUnit: number,
): StellarFlowLabelAnchor[] {
  const length = Math.max(1, Math.hypot(x, y / 0.82));
  const radialX = x / length;
  const radialY = (y / 0.82) / length;
  const offset = radius + 7 * screenUnit;
  const anchorX = x + radialX * offset;
  const anchorY = y + radialY * offset * 0.82;
  const verticalOffset = 14 * screenUnit;
  const align = x < 0 ? "right" : "left";
  return [
    { x: anchorX, y: anchorY, align },
    { x: anchorX, y: anchorY - verticalOffset, align },
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
