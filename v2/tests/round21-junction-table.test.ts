// v2/tests/round21-junction-table.test.ts
// Tests for R21 junction table optimization (human_node_cbm_links).

import { describe, it, expect } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';
import { runMigrations } from '../src/human/schema.js';
import Database from 'better-sqlite3';

describe('R21: junction table human_node_cbm_links', () => {
  it('creates the junction table on new DBs', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='human_node_cbm_links'")
        .all() as any[];
      expect(tables.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it('creates the covering index on cbm_node_id', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='human_node_cbm_links'")
        .all() as any[];
      const indexNames = indexes.map((r) => r.name);
      // PRIMARY KEY creates an automatic index, plus our explicit idx_cbm_links_cbm_id.
      expect(indexNames).toContain('idx_cbm_links_cbm_id');
    } finally {
      store.close();
    }
  });

  it('populates junction table on createNode with cbm_node_ids', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR',
        cbm_node_ids: [10, 20, 30],
      });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ? ORDER BY cbm_node_id')
        .all(node.id) as any[];
      expect(links.length).toBe(3);
      expect(links.map((l) => l.cbm_node_id)).toEqual([10, 20, 30]);
    } finally {
      store.close();
    }
  });

  it('deduplicates cbm_node_ids in the junction table', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Dedup test',
        cbm_node_ids: [42, 42, 42], // duplicates
      });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ?')
        .all(node.id) as any[];
      expect(links.length).toBe(1); // deduped
    } finally {
      store.close();
    }
  });

  it('filters invalid cbm_node_ids (zero, negative, NaN)', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Filter test',
        cbm_node_ids: [0, -1, 42, NaN, 99],
      });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ? ORDER BY cbm_node_id')
        .all(node.id) as any[];
      // Only 42 and 99 are valid positive integers.
      expect(links.length).toBe(2);
      expect(links.map((l) => l.cbm_node_id)).toEqual([42, 99]);
    } finally {
      store.close();
    }
  });

  it('syncs junction table on updateNode with new cbm_node_ids', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Update test',
        cbm_node_ids: [10, 20],
      });

      // Update to a completely different set.
      store.updateNode(node.id, { cbm_node_ids: [30, 40, 50] });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ? ORDER BY cbm_node_id')
        .all(node.id) as any[];
      expect(links.map((l) => l.cbm_node_id)).toEqual([30, 40, 50]);
    } finally {
      store.close();
    }
  });

  it('clears junction table when cbm_node_ids is set to empty', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Clear test',
        cbm_node_ids: [10, 20],
      });

      store.updateNode(node.id, { cbm_node_ids: [] });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT COUNT(*) AS c FROM human_node_cbm_links WHERE human_node_id = ?')
        .get(node.id) as any;
      expect(links.c).toBe(0);
    } finally {
      store.close();
    }
  });

  it('does NOT touch junction table when updateNode omits cbm_node_ids', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'No-op test',
        cbm_node_ids: [10, 20],
      });

      // Update only the title — cbm_node_ids should be untouched.
      store.updateNode(node.id, { title: 'New title' });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ? ORDER BY cbm_node_id')
        .all(node.id) as any[];
      expect(links.map((l) => l.cbm_node_id)).toEqual([10, 20]);
    } finally {
      store.close();
    }
  });

  it('adds to junction table on createEdge with code target', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Edge test',
        cbm_node_ids: [],
      });

      // Create an edge linking to code node 42.
      store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 42,
        type: 'DECIDES',
      });

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ?')
        .all(node.id) as any[];
      expect(links.length).toBe(1);
      expect(links[0].cbm_node_id).toBe(42);
    } finally {
      store.close();
    }
  });

  it('cascade deletes junction table rows when node is deleted', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Cascade delete test',
        cbm_node_ids: [10, 20, 30],
      });
      const nodeId = node.id;

      // Verify links exist.
      const db = store.getRawDb();
      const before = db
        .prepare('SELECT COUNT(*) AS c FROM human_node_cbm_links WHERE human_node_id = ?')
        .get(nodeId) as any;
      expect(before.c).toBe(3);

      // Delete the node.
      store.deleteNode(nodeId);

      // Junction table rows should be cascade-deleted.
      const after = db
        .prepare('SELECT COUNT(*) AS c FROM human_node_cbm_links WHERE human_node_id = ?')
        .get(nodeId) as any;
      expect(after.c).toBe(0);
    } finally {
      store.close();
    }
  });

  it('listNodesByCbmNodeId finds notes via junction table', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      // Create 3 notes, 2 linked to code node 42.
      store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'ADR linked to 42',
        cbm_node_ids: [42],
      });
      store.createNode({
        project: 'test',
        label: 'BugNote',
        title: 'Bug linked to 42',
        cbm_node_ids: [42],
      });
      store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'ADR NOT linked to 42',
        cbm_node_ids: [99],
      });

      const notes = store.listNodesByCbmNodeId('test', 42);
      expect(notes.length).toBe(2);
      expect(notes.every((n) => n.cbm_node_ids.includes(42))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('getBulkNotesByCbmNodeIds uses junction table for multi-id lookup', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'ADR for 10 and 20',
        cbm_node_ids: [10, 20],
      });
      store.createNode({
        project: 'test',
        label: 'BugNote',
        title: 'Bug for 20',
        cbm_node_ids: [20],
      });
      store.createNode({
        project: 'test',
        label: 'Convention',
        title: 'Convention for 30',
        cbm_node_ids: [30],
      });

      const result = store.getBulkNotesByCbmNodeIds('test', [10, 20, 30, 40], 5);
      expect(result.get(10)?.length).toBe(1);
      expect(result.get(20)?.length).toBe(2);
      expect(result.get(30)?.length).toBe(1);
      expect(result.get(40)?.length).toBe(0); // no notes linked to 40
    } finally {
      store.close();
    }
  });

  it('backfills junction table from existing cbm_node_ids on migration', () => {
    // Simulate an existing V2 DB (before R21) with cbm_node_ids data.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Apply V1 schema + V2 migration manually (without V3).
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      
      CREATE TABLE human_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, label TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
        body_markdown TEXT NOT NULL DEFAULT '', frontmatter_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'human',
        obsidian_path TEXT, cbm_node_ids TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
        provenance TEXT NOT NULL DEFAULT 'human', confidence REAL NOT NULL DEFAULT 1.0,
        source_file TEXT, author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_synced_at TEXT, UNIQUE(project, slug)
      );
      CREATE INDEX idx_human_nodes_project_label ON human_nodes(project, label);
      CREATE INDEX idx_human_nodes_project_status ON human_nodes(project, status);
      
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', '2026-01-01');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'optimize_indexes', '2026-01-02');
      
      -- Insert test data with cbm_node_ids.
      INSERT INTO human_nodes (project, label, title, slug, cbm_node_ids, created_at, updated_at)
      VALUES ('test', 'ADR', 'ADR 1', 'adr-1', '[10, 20, 30]', '2026-01-01', '2026-01-01');
      INSERT INTO human_nodes (project, label, title, slug, cbm_node_ids, created_at, updated_at)
      VALUES ('test', 'BugNote', 'Bug 1', 'bug-1', '[42]', '2026-01-01', '2026-01-01');
    `);

    // Verify no junction table exists yet.
    const beforeTable = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='human_node_cbm_links'")
      .get() as any;
    expect(beforeTable.c).toBe(0);

    // Run migrations (should apply V3 — backfill).
    runMigrations(db);

    // Verify junction table exists and was backfilled.
    const links = db
      .prepare('SELECT human_node_id, cbm_node_id FROM human_node_cbm_links ORDER BY human_node_id, cbm_node_id')
      .all() as any[];
    expect(links.length).toBe(4); // 3 from ADR 1 + 1 from Bug 1
    expect(links.map((l) => [l.human_node_id, l.cbm_node_id])).toEqual([
      [1, 10], [1, 20], [1, 30], [2, 42],
    ]);

    db.close();
  });

  it('cbm_node_ids JSON cache stays in sync with junction table', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      // Create with [10, 20].
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Sync test',
        cbm_node_ids: [10, 20],
      });
      expect(node.cbm_node_ids).toEqual([10, 20]);

      // Add a code-target edge to 30 (R19+R21 sync).
      store.createEdge({
        project: 'test',
        source_human_node_id: node.id,
        target_kind: 'code',
        target_cbm_node_id: 30,
        type: 'DECIDES',
      });

      // Re-fetch — both the JSON cache and junction table should have 30.
      const updated = store.getNodeById(node.id);
      expect(updated!.cbm_node_ids).toContain(30);
      expect(updated!.cbm_node_ids.length).toBe(3);

      const db = store.getRawDb();
      const links = db
        .prepare('SELECT cbm_node_id FROM human_node_cbm_links WHERE human_node_id = ? ORDER BY cbm_node_id')
        .all(node.id) as any[];
      expect(links.map((l) => l.cbm_node_id)).toEqual([10, 20, 30]);
    } finally {
      store.close();
    }
  });
});
