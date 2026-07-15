// graph-ui/src/components/GraphCanvas.test.tsx
// Regression coverage for simulation reuse, topology-aware reheating,
// position restoration, bounded node sizing, and bounding-box fit/reset.

import { createRef } from "react";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { GraphCanvas, type GraphCanvasHandle } from "./GraphCanvas";
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
  return {
    forceSimulation,
    forceManyBody: () => ({ strength: () => ({ distanceMax: () => ({}) }) }),
    forceLink: () => ({ id: () => ({ distance: () => ({ strength: () => ({}) }) }) }),
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
} as GraphData;

const dataB: GraphData = {
  nodes: [makeNode(1, "foo"), makeNode(2, "bar")],
  edges: [{ source: 1, target: 2, type: "calls" } as unknown as GraphEdge],
} as GraphData;

describe("R45 (F5): GraphCanvas sim-reuse (R40 UI-2)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

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
        data={dataA}
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
    expect(initialFitScale).toBeCloseTo(704 / 208, 4);
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
    const canvas = getByRole("img");
    const tap = makeTouch(1, 400, 300);

    expect((canvas as HTMLCanvasElement).style.touchAction).toBe("none");
    expect(canvas).toHaveAccessibleName(/scroll or pinch to zoom, click or tap a node/i);
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
    const canvas = getByRole("img");

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
    const canvas = getByRole("img");
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
    const canvas = getByRole("img");
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
    const canvas = getByRole("img");
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
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
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
