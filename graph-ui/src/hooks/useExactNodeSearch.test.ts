import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphNodeSearchData } from "../lib/types";
import { useExactNodeSearch } from "./useExactNodeSearch";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: number, message: string, public details?: unknown) {
      super(message);
    }
  },
  api: {
    searchNodes: vi.fn(),
  },
}));

const makeNode = (id: number, name: string): GraphNode => ({
  id,
  x: 0,
  y: 0,
  label: "Function",
  name,
  size: 4,
  color: "#22d3ee",
});

function makePage(
  query: string,
  nodes: GraphNode[],
  nextCursor: string | null,
  totalMatches = nodes.length,
): GraphNodeSearchData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
    scope: "complete_project",
    query,
    match_strategy: "literal-relevance-v1",
    total_matches: totalMatches,
    returned_nodes: nodes.length,
    truncated: nextCursor != null,
    nodes,
    page: {
      limit: 50,
      returned: nodes.length,
      next_cursor: nextCursor,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useExactNodeSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces input and ignores an aborted stale query", async () => {
    vi.useFakeTimers();
    const first = deferred<GraphNodeSearchData>();
    const second = deferred<GraphNodeSearchData>();
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ query }) => useExactNodeSearch("project", query, 180),
      { initialProps: { query: "old" } },
    );

    expect(api.searchNodes).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(180);
      await Promise.resolve();
    });
    const firstSignal = (api.searchNodes as ReturnType<typeof vi.fn>).mock.calls[0][3].signal as AbortSignal;

    rerender({ query: "new" });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(180);
      await Promise.resolve();
    });

    await act(async () => {
      first.resolve(makePage("old", [makeNode(1, "old")], null));
      second.resolve(makePage("new", [makeNode(2, "new")], null));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.query).toBe("new");
    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([2]);
  });

  it("restarts page one when the caller advances the exact refresh key", async () => {
    const oldPage = makePage("graph", [makeNode(1, "old")], null);
    const freshPage = makePage("graph", [makeNode(2, "fresh")], null);
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(oldPage)
      .mockResolvedValueOnce(freshPage);
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useExactNodeSearch("project", "graph", 0, refreshKey),
      { initialProps: { refreshKey: 1 } },
    );

    await waitFor(() => expect(result.current.data?.nodes[0]?.id).toBe(1));
    rerender({ refreshKey: 2 });
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.data?.nodes[0]?.id).toBe(2));
    expect(api.searchNodes).toHaveBeenCalledTimes(2);
    expect(api.searchNodes).toHaveBeenLastCalledWith(
      "project",
      "graph",
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("never exposes project A results while the same query loads for project B", async () => {
    const projectB = deferred<GraphNodeSearchData>();
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePage("graph", [makeNode(1, "project-a")], null))
      .mockReturnValueOnce(projectB.promise);
    const { result, rerender } = renderHook(
      ({ project }) => useExactNodeSearch(project, "graph", 0, "generation-1"),
      { initialProps: { project: "project-a" } },
    );
    await waitFor(() => expect(result.current.data?.nodes[0]?.id).toBe(1));

    rerender({ project: "project-b" });
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(api.searchNodes).toHaveBeenCalledTimes(2));

    await act(async () => {
      projectB.resolve(makePage("graph", [makeNode(2, "project-b")], null));
      await projectB.promise;
    });
    expect(result.current.data?.nodes[0]?.id).toBe(2);
    expect(api.searchNodes).toHaveBeenLastCalledWith(
      "project-b",
      "graph",
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("masks an old error when both the query and refresh generation change", async () => {
    const { ApiError } = await import("../api/client");
    const fresh = deferred<GraphNodeSearchData>();
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new ApiError(503, "Old search unavailable"))
      .mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(
      ({ query, refreshKey }) => useExactNodeSearch("project", query, 0, refreshKey),
      { initialProps: { query: "old", refreshKey: 1 } },
    );

    await waitFor(() => expect(result.current.error).toBe("Old search unavailable"));
    expect(result.current.errorStatus).toBe(503);
    expect(result.current.loading).toBe(false);

    rerender({ query: "fresh", refreshKey: 2 });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.errorPhase).toBeNull();
    expect(result.current.errorStatus).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(api.searchNodes).toHaveBeenCalledTimes(2));
    await act(async () => {
      fresh.resolve(makePage("fresh", [makeNode(2, "fresh")], null));
      await fresh.promise;
    });
    expect(result.current.data?.query).toBe("fresh");
    expect(result.current.error).toBeNull();
  });

  it("does not expose an old loading state after search is disabled", async () => {
    const pending = deferred<GraphNodeSearchData>();
    (api.searchNodes as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ query }) => useExactNodeSearch("project", query, 0, "generation-1"),
      { initialProps: { query: "active" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ query: "" });

    expect(result.current.loading).toBe(false);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("merges exact pages in relevance order without duplicates", async () => {
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePage("auth", [makeNode(2, "exact"), makeNode(1, "prefix")], "next", 4))
      .mockResolvedValueOnce(makePage("auth", [makeNode(1, "prefix"), makeNode(3, "path")], null, 4));
    const { result } = renderHook(() => useExactNodeSearch("project", " auth ", 0));

    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("next"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([2, 1, 3]);
    expect(result.current.data?.page).toMatchObject({ returned: 3, next_cursor: null });
    expect(api.searchNodes).toHaveBeenNthCalledWith(
      2,
      "project",
      "auth",
      "next",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps loaded pages when pagination fails and retries that page", async () => {
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePage("graph", [makeNode(1, "graph")], "cursor", 2))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(makePage("graph", [makeNode(2, "graph-ui")], null, 2));
    const { result } = renderHook(() => useExactNodeSearch("project", "graph", 0));

    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.errorPhase).toBe("more"));
    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1]);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data?.nodes.map((node) => node.id)).toEqual([1, 2]));
    expect(result.current.error).toBeNull();
  });

  it("discards stale pages and restarts automatically after a graph revision mismatch", async () => {
    const { ApiError } = await import("../api/client");
    const fresh = makePage("graph", [makeNode(9, "fresh")], null, 1);
    fresh.graph_revision = "graph-reader-v1:bbbbbbbbbbbbbbbbbbbbbb";
    (api.searchNodes as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePage("graph", [makeNode(1, "stale")], "old-cursor", 2))
      .mockRejectedValueOnce(new ApiError(409, "Graph changed", {
        code: "GRAPH_REVISION_MISMATCH",
        restart_from_first_page: true,
      }))
      .mockResolvedValueOnce(fresh);
    const { result } = renderHook(() => useExactNodeSearch("project", "graph", 0));

    await waitFor(() => expect(result.current.data?.page.next_cursor).toBe("old-cursor"));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.data?.graph_revision).toBe(fresh.graph_revision));
    expect(result.current.data?.nodes.map((node) => node.id)).toEqual([9]);
    expect(result.current.error).toBeNull();
    expect(api.searchNodes).toHaveBeenNthCalledWith(
      3,
      "project",
      "graph",
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
