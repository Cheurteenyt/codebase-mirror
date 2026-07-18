import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNeighborhoodData, GraphNode } from "../lib/types";
import { NodeDetailPanel } from "./NodeDetailPanel";

const useExactNeighborhoodMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useExactNeighborhood", () => ({
  useExactNeighborhood: useExactNeighborhoodMock,
}));

const node = {
  id: 1,
  x: 0,
  y: 0,
  size: 5,
  color: "#60a5fa",
  label: "Function",
  name: "hub",
  file_path: "src/hub.ts",
  in_degree: 3,
  out_degree: 42,
} as GraphNode;

function graphNode(id: number): GraphNode {
  return {
    ...node,
    id,
    name: `node-${id}`,
    file_path: `src/node-${id}.ts`,
    in_degree: 0,
    out_degree: 0,
  };
}

const neighbor = graphNode(2);

function exactData(overrides: Partial<GraphNeighborhoodData> = {}): GraphNeighborhoodData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
    anchor: {
      kind: "node",
      id: 1,
      total_inbound: 0,
      total_outbound: 1,
      total_unique_edges: 1,
    },
    nodes: [node, neighbor],
    edges: [{ id: 10, source: 1, target: 2, type: "CALLS" }],
    page: { limit: 250, returned: 1, next_cursor: null },
    ...overrides,
  };
}

function hookState(overrides: Record<string, unknown> = {}) {
  return {
    data: null,
    loading: false,
    loadingMore: false,
    error: null,
    errorPhase: null,
    errorStatus: null,
    loadMore: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPanel({
  selectedNode = node,
  overviewNodes,
  allNodes = [node, neighbor],
  allEdges = [{ source: 1, target: 2, type: "CALLS" }],
  onNavigate = vi.fn(),
  exactRefreshKey,
  requiresExactValidation = false,
  onExactValidation,
}: {
  selectedNode?: GraphNode;
  overviewNodes?: GraphNode[];
  allNodes?: GraphNode[];
  allEdges?: Array<{ source: number; target: number; type: string }>;
  onNavigate?: (next: GraphNode) => void;
  exactRefreshKey?: string | number;
  requiresExactValidation?: boolean;
  onExactValidation?: (nodeId: number, refreshKey: string | number | undefined, valid: boolean) => void;
} = {}) {
  return render(
    <NodeDetailPanel
      node={selectedNode}
      overviewNodes={overviewNodes}
      allNodes={allNodes}
      allEdges={allEdges}
      project="test"
      exactRefreshKey={exactRefreshKey}
      requiresExactValidation={requiresExactValidation}
      onExactValidation={onExactValidation}
      onClose={vi.fn()}
      onNavigate={onNavigate}
    />,
  );
}

describe("NodeDetailPanel exact neighborhood", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExactNeighborhoodMock.mockReturnValue(hookState());
  });

  it("keeps exact degrees visible while honestly labeling the bounded overview list", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "hub" })).toHaveFocus();

    expect(screen.getByLabelText("Out connections: 42")).toBeInTheDocument();
    expect(screen.getByLabelText("In connections: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Estimated total unique connections: 45")).toBeInTheDocument();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByText("≈45 unique")).toBeInTheDocument();
    expect(useExactNeighborhoodMock).toHaveBeenCalledWith("test", 1, true, undefined);
  });

  it("turns exact counts into an immediately readable directional flow profile", () => {
    const calledA = graphNode(2);
    const calledB = graphNode(3);
    const calledC = graphNode(4);
    const caller = graphNode(5);
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: 1,
          total_outbound: 3,
          total_unique_edges: 4,
        },
        nodes: [node, calledA, calledB, calledC, caller],
        edges: [
          { id: 10, source: 1, target: 2, type: "CALLS" },
          { id: 11, source: 1, target: 3, type: "CALLS" },
          { id: 12, source: 1, target: 4, type: "CALLS" },
          { id: 13, source: 5, target: 1, type: "IMPORTS" },
        ],
        page: { limit: 250, returned: 4, next_cursor: null },
      }),
    }));

    renderPanel();

    expect(screen.getByLabelText("Flow profile: Outbound hub")).toBeInTheDocument();
    expect(screen.getByText("Exact")).toBeInTheDocument();
    expect(screen.getByLabelText("Out connections: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("In connections: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Total connections: 4")).toBeInTheDocument();
    expect(screen.getByText("OUT calls · 3")).toBeInTheDocument();
    expect(screen.getByText("IN imports · 1")).toBeInTheDocument();
  });

  it("does not misclassify an exact self-loop as a bidirectional connector", () => {
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: 1,
          total_outbound: 1,
          total_unique_edges: 1,
        },
        nodes: [node],
        edges: [{ id: 10, source: 1, target: 1, type: "CALLS" }],
        page: { limit: 250, returned: 1, next_cursor: null },
      }),
    }));

    renderPanel();

    expect(screen.getByLabelText("Flow profile: Self-linked")).toBeInTheDocument();
  });

  it.each([
    [0, 0, "Isolated"],
    [1, 0, "Outbound only"],
    [0, 1, "Inbound only"],
    [2, 2, "Connector"],
    [1, 3, "Inbound hub"],
  ] as const)("classifies %i outbound and %i inbound relations as %s", (outbound, inbound, role) => {
    const outboundNodes = Array.from({ length: outbound }, (_, index) => graphNode(10 + index));
    const inboundNodes = Array.from({ length: inbound }, (_, index) => graphNode(20 + index));
    const edges = [
      ...outboundNodes.map((target, index) => ({ id: index + 1, source: 1, target: target.id, type: "CALLS" })),
      ...inboundNodes.map((source, index) => ({ id: outbound + index + 1, source: source.id, target: 1, type: "CALLS" })),
    ];
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: inbound,
          total_outbound: outbound,
          total_unique_edges: outbound + inbound,
        },
        nodes: [node, ...outboundNodes, ...inboundNodes],
        edges,
        page: { limit: 250, returned: edges.length, next_cursor: null },
      }),
    }));

    renderPanel();

    expect(screen.getByLabelText(`Flow profile: ${role}`)).toBeInTheDocument();
  });

  it("does not double-count a visible self-loop in the provisional unique total", () => {
    const selfLoopNode = {
      ...node,
      in_degree: 2,
      out_degree: 3,
    };
    renderPanel({
      selectedNode: selfLoopNode,
      allNodes: [selfLoopNode],
      allEdges: [{ source: 1, target: 1, type: "CALLS" }],
    });

    expect(screen.getByLabelText("Out connections: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("In connections: 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Estimated total unique connections: 4")).toBeInTheDocument();
    expect(screen.getByText("≈4 unique")).toBeInTheDocument();
    expect(screen.getByText("Self references")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open hub (Function)" })).toHaveLength(1);
  });

  it("identifies an exact search result that is outside the representative map", () => {
    renderPanel({ allNodes: [neighbor], allEdges: [] });

    expect(screen.getByText(/Outside the representative map/u))
      .toHaveAttribute("role", "status");
  });

  it("distinguishes a represented node hidden by filters from a node absent from the overview", () => {
    renderPanel({ overviewNodes: [node], allNodes: [], allEdges: [] });

    expect(screen.getByText(/Hidden by active filters/u))
      .toHaveAttribute("role", "status");
    expect(screen.queryByText(/Outside the representative map/u)).not.toBeInTheDocument();
  });

  it("shows a useful empty loading state instead of claiming that there are no connections", () => {
    useExactNeighborhoodMock.mockReturnValue(hookState({ loading: true }));
    renderPanel({ allNodes: [node], allEdges: [] });

    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByText("Loading exact connections…")).toBeInTheDocument();
    expect(screen.queryByText("No connections")).not.toBeInTheDocument();
  });

  it("labels and retries an initial exact-load failure", () => {
    const retry = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({
      error: "Neighborhood unavailable",
      errorPhase: "initial",
      retry,
    }));
    renderPanel({ allNodes: [node], allEdges: [] });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load exact connections: Neighborhood unavailable",
    );
    expect(screen.queryByText("No connections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact load" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("never consumes an exact frame anchored to the previously selected node", () => {
    const selectedNode = graphNode(3);
    const onExactValidation = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({ data: exactData() }));

    renderPanel({
      selectedNode,
      allNodes: [selectedNode],
      allEdges: [],
      exactRefreshKey: "graph-b:2",
      requiresExactValidation: true,
      onExactValidation,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Exact neighborhood response did not match the selected node",
    );
    expect(screen.queryByText("References")).not.toBeInTheDocument();
    expect(screen.queryByText("No connections")).not.toBeInTheDocument();
    expect(onExactValidation).not.toHaveBeenCalled();
  });

  it("revalidates an off-overview selection against the current exact refresh key", () => {
    const onExactValidation = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({ data: exactData() }));

    renderPanel({
      allNodes: [neighbor],
      allEdges: [],
      exactRefreshKey: "graph-a:7",
      requiresExactValidation: true,
      onExactValidation,
    });

    expect(useExactNeighborhoodMock).toHaveBeenLastCalledWith("test", 1, true, "graph-a:7");
    expect(onExactValidation).toHaveBeenCalledWith(1, "graph-a:7", true);
  });

  it("invalidates an off-overview selection only for a current 404", () => {
    const onExactValidation = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({
      error: "Node not found",
      errorPhase: "initial",
      errorStatus: 404,
    }));

    renderPanel({
      allNodes: [neighbor],
      allEdges: [],
      exactRefreshKey: "graph-current:9",
      requiresExactValidation: true,
      onExactValidation,
    });

    expect(onExactValidation).toHaveBeenCalledWith(1, "graph-current:9", false);
  });

  it("keeps a 503 revalidation failure visible and retryable without deleting the node", () => {
    const retry = vi.fn();
    const onExactValidation = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({
      error: "Backend is busy",
      errorPhase: "initial",
      errorStatus: 503,
      retry,
    }));

    renderPanel({
      allNodes: [neighbor],
      allEdges: [],
      exactRefreshKey: "graph-current:10",
      requiresExactValidation: true,
      onExactValidation,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load exact connections: Backend is busy",
    );
    expect(onExactValidation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact load" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders self-loops once and uses the exact unique-edge total", () => {
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: 1,
          total_outbound: 2,
          total_unique_edges: 2,
        },
        edges: [
          { id: 10, source: 1, target: 2, type: "CALLS" },
          { id: 11, source: 1, target: 1, type: "CALLS" },
        ],
        page: { limit: 250, returned: 2, next_cursor: null },
      }),
    }));
    renderPanel();

    expect(screen.getByLabelText("Out connections: 2")).toBeInTheDocument();
    expect(screen.getByLabelText("In connections: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Total connections: 2")).toBeInTheDocument();
    expect(screen.getByText("Self references")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open hub (Function)" })).toHaveLength(1);
    expect(screen.getByText("Exact")).toBeInTheDocument();
  });

  it("compacts repeated edges while keeping ambiguous neighbors identifiable", () => {
    const readerCountEdges = {
      ...graphNode(2),
      name: "countEdges",
      qualified_name: "CodeGraphReader::countEdges",
      file_path: "v2/src/bridge/sqlite-ro.ts",
    };
    const storeCountEdges = {
      ...graphNode(3),
      name: "countEdges",
      qualified_name: "HumanMemoryStore::countEdges",
      file_path: "v2/src/human/store.ts",
    };
    const anonymousTest = {
      ...graphNode(4),
      name: "anonymous#2",
      file_path: "v2/tests/get-project-overview.test.ts",
      start_line: 7,
    };
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: 1,
          total_outbound: 3,
          total_unique_edges: 4,
        },
        nodes: [node, readerCountEdges, storeCountEdges, anonymousTest],
        edges: [
          { id: 10, source: 1, target: 2, type: "CALLS" },
          { id: 11, source: 1, target: 2, type: "CALLS" },
          { id: 12, source: 1, target: 3, type: "CALLS" },
          { id: 13, source: 4, target: 1, type: "CALLS" },
        ],
        page: { limit: 250, returned: 4, next_cursor: null },
      }),
    }));
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });

    expect(screen.getByLabelText("Out connections: 3")).toBeInTheDocument();
    expect(screen.getByLabelText("In connections: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Total connections: 4")).toBeInTheDocument();
    expect(screen.getByText("References").parentElement).toHaveTextContent("(3)");
    expect(screen.getByText("Referenced by").parentElement).toHaveTextContent("(1)");

    const readerConnection = screen.getByRole("button", {
      name: "Open countEdges · CodeGraphReader (Function), 2 connections",
    });
    expect(screen.getByRole("button", {
      name: "Open countEdges · HumanMemoryStore (Function)",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open get-project-overview.test.ts:7 (Function)",
    })).toBeInTheDocument();
    expect(screen.queryByText("anonymous#2")).not.toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
    expect(screen.getAllByText("Function")).toHaveLength(1);

    fireEvent.click(readerConnection);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(readerCountEdges);
  });

  it("keeps pagination actionable and distinguishes retrying a failed page", () => {
    const loadMore = vi.fn();
    const retry = vi.fn();
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({ page: { limit: 250, returned: 1, next_cursor: "page-2" } }),
      loadMore,
      retry,
    }));
    const view = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Load more exact connections" }));
    expect(loadMore).toHaveBeenCalledTimes(1);

    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({ page: { limit: 250, returned: 1, next_cursor: "page-2" } }),
      error: "Backend is busy",
      errorPhase: "more",
      loadMore,
      retry,
    }));
    view.rerender(
      <NodeDetailPanel
        node={node}
        allNodes={[node, neighbor]}
        allEdges={[{ source: 1, target: 2, type: "CALLS" }]}
        project="test"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the next page: Backend is busy");
    expect(screen.queryByRole("button", { name: "Load more exact connections" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lets users reveal a large edge-type group instead of permanently truncating it", () => {
    const neighbors = Array.from({ length: 30 }, (_, index) => graphNode(index + 2));
    useExactNeighborhoodMock.mockReturnValue(hookState({
      data: exactData({
        anchor: {
          kind: "node",
          id: 1,
          total_inbound: 0,
          total_outbound: 30,
          total_unique_edges: 30,
        },
        nodes: [node, ...neighbors],
        edges: neighbors.map((target, index) => ({
          id: index + 1,
          source: 1,
          target: target.id,
          type: "CALLS",
        })),
        page: { limit: 250, returned: 30, next_cursor: null },
      }),
    }));
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });

    expect(screen.queryByRole("button", { name: "Open node-31 (Function)" })).not.toBeInTheDocument();
    const reveal = screen.getByRole("button", { name: "Show 5 more calls connections" });
    expect(reveal).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(reveal);

    expect(screen.getByRole("button", { name: "Open node-31 (Function)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show fewer calls connections" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
