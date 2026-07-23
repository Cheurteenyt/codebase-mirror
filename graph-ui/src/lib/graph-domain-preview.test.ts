import { describe, expect, it } from "vitest";
import { buildDomainPreviewPlan } from "./graph-domain-preview";

describe("domain preview planning", () => {
  const candidates = [
    { id: 10, domainKey: "analysis", name: "analyzer.ts", label: "File", rank: 0.7, size: 8 },
    { id: 11, domainKey: "analysis", name: "buildAnalysis", label: "Function", rank: 0.9, size: 6 },
    { id: 12, domainKey: "analysis", name: "Analysis", label: "Interface", rank: 0.8, size: 7 },
    { id: 13, domainKey: "analysis", name: "anonymous#1", label: "Function", rank: 1, size: 9 },
    { id: 20, domainKey: "delivery", name: "publish.ts", label: "File", rank: 0.6, size: 7 },
    { id: 21, domainKey: "delivery", name: "publishAnalysis", label: "Function", rank: 0.8, size: 6 },
    { id: 30, domainKey: "root", name: "main", label: "Project", rank: 1, size: 9 },
  ];

  it("keeps the server representative first and adds one semantic signal", () => {
    expect(buildDomainPreviewPlan([
      { key: "analysis", nodeCount: 23, representativeNodeId: 10 },
      { key: "delivery", nodeCount: 11, representativeNodeId: 20 },
    ], [...candidates].reverse())).toEqual([
      { domainKey: "analysis", nodeIds: [10, 11], hiddenCount: 21 },
      { domainKey: "delivery", nodeIds: [20, 21], hiddenCount: 9 },
    ]);
  });

  it("is bounded and excludes structural or anonymous secondary symbols", () => {
    expect(buildDomainPreviewPlan([
      { key: "delivery", nodeCount: 11, representativeNodeId: 20 },
      { key: "analysis", nodeCount: 23, representativeNodeId: 13 },
      { key: "root", nodeCount: 1, representativeNodeId: 30 },
    ], candidates, { maxDomains: 2, maxNodesPerDomain: 2 })).toEqual([
      { domainKey: "analysis", nodeIds: [11, 12], hiddenCount: 21 },
      { domainKey: "delivery", nodeIds: [20, 21], hiddenCount: 9 },
    ]);
  });
});
