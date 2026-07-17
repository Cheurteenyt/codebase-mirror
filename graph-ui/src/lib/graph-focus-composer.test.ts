import { describe, expect, it } from "vitest";
import {
  composeStellarFocusViewport,
  stellarFocusLabelBudget,
  stellarFocusWorldBoxFitsViewport,
} from "./graph-focus-composer";
import type { StellarFlowTarget } from "./graph-stellar-layout";

function target(
  x: number,
  y: number,
  role: StellarFlowTarget["role"],
  depth: number | null,
): StellarFlowTarget {
  return { x, y, role, depth, laneKey: null };
}

function screenPoint(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  transform: { x: number; y: number; k: number },
) {
  return {
    x: viewport.width / 2 + transform.x + point.x * transform.k,
    y: viewport.height / 2 + transform.y + point.y * transform.k,
  };
}

describe("Stellar focus composer", () => {
  const directedTargets = [
    target(0, 0, "focus", 0),
    target(-180, -120, "incoming", 1),
    target(-720, 220, "incoming", 4),
    target(180, -160, "outgoing", 1),
    target(720, 260, "outgoing", 4),
    target(2_400, 1_600, "context", null),
  ];

  it("fits every directed depth inside a narrow desktop canvas and ignores context", () => {
    const viewport = { width: 720, height: 900 };
    const composition = composeStellarFocusViewport(directedTargets, viewport);
    expect(composition).not.toBeNull();
    expect(composition!.k).toBeLessThan(0.5);

    for (const point of directedTargets.slice(0, -1)) {
      const screen = screenPoint(point, viewport, composition!);
      expect(screen.x).toBeGreaterThanOrEqual(56);
      expect(screen.x).toBeLessThanOrEqual(596);
      expect(screen.y).toBeGreaterThanOrEqual(84);
      expect(screen.y).toBeLessThanOrEqual(756);
    }
  });

  it("uses additional wide-screen space without exceeding the readable zoom ceiling", () => {
    const narrow = composeStellarFocusViewport(directedTargets, { width: 720, height: 900 })!;
    const standard = composeStellarFocusViewport(directedTargets, { width: 880, height: 900 })!;
    const wide = composeStellarFocusViewport(directedTargets, { width: 1_360, height: 900 })!;
    expect(standard.k).toBeGreaterThan(narrow.k);
    expect(wide.k).toBeGreaterThan(narrow.k);
    expect(wide.k).toBeGreaterThan(standard.k);
    expect(wide.k).toBeLessThanOrEqual(1.05);
  });

  it("shifts an asymmetric outgoing frame so the focus and far depth both remain visible", () => {
    const viewport = { width: 760, height: 820 };
    const composition = composeStellarFocusViewport([
      target(0, 0, "focus", 0),
      target(180, 0, "outgoing", 1),
      target(720, 80, "outgoing", 4),
    ], viewport)!;
    const focus = screenPoint({ x: 0, y: 0 }, viewport, composition);
    const far = screenPoint({ x: 720, y: 80 }, viewport, composition);
    expect(focus.x).toBeGreaterThanOrEqual(56);
    expect(far.x).toBeLessThanOrEqual(636);
    expect(focus.x).toBeLessThan(viewport.width / 2);
  });

  it("rejects labels clipped by canvas chrome while preserving an interior label", () => {
    const viewport = { width: 720, height: 900 };
    const transform = { x: 0, y: 0, k: 1 };
    expect(stellarFocusWorldBoxFitsViewport(
      { left: -120, right: 80, top: -20, bottom: 0 },
      transform,
      viewport,
    )).toBe(true);
    expect(stellarFocusWorldBoxFitsViewport(
      { left: -400, right: -300, top: -20, bottom: 0 },
      transform,
      viewport,
    )).toBe(false);
    expect(stellarFocusWorldBoxFitsViewport(
      { left: -20, right: 80, top: 330, bottom: 350 },
      transform,
      viewport,
    )).toBe(false);
  });

  it("bounds label attention by the actual viewport", () => {
    expect(stellarFocusLabelBudget({ width: 520, height: 760 })).toBe(10);
    expect(stellarFocusLabelBudget({ width: 720, height: 900 })).toBe(18);
    expect(stellarFocusLabelBudget({ width: 1_360, height: 900 })).toBe(32);
  });
});
