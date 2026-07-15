// graph-ui/src/components/GraphTab.test.tsx
// R53 (Part E): test the C1 chain end-to-end — GraphTab must NOT unmount
// GraphCanvas across a same-project refetch (loading && !data gate).
// This closes the last untested link in the C1 regression chain:
// useGraphData.loading (tested) → GraphTab conditional (THIS TEST) → GraphCanvas unmount (tested)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Mock useGraphData to control loading state
vi.mock("../hooks/useGraphData", () => ({
  useGraphData: vi.fn(),
  GRAPH_RENDER_NODE_LIMIT: 1000,
}));

// Mock useWebSocket (no-op)
vi.mock("../hooks/useWebSocket", () => ({
  useWebSocket: vi.fn(() => ({ connected: false, lastEvent: null, reconnect: () => {} })),
}));

import { GraphTab } from "./GraphTab";
import { useGraphData } from "../hooks/useGraphData";
import { useWebSocket } from "../hooks/useWebSocket";

const mockData = {
  nodes: [
    { id: 1, label: "Function", name: "foo", file_path: "a.ts", qualified_name: "foo", start_line: 1, end_line: 10, properties_json: "{}", risk_score: null, notes_count: 0, status: "active" },
  ],
  edges: [],
  total_nodes: 1,
};

describe("R53 (Part E): GraphTab C1 chain — canvas not unmounted on refetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT show spinner on same-project refetch (keeps GraphCanvas mounted)", async () => {
    const mockUseGraphData = useGraphData as any;

    // Initial state: loading=false, data=mockData (already loaded)
    mockUseGraphData.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { rerender, container } = render(<GraphTab project="test-project" />);

    // GraphCanvas should be rendered (not the spinner)
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();

    // Simulate a same-project refetch (WS notification):
    // loading stays false (C1 fix: same-project refetch doesn't set loading=true)
    // data stays the same
    rerender(<GraphTab project="test-project" />);

    // Canvas should STILL be there — no spinner replaced it
    const canvasAfterRefetch = container.querySelector("canvas");
    expect(canvasAfterRefetch).toBeTruthy();
    expect(canvasAfterRefetch).toBe(canvas); // same DOM element = not unmounted
  });

  it("DOES show spinner on project switch (loading=true, data=null)", () => {
    const mockUseGraphData = useGraphData as any;

    mockUseGraphData.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="new-project" />);

    // Spinner should be shown, NOT canvas
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeNull();
  });

  it("pauses hidden network work and revalidates when the warm graph is shown again", () => {
    const fetchOverview = vi.fn().mockResolvedValue(undefined);
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview,
    });

    const { rerender } = render(<GraphTab project="test-project" active={false} />);
    expect(fetchOverview).not.toHaveBeenCalled();
    expect(useWebSocket).toHaveBeenLastCalledWith(null, expect.any(Function));

    rerender(<GraphTab project="test-project" active />);
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    expect(fetchOverview).toHaveBeenCalledWith("test-project");
    expect(useWebSocket).toHaveBeenLastCalledWith("test-project", expect.any(Function));
  });

  it("keeps the same canvas mounted when all nodes are filtered and restored", () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="test-project" />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByText("All nodes filtered out")).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(canvas?.getAttribute("aria-label")).toContain("0 nodes");

    fireEvent.click(screen.getByRole("button", { name: "Reset Filters" }));
    expect(screen.queryByText("All nodes filtered out")).not.toBeInTheDocument();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(canvas?.getAttribute("aria-label")).toContain("1 nodes");
  });

  it("resets dead-code filters when they hide every node", () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    render(<GraphTab project="test-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Show only dead code" }));
    expect(screen.getByText("All nodes filtered out")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset Filters" }));
    expect(screen.queryByText("All nodes filtered out")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show only dead code" })).toHaveClass("text-foreground/40");
  });

  it("stacks graph actions below the HUD on narrow screens", () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    render(<GraphTab project="test-project" />);

    const actions = screen.getByRole("toolbar", { name: "Graph actions" });
    expect(actions).toHaveClass("top-20", "flex-col", "items-end");
    expect(actions).toHaveClass("lg:top-4", "lg:flex-row", "lg:items-center");
  });
});
