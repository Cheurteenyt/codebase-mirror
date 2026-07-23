import { describe, expect, it } from 'vitest';
import {
  analyzeFrames,
  assertGraphBrowserSmoke,
  assertRenderedGraphIdentity,
  assertSameCompleteTopology,
  blindLabels,
  isHelpRequest,
  percentile,
  summarizeTimings,
  topologyFingerprint,
} from '../../scripts/graph-ui-lab-core.js';

describe('graph UI comparison lab contract', () => {
  const completeLayout = {
    total_nodes: 3,
    nodes: [{ id: 3 }, { id: 1 }, { id: 2 }],
    edges: [
      { source: 2, target: 3, type: 'CALLS' },
      { source: 1, target: 2, type: 'IMPORTS' },
    ],
  };

  it('fingerprints topology independently from response ordering', () => {
    const first = topologyFingerprint(completeLayout);
    const second = topologyFingerprint({
      total_nodes: 3,
      returned_nodes: 3,
      nodes: [{ id: 2 }, { id: 3 }, { id: 1 }],
      edges: [...completeLayout.edges].reverse(),
    });

    expect(first.complete).toBe(true);
    expect(first).toEqual(second);
    expect(() => assertSameCompleteTopology('v1', first, 'v2', second)).not.toThrow();
  });

  it('rejects sampled or different layouts instead of making a false comparison', () => {
    const complete = topologyFingerprint(completeLayout);
    const sampled = topologyFingerprint({
      total_nodes: 3,
      returned_nodes: 2,
      nodes: [{ id: 1 }, { id: 2 }],
      edges: [{ source: 1, target: 2, type: 'IMPORTS' }],
    });
    const different = topologyFingerprint({
      total_nodes: 3,
      nodes: [{ id: 1 }, { id: 2 }, { id: 4 }],
      edges: completeLayout.edges,
    });

    expect(() => assertSameCompleteTopology('v1', complete, 'v2', sampled))
      .toThrow(/complete layouts/);
    expect(() => assertSameCompleteTopology('v1', complete, 'v2', different))
      .toThrow(/Topology mismatch/);
  });

  it('rejects a stale browser project even when the preflight topology passed', () => {
    const expected = topologyFingerprint(completeLayout);
    const rendered = {
      url: 'http://127.0.0.1:9752/api/layout?project=stale-project&max_nodes=2000',
      layout: completeLayout,
    };

    expect(() => assertRenderedGraphIdentity('V1', 'controlled-project', expected, [rendered]))
      .toThrow(/rendered project "stale-project" instead of "controlled-project"/);
  });

  it('verifies the project and topology rendered by the browser', () => {
    const expected = topologyFingerprint(completeLayout);
    const observation = {
      url: 'http://127.0.0.1:9752/api/layout?project=controlled-project&max_nodes=2000',
      layout: completeLayout,
    };

    expect(assertRenderedGraphIdentity('V1', 'controlled-project', expected, [observation]))
      .toEqual({ url: observation.url, topology: expected });
    expect(() => assertRenderedGraphIdentity('V1', 'controlled-project', expected, [{
      ...observation,
      layout: { ...completeLayout, nodes: [{ id: 1 }, { id: 2 }, { id: 4 }] },
    }])).toThrow(/Topology mismatch/);
    expect(() => assertRenderedGraphIdentity('V1', 'controlled-project', expected, []))
      .toThrow(/did not render an \/api\/layout response/);
  });

  it('uses nearest-rank percentiles and reports dispersion', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(summarizeTimings([10, 10, 20])).toEqual({
      runs: 3,
      min: 10,
      p50: 10,
      p95: 20,
      max: 20,
      mean: 13.333,
      coefficientOfVariationPct: 35.355,
    });
  });

  it('derives interaction FPS and dropped-frame ratios from animation frames', () => {
    expect(analyzeFrames([0, 16, 32, 82])).toEqual({
      frameCount: 4,
      durationMs: 82,
      fps: 36.585,
      p50FrameMs: 16,
      p95FrameMs: 50,
      framesOver25MsPct: 33.333,
      framesOver50MsPct: 0,
    });
  });

  it('assigns both anonymous labels deterministically', () => {
    expect(blindLabels('same-seed')).toEqual(blindLabels('same-seed'));
    expect(new Set(Object.values(blindLabels('same-seed')))).toEqual(new Set(['A', 'B']));
  });

  it('recognizes both documented help switches without matching ordinary arguments', () => {
    expect(isHelpRequest(['--help'])).toBe(true);
    expect(isHelpRequest(['-h'])).toBe(true);
    expect(isHelpRequest(['--project', 'help'])).toBe(false);
  });

  it('fails closed when the packaged browser smoke does not exercise the graph', () => {
    const valid = {
      graphTabSelected: true,
      projectVisible: true,
      canvas: { cssWidth: 1200, cssHeight: 800, pixelWidth: 1200, pixelHeight: 800 },
      initial: { visualMode: 'architecture', viewPressed: true, flowLens: 'off' },
      dependencies: { visualMode: 'stellar', viewPressed: true, flowLens: 'semantic-depth-v2' },
      keyboardAnnouncement: 'Node packagedGraphCaller, 1 of 2. Press Enter to activate.',
      restored: { visualMode: 'architecture', viewPressed: true, flowLens: 'off' },
      consoleErrors: [],
      pageErrors: [],
      failedResponses: [],
    } as const;

    expect(() => assertGraphBrowserSmoke(valid)).not.toThrow();
    expect(() => assertGraphBrowserSmoke({
      ...valid,
      graphTabSelected: false,
      dependencies: { visualMode: 'architecture', viewPressed: false, flowLens: 'off' },
      keyboardAnnouncement: 'No visible node targets.',
      consoleErrors: ['render failed'],
      failedResponses: [{ status: 500, url: 'http://127.0.0.1/api/layout' }],
    })).toThrow(/graph tab is not selected.*Dependencies view did not activate.*keyboard traversal.*console error.*HTTP response/si);
  });
});
