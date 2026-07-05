// v2/tests/round22-fixes.test.ts
// Tests for R22 fixes: human link cbm_node_id validation, comment accuracy.

import { describe, it, expect } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';

describe('R22: human link validates cbm_node_id (regression check)', () => {
  it('createEdge still works without a code reader (no validation)', () => {
    // This is a unit test verifying the store layer — the CLI validation
    // happens in human.ts before createEdge is called.
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR',
      });

      // createEdge succeeds even with a non-existent cbm_node_id (the store
      // doesn't validate against the code graph — that's the CLI/MCP layer's job).
      const edge = store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 999999, // doesn't exist in any code graph
        type: 'DECIDES',
      });
      expect(edge.id).toBeGreaterThan(0);

      // The junction table should still have the link (store doesn't validate).
      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ?')
        .all(node.id) as any[];
      expect(links.length).toBe(1);
      expect(links[0].cbm_node_id).toBe(999999);
    } finally {
      store.close();
    }
  });

  it('junction table stays consistent after multiple createEdge calls to same target', () => {
    // R22 regression: ensure that calling createEdge twice for the same
    // (source, target) pair doesn't corrupt the junction table.
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Dedup edge test',
      });

      // First edge — should add to junction table.
      store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'DECIDES',
      });

      // Second edge with same target but different type — createEdge dedup
      // returns the existing edge (same source+target+type). But here the
      // type is different, so a new edge IS created. The junction table
      // should still have only ONE row for (node, 42) because the PK
      // prevents duplicates.
      store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'AFFECTS',
      });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT COUNT(*) AS c FROM human_node_cbm_links WHERE human_node_id = ? AND cbm_node_id = ?')
        .get(node.id, 42) as any;
      expect(links.c).toBe(1); // PK dedup

      // The cbm_node_ids JSON cache should also have 42 only once.
      const updated = store.getNodeById(node.id);
      expect(updated!.cbm_node_ids.filter((id) => id === 42).length).toBe(1);
    } finally {
      store.close();
    }
  });
});
