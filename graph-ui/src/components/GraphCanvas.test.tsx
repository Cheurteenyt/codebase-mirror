// graph-ui/src/components/GraphCanvas.test.tsx
// R45 (F5): regression test for the R40 sim-reuse optimization. Spies on
// forceSimulation to assert it's constructed exactly ONCE across data changes,
// and that sim.stop() is called exactly ONCE on unmount (not on every data change).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { GraphCanvas } from "./GraphCanvas";
import type { GraphData, GraphNode, GraphEdge } from "../lib/types";

// Mock d3-force to track simulation construction and method calls.
// The real API is chainable — every method returns the simulation itself.
vi.mock("d3-force", () => {
  const stop = vi.fn();
  const restart = vi.fn();
  const alphaTarget = vi.fn(function (this: unknown) { return this; });
  const alpha = vi.fn(function (this: unknown) { return this; });
  const alphaDecay = vi.fn(function (this: unknown) { return this; });
  const on = vi.fn(function (this: unknown) { return this; });
  const nodes = vi.fn(function (this: unknown) { return this; });
  const linksMock = vi.fn();
  // force(name, force?) — with 2 args returns the simulation (chainable);
  // with 1 arg (getter) returns the force object (which has .links()).
  const force = vi.fn(function (this: unknown, _name: string, f?: unknown) {
    if (f !== undefined) return this; // setter → chainable
    return { links: linksMock }; // getter → returns the force object
  });
  const forceSimulation = vi.fn(() => ({ nodes, alpha, alphaDecay, on, stop, force, alphaTarget, restart }));
  return {
    forceSimulation,
    forceManyBody: () => ({ strength: () => ({}) }),
    forceLink: () => ({ id: () => ({ distance: () => ({ strength: () => ({}) }) }) }),
    forceCenter: () => ({}),
    forceCollide: () => ({}),
  };
});

const makeNode = (id: number, name: string): GraphNode => ({
  id,
  label: "Function",
  name,
  file_path: `${name}.ts`,
  qualified_name: name,
  start_line: 1,
  end_line: 10,
  properties_json: "{}",
  risk_score: null,
  notes_count: 0,
  status: "active",
} as GraphNode);

const dataA: GraphData = {
  nodes: [makeNode(1, "foo")],
  edges: [],
} as GraphData;

const dataB: GraphData = {
  nodes: [makeNode(1, "foo"), makeNode(2, "bar")],
  edges: [{ source: 1, target: 2, type: "calls" } as unknown as GraphEdge],
} as GraphData;

describe("R45 (F5): GraphCanvas sim-reuse (R40 UI-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reuses the same simulation across data changes (does not explode the graph)", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const { rerender, unmount } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    expect(forceSimulation).toHaveBeenCalledTimes(1);

    // Re-render with new data (filter toggle, WS refetch, etc.) — must NOT
    // construct a new simulation. The pre-R40 code would call forceSimulation
    // again here, losing all node positions.
    rerender(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    expect(forceSimulation).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("calls sim.stop() on unmount (not on every data change)", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const { rerender, unmount } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    // Data change should NOT call stop (pre-R40 behavior was to stop+recreate).
    rerender(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    const sim = (forceSimulation as any).mock.results[0].value;
    // stop should not have been called yet (only on unmount).
    expect(sim.stop).not.toHaveBeenCalled();

    unmount();
    // Cleanup runs sim.stop() exactly once (on unmount).
    expect(sim.stop).toHaveBeenCalledTimes(1);
  });
});
