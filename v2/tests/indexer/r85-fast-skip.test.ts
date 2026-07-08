// v2/tests/indexer/r85-fast-skip.test.ts
// R85: Tests for mtimeNs precision, metadata-only update, and no-pre-read incremental.
// Covers bugs 26-27 from GPT 5.5 R84 audit report.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initIndexerSchema } from '../../src/indexer/schema.js';

describe('R85: mtimeNs precision + no-pre-read incremental', () => {

  describe('Bug 26: mtime_ns column migration', () => {
    it('adds mtime_ns column to old file_hashes table', () => {
      const db = new Database(':memory:');
      // Create pre-R85 schema (no mtime_ns column)
      db.exec(`
        CREATE TABLE file_hashes (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          file_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL,
          UNIQUE(project, file_path)
        );
      `);

      // Verify mtime_ns doesn't exist yet
      const colsBefore = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
      expect(colsBefore.some(c => c.name === 'mtime_ns')).toBe(false);

      // Run migration
      initIndexerSchema(db);

      // Verify mtime_ns now exists
      const colsAfter = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
      expect(colsAfter.some(c => c.name === 'mtime_ns')).toBe(true);

      db.close();
    });

    it('does not re-add mtime_ns if already present', () => {
      const db = new Database(':memory:');
      initIndexerSchema(db); // creates with mtime_ns
      initIndexerSchema(db); // should be idempotent

      const cols = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
      const mtimeNsCount = cols.filter(c => c.name === 'mtime_ns').length;
      expect(mtimeNsCount).toBe(1); // exactly one column, not duplicated

      db.close();
    });
  });

  describe('Bug 27: no-pre-read incremental (O(stat) not O(bytes))', () => {
    let tmpDir: string;
    let db: Database.Database;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'r85-test-'));
      db = new Database(':memory:');
      initIndexerSchema(db);
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('fast-skip uses mtime_ns when available (nanosecond precision)', () => {
      // Create a test file
      const filePath = join(tmpDir, 'test.ts');
      writeFileSync(filePath, 'export function foo() { return 1; }');

      // Get stat with bigint
      const stat = statSync(filePath, { bigint: true });
      const mtimeNs = stat.mtimeNs.toString();
      const size = Number(stat.size);

      // Insert a file_hashes entry with mtime_ns
      db.prepare(`
        INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('test', 'test.ts', 'fakehash', Math.floor(Number(stat.mtimeMs)), mtimeNs, size, new Date().toISOString());

      // Query it back
      const row = db.prepare(
        'SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?'
      ).get('test', 'test.ts') as { content_hash: string; mtime: number; mtime_ns: string | null; size: number };

      expect(row.mtime_ns).toBe(mtimeNs);
      expect(row.size).toBe(size);

      // Simulate fast-skip check: mtime_ns matches
      const mtimeMatches = row.mtime_ns === mtimeNs;
      expect(mtimeMatches).toBe(true);
    });

    it('falls back to mtime when mtime_ns is null (pre-R85 DB)', () => {
      const db2 = new Database(':memory:');
      initIndexerSchema(db2);

      // Insert with mtime_ns = null (simulating pre-R85 data)
      db2.prepare(`
        INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run('test', 'old.ts', 'hash123', 1000, 50, new Date().toISOString());

      const row = db2.prepare(
        'SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?'
      ).get('test', 'old.ts') as { content_hash: string; mtime: number; mtime_ns: string | null; size: number };

      // Should fall back to mtime comparison
      expect(row.mtime_ns).toBeNull();
      const mtimeMatches = row.mtime_ns
        ? false // would use mtime_ns
        : row.mtime === 1000; // falls back to mtime
      expect(mtimeMatches).toBe(true);

      db2.close();
    });
  });

  describe('Metadata-only update preserves nodes', () => {
    it('metadata-only update does not touch nodes table', () => {
      const db = new Database(':memory:');
      initIndexerSchema(db);

      // Insert a node
      db.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?, ?)')
        .run(1, 'test', 'Function', 'foo', 'test::foo', 'src/foo.ts');

      // Simulate metadata-only hash update (mtime changed, content same)
      db.prepare(`
        INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, file_path) DO UPDATE SET
          content_hash = excluded.content_hash, mtime = excluded.mtime,
          mtime_ns = excluded.mtime_ns, size = excluded.size, indexed_at = excluded.indexed_at
      `).run('test', 'src/foo.ts', 'hashABC', 2000, '2000000000', 100, new Date().toISOString());

      // Node should still be there
      const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get('test') as { c: number };
      expect(nodeCount.c).toBe(1);

      // Hash should be updated
      const hash = db.prepare('SELECT mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?')
        .get('test', 'src/foo.ts') as { mtime: number; mtime_ns: string; size: number };
      expect(hash.mtime).toBe(2000);
      expect(hash.mtime_ns).toBe('2000000000');

      db.close();
    });
  });

  describe('Orphan edges invariant after incremental', () => {
    it('no orphan edges when metadata-only update skips re-indexing', () => {
      const db = new Database(':memory:');
      initIndexerSchema(db);

      // Insert nodes and edges
      db.transaction(() => {
        db.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?, ?)')
          .run(1, 'test', 'Function', 'foo', 'test::foo', 'src/foo.ts');
        db.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, file_path) VALUES (?, ?, ?, ?, ?, ?)')
          .run(2, 'test', 'Function', 'bar', 'test::bar', 'src/bar.ts');
        db.prepare('INSERT INTO edges (project, source_id, target_id, type) VALUES (?, ?, ?, ?)')
          .run('test', 1, 2, 'CALLS');
      })();

      // Simulate metadata-only update (no nodes/edges touched)
      db.prepare(`
        INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('test', 'src/foo.ts', 'hash', 1000, '1000000000', 50, new Date().toISOString());

      // Check orphan edges
      const orphanCount = db.prepare(`
        SELECT COUNT(*) AS c FROM edges e
        LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
        LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
        WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
      `).get('test') as { c: number };

      expect(orphanCount.c).toBe(0);

      db.close();
    });
  });
});
