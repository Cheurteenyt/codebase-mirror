import { describe, expect, it } from 'vitest';
import {
  buildStructuredOverview,
  ensureArchitectureDomainCoverage,
} from '../../src/ui/routes/graph.js';

const CLUSTER_GAP = 36;

function makeNodes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    label: 'Function',
    file_path: `packages/community-${index.toString().padStart(5, '0')}/src/file.ts`,
  }));
}

describe('structured Graph UI layout', () => {
  it('packs 10k communities deterministically without overlap', { timeout: 5_000 }, () => {
    const nodes = makeNodes(10_000);
    const first = buildStructuredOverview(nodes, new Map());
    const second = buildStructuredOverview(nodes, new Map());

    expect(first.clusters).toEqual(second.clusters);
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()]);
    expect(first.clusters).toHaveLength(10_000);

    const byLeftEdge = [...first.clusters].sort(
      (left, right) => (left.x - left.radius) - (right.x - right.radius),
    );
    let active: typeof byLeftEdge = [];
    for (const cluster of byLeftEdge) {
      const leftEdge = cluster.x - cluster.radius - CLUSTER_GAP;
      active = active.filter((other) => other.x + other.radius >= leftEdge);
      for (const other of active) {
        if (Math.abs(cluster.y - other.y) > cluster.radius + other.radius + CLUSTER_GAP) continue;
        expect(Math.hypot(cluster.x - other.x, cluster.y - other.y))
          .toBeGreaterThanOrEqual(cluster.radius + other.radius + CLUSTER_GAP - 0.02);
      }
      active.push(cluster);
    }
  });

  it('uses locale-independent code-point ordering for community IDs', () => {
    const names = ['éclair', 'Alpha', 'zeta', 'Éclair', 'alpha'];
    const nodes = names.map((name, index) => ({
      id: index + 1,
      label: 'Function',
      file_path: `packages/${name}/src/file.ts`,
    }));
    const result = buildStructuredOverview(nodes, new Map());
    const expected = names
      .map((name) => `packages/${name}/src`)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

    expect(result.clusters.map((cluster) => cluster.key)).toEqual(expected);
  });

  it('groups communities into stable top-level architecture domains', () => {
    const nodes = [
      { id: 1, label: 'Function', file_path: 'v2/src/ui/routes/graph.ts' },
      { id: 2, label: 'Function', file_path: 'v2/src/bridge/sqlite-ro.ts' },
      { id: 3, label: 'Function', file_path: 'graph-ui/src/components/GraphCanvas.tsx' },
      { id: 4, label: 'Function', file_path: 'packages/search/src/index.ts' },
      { id: 5, label: 'Function', file_path: 'packages/storage/src/index.ts' },
    ];

    const result = buildStructuredOverview(nodes, new Map());

    expect(result.domains.map(({ key, node_count, cluster_count }) => ({
      key,
      node_count,
      cluster_count,
    }))).toEqual([
      { key: 'graph-ui', node_count: 1, cluster_count: 1 },
      { key: 'packages', node_count: 2, cluster_count: 2 },
      { key: 'v2', node_count: 2, cluster_count: 2 },
    ]);
    for (const cluster of result.clusters) {
      expect(result.domains[cluster.domain_id]?.key).toBe(cluster.key.split('/')[0]);
    }
  });

  it('keeps folder nodes in their own full directory community', () => {
    const nodes = [
      { id: 1, label: 'Folder', file_path: 'scripts' },
      { id: 2, label: 'Folder', file_path: 'src/lib' },
      { id: 3, label: 'File', file_path: 'src/lib/parser.ts' },
    ];

    const result = buildStructuredOverview(nodes, new Map());

    expect(result.clusters.map((cluster) => ({ key: cluster.key, count: cluster.node_count })))
      .toEqual([
        { key: 'scripts', count: 1 },
        { key: 'src/lib', count: 2 },
      ]);
  });

  it('reserves a representative for small architecture domains in a capped sample', () => {
    const selected = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      label: 'File',
      file_path: `v2/src/file-${index}.ts`,
    }));
    const candidates = [
      ...selected,
      { id: 20, label: 'File', file_path: 'docs/guide.md' },
      { id: 21, label: 'File', file_path: '.github/workflows/ci.yml' },
      { id: 22, label: 'File', file_path: 'README.md' },
    ];

    const covered = ensureArchitectureDomainCoverage(selected, candidates, 6);
    const layout = buildStructuredOverview(covered, new Map());

    expect(covered).toHaveLength(6);
    expect(new Set(covered.map((node) => node.id)).size).toBe(6);
    expect(layout.domains.map((domain) => domain.key)).toEqual([
      '(root)',
      '.github',
      'docs',
      'v2',
    ]);
  });

  it('keeps nested domains disjoint, contains their communities, and ignores input order', () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      label: 'Function',
      file_path: `domain-${Math.floor(index / 10).toString().padStart(3, '0')}/community-${(index % 10).toString().padStart(2, '0')}/file.ts`,
    }));
    const forward = buildStructuredOverview(nodes, new Map());
    const reversed = buildStructuredOverview([...nodes].reverse(), new Map());

    expect(reversed).toEqual(forward);
    for (let leftIndex = 0; leftIndex < forward.domains.length; leftIndex += 1) {
      const left = forward.domains[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < forward.domains.length; rightIndex += 1) {
        const right = forward.domains[rightIndex];
        expect(Math.hypot(left.x - right.x, left.y - right.y))
          .toBeGreaterThanOrEqual(left.radius + right.radius + 92 - 0.02);
      }
    }
    for (const cluster of forward.clusters) {
      const domain = forward.domains[cluster.domain_id];
      expect(domain).toBeDefined();
      expect(Math.hypot(cluster.x - domain.x, cluster.y - domain.y) + cluster.radius)
        .toBeLessThanOrEqual(domain.radius + 0.02);
    }
  });
});
