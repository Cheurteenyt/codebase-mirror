import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useGraphData", () => ({
  useGraphData: vi.fn(),
  GRAPH_RENDER_NODE_LIMIT: 1000,
}));
vi.mock("../hooks/useWebSocket", () => ({
  useWebSocket: vi.fn(() => ({ connected: false, lastEvent: null, reconnect: () => {} })),
}));
const useExactNeighborhoodMock = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useExactNeighborhood", () => ({
  useExactNeighborhood: useExactNeighborhoodMock,
}));
const useExactScopeMock = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useExactScope", () => ({
  useExactScope: useExactScopeMock,
}));
vi.mock("./GraphCanvas", async () => {
  const React = await import("react");
  return {
  GraphCanvas: React.forwardRef(function GraphCanvasMock(
    {
      data,
      onNodeClick,
      onScopeSelect,
      selectedNodeId,
      highlightedIds,
    }: {
      data: { nodes: any[]; layout?: { strategy: string } };
      onNodeClick: (node: any) => void;
      onScopeSelect?: (scope: any) => void;
      selectedNodeId?: number | null;
      highlightedIds?: Set<number> | null;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      fitView: () => {},
      resetView: () => {},
      zoomBy: () => {},
      focusNode: () => {},
      focusNodes: () => {},
    }));
    return (
      <>
        <output data-testid="graph-canvas-node-count">{data.nodes.length}</output>
        <output data-testid="graph-canvas-layout">{data.layout?.strategy ?? "flat"}</output>
        <output data-testid="graph-canvas-selected-node">{selectedNodeId ?? "none"}</output>
        <output data-testid="graph-canvas-highlight-count">{highlightedIds?.size ?? 0}</output>
        <button
          type="button"
          aria-label="Select first graph node"
          onClick={() => data.nodes[0] && onNodeClick(data.nodes[0])}
        />
        <button
          type="button"
          aria-label="Select exact node outside overview"
          onClick={() => onNodeClick({
            id: 999,
            x: 0,
            y: 0,
            size: 4,
            color: "#a78bfa",
            label: "Class",
            name: "exact-outside",
            file_path: "hidden/exact-outside.ts",
            in_degree: 0,
            out_degree: 0,
          })}
        />
        <button
          type="button"
          aria-label="Select first domain"
          onClick={() => onScopeSelect?.({
            kind: "domain",
            id: 0,
            key: "src",
            nodeIds: new Set(data.nodes.map((node) => node.id)),
          })}
        />
        <button
          type="button"
          aria-label="Select first community"
          onClick={() => onScopeSelect?.({
            kind: "community",
            id: 0,
            key: "src/lib",
            nodeIds: new Set(data.nodes.map((node) => node.id)),
          })}
        />
      </>
    );
  }),
  };
});

import { GraphTab } from "./GraphTab";
import { useGraphData } from "../hooks/useGraphData";

const makeNode = (id: number, name: string) => ({
  id,
  x: id * 10,
  y: id * 5,
  size: 4,
  color: "#60a5fa",
  label: "Function",
  name,
  file_path: `src/${name}.ts`,
  in_degree: 0,
  out_degree: 0,
});

const emptyExactState = () => ({
  data: null,
  loading: false,
  loadingMore: false,
  error: null,
  errorPhase: null,
  loadMore: vi.fn(),
  retry: vi.fn(),
});

const exactScopeState = (loadMore = vi.fn()) => ({
  data: {
    contract_version: 1 as const,
    exact: true as const,
    graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
    scope: {
      kind: "domain" as const,
      key: "src",
      total_nodes: 3,
      total_internal_edges: 1,
    },
    nodes: [
      { ...makeNode(10, "exact-ten"), cluster_id: 0 },
      { ...makeNode(20, "exact-twenty"), cluster_id: 0 },
    ],
    edges: [{ id: 1, source: 10, target: 20, type: "CALLS" }],
    layout: {
      strategy: "exact-directory-file-v1",
      node_spacing: 16,
      counts_scope: "all_nodes" as const,
      clusters: [{ id: 0, domain_id: 0, key: "src/exact.ts", x: 0, y: 0, radius: 60, node_count: 3 }],
      domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 110, node_count: 3, cluster_count: 1 }],
    },
    complete: false,
    page: {
      node_limit: 125,
      edge_limit: 125,
      returned_nodes: 2,
      returned_edges: 1,
      next_cursor: "scope-page-2",
    },
  },
  loading: false,
  loadingMore: false,
  error: null,
  errorPhase: null,
  errorStatus: null,
  loadMore,
  retry: vi.fn(),
});

const exactOutsideData = {
  contract_version: 1 as const,
  exact: true as const,
  graph_revision: "graph-reader-v1:bbbbbbbbbbbbbbbbbbbbbb",
  anchor: {
    kind: "node" as const,
    id: 999,
    total_inbound: 0,
    total_outbound: 0,
    total_unique_edges: 0,
  },
  nodes: [],
  edges: [],
  page: { limit: 250, returned: 0, next_cursor: null },
};

describe("GraphTab server-refresh state reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExactNeighborhoodMock.mockReturnValue(emptyExactState());
    useExactScopeMock.mockReturnValue(emptyExactState());
  });

  it("closes details for a node removed by a topology refresh", async () => {
    const first = {
      nodes: [makeNode(1, "removed"), makeNode(2, "kept")],
      edges: [],
      total_nodes: 2,
      topology_revision: "revision-1",
    };
    const second = {
      nodes: [makeNode(2, "kept")],
      edges: [],
      total_nodes: 1,
      topology_revision: "revision-2",
    };
    const state = {
      data: first,
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    };
    (useGraphData as any).mockImplementation(() => state);
    const { rerender } = render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Select first graph node" }));
    expect(await screen.findByRole("heading", { name: "removed" })).toBeInTheDocument();

    state.data = second;
    rerender(<GraphTab project="test" />);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "removed" })).not.toBeInTheDocument();
    });
  });

  it("preserves an off-overview result only after its exact anchor is revalidated", async () => {
    const state = {
      data: {
        nodes: [makeNode(1, "representative")],
        edges: [],
        total_nodes: 100,
        topology_revision: "exact-refresh-1",
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    };
    (useGraphData as any).mockImplementation(() => state);
    const { rerender } = render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Select exact node outside overview" }));
    expect(await screen.findByRole("heading", { name: "exact-outside" })).toBeInTheDocument();

    state.data = {
      ...state.data,
      nodes: [makeNode(2, "new-representative")],
      topology_revision: "exact-refresh-2",
    };
    useExactNeighborhoodMock.mockReturnValue({
      ...emptyExactState(),
      data: exactOutsideData,
    });
    rerender(<GraphTab project="test" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "exact-outside" })).toBeInTheDocument();
      expect(screen.getByText(/outside the representative map/i)).toBeInTheDocument();
    });
    expect(useExactNeighborhoodMock).toHaveBeenCalledWith(
      "test",
      999,
      true,
      "test:exact-refresh-2:0",
    );
  });

  it("closes an off-overview result when exact revalidation fails", async () => {
    const state = {
      data: {
        nodes: [makeNode(1, "representative")],
        edges: [],
        total_nodes: 100,
        topology_revision: "exact-refresh-1",
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    };
    (useGraphData as any).mockImplementation(() => state);
    const { rerender } = render(<GraphTab project="test" />);

    const trigger = screen.getByRole("button", { name: "Select exact node outside overview" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("heading", { name: "exact-outside" })).toBeInTheDocument();

    state.data = {
      ...state.data,
      topology_revision: "exact-refresh-2",
    };
    useExactNeighborhoodMock.mockReturnValue({
      ...emptyExactState(),
      error: "Node not found",
      errorStatus: 404,
      errorPhase: "initial",
    });
    rerender(<GraphTab project="test" />);

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "exact-outside" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("restores focus to the detail trigger after closing the panel", async () => {
    (useGraphData as any).mockReturnValue({
      data: {
        nodes: [makeNode(1, "focus-target")],
        edges: [],
        total_nodes: 1,
        topology_revision: "focus-1",
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });
    render(<GraphTab project="test" />);

    const trigger = screen.getByRole("button", { name: "Select first graph node" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("heading", { name: "focus-target" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("navigates domain scope with a reversible breadcrumb", () => {
    const nodes = [
      { ...makeNode(1, "one"), cluster_id: 0 },
      { ...makeNode(2, "two"), cluster_id: 0 },
    ];
    (useGraphData as any).mockReturnValue({
      data: {
        nodes,
        edges: [],
        total_nodes: 2,
        layout: {
          strategy: "architecture-domain-v1",
          node_spacing: 16,
          counts_scope: "returned_nodes",
          clusters: [{ id: 0, domain_id: 0, key: "src/lib", x: 0, y: 0, radius: 80, node_count: 2 }],
          domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 140, node_count: 2, cluster_count: 1 }],
        },
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });
    render(<GraphTab project="test" />);

    const domainControl = screen.getByRole("button", { name: "Select first domain" });
    fireEvent.click(domainControl);
    expect(screen.getByRole("navigation", { name: "Graph navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-current", "page");

    fireEvent.keyDown(domainControl, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Graph navigation" })).not.toBeInTheDocument();
  });

  it("opens a paginated exact scope in the existing canvas", async () => {
    const nodes = [
      { ...makeNode(1, "one"), cluster_id: 0 },
      { ...makeNode(2, "two"), cluster_id: 0 },
    ];
    (useGraphData as any).mockReturnValue({
      data: {
        nodes,
        edges: [],
        total_nodes: 3,
        graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
        layout: {
          strategy: "architecture-domain-v1",
          node_spacing: 16,
          counts_scope: "returned_nodes",
          clusters: [{ id: 0, domain_id: 0, key: "src/lib", x: 0, y: 0, radius: 80, node_count: 2 }],
          domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 140, node_count: 2, cluster_count: 1 }],
        },
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });
    const loadMore = vi.fn();
    useExactScopeMock.mockImplementation((
      _project: string,
      _kind: string,
      _key: string,
      enabled: boolean,
    ) => enabled ? exactScopeState(loadMore) : emptyExactState());
    render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Select first domain" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open exact scope" }));

    await waitFor(() => expect(screen.getByTestId("graph-canvas-node-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("graph-canvas-layout")).toHaveTextContent("exact-directory-file-v1");
    expect(screen.getByText(/3 exact nodes/i)).toBeInTheDocument();
    expect(useExactScopeMock).toHaveBeenLastCalledWith(
      "test",
      "domain",
      "src",
      true,
      "test:graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa:0",
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more exact scope" }));
    expect(loadMore).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Select first graph node" }));
    expect(screen.getByTestId("graph-canvas-layout")).toHaveTextContent("exact-directory-file-v1");
    expect(screen.getByTestId("graph-canvas-selected-node")).toHaveTextContent("10");
    expect(screen.getByTestId("graph-canvas-highlight-count")).toHaveTextContent("2");
    expect(useExactScopeMock).toHaveBeenLastCalledWith(
      "test",
      "domain",
      "src",
      true,
      "test:graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa:0",
    );
  });

  it("opens exact symbols immediately after an explicit community drill-down", async () => {
    const nodes = [
      { ...makeNode(1, "one"), cluster_id: 0 },
      { ...makeNode(2, "two"), cluster_id: 0 },
    ];
    (useGraphData as any).mockReturnValue({
      data: {
        nodes,
        edges: [],
        total_nodes: 2,
        graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
        layout: {
          strategy: "architecture-domain-v1",
          node_spacing: 16,
          counts_scope: "returned_nodes",
          clusters: [{ id: 0, domain_id: 0, key: "src/lib", x: 0, y: 0, radius: 80, node_count: 2 }],
          domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 140, node_count: 2, cluster_count: 1 }],
        },
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });
    useExactScopeMock.mockImplementation((
      _project: string,
      _kind: string,
      _key: string,
      enabled: boolean,
    ) => enabled ? exactScopeState() : emptyExactState());
    render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Select first community" }));

    await waitFor(() => expect(useExactScopeMock).toHaveBeenLastCalledWith(
      "test",
      "community",
      "src/lib",
      true,
      "test:graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa:0",
    ));
    expect(screen.queryByRole("button", { name: "Open exact scope" })).not.toBeInTheDocument();
  });

  it("keeps a sidebar directory distinct from a homonymous community", async () => {
    const nodes = [
      { ...makeNode(1, "one"), file_path: "src/lib/one.ts", cluster_id: 0 },
      { ...makeNode(2, "two"), file_path: "src/lib/nested/two.ts", cluster_id: 1 },
    ];
    (useGraphData as any).mockReturnValue({
      data: {
        nodes,
        edges: [],
        total_nodes: 20,
        graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
        layout: {
          strategy: "architecture-domain-v1",
          node_spacing: 16,
          counts_scope: "returned_nodes",
          clusters: [
            { id: 0, domain_id: 0, key: "src/lib", x: 0, y: 0, radius: 80, node_count: 1 },
            { id: 1, domain_id: 0, key: "src/lib/nested", x: 100, y: 0, radius: 80, node_count: 1 },
          ],
          domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 160, node_count: 2, cluster_count: 2 }],
        },
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    });
    useExactScopeMock.mockReturnValue(emptyExactState());
    render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    fireEvent.click(screen.getByRole("button", { name: "Select src/lib" }));

    await waitFor(() => expect(useExactScopeMock).toHaveBeenLastCalledWith(
      "test",
      "directory",
      "src/lib",
      true,
      "test:graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa:0",
    ));
    expect(screen.getByRole("button", { name: "lib" })).toHaveAttribute("aria-current", "page");
  });

  it("resolves breadcrumb scopes by stable keys after layout ids are renumbered", async () => {
    const firstNodes = [
      { ...makeNode(1, "one"), cluster_id: 0 },
      { ...makeNode(2, "two"), cluster_id: 0 },
    ];
    const state = {
      data: {
        nodes: firstNodes,
        edges: [],
        total_nodes: 2,
        topology_revision: "scope-revision-1",
        layout: {
          strategy: "architecture-domain-v1",
          node_spacing: 16,
          counts_scope: "returned_nodes",
          clusters: [{ id: 0, domain_id: 0, key: "src/lib", x: 0, y: 0, radius: 80, node_count: 2 }],
          domains: [{ id: 0, key: "src", x: 0, y: 0, radius: 140, node_count: 2, cluster_count: 1 }],
        },
      },
      loading: false,
      error: null,
      fetchOverview: vi.fn(),
    };
    (useGraphData as any).mockImplementation(() => state);
    const { rerender } = render(<GraphTab project="test" />);

    fireEvent.click(screen.getByRole("button", { name: "Select first domain" }));
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-current", "page");

    state.data = {
      ...state.data,
      nodes: [
        { ...makeNode(1, "one"), cluster_id: 91 },
        { ...makeNode(2, "two"), cluster_id: 91 },
        { ...makeNode(3, "three"), cluster_id: 91 },
      ],
      total_nodes: 3,
      topology_revision: "scope-revision-2",
      layout: {
        ...state.data.layout,
        clusters: [{ id: 91, domain_id: 37, key: "src/lib", x: 0, y: 0, radius: 90, node_count: 3 }],
        domains: [{ id: 37, key: "src", x: 0, y: 0, radius: 150, node_count: 3, cluster_count: 1 }],
      },
    };
    rerender(<GraphTab project="test" />);

    await waitFor(() => {
      expect(screen.getByText("3 selected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-current", "page");
    });
  });
});
