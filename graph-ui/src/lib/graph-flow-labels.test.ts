import { describe, expect, it } from "vitest";
import {
  stellarFlowLabelAnchors,
  stellarOverviewLabelAnchors,
} from "./graph-flow-labels";

describe("Stellar flow label anchors", () => {
  it("places incoming and outgoing labels away from the focus", () => {
    const incoming = stellarFlowLabelAnchors("incoming", -180, 20, 8, 1);
    const outgoing = stellarFlowLabelAnchors("outgoing", 180, 20, 8, 1);

    expect(incoming[0]).toMatchObject({ align: "right" });
    expect(incoming[0].x).toBeLessThan(-180);
    expect(outgoing[0]).toMatchObject({ align: "left" });
    expect(outgoing[0].x).toBeGreaterThan(180);
  });

  it("provides deterministic vertical fallbacks for collision avoidance", () => {
    const first = stellarFlowLabelAnchors("outgoing", 180, 20, 8, 1);
    const second = stellarFlowLabelAnchors("outgoing", 180, 20, 8, 1);

    expect(first).toEqual(second);
    expect(first.map((anchor) => anchor.y)).toEqual([20, 6, 34]);
  });

  it("gives Structure nodes stable outside-first collision fallbacks", () => {
    expect(stellarFlowLabelAnchors(undefined, -40, 20, 8, 1)).toEqual([
      { x: -54, y: 20, align: "right" },
      { x: -54, y: 6, align: "right" },
      { x: -54, y: 34, align: "right" },
    ]);
    expect(stellarFlowLabelAnchors(undefined, 40, -20, 8, 1)[0]).toEqual({
      x: 54,
      y: -20,
      align: "left",
    });
  });

  it("anchors overview labels radially outside both sides of the constellation", () => {
    const left = stellarOverviewLabelAnchors(-180, 40, 8, 1);
    const right = stellarOverviewLabelAnchors(180, -40, 8, 1);

    expect(left[0].align).toBe("right");
    expect(left[0].x).toBeLessThan(-180);
    expect(right[0].align).toBe("left");
    expect(right[0].x).toBeGreaterThan(180);
    expect(left.map((anchor) => anchor.y)).toEqual([
      left[0].y,
      left[0].y - 14,
    ]);
    expect(stellarOverviewLabelAnchors(-180, 40, 8, 1)).toEqual(left);
  });

  it("keeps central hub labels outside a quiet screen-space core", () => {
    const [anchor] = stellarOverviewLabelAnchors(12, 0, 8, 2);
    const screenRadius = Math.hypot(anchor.x, anchor.y / 0.82) / 2;

    expect(screenRadius).toBeGreaterThanOrEqual(72);
  });
});
