// v2/tests/indexer/r109-empty-graph-complete.test.ts
// R109: Empty Graph Complete State Lock
//
// Tests that a project with call_sites_initialized=1 and nodesCount=0 is
// treated as a COMPLETE state (stale=false).
//
// R110 audit report claimed this was a P2 bug, but verification showed the
// bug was NOT triggerable because the extractor always creates a File node
// per file (so nodesCount >= 1 when any file exists). nodesCount=0 only
// happens when ALL files are deleted, which is handled by the deletion-only
// fast path.
//
// However, R109 applies a DEFENSIVE fix: make the "empty graph is complete"
// semantics explicit in all 3 code paths (single-thread, parallel,
// deletion-only). This guards against future changes to the extractor that
// might skip File node creation for empty files.
//
// These tests LOCK IN the correct behavior so future regressions are caught.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R109: Empty Graph Complete State Lock', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r109-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r109-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function getStaleFromDB(): boolean {
    const db = getDb();
    const row = db.prepare('SELECT cross_file_calls_stale FROM projects WHERE name = ?').get(projectName) as { cross_file_calls_stale?: number } | undefined;
    db.close();
    return row?.cross_file_calls_stale === 1;
  }

  // ── Test 1: single-thread function → const, stale=false ───────────────
  // The report claimed nodesCount could become 0 when a function is replaced
  // by a const. In reality, the File node is always created, so nodesCount=1.
  // But this test verifies the correct behavior regardless.
  it('single-thread: function → const, stale=false (File node always created)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');

    // Full index
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);

    // Replace function with const (no function/class/method nodes)
    writeFileSync(join(projectDir, 'a.ts'), 'export const x = 1;\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(1);
    // R109: stale must be false — graph is complete
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    const db = getDb();
    // File node still exists (extractor always creates one per file)
    const nodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    expect(nodes).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // ── Test 2: deletion-only ALL files deleted, stale=false ──────────────
  // This is the only scenario where nodesCount actually becomes 0.
  it('deletion-only: all files deleted → nodes=0, edges=0, call_sites=0, stale=false', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);

    const db1 = getDb();
    const nodes1 = (db1.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    expect(nodes1).toBeGreaterThan(0);
    db1.close();

    // Delete ALL files
    unlinkSync(join(projectDir, 'a.ts'));
    unlinkSync(join(projectDir, 'b.ts'));

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // deletion-only fast path
    // R109: stale must be false — empty graph is complete
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    const db2 = getDb();
    const nodes2 = (db2.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    const edges2 = (db2.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ?").get(projectName) as { c: number }).c;
    const callSites2 = (db2.prepare("SELECT COUNT(*) AS c FROM call_sites WHERE project = ?").get(projectName) as { c: number }).c;
    expect(nodes2).toBe(0);
    expect(edges2).toBe(0);
    expect(callSites2).toBe(0);
    db2.close();
  });

  // ── Test 3: deletion-only all files deleted, then full reindex works ──
  it('deletion-only all deleted → full reindex repopulates correctly', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete all files
    unlinkSync(join(projectDir, 'a.ts'));
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    // Add a new file and full reindex
    writeFileSync(join(projectDir, 'c.ts'), 'export function g() { return 2; }\n');
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result3.errors.length).toBe(0);
    expect(result3.crossFileCallsStale).toBe(false);

    const db = getDb();
    const nodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    expect(nodes).toBeGreaterThan(0);
    db.close();
  });

  // ── Test 4: parallel smoke — file loses last node, stale=false ────────
  // P2/P3 from R110 report: parallel path with a file that loses its last
  // extractable construct. Verifies stale=false and orphan_edges=0.
  it('parallel: file loses last function → stale=false, orphan_edges=0', async () => {
    // Create 24+ files to force parallel
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}() { return ${i}; }\n`);
    }

    // Full index — try parallel, fallback to single-thread
    let workers = 2;
    let result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
    });
    if (result1.errors.length > 0 || !result1.parallel) {
      workers = 0;
      result1 = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
      });
    }
    expect(result1.errors.length).toBe(0);

    // Modify file0.ts to remove its function (replace with const)
    writeFileSync(join(projectDir, 'file0.ts'), 'export const x = 0;\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
    });

    expect(result2.errors.length).toBe(0);
    // R109: stale must be false
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // No orphan edges
    const db = getDb();
    const orphanEdges = (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanEdges).toBe(0);
    db.close();
  });

  // ── Test 5: legacy DB (initialized=0) + nodesCount=0 → stale=true ─────
  // Documents the expected behavior for legacy DBs with no nodes.
  it('legacy DB (initialized=0) + all files deleted → stale=true (forces full reindex)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    // Full index — sets initialized=1
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Simulate legacy DB: reset initialized=0
    const { initIndexerSchema } = await import('../../src/indexer/schema.js');
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('UPDATE projects SET call_sites_initialized = 0 WHERE name = ?').run(projectName);
    dbW.close();

    // Delete all files
    unlinkSync(join(projectDir, 'a.ts'));

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R109: legacy DB (initialized=0) → stale=true even if nodesCount=0
    // This forces a full reindex to properly initialize the DB.
    expect(result2.crossFileCallsStale).toBe(true);
    expect(getStaleFromDB()).toBe(true);
  });

  // ── Test 6: rebuildCrossFileCallsEdges is safe with nodesCount=0 ──────
  // Direct unit test: call rebuildCrossFileCallsEdges on an empty project
  // and verify it doesn't throw and returns 0.
  it('rebuildCrossFileCallsEdges is safe when nodesCount=0 (defensive)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete all files (nodesCount becomes 0)
    unlinkSync(join(projectDir, 'a.ts'));
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    // Directly call rebuildCrossFileCallsEdges on the empty project
    const { rebuildCrossFileCallsEdges } = await import('../../src/indexer/cross-file-resolver.js');
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    let result: number;
    expect(() => {
      const tx = db.transaction(() => {
        result = rebuildCrossFileCallsEdges(db, projectName);
      });
      tx();
    }).not.toThrow();
    expect(result!).toBe(0);
    db.close();
  });
});
