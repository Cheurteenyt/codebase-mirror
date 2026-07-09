// v2/tests/indexer/r108-stale-complete-precision.test.ts
// R108: Call-sites Empty Initialized Precision Lock
//
// Tests that a project with call_sites_initialized=1 and call_sites=0 is
// treated as a COMPLETE state (stale=false) even when files change.
//
// This fixes the R109 P2 bug where:
//   - Full index with 0 call-sites → initialized=1, call_sites=0, stale=false
//   - Modify a.ts (content change, still no call-sites) → incremental
//   - Before R108: stale=true (false positive — graph is complete)
//   - After R108: stale=false (correct — no cross-file calls to resolve)
//
// Also tests that stale cross-file edges are cleaned up when call_sites
// becomes empty after a change (e.g., removing the last cross-file call).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R108: Call-sites Empty Initialized Precision Lock', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r108-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r108-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function countCallSites(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM call_sites WHERE project = ?").get(projectName) as { c: number }).c;
  }

  function countCrossFileEdges(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
  }

  function getStaleFromDB(): boolean {
    const db = getDb();
    const row = db.prepare('SELECT cross_file_calls_stale FROM projects WHERE name = ?').get(projectName) as { cross_file_calls_stale?: number } | undefined;
    db.close();
    return row?.cross_file_calls_stale === 1;
  }

  // ── Test 1: content change with initialized+empty call_sites stays stale=false ─
  // This is the exact R109 P2 scenario.
  it('incremental content change with initialized empty call_sites stays stale=false', async () => {
    // Step 1: Full index on project with NO cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function other() { return 2; }\n');

    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);

    const db1 = getDb();
    expect(countCallSites(db1)).toBe(0);
    expect(countCrossFileEdges(db1)).toBe(0);
    db1.close();

    // Step 2: Modify a.ts WITHOUT adding any call-site (just change return value)
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 10; }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(1); // a.ts was re-indexed
    // R108: stale must be FALSE — the graph is complete (no cross-file calls to resolve)
    // Before R108, this was true (false positive).
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    const db2 = getDb();
    expect(countCallSites(db2)).toBe(0);
    expect(countCrossFileEdges(db2)).toBe(0);
    db2.close();
  });

  // ── Test 2: cross-file edges cleaned up when call_sites becomes empty ──
  // Scenario: project has cross-file calls, then a.ts is modified to REMOVE
  // all cross-file calls. The old cross-file edges must be cleaned up.
  it('incremental removing all cross-file calls cleans up edges, stale=false', async () => {
    // Step 1: Full index WITH cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);

    const db1 = getDb();
    expect(countCallSites(db1)).toBeGreaterThan(0);
    expect(countCrossFileEdges(db1)).toBeGreaterThan(0);
    db1.close();

    // Step 2: Modify a.ts to REMOVE the cross-file call
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return 1; }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(1);
    // R108: stale must be FALSE — the graph is complete (resolver ran, cleaned up)
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    const db2 = getDb();
    // call_sites for a.ts should be 0 now (no cross-file calls in new content)
    // call_sites for b.ts is still 0 (b.ts never had cross-file calls)
    expect(countCallSites(db2)).toBe(0);
    // R108: cross-file edges must be cleaned up (rebuildCrossFileCallsEdges
    // deletes all old cross-file edges, then inserts 0 new ones)
    expect(countCrossFileEdges(db2)).toBe(0);
    db2.close();
  });

  // ── Test 3: content change with initialized + non-empty call_sites → stale=false ──
  // Sanity check: the normal case (has call-sites, content changes) still works.
  it('incremental content change with initialized non-empty call_sites stays stale=false', async () => {
    // Full index with cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify a.ts — still has cross-file call to foo()
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(1);
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    const db = getDb();
    expect(countCallSites(db)).toBeGreaterThan(0);
    expect(countCrossFileEdges(db)).toBeGreaterThan(0);
    db.close();
  });

  // ── Test 4: no-op incremental after initialized+empty stays stale=false ──
  it('no-op incremental after initialized empty call_sites stays stale=false', async () => {
    // Full index with no cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // No-op incremental (no changes)
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0);
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });

  // ── Test 5: deletion-only with initialized+empty stays stale=false ─────
  it('deletion-only with initialized empty call_sites stays stale=false', async () => {
    // Full index with no cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function other() { return 2; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete b.ts (deletion-only: no other files changed)
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(projectDir, 'b.ts'));

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // deletion-only fast path
    // R108: stale must be FALSE — graph is complete (no cross-file calls)
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });

  // ── Test 6: transition from cross-file calls to no cross-file calls ────
  // Full lifecycle: empty → add calls → remove calls → empty
  it('lifecycle: empty → add calls → remove calls → empty, stale always false', async () => {
    // Step 1: Full index, no cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    const r1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(r1.crossFileCallsStale).toBe(false);

    // Step 2: Add cross-file call
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return foo(); }\n');
    const r2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(r2.crossFileCallsStale).toBe(false);
    const db2 = getDb();
    expect(countCrossFileEdges(db2)).toBeGreaterThan(0);
    db2.close();

    // Step 3: Remove cross-file call
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    const r3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(r3.crossFileCallsStale).toBe(false);
    const db3 = getDb();
    expect(countCrossFileEdges(db3)).toBe(0); // cleaned up
    db3.close();

    // Step 4: No-op incremental — stale stays false
    const r4 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(r4.crossFileCallsStale).toBe(false);
  });

  // ── Test 7: legacy DB (initialized=0) + content change → stale=true ────
  // Sanity check: legacy DBs still get stale=true (forces full reindex)
  it('legacy DB (initialized=0) + content change → stale=true (unchanged by R108)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index — sets initialized=1
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Simulate legacy DB: reset initialized=0 + delete call_sites
    const { initIndexerSchema } = await import('../../src/indexer/schema.js');
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('DELETE FROM call_sites WHERE project = ?').run(projectName);
    dbW.prepare('UPDATE projects SET call_sites_initialized = 0 WHERE name = ?').run(projectName);
    dbW.close();

    // Modify a.ts — incremental
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R108: legacy DB still gets stale=true (forces full reindex)
    expect(result2.crossFileCallsStale).toBe(true);
    expect(getStaleFromDB()).toBe(true);
  });
});
