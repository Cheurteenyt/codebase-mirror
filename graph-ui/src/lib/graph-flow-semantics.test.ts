import { describe, expect, it } from "vitest";
import {
  GRAPH_EDGE_GROUP_META,
  graphEdgeGroup,
  summarizeSelectedEdgeGroups,
} from "./graph-flow-semantics";

describe("Stellar flow relation semantics", () => {
  it("classifies relation names without depending on backend casing", () => {
    expect(graphEdgeGroup("CALLS")).toBe("calls");
    expect(graphEdgeGroup("contains_member")).toBe("contains");
    expect(graphEdgeGroup("IMPORTS")).toBe("imports");
    expect(graphEdgeGroup("reads_data")).toBe("data");
    expect(graphEdgeGroup("unknown_relation")).toBe("other");
  });

  it("keeps every relation group decodable without color", () => {
    const patterns = Object.values(GRAPH_EDGE_GROUP_META).map((meta) => meta.dash.join(","));
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("summarizes only relations incident to the selected symbol", () => {
    const summary = summarizeSelectedEdgeGroups([
      { source: 1, target: 2, type: "calls" },
      { source: 3, target: 1, type: "CALLS" },
      { source: 1, target: 4, type: "imports" },
      { source: 8, target: 9, type: "contains" },
    ], 1);

    expect(summary).toEqual([
      { group: "calls", count: 2 },
      { group: "imports", count: 1 },
    ]);
  });

});
