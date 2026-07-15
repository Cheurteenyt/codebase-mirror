// graph-ui/src/components/NodeTooltip.test.tsx
// R46 (F1): regression test for the R40 viewport-flip fix (UI-12).
// The tooltip must flip its offset when near the right/bottom viewport edge
// so it isn't clipped. Without the flip, a node hovered at x=990 on a 1000px
// viewport would render the tooltip off-screen.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { NodeTooltip } from "./NodeTooltip";
import type { GraphNode } from "../lib/types";

const node = {
  id: 1, label: "Function", name: "foo", file_path: "a.ts",
} as GraphNode;

describe("R40 (UI-12): NodeTooltip viewport flip", () => {
  beforeEach(() => {
    // getBoundingClientRect is normally 0 in jsdom. The tooltip measures both
    // itself and its graph container, so mock their distinct real-world sizes.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      const isTooltip = (this as HTMLElement).classList?.contains("pointer-events-none");
      const width = isTooltip ? 220 : 1000;
      const height = isTooltip ? 64 : 800;
      return {
        width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  it("flips X when tooltip would overflow the right viewport edge", () => {
    // Cursor at x=990; offset 12 → left edge would be 1002, overflow (1000 - 8 margin).
    const { container } = render(<NodeTooltip node={node} x={990} y={100} />);
    const tip = container.firstChild as HTMLElement;
    const left = parseFloat(tip.style.left);
    // Flipped: left = x - OFFSET - size.w = 990 - 12 - 220 = 758
    expect(left).toBe(758);
  });

  it("does NOT flip X when there is room", () => {
    const { container } = render(<NodeTooltip node={node} x={100} y={100} />);
    const tip = container.firstChild as HTMLElement;
    expect(parseFloat(tip.style.left)).toBe(112); // 100 + 12
  });

  it("flips Y when tooltip would overflow the bottom viewport edge", () => {
    const { container } = render(<NodeTooltip node={node} x={100} y={790} />);
    const tip = container.firstChild as HTMLElement;
    const top = parseFloat(tip.style.top);
    // Flipped: top = y - OFFSET - size.h = 790 - 12 - 64 = 714
    expect(top).toBe(714);
  });
});
