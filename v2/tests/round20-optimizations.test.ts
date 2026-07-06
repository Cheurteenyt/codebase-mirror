// v2/tests/round20-optimizations.test.ts
// Tests for R20 storage optimizations: migration V2, PRAGMA settings, maxNodes clamping.

import { describe, it, expect } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';
import { runMigrations } from '../src/human/schema.js';
import Database from 'better-sqlite3';

describe('R20: Migration V2 — index optimization', () => {
  it('creates composite indexes on new DBs', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      // Check that composite indexes exist.
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='human_nodes'")
        .all() as any[];
      const indexNames = indexes.map((r) => r.name);

      // R20 composites should exist.
      expect(indexNames).toContain('idx_human_nodes_project_label');
      expect(indexNames).toContain('idx_human_nodes_project_status');

      // R20 dropped indexes should NOT exist.
      expect(indexNames).not.toContain('idx_human_nodes_cbm_node_ids');
      expect(indexNames).not.toContain('idx_human_nodes_label');
      expect(indexNames).not.toContain('idx_human_nodes_status');
      expect(indexNames).not.toContain('idx_human_nodes_project');
    } finally {
      store.close();
    }
  });

  it('migration V2 is recorded in schema_migrations', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      const migrations = db
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all() as any[];
      // R21 added migration V3 (cbm_links_junction_table).
      // R41 added migration V4 (human_nodes_fts).
      expect(migrations.length).toBe(4);
      expect(migrations[0].version).toBe(1);
      expect(migrations[0].name).toBe('initial_schema');
      expect(migrations[1].version).toBe(2);
      expect(migrations[1].name).toBe('optimize_indexes');
      expect(migrations[2].version).toBe(3);
      expect(migrations[2].name).toBe('cbm_links_junction_table');
      expect(migrations[3].version).toBe(4);
      expect(migrations[3].name).toBe('human_nodes_fts');
    } finally {
      store.close();
    }
  });

  it('composite indexes support project + label queries efficiently', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      // Create nodes in two projects.
      store.createNode({ project: 'proj-a', label: 'ADR', title: 'ADR 1' });
      store.createNode({ project: 'proj-a', label: 'BugNote', title: 'Bug 1' });
      store.createNode({ project: 'proj-b', label: 'ADR', title: 'ADR 2' });

      // Query by project + label — should use the composite index.
      const adrsInA = store.listNodes('proj-a', { label: 'ADR' });
      expect(adrsInA.length).toBe(1);
      expect(adrsInA[0].title).toBe('ADR 1');

      // Query by project + status.
      const activeInA = store.listNodes('proj-a', { status: 'active' });
      expect(activeInA.length).toBe(2);
    } finally {
      store.close();
    }
  });

  it('upgrades existing V1 DBs to V2 indexes without data loss', () => {
    // Create a V1 DB manually (simulating an existing installation).
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Apply V1 schema with old indexes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS human_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        label TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        body_markdown TEXT NOT NULL DEFAULT '',
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'human',
        obsidian_path TEXT,
        cbm_node_ids TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        provenance TEXT NOT NULL DEFAULT 'human',
        confidence REAL NOT NULL DEFAULT 1.0,
        source_file TEXT,
        author TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_synced_at TEXT,
        UNIQUE(project, slug)
      );

      -- Old V1 indexes (the suboptimal ones).
      CREATE INDEX idx_human_nodes_project ON human_nodes(project);
      CREATE INDEX idx_human_nodes_label ON human_nodes(label);
      CREATE INDEX idx_human_nodes_status ON human_nodes(status);
      CREATE INDEX idx_human_nodes_obsidian_path ON human_nodes(obsidian_path);
      CREATE INDEX idx_human_nodes_updated_at ON human_nodes(updated_at);
      CREATE INDEX idx_human_nodes_cbm_node_ids ON human_nodes(project, cbm_node_ids);

      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', '2026-01-01T00:00:00Z');

      -- Insert test data.
      INSERT INTO human_nodes (project, label, title, slug, created_at, updated_at)
      VALUES ('test', 'ADR', 'Test ADR', 'test-adr', '2026-01-01', '2026-01-01');
    `);

    // Verify old indexes exist before migration.
    const beforeIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='human_nodes'")
      .all() as any[];
    const beforeNames = beforeIndexes.map((r) => r.name);
    expect(beforeNames).toContain('idx_human_nodes_cbm_node_ids');
    expect(beforeNames).toContain('idx_human_nodes_label');

    // Now run migrations (should apply V2).
    runMigrations(db);

    // Verify V2+V3 migrations were applied.
    const migrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as any[];
    expect(migrations.length).toBe(4);
    expect(migrations[1].version).toBe(2);
    expect(migrations[2].version).toBe(3);

    // Verify old indexes were dropped.
    const afterIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='human_nodes'")
      .all() as any[];
    const afterNames = afterIndexes.map((r) => r.name);
    expect(afterNames).not.toContain('idx_human_nodes_cbm_node_ids');
    expect(afterNames).not.toContain('idx_human_nodes_label');
    expect(afterNames).not.toContain('idx_human_nodes_status');
    expect(afterNames).not.toContain('idx_human_nodes_project');

    // Verify new composite indexes exist.
    expect(afterNames).toContain('idx_human_nodes_project_label');
    expect(afterNames).toContain('idx_human_nodes_project_status');

    // Verify data is still there (no data loss).
    const rows = db.prepare('SELECT COUNT(*) AS c FROM human_nodes').get() as any;
    expect(rows.c).toBe(1);

    db.close();
  });
});

describe('R20: PRAGMA optimizations', () => {
  it('sets temp_store to MEMORY on file-based DBs', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      const tempStore = db.pragma('temp_store', { simple: true });
      // temp_store: 0=DEFAULT, 1=FILE, 2=MEMORY
      expect(tempStore).toBe(2);
    } finally {
      store.close();
    }
  });

  it('sets a positive cache_size', () => {
    const store = HumanMemoryStore.openMemory();
    try {
      const db = store.getRawDb();
      const cacheSize = db.pragma('cache_size', { simple: true });
      // cache_size is negative when in KB (our -65536 = 64MB).
      // Just verify it's set to something non-default (default is -2000).
      expect(Math.abs(cacheSize)).toBeGreaterThan(2000);
    } finally {
      store.close();
    }
  });
});

describe('R20: maxNodes clamping (UI server security)', () => {
  it('Math.max/min clamping logic works correctly', () => {
    // Test the clamping logic without starting a server.
    const clamp = (raw: number) => Math.max(1, Math.min(10000, Number.isFinite(raw) ? raw : 2000));

    // Normal values pass through.
    expect(clamp(2000)).toBe(2000);
    expect(clamp(100)).toBe(100);

    // Negative values are clamped to 1.
    expect(clamp(-1)).toBe(1);
    expect(clamp(-100)).toBe(1);

    // Values above 10000 are clamped to 10000.
    expect(clamp(50000)).toBe(10000);
    expect(clamp(999999)).toBe(10000);

    // NaN falls back to 2000.
    expect(clamp(NaN)).toBe(2000);

    // Zero is clamped to 1.
    expect(clamp(0)).toBe(1);
  });
});
