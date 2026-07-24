import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphScopeData } from "../lib/types";
import { useExactScope } from "./useExactScope";

vi.mock("../api/client", () => {
  class ApiError extends Error {
    constructor(public code: number, message: string, public details?: unknown) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { ApiError, api: { getScope: vi.fn() } };
});

function graphNode(id: number): GraphNode {
  return {
    id,
    x: id * 10,
    y: id * 5,
    size: 5,
    color: "#60a5fa",
    label: "Function",
    name: `node-${id}`,
    file_path: `src/node-${id}.ts`,
  };
}

function scopePage({
  key = "src",
  nodes = [graphNode(1)],
  edges = [],
  nextCursor = null,
  graphRevision = "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
}: {
  key?: string;
  nodes?: GraphNode[];
  edges?: GraphScopeData["edges"];
  nextCursor?: string | null;
  graphRevision?: string;
} = {}): GraphScopeData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: graphRevision,
    scope: {
      kind: "community",
      key,
      total_nodes: 3,
      total_internal_edges: 2,
    },
    boundary: {
      exact: true,
      total_relations: 0,
      incoming_relations: 0,
      outgoing_relations: 0,
      returned_groups: 0,
      truncated: false,
      dependencies: [],
    },
    nodes,
    edges,
    complete: nextCursor == null,
    page: {
      node_limit: 125,
      edge_limit: 125,
      returned_nodes: nodes.length,
      returned_edges: edges.length,
      next_cursor: nextCursor,
    },
  };
}

describe("useExactScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges bounded pages into one deterministic exact scope frame", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.getScope)
      .mockResolvedValueOnce(scopePage({ nextCursor: "page-2" }))
      .mockResolvedValueOnce(scopePage({
        nodes: [graphNode(3), graphNode(2)],
        edges: [
          { id: 11, source: 3, target: 1, type: "IMPORTS" },
          { id: 10, source: 1, target: 2, type: "CALLS" },
        ],
      }));

    const { result } = renderHook(() => (
      useExactScope("project-a", "community", "src", true, "revision-1")
    ));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("page-2"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1, 2, 3]);
    expect(result.current.data?.edges.map((edge) => edge.id)).toEqual([10, 11]);
    expect(result.current.data?.complete).toBe(true);
    expect(api.getScope).toHaveBeenNthCalledWith(
      2,
      "project-a",
      "community",
      "src",
      "page-2",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("masks old pages immediately when the scope changes", async () => {
    const { api } = await import("../api/client");
    let resolveNext!: (page: GraphScopeData) => void;
    const next = new Promise<GraphScopeData>((resolve) => { resolveNext = resolve; });
    vi.mocked(api.getScope)
      .mockResolvedValueOnce(scopePage())
      .mockImplementationOnce(() => next);

    const { result, rerender } = renderHook(
      ({ key }) => useExactScope("project-a", "community", key, true, "revision-1"),
      { initialProps: { key: "src" } },
    );
    await waitFor(() => expect(result.current.data?.scope.key).toBe("src"));
    rerender({ key: "tests" });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveNext(scopePage({ key: "tests" }));
      await next;
    });
    expect(result.current.data?.scope.key).toBe("tests");
  });

  it("drops accumulated pages and restarts after a revision mismatch", async () => {
    const { api, ApiError } = await import("../api/client");
    vi.mocked(api.getScope)
      .mockResolvedValueOnce(scopePage({ nextCursor: "old-page" }))
      .mockRejectedValueOnce(new ApiError(409, "Graph changed", {
        code: "GRAPH_REVISION_MISMATCH",
        restart_from_first_page: true,
      }))
      .mockResolvedValueOnce(scopePage({
        nodes: [graphNode(9)],
        graphRevision: "graph-reader-v1:bbbbbbbbbbbbbbbbbbbbbb",
      }));

    const { result } = renderHook(() => (
      useExactScope("project-a", "community", "src", true, "revision-1")
    ));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("old-page"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.data?.nodes[0]?.id).toBe(9));
    expect(result.current.error).toBeNull();
    expect(api.getScope).toHaveBeenNthCalledWith(
      3,
      "project-a",
      "community",
      "src",
      null,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("preserves loaded pages after a recoverable pagination failure", async () => {
    const { api, ApiError } = await import("../api/client");
    vi.mocked(api.getScope)
      .mockResolvedValueOnce(scopePage({ nextCursor: "page-2" }))
      .mockRejectedValueOnce(new ApiError(503, "Backend busy"))
      .mockResolvedValueOnce(scopePage({ nodes: [graphNode(2)] }));
    const { result } = renderHook(() => (
      useExactScope("project-a", "community", "src", true, "revision-1")
    ));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("page-2"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe("Backend busy"));
    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1, 2]));
  });
});
