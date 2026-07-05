// v2/tests/round15-fixes.test.ts
// Regression tests for bugs found and fixed in Round 15.

import { describe, it, expect } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';

describe('R15: getBulkNotesByCbmNodeIds SQL-level limit', () => {
  it('respects the limit parameter at the SQL level', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      // Create one code node target (cbm_node_id=42) and 5 notes pointing to it.
      for (let i = 0; i < 5; i++) {
        store.createNode({
          project: 'test',
          label: 'BugNote',
          title: `Bug ${i} for node 42`,
          body_markdown: `body ${i}`,
          cbm_node_ids: [42],
        });
      }

      // Request limit=1 — should get exactly 1 note (the most recent).
      const result = store.getBulkNotesByCbmNodeIds('test', [42], 1);
      expect(result.get(42)?.length).toBe(1);

      // Request limit=3 — should get exactly 3.
      const result3 = store.getBulkNotesByCbmNodeIds('test', [42], 3);
      expect(result3.get(42)?.length).toBe(3);

      // Request limit=10 — should get all 5 (not 10).
      const result10 = store.getBulkNotesByCbmNodeIds('test', [42], 10);
      expect(result10.get(42)?.length).toBe(5);
    } finally {
      store.close();
    }
  });

  it('handles multiple cbm_node_ids with different note counts', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      // Node 100: 3 notes, Node 200: 1 note, Node 300: 0 notes.
      for (let i = 0; i < 3; i++) {
        store.createNode({
          project: 'test',
          label: 'ADR',
          title: `ADR ${i} for node 100`,
          cbm_node_ids: [100],
        });
      }
      store.createNode({
        project: 'test',
        label: 'BugNote',
        title: 'Bug for node 200',
        cbm_node_ids: [200],
      });

      const result = store.getBulkNotesByCbmNodeIds('test', [100, 200, 300], 5);
      expect(result.get(100)?.length).toBe(3);
      expect(result.get(200)?.length).toBe(1);
      expect(result.get(300)?.length).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('R15: listAllEdges', () => {
  it('lists all edges for a project in one query', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const n1 = store.createNode({ project: 'test', label: 'ADR', title: 'ADR 1' });
      const n2 = store.createNode({ project: 'test', label: 'BugNote', title: 'Bug 1' });
      store.createEdge({
        project: 'test',
        source_human_node_id: n1.id,
        target_kind: 'human',
        target_human_node_id: n2.id,
        type: 'MENTIONS',
      });
      store.createEdge({
        project: 'test',
        source_human_node_id: n2.id,
        target_kind: 'code',
        target_cbm_node_id: 999,
        type: 'AFFECTS',
      });

      const edges = store.listAllEdges('test');
      expect(edges.length).toBe(2);
      expect(edges.some((e) => e.type === 'MENTIONS')).toBe(true);
      expect(edges.some((e) => e.type === 'AFFECTS')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('does not return edges from other projects', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const n1 = store.createNode({ project: 'proj-a', label: 'ADR', title: 'A' });
      const n2 = store.createNode({ project: 'proj-b', label: 'ADR', title: 'B' });
      store.createEdge({
        project: 'proj-a',
        source_human_node_id: n1.id,
        target_kind: 'code',
        target_cbm_node_id: 1,
        type: 'MENTIONS',
      });
      store.createEdge({
        project: 'proj-b',
        source_human_node_id: n2.id,
        target_kind: 'code',
        target_cbm_node_id: 2,
        type: 'MENTIONS',
      });

      const edgesA = store.listAllEdges('proj-a');
      const edgesB = store.listAllEdges('proj-b');
      expect(edgesA.length).toBe(1);
      expect(edgesB.length).toBe(1);
      expect(edgesA[0].target_cbm_node_id).toBe(1);
      expect(edgesB[0].target_cbm_node_id).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe('R15: updateNode no-op guard (re-verify from R14)', () => {
  it('does not bump updated_at when nothing changes', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test',
      });
      const before = node.updated_at;
      const after = store.updateNode(node.id, {});
      expect(after?.updated_at).toBe(before);
    } finally {
      store.close();
    }
  });
});
