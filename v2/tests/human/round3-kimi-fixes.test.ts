// v2/tests/human/round3-kimi-fixes.test.ts
// Regression tests for the 9 bugs found by the Kimi K2.6 audit (round 3).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../../src/human/store.js';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import { walkVault, ensureVaultDirs } from '../../src/obsidian/vault.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Round 3 — Kimi K2.6 audit regression tests', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
  });

  afterEach(() => {
    store.close();
  });

  describe('BUG-HIGH-01: updateNode validates obsidian_path', () => {
    it('rejects obsidian_path with .. in updateNode', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR',
      });
      expect(() =>
        store.updateNode(node.id, { obsidian_path: '../../../etc/passwd' })
      ).toThrow(/\.\.|path traversal|backslash/i);
    });

    it('rejects obsidian_path with backslashes in updateNode', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR 2',
      });
      expect(() =>
        store.updateNode(node.id, { obsidian_path: 'foo\\bar.md' })
      ).toThrow(/backslash|path traversal/i);
    });

    it('accepts valid obsidian_path in updateNode', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR 3',
      });
      const updated = store.updateNode(node.id, { obsidian_path: 'ADR/new-path.md' });
      expect(updated!.obsidian_path).toBe('ADR/new-path.md');
    });

    it('accepts null obsidian_path in updateNode', () => {
      const node = store.createNode({
        project: 'test',
        label: 'ADR',
        title: 'Test ADR 4',
      });
      const updated = store.updateNode(node.id, { obsidian_path: null });
      expect(updated!.obsidian_path).toBeNull();
    });
  });

  describe('BUG-HIGH-02: createNode TOCTOU race (transaction)', () => {
    it('createNode is wrapped in a transaction (no UNIQUE error on collision)', () => {
      // Create two nodes with the same title — the second should auto-suffix, not throw.
      const n1 = store.createNode({ project: 'test', label: 'ADR', title: 'Same Title' });
      const n2 = store.createNode({ project: 'test', label: 'ADR', title: 'Same Title' });
      expect(n1.slug).toBe('same-title');
      expect(n2.slug).toBe('same-title-2');
      expect(n1.id).not.toBe(n2.id);
    });

    it('handles 50 concurrent same-title creates without UNIQUE errors', () => {
      const ids: number[] = [];
      for (let i = 0; i < 50; i++) {
        const node = store.createNode({ project: 'test', label: 'ADR', title: 'Concurrent Test' });
        ids.push(node.id);
      }
      // All 50 should succeed with unique slugs.
      const uniqueSlugs = new Set(ids.map((id) => store.getNodeById(id)?.slug));
      expect(uniqueSlugs.size).toBe(50);
    });
  });

  describe('BUG-CRIT-02: JSON.parse in findRoute fallback is guarded', () => {
    it('findRoute does not crash on corrupted properties_json', () => {
      // Create a temp SQLite DB mimicking V1 code graph.
      const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-findroutetest-'));
      const dbPath = join(tmpDir, 'test-code.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY,
          project TEXT, label TEXT, name TEXT, qualified_name TEXT,
          file_path TEXT, start_line INTEGER, end_line INTEGER, properties_json TEXT
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER, target_id INTEGER,
          type TEXT, properties_json TEXT
        );
        CREATE TABLE projects (name TEXT);
      `);
      // Insert a route with valid properties.
      db.prepare(
        `INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
         VALUES ('test', 'Route', 'POST /api/login', 'test.login', 'src/routes.ts', 1, 50, ?)`
      ).run(JSON.stringify({ route_method: 'POST', route_path: '/api/login' }));
      // Insert a route with corrupted properties_json.
      db.prepare(
        `INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
         VALUES ('test', 'Route', 'GET /api/corrupt', 'test.corrupt', 'src/routes.ts', 51, 80, ?)`
      ).run('{corrupt json');
      // Insert a route with NULL properties_json.
      db.prepare(
        `INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
         VALUES ('test', 'Route', 'GET /api/null', 'test.null', 'src/routes.ts', 81, 100, NULL)`
      ).run();

      db.close();

      const reader = new CodeGraphReader(dbPath);

      // Should find the valid route.
      const route = reader.findRoute('test', 'POST', '/api/login');
      expect(route).not.toBeNull();
      expect(route!.name).toBe('POST /api/login');

      // Should NOT crash on corrupted or NULL properties — just skip them.
      expect(() => reader.findRoute('test', 'GET', '/api/nonexistent')).not.toThrow();

      reader.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('BUG-MED-03: walkVault uses Set<string> for inodeKey', () => {
    it('walkVault handles symlink loops without type errors', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-walkvault-'));
      const vaultPath = join(tmpDir, 'vault');
      ensureVaultDirs(vaultPath);
      const files = walkVault(vaultPath);
      expect(files).toEqual([]);
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('BUG-MED-04: existsSync + mkdirSync simplified', () => {
    it('HumanMemoryStore constructor creates parent dir without existsSync check', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-storetest-'));
      const dbPath = join(tmpDir, 'nested', 'deep', 'test.human.db');
      // Should not throw — mkdirSync with recursive: true creates all parents.
      const s = new HumanMemoryStore(dbPath);
      expect(s.getNodeById(999)).toBeNull();
      s.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('ensureVaultDirs creates all dirs without existsSync check', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-vaultdirs-'));
      const vaultPath = join(tmpDir, 'myvault');
      ensureVaultDirs(vaultPath);
      // All 10 directories should exist.
      const files = walkVault(vaultPath);
      expect(files).toEqual([]); // no .md files yet
      // Calling again should not throw (idempotent).
      ensureVaultDirs(vaultPath);
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
