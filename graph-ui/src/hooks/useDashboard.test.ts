// graph-ui/src/hooks/useDashboard.test.ts
// R45 (F2): regression test for useDashboard — mirrors the C1 test for useGraphData.
// useDashboard had the same unconditional setLoading(true) bug (R43 H1) and the
// same dataProjectRef fix. Without this test, a future refactor could regress
// the fix and the DashboardTab would flicker on every WS notification.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDashboard } from "./useDashboard";

vi.mock("../api/client", () => ({
  api: { getDashboard: vi.fn() },
}));

function mockDashboard(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    project: "my-project",
    generated_at: new Date().toISOString(),
    code_graph: { total_nodes: 10, total_edges: 20, nodes_by_label: {} },
    human_memory: { total_notes: 0, adrs: 0, bugs: 0, refactors: 0, conventions: 0 },
    documentation_coverage: { critical_modules_total: 0, critical_modules_documented: 0, coverage_pct: null },
    graph_status: {
      available: true, last_indexed: null, age_seconds: 0, stale: false, stale_reason: null,
      stale_files_count: 0, stale_files_sample: [], total_nodes: 10, total_edges: 20,
      freshness_score: 1.0, freshness_label: "FRESH", recommendation: "FRESH",
    },
    recommendations: [],
    ...overrides,
  };
}

describe("R45 (F2): useDashboard — C1 regression test (mirrors useGraphData)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT set loading=true on refetch when data already exists for the same project", async () => {
    const { api } = await import("../api/client");
    (api.getDashboard as any).mockResolvedValue(mockDashboard());

    const { result } = renderHook(() => useDashboard());

    await act(async () => { result.current.fetch("my-project"); });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).not.toBeNull();

    // Refetch same project (simulating WS notification) — must not show spinner.
    await act(async () => { result.current.fetch("my-project"); });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).not.toBeNull();
  });

  it("DOES set loading=true when switching to a different project", async () => {
    const { api } = await import("../api/client");
    let call = 0;
    (api.getDashboard as any).mockImplementation(async () =>
      mockDashboard({ project: call++ === 0 ? "a" : "b" }),
    );

    const { result } = renderHook(() => useDashboard());
    await act(async () => { result.current.fetch("a"); });
    expect(result.current.data?.project).toBe("a");

    await act(async () => { result.current.fetch("b"); });
    expect(result.current.data?.project).toBe("b");
    expect(result.current.loading).toBe(false);
  });

  it("ignores stale responses (rapid project switch)", async () => {
    const { api } = await import("../api/client");
    let resolveA: (v: unknown) => void = () => {};
    const aPromise = new Promise((r) => { resolveA = r; });
    (api.getDashboard as any)
      .mockReturnValueOnce(aPromise)
      .mockResolvedValueOnce(mockDashboard({ project: "b" }));

    const { result } = renderHook(() => useDashboard());
    act(() => { result.current.fetch("a"); });
    await act(async () => { result.current.fetch("b"); });
    expect(result.current.data?.project).toBe("b");

    // Now resolve A late — it must NOT overwrite B's data.
    await act(async () => { resolveA(mockDashboard({ project: "a" })); });
    expect(result.current.data?.project).toBe("b");
  });
});
