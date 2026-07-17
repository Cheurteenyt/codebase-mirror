// graph-ui/src/components/GraphTab.test.tsx
// R53 (Part E): test the C1 chain end-to-end — GraphTab must NOT unmount
// GraphCanvas across a same-project refetch (loading && !data gate).
// This closes the last untested link in the C1 regression chain:
// useGraphData.loading (tested) → GraphTab conditional (THIS TEST) → GraphCanvas unmount (tested)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

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

  it("recomputes a selected node neighborhood when relationship filters change", async () => {
    (useGraphData as any).mockReturnValue({
      data: {
        nodes: [
          mockData.nodes[0],
          {
            ...mockData.nodes[0],
            id: 2,
            label: "Class",
            name: "bar",
            file_path: "b.ts",
            qualified_name: "bar",
          },
        ],
        edges: [{ source: 1, target: 2, type: "CALLS" }],
        total_nodes: 2,
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    render(<GraphTab project="test-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand (root)" }));
    fireEvent.click(screen.getByRole("button", { name: "Open foo" }));
    await waitFor(() => expect(screen.getByText("2 selected")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /calls 1/i }));
    await waitFor(() => expect(screen.getByText("1 selected")).toBeInTheDocument());
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
    fireEvent.click(screen.getByRole("button", { name: "Select (root)" }));

    const actions = screen.getByRole("toolbar", { name: "Graph actions" });
    expect(actions).toHaveClass("top-20", "flex-col", "items-end");
    expect(actions).toHaveClass("xl:top-4", "xl:flex-row", "xl:items-center");
    expect(actions).not.toHaveTextContent("Clear selection");
  });

  it("defers the horizontal action bar while the detail panel narrows the canvas", () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    render(<GraphTab project="test-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand (root)" }));
    fireEvent.click(screen.getByRole("button", { name: "Open foo" }));

    const actions = screen.getByRole("toolbar", { name: "Graph actions" });
    expect(actions).toHaveClass("top-20", "flex-col", "items-end");
    expect(actions).toHaveClass("2xl:top-4", "2xl:flex-row", "2xl:items-center");
    expect(actions).not.toHaveClass("xl:top-4", "xl:flex-row");
  });

  it("persists the Dependencies policy without replacing the graph canvas", () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const first = render(<GraphTab project="test-project" />);
    const canvas = first.container.querySelector("canvas");
    expect(canvas).toHaveAttribute("data-visual-mode", "architecture");
    expect(screen.getByRole("tree", { name: "Structure tree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status", { name: "Graph view guide" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
    expect(first.container.querySelector("canvas")).toBe(canvas);
    expect(canvas).toHaveAttribute("data-visual-mode", "stellar");
    expect(canvas).toHaveAttribute("data-layout-policy", "hub-orbit");
    expect(screen.queryByRole("status", { name: "Graph view guide" })).not.toBeInTheDocument();
    expect(localStorage.getItem("cbm-graph-visual-mode")).toBe("stellar");

    first.unmount();
    const second = render(<GraphTab project="test-project" />);
    expect(second.container.querySelector("canvas")).toHaveAttribute("data-visual-mode", "stellar");
    expect(screen.getByRole("button", { name: "Dependencies" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps selected Stellar semantics inside the canvas instead of permanent chrome", () => {
    localStorage.setItem("cbm-graph-visual-mode", "stellar");
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="test-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand (root)" }));
    fireEvent.click(screen.getByRole("button", { name: "Open foo" }));

    expect(container.querySelector("canvas")).toHaveAttribute("data-layout-policy", "directed-focus");
    expect(screen.queryByRole("status", { name: "Graph view guide" })).not.toBeInTheDocument();
  });

  it("dismisses the mobile navigation drawer after opening a node", async () => {
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="test-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Open graph filters" }));
    expect(container.querySelector('[aria-label="Dismiss graph filters"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand (root)" }));
    fireEvent.click(screen.getByRole("button", { name: "Open foo" }));

    expect(container.querySelector('[aria-label="Dismiss graph filters"]')).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "foo" })).toBeInTheDocument();
  });

  it("keeps the closed mobile drawer out of the accessibility tree and manages modal focus", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    (useGraphData as any).mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });

    const { container } = render(<GraphTab project="test-project" />);
    const trigger = screen.getByRole("button", { name: "Open graph filters" });
    const closedDrawer = container.querySelector('[aria-hidden="true"][inert]');
    expect(closedDrawer).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "None" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Graph filters and structure search" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).not.toHaveAttribute("aria-hidden");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close graph filters" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Close graph filters" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(container.querySelector('[aria-hidden="true"][inert]')).toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    window.dispatchEvent(new Event("resize"));
  });

  it("cancels a queued project-A refresh and ignores its stale callback after switching to B", () => {
    vi.useFakeTimers();
    try {
      const fetchOverview = vi.fn().mockResolvedValue(undefined);
      (useGraphData as any).mockReturnValue({
        data: mockData,
        loading: false,
        error: null,
        fetchOverview,
      });
      const view = render(<GraphTab project="project-a" />);
      const projectACallback = (useWebSocket as any).mock.calls.at(-1)[1] as (notification: {
        type: string;
        event: string;
        project: string;
        timestamp: string;
      }) => void;

      act(() => projectACallback({
        type: "notification",
        event: "graph_reindexed",
        project: "project-a",
        timestamp: new Date().toISOString(),
      }));
      view.rerender(<GraphTab project="project-b" />);
      expect(fetchOverview).toHaveBeenCalledWith("project-b");
      fetchOverview.mockClear();

      act(() => {
        projectACallback({
          type: "notification",
          event: "graph_reindexed",
          project: "project-a",
          timestamp: new Date().toISOString(),
        });
        vi.advanceTimersByTime(400);
      });
      expect(fetchOverview).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
