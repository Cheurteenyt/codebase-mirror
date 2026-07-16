import { describe, expect, it } from "vitest";
import { stellarFlowLabelAnchors } from "./graph-flow-labels";

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
});
