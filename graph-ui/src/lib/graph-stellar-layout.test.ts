import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./types";
import { computeStellarFlowLayout } from "./graph-stellar-layout";

const node = (
  id: number,
  inDegree: number,
  outDegree: number,
  clusterId = 1,
): GraphNode => ({
  id,
  x: id * 10,
  y: id * 5,
  cluster_id: clusterId,
  label: "Function",
  name: `node-${id}`,
  size: Math.sqrt(inDegree + outDegree) + 3,
  color: "#fff",
  in_degree: inDegree,
  out_degree: outDegree,
});

describe("Stellar flow layout", () => {
  it("places exact-degree hubs inside a stable constellation", () => {
    const nodes = [
      node(1, 45, 55, 10),
      node(2, 2, 1, 10),
      node(3, 0, 1, 20),
      node(4, 4, 3, 20),
    ];
    const edges: GraphEdge[] = [
      { source: 1, target: 2, type: "calls" },
      { source: 4, target: 1, type: "calls" },
    ];

    const first = computeStellarFlowLayout(nodes, edges, null);
    const second = computeStellarFlowLayout(nodes, edges, null);
    const hub = first.get(1)!;
    const leaf = first.get(3)!;

    expect(hub.role).toBe("hub");
    expect(Math.hypot(hub.x, hub.y)).toBeLessThan(Math.hypot(leaf.x, leaf.y));
    expect([...first]).toEqual([...second]);
    expect([...first.values()].every((target) => Number.isFinite(target.x) && Number.isFinite(target.y))).toBe(true);
  });

  it("separates incoming and outgoing layers around the selected node", () => {
    const nodes = [
      node(1, 2, 2),
      node(2, 0, 1),
      node(3, 1, 1),
      node(4, 1, 0),
      node(5, 0, 0),
    ];
    const edges: GraphEdge[] = [
      { source: 2, target: 1, type: "calls" },
      { source: 1, target: 3, type: "calls" },
      { source: 3, target: 4, type: "calls" },
    ];

    const layout = computeStellarFlowLayout(nodes, edges, 1);

    expect(layout.get(1)).toMatchObject({ x: 0, y: 0, role: "focus", depth: 0 });
    expect(layout.get(2)).toMatchObject({ role: "incoming", depth: 1 });
    expect(layout.get(2)!.x).toBeLessThan(0);
    expect(layout.get(3)).toMatchObject({ role: "outgoing", depth: 1 });
    expect(layout.get(3)!.x).toBeGreaterThan(0);
    expect(layout.get(4)).toMatchObject({ role: "outgoing", depth: 2 });
    expect(layout.get(4)!.x).toBeGreaterThan(layout.get(3)!.x);
    expect(layout.get(5)!.role).toBe("context");
  });

  it("keeps high-fanout directed layers spatially bounded", () => {
    const nodes = [node(1, 0, 240)];
    const edges: GraphEdge[] = [];
    for (let id = 2; id <= 241; id += 1) {
      nodes.push(node(id, 1, 0));
      edges.push({ source: 1, target: id, type: "calls" });
    }

    const layout = computeStellarFlowLayout(nodes, edges, 1);
    const outgoing = [...layout.values()].filter((target) => target.role === "outgoing");
    const verticalSpan = Math.max(...outgoing.map((target) => target.y))
      - Math.min(...outgoing.map((target) => target.y));

    expect(outgoing).toHaveLength(240);
    expect(outgoing.every((target) => target.x > 0 && target.depth === 1)).toBe(true);
    expect(verticalSpan).toBeLessThanOrEqual(800);
  });
});
