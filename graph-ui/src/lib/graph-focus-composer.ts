import type { StellarFlowTarget } from "./graph-stellar-layout";

export interface StellarFocusViewport {
  width: number;
  height: number;
}

export interface StellarFocusTransform {
  x: number;
  y: number;
  k: number;
}

export interface StellarFocusScreenRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface StellarFocusWorldBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const FLOW_WORLD_PADDING = 34;
const MAX_FOCUS_ZOOM = 1.05;
const MIN_FOCUS_ZOOM = 0.12;

function boundedContentRect(viewport: StellarFocusViewport): StellarFocusScreenRect | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  // Tiny/mobile canvases still receive a valid transform. Scale the reserved
  // chrome down symmetrically instead of producing a negative content area.
  const horizontalScale = Math.min(1, Math.max(0, (viewport.width - 96) / 180));
  const verticalScale = Math.min(1, Math.max(0, (viewport.height - 96) / 228));
  const left = 56 * horizontalScale;
  const right = viewport.width - 124 * horizontalScale;
  const top = 84 * verticalScale;
  const bottom = viewport.height - 144 * verticalScale;
  if (right <= left || bottom <= top) return null;
  return { left, right, top, bottom };
}

/**
 * Fit only the semantic directed frame. Unrelated context nodes deliberately
 * stay outside this calculation so a 1 000-node overview cannot shrink an
 * exact 20-node neighborhood into an unreadable dot.
 */
export function composeStellarFocusViewport(
  targets: Iterable<StellarFlowTarget>,
  viewport: StellarFocusViewport,
): StellarFocusTransform | null {
  const contentRect = boundedContentRect(viewport);
  if (!contentRect) return null;

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (const target of targets) {
    if (target.role === "context") continue;
    minX = Math.min(minX, target.x);
    minY = Math.min(minY, target.y);
    maxX = Math.max(maxX, target.x);
    maxY = Math.max(maxY, target.y);
    count += 1;
  }
  if (count === 0) return null;

  minX -= FLOW_WORLD_PADDING;
  maxX += FLOW_WORLD_PADDING;
  minY -= FLOW_WORLD_PADDING;
  maxY += FLOW_WORLD_PADDING;
  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;
  const availableWidth = contentRect.right - contentRect.left;
  const availableHeight = contentRect.bottom - contentRect.top;
  const k = Math.max(
    MIN_FOCUS_ZOOM,
    Math.min(MAX_FOCUS_ZOOM, availableWidth / graphWidth, availableHeight / graphHeight),
  );
  const worldCenterX = (minX + maxX) / 2;
  const worldCenterY = (minY + maxY) / 2;
  const screenCenterX = (contentRect.left + contentRect.right) / 2;
  const screenCenterY = (contentRect.top + contentRect.bottom) / 2;

  return {
    x: screenCenterX - viewport.width / 2 - worldCenterX * k,
    y: screenCenterY - viewport.height / 2 - worldCenterY * k,
    k,
  };
}

/** Reject labels that Canvas would otherwise clip or place under graph chrome. */
export function stellarFocusWorldBoxFitsViewport(
  box: StellarFocusWorldBox,
  transform: StellarFocusTransform,
  viewport: StellarFocusViewport,
): boolean {
  const horizontalScale = Math.min(1, viewport.width / 480);
  const verticalScale = Math.min(1, viewport.height / 420);
  const originX = viewport.width / 2 + transform.x;
  const originY = viewport.height / 2 + transform.y;
  return originX + box.left * transform.k >= 10 * horizontalScale
    && originX + box.right * transform.k <= viewport.width - 84 * horizontalScale
    && originY + box.top * transform.k >= 62 * verticalScale
    && originY + box.bottom * transform.k <= viewport.height - 124 * verticalScale;
}

/** Bounded attention budget derived from available label lanes, not node count. */
export function stellarFocusLabelBudget(viewport: StellarFocusViewport): number {
  const capacity = Math.floor(
    Math.max(0, viewport.width - 100) * Math.max(0, viewport.height - 200) / 23_000,
  );
  return Math.max(10, Math.min(32, capacity));
}
