import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNeighborhoodData, GraphNode } from "../lib/types";
import { useExactNeighborhood } from "./useExactNeighborhood";

vi.mock("../api/client", () => {
  class ApiError extends Error {
    constructor(public code: number, message: string, public details?: unknown) {
      super(message);
      this.name = "ApiError";
    }
  }

  return {
    ApiError,
    api: { getNeighborhood: vi.fn() },
  };
});

function graphNode(id: number): GraphNode {
  return {
    id,
    x: id,
    y: id,
    size: 5,
    color: "#60a5fa",
    label: "Function",
    name: `node-${id}`,
    file_path: `src/node-${id}.ts`,
  };
}

function neighborhoodPage({
  anchorId = 1,
  nodes = [graphNode(1), graphNode(2)],
  edges = [{ id: 10, source: 1, target: 2, type: "CALLS" }],
  nextCursor = null,
}: {
  anchorId?: number;
  nodes?: GraphNode[];
  edges?: GraphNeighborhoodData["edges"];
  nextCursor?: string | null;
} = {}): GraphNeighborhoodData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
    anchor: {
      kind: "node",
      id: anchorId,
      total_inbound: 1,
      total_outbound: 2,
      total_unique_edges: 2,
    },
    nodes,
    edges,
    page: {
      limit: 250,
      returned: edges.length,
      next_cursor: nextCursor,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useExactNeighborhood", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads and deterministically merges exact pages without duplicate nodes or edges", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage({ nextCursor: "page-2" }))
      .mockResolvedValueOnce(neighborhoodPage({
        nodes: [graphNode(3), graphNode(2)],
        edges: [
          { id: 11, source: 3, target: 1, type: "IMPORTS" },
          { id: 10, source: 1, target: 2, type: "CALLS" },
        ],
      }));

    const { result } = renderHook(() => useExactNeighborhood("project-a", 1, true));

    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("page-2"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1, 2, 3]);
    expect(result.current.data?.edges.map((edge) => edge.id)).toEqual([10, 11]);
    expect(result.current.data?.page).toEqual({
      limit: 250,
      returned: 2,
      next_cursor: null,
    });
    expect(api.getNeighborhood).toHaveBeenNthCalledWith(
      2,
      "project-a",
      1,
      "page-2",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("aborts a stale node request and never lets its late response overwrite the new node", async () => {
    const { api } = await import("../api/client");
    const stale = deferred<GraphNeighborhoodData>();
    let staleSignal: AbortSignal | undefined;
    vi.mocked(api.getNeighborhood)
      .mockImplementationOnce((_project, _nodeId, _cursor, opts) => {
        staleSignal = opts?.signal;
        return stale.promise;
      })
      .mockResolvedValueOnce(neighborhoodPage({
        anchorId: 2,
        nodes: [graphNode(2), graphNode(4)],
        edges: [{ id: 20, source: 2, target: 4, type: "CALLS" }],
      }));

    const { result, rerender } = renderHook(
      ({ nodeId }) => useExactNeighborhood("project-a", nodeId, true),
      { initialProps: { nodeId: 1 } },
    );
    expect(api.getNeighborhood).toHaveBeenCalledTimes(1);

    rerender({ nodeId: 2 });
    await waitFor(() => expect(result.current.data?.anchor.id).toBe(2));
    expect(staleSignal?.aborted).toBe(true);

    await act(async () => {
      stale.resolve(neighborhoodPage({ anchorId: 1 }));
      await stale.promise;
    });
    expect(result.current.data?.anchor.id).toBe(2);
  });

  it("masks loaded pages synchronously when the project changes with the same node id", async () => {
    const { api } = await import("../api/client");
    const projectB = deferred<GraphNeighborhoodData>();
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage())
      .mockImplementationOnce(() => projectB.promise);

    const { result, rerender } = renderHook(
      ({ project }) => useExactNeighborhood(project, 1, true, "revision-1"),
      { initialProps: { project: "project-a" } },
    );
    await waitFor(() => expect(result.current.data?.anchor.id).toBe(1));

    rerender({ project: "project-b" });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      projectB.resolve(neighborhoodPage());
      await projectB.promise;
    });
    expect(result.current.data?.anchor.id).toBe(1);
    expect(api.getNeighborhood).toHaveBeenLastCalledWith(
      "project-b",
      1,
      null,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("invalidates exact pages when the caller refresh generation changes", async () => {
    const { api } = await import("../api/client");
    const refreshed = deferred<GraphNeighborhoodData>();
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage())
      .mockImplementationOnce(() => refreshed.promise);

    const { result, rerender } = renderHook(
      ({ refreshKey }) => useExactNeighborhood("project-a", 1, true, refreshKey),
      { initialProps: { refreshKey: "graph-a:1" } },
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());

    rerender({ refreshKey: "graph-b:2" });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      refreshed.resolve(neighborhoodPage());
      await refreshed.promise;
    });
    expect(result.current.data?.anchor.id).toBe(1);
    expect(api.getNeighborhood).toHaveBeenCalledTimes(2);
  });

  it("rejects a response frame anchored to a different node", async () => {
    const { api } = await import("../api/client");
    vi.mocked(api.getNeighborhood).mockResolvedValueOnce(neighborhoodPage({ anchorId: 9 }));

    const { result } = renderHook(() => useExactNeighborhood("project-a", 1, true));

    await waitFor(() => expect(result.current.error).toMatch(/did not match the selected node/u));
    expect(result.current.data).toBeNull();
    expect(result.current.errorPhase).toBe("initial");
  });

  it("preserves loaded pages after a pagination error and retries only the failed page", async () => {
    const { api, ApiError } = await import("../api/client");
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage({ nextCursor: "page-2" }))
      .mockRejectedValueOnce(new ApiError(503, "Backend is busy"))
      .mockResolvedValueOnce(neighborhoodPage({
        nodes: [graphNode(1), graphNode(3)],
        edges: [{ id: 11, source: 3, target: 1, type: "IMPORTS" }],
      }));

    const { result } = renderHook(() => useExactNeighborhood("project-a", 1, true));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("page-2"));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toBe("Backend is busy"));
    expect(result.current.errorPhase).toBe("more");
    expect(result.current.data?.edges.map((edge) => edge.id)).toEqual([10]);
    expect(result.current.data?.page.next_cursor).toBe("page-2");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data?.edges.map((edge) => edge.id)).toEqual([10, 11]));
    expect(result.current.error).toBeNull();
    expect(api.getNeighborhood).toHaveBeenNthCalledWith(
      3,
      "project-a",
      1,
      "page-2",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("restarts the first page after an initial failure", async () => {
    const { api, ApiError } = await import("../api/client");
    vi.mocked(api.getNeighborhood)
      .mockRejectedValueOnce(new ApiError(500, "Neighborhood unavailable"))
      .mockResolvedValueOnce(neighborhoodPage());

    const { result } = renderHook(() => useExactNeighborhood("project-a", 1, true));
    await waitFor(() => expect(result.current.error).toBe("Neighborhood unavailable"));
    expect(result.current.errorPhase).toBe("initial");
    expect(result.current.errorStatus).toBe(500);
    expect(result.current.data).toBeNull();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data?.anchor.id).toBe(1));
    expect(result.current.error).toBeNull();
    expect(api.getNeighborhood).toHaveBeenNthCalledWith(
      2,
      "project-a",
      1,
      null,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("masks a prior generation's HTTP failure before the refreshed request settles", async () => {
    const { api, ApiError } = await import("../api/client");
    const refreshed = deferred<GraphNeighborhoodData>();
    vi.mocked(api.getNeighborhood)
      .mockRejectedValueOnce(new ApiError(503, "Temporarily unavailable"))
      .mockImplementationOnce(() => refreshed.promise);
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useExactNeighborhood("project-a", 1, true, refreshKey),
      { initialProps: { refreshKey: "revision-1" } },
    );

    await waitFor(() => expect(result.current.error).toBe("Temporarily unavailable"));
    expect(result.current.errorStatus).toBe(503);

    rerender({ refreshKey: "revision-2" });
    expect(result.current.error).toBeNull();
    expect(result.current.errorPhase).toBeNull();
    expect(result.current.errorStatus).toBeNull();
    expect(result.current.data).toBeNull();

    await act(async () => {
      refreshed.resolve(neighborhoodPage());
      await refreshed.promise;
    });
    expect(result.current.data?.anchor.id).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("exposes the HTTP 404 status for the current exact anchor request", async () => {
    const { api, ApiError } = await import("../api/client");
    vi.mocked(api.getNeighborhood).mockRejectedValueOnce(new ApiError(404, "Node not found"));

    const { result } = renderHook(() => (
      useExactNeighborhood("project-a", 404, true, "revision-current")
    ));

    await waitFor(() => expect(result.current.error).toBe("Node not found"));
    expect(result.current.errorStatus).toBe(404);
    expect(result.current.errorPhase).toBe("initial");
  });

  it("aborts an in-flight pagination request when the consumer unmounts", async () => {
    const { api } = await import("../api/client");
    const pendingPage = deferred<GraphNeighborhoodData>();
    let paginationSignal: AbortSignal | undefined;
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage({ nextCursor: "page-2" }))
      .mockImplementationOnce((_project, _nodeId, _cursor, opts) => {
        paginationSignal = opts?.signal;
        return pendingPage.promise;
      });

    const { result, unmount } = renderHook(() => useExactNeighborhood("project-a", 1, true));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("page-2"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    unmount();
    expect(paginationSignal?.aborted).toBe(true);
  });

  it("drops accumulated edges and restarts page one after a graph revision mismatch", async () => {
    const { api, ApiError } = await import("../api/client");
    const fresh = neighborhoodPage({
      nodes: [graphNode(1), graphNode(9)],
      edges: [{ id: 90, source: 1, target: 9, type: "CALLS" }],
    });
    fresh.graph_revision = "graph-reader-v1:bbbbbbbbbbbbbbbbbbbbbb";
    vi.mocked(api.getNeighborhood)
      .mockResolvedValueOnce(neighborhoodPage({ nextCursor: "old-page" }))
      .mockRejectedValueOnce(new ApiError(409, "Graph changed", {
        code: "GRAPH_REVISION_MISMATCH",
        restart_from_first_page: true,
      }))
      .mockResolvedValueOnce(fresh);

    const { result } = renderHook(() => useExactNeighborhood("project-a", 1, true));
    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("old-page"));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.data?.graph_revision).toBe(fresh.graph_revision));
    expect(result.current.data?.edges.map((edge) => edge.id)).toEqual([90]);
    expect(result.current.error).toBeNull();
    expect(api.getNeighborhood).toHaveBeenNthCalledWith(
      3,
      "project-a",
      1,
      null,
      { signal: expect.any(AbortSignal) },
    );
  });
});
