// graph-ui/src/components/GraphCanvas.test.tsx
// Regression coverage for simulation reuse, topology-aware reheating,
// position restoration, bounded node sizing, and bounding-box fit/reset.

import { createRef } from "react";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { GraphCanvas, computeSemanticZoomLayers, type GraphCanvasHandle } from "./GraphCanvas";
import { NodeTooltip } from "./NodeTooltip";
import type { GraphData, GraphNode, GraphEdge } from "../lib/types";

// Mock d3-force to track simulation construction and method calls.
// The real API is chainable — every method returns the simulation itself.
vi.mock("d3-force", () => {
  const stop = vi.fn();
  const restart = vi.fn();
  const alphaTarget = vi.fn(function (this: unknown) { return this; });
  const alpha = vi.fn(function (this: unknown, value?: number) {
    return value === undefined ? 1 : this;
  });
  const alphaMin = vi.fn(() => 0.001);
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
  const forceSimulation = vi.fn(() => ({ nodes, alpha, alphaMin, alphaDecay, on, stop, force, alphaTarget, restart }));
  const forceLink = vi.fn(() => ({ id: () => ({ distance: () => ({ strength: () => ({}) }) }) }));
  return {
    forceSimulation,
    forceManyBody: () => ({ strength: () => ({ distanceMax: () => ({}) }) }),
    forceLink,
    forceCenter: () => ({}),
    forceX: () => ({ strength: () => ({}) }),
    forceY: () => ({ strength: () => ({}) }),
    forceCollide: () => ({}),
  };
});

const makeNode = (id: number, name: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  x: id * 100,
  y: id * 50,
  label: "Function",
  name,
  file_path: `${name}.ts`,
  qualified_name: name,
  start_line: 1,
  end_line: 10,
  size: 4,
  risk_score: null,
  notes_count: 0,
  status: "normal",
  ...overrides,
} as GraphNode);

const dataA: GraphData = {
  nodes: [makeNode(1, "foo")],
  edges: [],
  topology_revision: "revision-a",
} as GraphData;

const dataB: GraphData = {
  nodes: [makeNode(1, "foo"), makeNode(2, "bar")],
  edges: [{ source: 1, target: 2, type: "calls" } as unknown as GraphEdge],
  topology_revision: "revision-b",
} as GraphData;

describe("R45 (F5): GraphCanvas sim-reuse (R40 UI-2)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hands semantic zoom layers through quiet, non-overlapping flow transitions", () => {
    const [overviewDomains, overviewCommunities, , overviewRaw] = computeSemanticZoomLayers(4);
    expect(overviewDomains).toBe(1);
    expect(overviewCommunities).toBe(0);
    expect(overviewRaw).toBe(0);

    const [domainFlows, communityFlows, communityReveal] = computeSemanticZoomLayers(7);
    expect(domainFlows).toBe(0);
    expect(communityFlows).toBe(0);
    expect(communityReveal).toBeCloseTo(0.5);

    const [, fullCommunityFlows, , communityRaw] = computeSemanticZoomLayers(8.5);
    expect(fullCommunityFlows).toBeCloseTo(0.72);
    expect(communityRaw).toBe(0);

    const [, rawHandoffFlows, , rawHandoffReveal] = computeSemanticZoomLayers(18);
    expect(rawHandoffFlows).toBe(0);
    expect(rawHandoffReveal).toBe(0);

    const [, , , rawMidpoint] = computeSemanticZoomLayers(20);
    expect(rawMidpoint).toBeCloseTo(0.5);
    expect(computeSemanticZoomLayers(22)[3]).toBe(1);

    for (let spacing = 0; spacing <= 40; spacing += 0.1) {
      const [domains, communities, , raw] = computeSemanticZoomLayers(spacing);
      expect(domains > 0 && communities > 0).toBe(false);
      expect(communities > 0 && raw > 0).toBe(false);
    }
  });

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

    const sim = (forceSimulation as any).mock.results[0].value;
    expect(sim.force).toHaveBeenCalledWith("x", expect.anything());
    expect(sim.force).toHaveBeenCalledWith("y", expect.anything());
    expect(sim.force).not.toHaveBeenCalledWith("center", expect.anything());
    expect(sim.alpha).toHaveBeenCalledWith(0.3);
    expect(sim.restart).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("does not reheat for identical topology, known filter subsets, or restored nodes", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const refreshedDataB: GraphData = {
      ...dataB,
      nodes: [makeNode(1, "foo refreshed"), makeNode(2, "bar refreshed")],
    };
    const filteredDataB: GraphData = {
      ...dataB,
      nodes: [dataB.nodes[0]],
      edges: [],
    };
    const { rerender } = render(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const sim = (forceSimulation as any).mock.results[0].value;

    rerender(
      <GraphCanvas
        data={refreshedDataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    rerender(
      <GraphCanvas
        data={filteredDataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    rerender(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    expect(sim.alpha).not.toHaveBeenCalledWith(0.3);
    expect(sim.restart).not.toHaveBeenCalled();
  });

  it("reheats for a removal-only server topology revision", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const removedByServer: GraphData = {
      ...dataA,
      topology_revision: "revision-c",
    };
    const { rerender } = render(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const sim = (forceSimulation as any).mock.results[0].value;

    rerender(
      <GraphCanvas
        data={removedByServer}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    expect(sim.alpha).toHaveBeenCalledWith(0.3);
    expect(sim.restart).toHaveBeenCalledTimes(1);
  });

  it("reinitializes anchor forces when the server layout moves identical topology", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const movedLayout: GraphData = {
      ...dataB,
      topology_revision: "revision-moved",
      nodes: dataB.nodes.map((node) => ({
        ...node,
        x: node.x + 500,
        y: node.y - 250,
      })),
    };
    const { rerender } = render(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const sim = (forceSimulation as any).mock.results[0].value;
    const previousPhysicsNode = (forceSimulation as any).mock.calls[0][0][0] as GraphNode;

    rerender(
      <GraphCanvas
        data={movedLayout}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    expect(sim.nodes).toHaveBeenCalledTimes(1);
    const refreshedPhysicsNode = sim.nodes.mock.calls.at(-1)[0][0] as GraphNode;
    expect(refreshedPhysicsNode).not.toBe(previousPhysicsNode);
    expect(refreshedPhysicsNode.x).toBe(movedLayout.nodes[0].x);
    expect(sim.alpha).toHaveBeenCalledWith(0.3);
    expect(sim.restart).toHaveBeenCalledTimes(1);
  });

  it("confines local d3 refinement inside the server-authored community", async () => {
    const { forceSimulation } = await import("d3-force");
    installCanvasMock(800, 600);
    const boundedData: GraphData = {
      nodes: [makeNode(1, "outside", { x: 500, y: 0, cluster_id: 0, size: 4 })],
      edges: [],
      total_nodes: 1,
      topology_revision: "bounded-revision",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src", x: 0, y: 0, radius: 70, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 100, node_count: 1, cluster_count: 1 },
        ],
      },
    };

    render(
      <GraphCanvas
        data={boundedData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    const sim = (forceSimulation as any).mock.results[0].value;
    const tick = sim.on.mock.calls.find((call: unknown[]) => call[0] === "tick")?.[1] as (() => void) | undefined;
    const physicsNode = (forceSimulation as any).mock.calls[0][0][0] as GraphNode & { vx?: number; vy?: number };
    expect(tick).toBeTypeOf("function");

    act(() => tick?.());

    expect(Math.hypot(physicsNode.x, physicsNode.y)).toBeLessThanOrEqual(62);
    expect(physicsNode.vx).toBe(0);
    expect(physicsNode.vy).toBe(0);
  });

  it("reveals exact architecture counts only for the active scope", () => {
    const ctx = installCanvasMock(800, 600);
    const compactData: GraphData = {
      nodes: [makeNode(1, "root", { x: 0, y: 0, cluster_id: 0 })],
      edges: [],
      total_nodes: 12_500,
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "(root)", x: 0, y: 0, radius: 500, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "(root)", x: 0, y: 0, radius: 600, node_count: 1, cluster_count: 1 },
        ],
        domain_catalog: {
          exact: true,
          counts_scope: "all_nodes",
          total_domains: 1,
          domains: [
            { key: "(root)", node_count: 12_500, file_count: 100, representative_node_id: 1 },
          ],
        },
      },
    };

    const { getByRole } = render(
      <GraphCanvas
        data={compactData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    expect(ctx.fillText).not.toHaveBeenCalledWith(expect.stringContaining("12.5k nodes"), expect.any(Number), expect.any(Number));

    ctx.fillText.mockClear();
    fireEvent.keyDown(getByRole("application"), { key: "d" });

    expect(ctx.fillText).toHaveBeenCalledWith("12.5k nodes · 1 group", 0, expect.any(Number));
  });

  it("keeps raw nodes out of macro tiers and reveals them at symbol scale", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const macroData: GraphData = {
      nodes: [
        makeNode(1, "left", { x: -100, y: 0, cluster_id: 0 }),
        makeNode(2, "center", { x: 0, y: 0, cluster_id: 0 }),
        makeNode(3, "right", { x: 100, y: 0, cluster_id: 0 }),
      ],
      edges: [
        { source: 1, target: 2, type: "CALLS" },
        { source: 2, target: 3, type: "CALLS" },
      ],
      total_nodes: 3,
      topology_revision: "macro-first-lod",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/core", x: 0, y: 0, radius: 500, node_count: 3 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 600, node_count: 3, cluster_count: 1 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={macroData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onScopeSelect={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.arc.mockClear();
    ctx.lineTo.mockClear();
    act(() => ref.current?.zoomBy(1));
    expect(ctx.arc.mock.calls.some((call) => call[2] === 4)).toBe(false);
    expect(ctx.lineTo).not.toHaveBeenCalled();

    ctx.arc.mockClear();
    ctx.lineTo.mockClear();
    act(() => ref.current?.zoomBy(4));
    expect(ctx.arc.mock.calls.filter((call) => call[2] === 4)).toHaveLength(3);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
  });

  it("restores cached positions after every node is filtered out", async () => {
    const { forceSimulation } = await import("d3-force");
    const ctx = installCanvasMock(800, 600);
    const noop = () => {};
    const { rerender } = render(
      <GraphCanvas
        data={dataB}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const initialNodes = (forceSimulation as any).mock.calls[0][0] as GraphNode[];
    const cachedNode = initialNodes.find((node) => node.id === 2)!;
    cachedNode.x = 777;
    cachedNode.y = -333;

    rerender(
      <GraphCanvas
        data={{ nodes: [], edges: [], total_nodes: 2 } as GraphData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const clearsAfterEmptyView = ctx.clearRect.mock.calls.length;
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
    const restoredNodes = sim.nodes.mock.calls.at(-1)[0] as GraphNode[];
    expect(restoredNodes.find((node) => node.id === 2)).toMatchObject({ x: 777, y: -333 });
    expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(clearsAfterEmptyView);
    expect(sim.restart).not.toHaveBeenCalled();
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

  it("pauses a warm hidden graph and resumes without forcing a new alpha", async () => {
    const { forceSimulation } = await import("d3-force");
    const noop = () => {};
    const { rerender, unmount } = render(
      <GraphCanvas
        data={dataA}
        active
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    const sim = (forceSimulation as any).mock.results[0].value;

    rerender(
      <GraphCanvas
        data={dataA}
        active={false}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    expect(sim.stop).toHaveBeenCalledTimes(1);

    rerender(
      <GraphCanvas
        data={dataA}
        active
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );
    expect(sim.alpha).toHaveBeenCalledWith();
    expect(sim.alphaMin).toHaveBeenCalledTimes(1);
    expect(sim.restart).toHaveBeenCalledTimes(1);
    expect(sim.alpha).not.toHaveBeenCalledWith(0.3);

    unmount();
    expect(sim.stop).toHaveBeenCalledTimes(2);
  });

  it("uses bounded node.size radii and treats an empty selection as no selection", () => {
    const ctx = installCanvasMock(800, 600);
    const noop = () => {};
    const sizedData: GraphData = {
      nodes: [
        makeNode(1, "small", { size: 0 }),
        makeNode(2, "fallback", { size: Number.POSITIVE_INFINITY }),
        makeNode(3, "large", { size: 999 }),
      ],
      edges: [],
      total_nodes: 3,
    };

    render(
      <GraphCanvas
        data={sizedData}
        highlightedIds={new Set()}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    const radii = new Set(ctx.arc.mock.calls.map((call) => call[2]));
    expect(radii).toEqual(new Set([2, 4, 12]));
    // An empty Set used to highlight nothing but dim everything. It must not
    // apply the 1.5× highlighted radius to any node.
    expect(radii.has(3)).toBe(false);
    expect(radii.has(18)).toBe(false);
  });

  it("does not dim the rendered map for highlights that are entirely outside the overview", () => {
    const ctx = installCanvasMock(800, 600);
    let currentAlpha = 1;
    const nodeFillAlphas: number[] = [];
    Object.defineProperty(ctx, "globalAlpha", {
      configurable: true,
      get: () => currentAlpha,
      set: (value: number) => { currentAlpha = value; },
    });
    ctx.fill.mockImplementation(() => nodeFillAlphas.push(currentAlpha));
    const ref = createRef<GraphCanvasHandle>();
    const visibleData: GraphData = {
      nodes: [
        makeNode(1, "visible-a", { x: -50, y: 0 }),
        makeNode(2, "visible-b", { x: 50, y: 0 }),
      ],
      edges: [],
      total_nodes: 3,
      topology_revision: "off-overview-highlight",
    };

    render(
      <GraphCanvas
        ref={ref}
        data={visibleData}
        highlightedIds={new Set([999])}
        selectedNodeId={999}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    nodeFillAlphas.length = 0;
    act(() => ref.current?.zoomBy(1));

    expect(nodeFillAlphas).toHaveLength(visibleData.nodes.length);
    expect(nodeFillAlphas).toEqual([1, 1]);
  });

  it("keeps highlighted scope labels inside the active LOD budget and prioritizes the selected node", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    // These bounds fit at k~=0.596, inside the 24-label mid LOD. Screen-space
    // gaps remain large enough that collision avoidance does not lower the
    // count and accidentally mask a budget regression.
    const nodes = Array.from({ length: 64 }, (_, index) => {
      const column = index % 8;
      const row = Math.floor(index / 8);
      const id = index + 1;
      return makeNode(id, `node-${id}`, {
        x: (column - 3.5) * 160,
        y: (row - 3.5) * 112,
      });
    });
    const highlightedIds = new Set(nodes.map((node) => node.id));
    const labelData: GraphData = {
      nodes,
      edges: [],
      total_nodes: nodes.length,
      topology_revision: "bounded-highlight-labels",
    };

    render(
      <GraphCanvas
        ref={ref}
        data={labelData}
        highlightedIds={highlightedIds}
        selectedNodeId={64}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.fillText.mockClear();
    act(() => ref.current?.zoomBy(2));

    expect(ctx.fillText).toHaveBeenCalledTimes(24);
    expect(ctx.fillText).toHaveBeenCalledWith("node-64", expect.any(Number), expect.any(Number));
  });

  it("bundles macro links at overview scale and keeps them out of d3 physics", async () => {
    const { forceLink } = await import("d3-force");
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const noop = () => {};
    const onScopeSelect = vi.fn();
    const overviewData: GraphData = {
      nodes: [
        makeNode(1, "left-a", { x: -1_000, y: 0, cluster_id: 0 }),
        makeNode(2, "left-b", { x: -900, y: 0, cluster_id: 0 }),
        makeNode(3, "right", { x: 1_000, y: 0, cluster_id: 1 }),
      ],
      edges: [
        { source: 1, target: 2, type: "CALLS" },
        { source: 2, target: 3, type: "CALLS" },
        // Same directed macro pair, different relation type: the overview
        // must keep one architectural connection, not parallel curves.
        { source: 1, target: 3, type: "IMPORTS" },
        { source: 3, target: 2, type: "IMPORTS" },
      ],
      total_nodes: 3,
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "left/src", x: -950, y: 0, radius: 90, node_count: 2 },
          { id: 1, domain_id: 1, key: "right/src", x: 1_000, y: 0, radius: 70, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "left", x: -950, y: 0, radius: 150, node_count: 2, cluster_count: 1 },
          { id: 1, key: "right", x: 1_000, y: 0, radius: 130, node_count: 1, cluster_count: 1 },
        ],
      },
    };

    const { getByRole } = render(
      <GraphCanvas
        ref={ref}
        data={overviewData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onScopeSelect={onScopeSelect}
        onNodeHover={noop}
      />,
    );

    const physicalEdges = (forceLink as any).mock.calls[0][0] as GraphEdge[];
    expect(physicalEdges).toHaveLength(1);
    expect(physicalEdges[0]).toMatchObject({ source: 1, target: 2 });
    ctx.quadraticCurveTo.mockClear();
    ctx.bezierCurveTo.mockClear();
    ctx.lineTo.mockClear();
    act(() => ref.current?.zoomBy(1));
    expect(ctx.quadraticCurveTo).toHaveBeenCalledTimes(2);
    expect(ctx.bezierCurveTo).not.toHaveBeenCalled();
    // Each bundle adds a two-segment target chevron without a second stroke.
    expect(ctx.lineTo).toHaveBeenCalledTimes(4);

    const canvas = getByRole("application");
    fireEvent.mouseDown(canvas, { clientX: 110, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 110, clientY: 300 });
    expect(onScopeSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: "domain",
      id: 0,
      key: "left",
      nodeIds: new Set([1, 2]),
    }));

    ctx.lineTo.mockClear();
    act(() => ref.current?.zoomBy(8));
    // Four retained raw edges, with macro bundles fully removed at deep LOD.
    expect(ctx.lineTo).toHaveBeenCalledTimes(4);
  });

  it("keeps the default community flow backbone bounded", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const clusterCount = 50;
    const clusters = Array.from({ length: clusterCount }, (_, index) => {
      const angle = (index / clusterCount) * Math.PI * 2;
      return {
        id: index,
        domain_id: 0,
        key: `src/community-${index}`,
        x: Math.cos(angle) * 220,
        y: Math.sin(angle) * 220,
        radius: 8,
        node_count: 1,
      };
    });
    const nodes = clusters.map((cluster, index) => makeNode(index + 1, `node-${index + 1}`, {
      x: cluster.x,
      y: cluster.y,
      cluster_id: cluster.id,
    }));
    const edges = Array.from({ length: clusterCount - 1 }, (_, index) => ({
      source: index + 1,
      target: index + 2,
      type: "CALLS",
    }));
    const boundedBackboneData: GraphData = {
      nodes,
      edges,
      total_nodes: nodes.length,
      topology_revision: "bounded-community-backbone",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 10,
        counts_scope: "returned_nodes",
        clusters,
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 260, node_count: nodes.length, cluster_count: clusterCount },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={boundedBackboneData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.quadraticCurveTo.mockClear();
    ctx.bezierCurveTo.mockClear();
    ctx.clip.mockClear();
    act(() => ref.current?.zoomBy(1));
    expect(ctx.quadraticCurveTo).not.toHaveBeenCalled();
    expect(ctx.bezierCurveTo).toHaveBeenCalledTimes(16);
    expect(ctx.clip).toHaveBeenCalledWith("evenodd");
  });

  it("routes community bundles away from the center of their shared domain", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const routingData: GraphData = {
      nodes: [
        makeNode(1, "left", { x: -140, y: 100, cluster_id: 0 }),
        makeNode(2, "right", { x: 140, y: 100, cluster_id: 2 }),
        makeNode(3, "center-left", { x: -180, y: 0, cluster_id: 3 }),
        makeNode(4, "center-right", { x: 180, y: 0, cluster_id: 4 }),
      ],
      edges: [
        { source: 1, target: 2, type: "CALLS" },
        { source: 3, target: 4, type: "CALLS" },
      ],
      total_nodes: 4,
      topology_revision: "outward-community-routing",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/left", x: -140, y: 100, radius: 40, node_count: 1 },
          { id: 2, domain_id: 0, key: "src/right", x: 140, y: 100, radius: 40, node_count: 1 },
          { id: 3, domain_id: 0, key: "src/center-left", x: -180, y: 0, radius: 40, node_count: 1 },
          { id: 4, domain_id: 0, key: "src/center-right", x: 180, y: 0, radius: 40, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 360, node_count: 4, cluster_count: 4 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={routingData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.quadraticCurveTo.mockClear();
    ctx.bezierCurveTo.mockClear();
    act(() => ref.current?.zoomBy(1));
    expect(ctx.quadraticCurveTo).not.toHaveBeenCalled();
    expect(ctx.bezierCurveTo).toHaveBeenCalledTimes(2);
    const upperRoute = ctx.bezierCurveTo.mock.calls.find(([, , , , , endY]) => endY > 100);
    const centerRoute = ctx.bezierCurveTo.mock.calls.find(([, , , , , endY]) => endY < 100);
    expect(upperRoute?.[0]).toBe(upperRoute?.[2]);
    expect(upperRoute?.[1]).toBe(upperRoute?.[3]);
    expect(Math.hypot(upperRoute?.[0] ?? 0, upperRoute?.[1] ?? 0)).toBeGreaterThanOrEqual(120);
    expect(Math.hypot(centerRoute?.[0] ?? 0, centerRoute?.[1] ?? 0)).toBeGreaterThanOrEqual(120);
  });

  it("selects a neighboring corridor lane when the direct lane is occupied", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const obstacleData: GraphData = {
      nodes: [
        makeNode(1, "source", { x: -180, y: 0, cluster_id: 0 }),
        makeNode(2, "target", { x: 180, y: 0, cluster_id: 1 }),
        makeNode(3, "blocker", { x: 0, y: 144, cluster_id: 2 }),
      ],
      edges: [{ source: 1, target: 2, type: "CALLS" }],
      total_nodes: 3,
      topology_revision: "obstacle-aware-corridor",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/source", x: -180, y: 0, radius: 40, node_count: 1 },
          { id: 1, domain_id: 0, key: "src/target", x: 180, y: 0, radius: 40, node_count: 1 },
          { id: 2, domain_id: 0, key: "src/blocker", x: 0, y: 144, radius: 70, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 360, node_count: 3, cluster_count: 3 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={obstacleData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.bezierCurveTo.mockClear();
    act(() => ref.current?.zoomBy(1));
    expect(ctx.bezierCurveTo).toHaveBeenCalledTimes(1);
    const [controlX, controlY] = ctx.bezierCurveTo.mock.calls[0] as [number, number, number, number, number, number];
    expect(Math.hypot(controlX, controlY - 144)).toBeGreaterThan(70);
  });

  it("adds a semantic outline only to domains carrying cross-domain traffic", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const domainTrafficData: GraphData = {
      nodes: [
        makeNode(1, "left", { x: -420, y: 80, cluster_id: 0 }),
        makeNode(2, "right", { x: 420, y: 80, cluster_id: 1 }),
        makeNode(3, "quiet", { x: 0, y: -360, cluster_id: 2 }),
      ],
      edges: Array.from({ length: 8 }, () => ({ source: 1, target: 2, type: "CALLS" })),
      total_nodes: 3,
      topology_revision: "semantic-domain-outline",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 4,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "left/src", x: -420, y: 80, radius: 44, node_count: 1 },
          { id: 1, domain_id: 1, key: "right/src", x: 420, y: 80, radius: 44, node_count: 1 },
          { id: 2, domain_id: 2, key: "quiet/src", x: 0, y: -360, radius: 44, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "left", x: -420, y: 80, radius: 120, node_count: 1, cluster_count: 1 },
          { id: 1, key: "right", x: 420, y: 80, radius: 120, node_count: 1, cluster_count: 1 },
          { id: 2, key: "quiet", x: 0, y: -360, radius: 120, node_count: 1, cluster_count: 1 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={domainTrafficData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.arc.mockClear();
    act(() => ref.current?.zoomBy(1));
    const outerArcsAt = (x: number, y: number) => ctx.arc.mock.calls.filter(
      ([arcX, arcY, radius]) => arcX === x && arcY === y && radius > 120,
    );
    expect(outerArcsAt(-420, 80).length).toBeGreaterThanOrEqual(1);
    expect(outerArcsAt(420, 80).length).toBeGreaterThanOrEqual(1);
    expect(outerArcsAt(0, -360)).toHaveLength(0);
  });

  it("surfaces only high-traffic community hubs in the domain overview", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const overviewHubData: GraphData = {
      nodes: [
        makeNode(1, "hub-source", { x: -160, y: 100, cluster_id: 0 }),
        makeNode(2, "hub-target", { x: 160, y: 100, cluster_id: 1 }),
        makeNode(3, "low-source", { x: -160, y: -120, cluster_id: 2 }),
        makeNode(4, "low-target", { x: 160, y: -120, cluster_id: 3 }),
      ],
      edges: [
        ...Array.from({ length: 16 }, () => ({ source: 1, target: 2, type: "CALLS" })),
        { source: 3, target: 4, type: "CALLS" },
      ],
      total_nodes: 4,
      topology_revision: "domain-overview-hubs",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 4,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/hub-source", x: -160, y: 100, radius: 44, node_count: 1 },
          { id: 1, domain_id: 0, key: "src/hub-target", x: 160, y: 100, radius: 44, node_count: 1 },
          { id: 2, domain_id: 0, key: "src/low-source", x: -160, y: -120, radius: 44, node_count: 1 },
          { id: 3, domain_id: 0, key: "src/low-target", x: 160, y: -120, radius: 44, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 380, node_count: 4, cluster_count: 4 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={overviewHubData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.arc.mockClear();
    act(() => ref.current?.zoomBy(1));
    const innerArcsAt = (x: number, y: number) => ctx.arc.mock.calls.filter(
      ([arcX, arcY, radius]) => arcX === x && arcY === y && radius < 44,
    );
    expect(innerArcsAt(-160, 100).length).toBeGreaterThanOrEqual(2);
    expect(innerArcsAt(160, 100).length).toBeGreaterThanOrEqual(2);
    expect(innerArcsAt(-160, -120)).toHaveLength(0);
    expect(innerArcsAt(160, -120)).toHaveLength(0);
  });

  it("adds bounded inner light only to communities carrying sampled traffic", () => {
    const ctx = installCanvasMock(800, 600);
    const ref = createRef<GraphCanvasHandle>();
    const trafficCoreData: GraphData = {
      nodes: [
        makeNode(1, "source", { x: -160, y: 80, cluster_id: 0 }),
        makeNode(2, "target", { x: 160, y: 80, cluster_id: 1 }),
        makeNode(3, "quiet", { x: 0, y: -180, cluster_id: 2 }),
      ],
      edges: [{ source: 1, target: 2, type: "CALLS" }],
      total_nodes: 3,
      topology_revision: "semantic-community-core",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/source", x: -160, y: 80, radius: 44, node_count: 1 },
          { id: 1, domain_id: 0, key: "src/target", x: 160, y: 80, radius: 44, node_count: 1 },
          { id: 2, domain_id: 0, key: "src/quiet", x: 0, y: -180, radius: 44, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 380, node_count: 3, cluster_count: 3 },
        ],
      },
    };

    render(
      <GraphCanvas
        ref={ref}
        data={trafficCoreData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    ctx.arc.mockClear();
    act(() => ref.current?.zoomBy(1));
    const innerArcsAt = (x: number, y: number) => ctx.arc.mock.calls.filter(
      ([arcX, arcY, radius]) => arcX === x && arcY === y && radius < 44,
    );
    expect(innerArcsAt(-160, 80).length).toBeGreaterThanOrEqual(2);
    expect(innerArcsAt(160, 80).length).toBeGreaterThanOrEqual(2);
    expect(innerArcsAt(0, -180)).toHaveLength(0);
  });

  it("reveals sampled incoming and outgoing community traffic only on focus", () => {
    const ctx = installCanvasMock(800, 600);
    const trafficData: GraphData = {
      nodes: [
        makeNode(1, "left-a", { x: -160, y: 0, cluster_id: 0 }),
        makeNode(2, "left-b", { x: -120, y: 0, cluster_id: 0 }),
        makeNode(3, "right", { x: 140, y: 0, cluster_id: 1 }),
      ],
      edges: [
        { source: 1, target: 3, type: "CALLS" },
        { source: 2, target: 3, type: "IMPORTS" },
        { source: 3, target: 1, type: "CALLS" },
      ],
      total_nodes: 3,
      topology_revision: "community-traffic-focus",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/left", x: -140, y: 0, radius: 100, node_count: 2 },
          { id: 1, domain_id: 0, key: "src/right", x: 140, y: 0, radius: 90, node_count: 1 },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 360, node_count: 3, cluster_count: 2 },
        ],
      },
    };

    const { getByRole } = render(
      <GraphCanvas
        data={trafficData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );
    const summary = "2 shown nodes · 1 in · 2 out";
    expect(ctx.fillText).not.toHaveBeenCalledWith(summary, expect.any(Number), expect.any(Number));

    fireEvent.keyDown(getByRole("application"), { key: "c" });
    expect(ctx.fillText).toHaveBeenCalledWith(summary, expect.any(Number), expect.any(Number));
  });

  it("prioritizes a dense architecture scope over overlapping node hit targets at overview LOD", () => {
    installCanvasMock(800, 600);
    const onNodeClick = vi.fn();
    const onScopeSelect = vi.fn();
    const nodes = Array.from({ length: 121 }, (_, index) => {
      const column = index % 11;
      const row = Math.floor(index / 11);
      return makeNode(index + 1, `dense-${index + 1}`, {
        x: (column - 5) * 16,
        y: (row - 5) * 16,
        cluster_id: 0,
      });
    });
    const denseData: GraphData = {
      nodes,
      edges: [],
      total_nodes: nodes.length,
      topology_revision: "dense-scope-hit-testing",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/dense", x: 0, y: 0, radius: 120, node_count: nodes.length },
        ],
        domains: [
          { id: 0, key: "src", x: 0, y: 0, radius: 600, node_count: nodes.length, cluster_count: 1 },
        ],
      },
    };

    const { getByRole } = render(
      <GraphCanvas
        data={denseData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={onNodeClick}
        onScopeSelect={onScopeSelect}
        onNodeHover={() => {}}
      />,
    );

    const canvas = getByRole("application");
    // The center is exactly on dense node 61. At the fitted domain LOD its
    // 20px hit disc overlaps the surrounding <7px projected spacing, so the
    // architecture scope must own this interaction until raw topology appears.
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 400, clientY: 300 });

    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onScopeSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: "domain",
      id: 0,
      key: "src",
      nodeIds: new Set(nodes.map((node) => node.id)),
    }));
  });

  it("clears node tooltips when the pointer leaves", () => {
    installCanvasMock(800, 600);
    const onNodeHover = vi.fn();
    const { getByRole } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={onNodeHover}
      />,
    );
    const canvas = getByRole("application");

    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    expect(onNodeHover).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), { x: 400, y: 300 });

    fireEvent.mouseLeave(canvas);

    expect(onNodeHover).toHaveBeenLastCalledWith(null);
    expect((canvas as HTMLCanvasElement).style.cursor).toBe("default");
  });

  it("moves a tooltip over the same node without re-emitting expensive hover state", async () => {
    vi.useFakeTimers();
    installCanvasMock(800, 600);
    const onNodeHover = vi.fn();
    const { container, getByRole } = render(
      <div className="relative">
        <GraphCanvas
          data={dataA}
          highlightedIds={null}
          deadCodeView={false}
          onNodeClick={() => {}}
          onNodeHover={onNodeHover}
        />
        <NodeTooltip node={dataA.nodes[0]} x={0} y={0} />
      </div>,
    );
    const canvas = getByRole("application");
    const tooltip = container.querySelector(".pointer-events-none") as HTMLElement;

    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    await act(async () => vi.advanceTimersByTime(20));
    expect(onNodeHover).toHaveBeenCalledTimes(1);
    expect(tooltip.style.left).toBe("412px");

    fireEvent.mouseMove(canvas, { clientX: 430, clientY: 300 });
    await act(async () => vi.advanceTimersByTime(20));
    expect(onNodeHover).toHaveBeenCalledTimes(1);
    expect(tooltip.style.left).toBe("442px");
  });

  it("keeps the backing store below the physical pixel ceiling for oversized CSS viewports", () => {
    installCanvasMock(5_000, 4_000);
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const { getByRole } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application") as HTMLCanvasElement;

    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000);
    expect(canvas.width).toBeLessThan(5_000);
    expect(canvas.height).toBeLessThan(4_000);
    expect(canvas.style.width).toBe("5000px");
    expect(canvas.style.height).toBe("4000px");
  });

  it("offers bounded virtual keyboard traversal for domains, communities, and nodes", () => {
    installCanvasMock(800, 600);
    const onNodeClick = vi.fn();
    const onScopeSelect = vi.fn();
    const nodes = Array.from({ length: 100 }, (_, index) => makeNode(index + 1, `node-${index + 1}`, {
      cluster_id: 0,
      x: index * 8,
      y: 0,
    }));
    const keyboardData: GraphData = {
      nodes,
      edges: [],
      total_nodes: nodes.length,
      topology_revision: "keyboard-revision",
      layout: {
        strategy: "architecture-domain-v1",
        node_spacing: 16,
        counts_scope: "returned_nodes",
        clusters: [
          { id: 0, domain_id: 0, key: "src/core", x: 396, y: 0, radius: 420, node_count: 100 },
        ],
        domains: [
          { id: 0, key: "src", x: 396, y: 0, radius: 460, node_count: 100, cluster_count: 1 },
        ],
      },
    };

    const { container, getByRole } = render(
      <GraphCanvas
        data={keyboardData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={onNodeClick}
        onScopeSelect={onScopeSelect}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");
    const status = getByRole("status");

    expect(canvas).toHaveAttribute("aria-roledescription", "interactive code graph");
    expect(canvas).toHaveAccessibleDescription(/Press D or Shift\+D to browse up to 32 visible domains/i);
    expect(container.querySelectorAll("*")).toHaveLength(3);

    fireEvent.keyDown(canvas, { key: "d" });
    expect(status).toHaveTextContent("Domain src, 1 of 1");
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onScopeSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "domain",
      id: 0,
      nodeIds: new Set(nodes.map((node) => node.id)),
    }));

    fireEvent.keyDown(canvas, { key: "c" });
    expect(status).toHaveTextContent("Community src/core, 1 of 1");
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onScopeSelect).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "community",
      id: 0,
    }));

    fireEvent.keyDown(canvas, { key: "n" });
    expect(status).toHaveTextContent("Node Function node-1, 1 of 64");
    expect(status).toHaveTextContent("64 of 100 visible node targets are keyboard-browsable");
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onNodeClick).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }));

    fireEvent.keyDown(canvas, { key: "N", shiftKey: true });
    fireEvent.keyDown(canvas, { key: " " });
    expect(onNodeClick).toHaveBeenLastCalledWith(expect.objectContaining({ id: 64 }));
  });

  it("auto-fits initially and resetView restores a real bounding-box fit", () => {
    const ctx = installCanvasMock(800, 600);
    const noop = () => {};
    const ref = createRef<GraphCanvasHandle>();
    const fitData: GraphData = {
      nodes: [
        makeNode(1, "left", { x: 100, y: 50, size: 4 }),
        makeNode(2, "right", { x: 300, y: 50, size: 4 }),
      ],
      edges: [],
      total_nodes: 2,
    };

    render(
      <GraphCanvas
        ref={ref}
        data={fitData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={noop}
        onNodeHover={noop}
      />,
    );

    const initialFitScale = ctx.scale.mock.calls.at(-1)[0] as number;
    expect(initialFitScale).toBeCloseTo(672 / 208, 4);
    expect(initialFitScale).not.toBe(1);
    expect(ref.current?.fitView).toBeTypeOf("function");

    act(() => ref.current?.zoomBy(0.5));
    expect(ctx.scale.mock.calls.at(-1)[0]).toBeCloseTo(initialFitScale * 0.5, 4);

    act(() => ref.current?.resetView());
    expect(ctx.scale.mock.calls.at(-1)[0]).toBeCloseTo(initialFitScale, 4);
    const [translatedX, translatedY] = ctx.translate.mock.calls.at(-1) as [number, number];
    expect(translatedX).toBeCloseTo(400 - 200 * initialFitScale, 4);
    expect(translatedY).toBeCloseTo(300 - 50 * initialFitScale, 4);
  });

  it("focuses immediately when reduced motion is requested", () => {
    const ctx = installCanvasMock(800, 600);
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    const ref = createRef<GraphCanvasHandle>();
    render(
      <GraphCanvas
        ref={ref}
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );
    ctx.translate.mockClear();

    act(() => ref.current?.focusNode(1));

    expect(ctx.translate.mock.calls.at(-1)).toEqual([-600, -200]);
  });

  it("supports touch tap selection and disables native touch gestures", () => {
    installCanvasMock(800, 600);
    const onNodeClick = vi.fn();
    const { getByRole } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");
    const tap = makeTouch(1, 400, 300);

    expect((canvas as HTMLCanvasElement).style.touchAction).toBe("none");
    expect(canvas).toHaveAccessibleName(/Code graph: 1 nodes and 0 edges/i);
    expect(canvas).toHaveAccessibleDescription(/Arrow keys pan, plus and minus zoom/i);
    fireEvent.touchStart(canvas, { touches: [tap], changedTouches: [tap] });
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [tap] });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("keeps mouse click selection working alongside touch handlers", () => {
    installCanvasMock(800, 600);
    const onNodeClick = vi.fn();
    const { getByRole } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");

    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 });
    fireEvent.mouseUp(window, { clientX: 400, clientY: 300 });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("pans with one finger in CSS-pixel coordinates", () => {
    const ctx = installCanvasMock(800, 600);
    const { getByRole } = render(
      <GraphCanvas
        data={{ nodes: [], edges: [], total_nodes: 0 } as GraphData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");
    const start = makeTouch(1, 100, 100);
    const moved = makeTouch(1, 150, 130);
    ctx.translate.mockClear();

    fireEvent.touchStart(canvas, { touches: [start], changedTouches: [start] });
    fireEvent.touchMove(canvas, { touches: [moved], changedTouches: [moved] });
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [moved] });

    expect(ctx.translate.mock.calls.at(-1)).toEqual([450, 330]);
  });

  it("pinch-zooms around the gesture midpoint and follows midpoint movement", () => {
    const ctx = installCanvasMock(800, 600);
    const { getByRole } = render(
      <GraphCanvas
        data={{ nodes: [], edges: [], total_nodes: 0 } as GraphData}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");
    const start = [makeTouch(1, 300, 300), makeTouch(2, 500, 300)];
    // Distance doubles and the midpoint moves from (400,300) to (450,330).
    const moved = [makeTouch(1, 250, 330), makeTouch(2, 650, 330)];
    ctx.scale.mockClear();
    ctx.translate.mockClear();

    fireEvent.touchStart(canvas, { touches: start, changedTouches: start });
    fireEvent.touchMove(canvas, { touches: moved, changedTouches: moved });
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: moved });

    expect(ctx.scale.mock.calls.at(-1)?.[0]).toBeCloseTo(2, 6);
    expect(ctx.translate.mock.calls.at(-1)).toEqual([450, 330]);
  });

  it("drags a node by touch, releases physics on cancellation, and never selects it", async () => {
    const { forceSimulation } = await import("d3-force");
    installCanvasMock(800, 600);
    const onNodeClick = vi.fn();
    const { getByRole } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
      />,
    );
    const canvas = getByRole("application");
    const sim = (forceSimulation as any).mock.results[0].value;
    const node = (forceSimulation as any).mock.calls[0][0][0] as GraphNode & { fx?: number | null; fy?: number | null };
    const start = makeTouch(7, 400, 300);
    const moved = makeTouch(7, 430, 330);

    fireEvent.touchStart(canvas, { touches: [start], changedTouches: [start] });
    fireEvent.touchMove(canvas, { touches: [moved], changedTouches: [moved] });
    expect(node.fx).toBeTypeOf("number");
    expect(node.fy).toBeTypeOf("number");
    expect(sim.alphaTarget).toHaveBeenCalledWith(0.3);
    expect(sim.restart).toHaveBeenCalledTimes(1);

    fireEvent.touchCancel(canvas, { touches: [], changedTouches: [moved] });
    expect(node.fx).toBeNull();
    expect(node.fy).toBeNull();
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0);
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("removes every native touch listener on unmount", () => {
    const removeEventListener = vi.spyOn(HTMLCanvasElement.prototype, "removeEventListener");
    const { unmount } = render(
      <GraphCanvas
        data={dataA}
        highlightedIds={null}
        deadCodeView={false}
        onNodeClick={() => {}}
        onNodeHover={() => {}}
      />,
    );

    unmount();

    for (const eventName of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(removeEventListener).toHaveBeenCalledWith(eventName, expect.any(Function));
    }
  });
});

function makeTouch(identifier: number, clientX: number, clientY: number): Touch {
  return {
    identifier,
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    target: document.body,
  } as Touch;
}

function installCanvasMock(width: number, height: number) {
  const ctx = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  return ctx;
}
