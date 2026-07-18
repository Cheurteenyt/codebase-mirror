import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphPathData } from "../lib/types";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: { getPath: vi.fn() },
}));

import { api } from "../api/client";
import { useExactPath } from "./useExactPath";

function response(overrides: Partial<GraphPathData> = {}): GraphPathData {
  return {
    contract_version: 1,
    exact: true,
    graph_revision: "graph-reader-v1:aaaaaaaaaaaaaaaaaaaaaa",
    strategy: "bounded-undirected-bfs-v1",
    status: "found",
    source_id: 1,
    target_id: 2,
    hops: 1,
    nodes: [
      { id: 1, x: 0, y: 0, size: 1, color: "#fff", label: "Function", name: "a" },
      { id: 2, x: 0, y: 0, size: 1, color: "#fff", label: "Function", name: "b" },
    ],
    edges: [{ id: 1, source: 1, target: 2, type: "CALLS" }],
    search: { complete: true, visited_nodes: 2, visited_edges: 1 },
    limits: { max_hops: 6, max_visited_nodes: 5000, max_visited_edges: 20000 },
    ...overrides,
  };
}

describe("useExactPath", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads only when armed and validates the returned endpoints", async () => {
    vi.mocked(api.getPath).mockResolvedValue(response());
    const { result, rerender } = renderHook(
      ({ enabled }) => useExactPath("project", 1, 2, enabled, "revision-a"),
      { initialProps: { enabled: false } },
    );
    expect(api.getPath).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data?.hops).toBe(1));
    expect(api.getPath).toHaveBeenCalledWith("project", 1, 2, { signal: expect.any(AbortSignal) });
  });

  it("rejects a malformed path instead of rendering misleading coupling", async () => {
    vi.mocked(api.getPath).mockResolvedValue(response({ target_id: 9 }));
    const { result } = renderHook(() => useExactPath("project", 1, 2, true));

    await waitFor(() => expect(result.current.error).toMatch(/invalid for the selected symbols/u));
    expect(result.current.data).toBeNull();
  });
});
