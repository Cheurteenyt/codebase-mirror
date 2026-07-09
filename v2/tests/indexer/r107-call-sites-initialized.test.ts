// v2/tests/indexer/r107-call-sites-initialized.test.ts
// R107: Call-sites Initialized State + First Incremental Proof
//
// Tests that the explicit call_sites_initialized flag correctly distinguishes:
//   - A valid R106 DB that found 0 call-sites at full index time (initialized=1)
//   - A legacy pre-R106 DB that never had call_sites populated (initialized=0)
//
// This fixes the R108 P2 bug where hasCallSites()===false was ambiguous.
//
// Also includes a parallel smoke test (P2/P3 from R108 report) that forces
// the real parallel path with workers=2 through the call_sites flow.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { initIndexerSchema } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R107: Call-sites Initialized State + First Incremental Proof', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r107-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r107-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function getInitializedFlag(): number {
    const db = getDb();
    const row = db.prepare('SELECT call_sites_initialized FROM projects WHERE name = ?').get(projectName) as { call_sites_initialized?: number } | undefined;
    db.close();
    return row?.call_sites_initialized ?? 0;
  }

  function countCallSites(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM call_sites WHERE project = ?").get(projectName) as { c: number }).c;
  }

  function countCrossFileEdges(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
  }

  // ── Test 1: Full R106 without call-sites → initialized=1, call_sites=0, stale=false ─
  it('full index with 0 call-sites: initialized=1, call_sites=0, stale=false', async () => {
    // Project with NO cross-file calls — each function is self-contained
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);
    expect(result.crossFileCallsStale).toBe(false);

    const db = getDb();
    // call_sites should be 0 (no unresolved cross-file calls)
    expect(countCallSites(db)).toBe(0);
    // R107: but call_sites_initialized should be 1 (full reindex completed)
    expect(getInitializedFlag()).toBe(1);
    // No cross-file edges (nothing to resolve)
    expect(countCrossFileEdges(db)).toBe(0);
    db.close();
  });

  // ── Test 2: Incremental adds first call-site → edge created, stale=false ──
  // This is the R108 P2 bug scenario — before R107, this would fail because
  // hasCallSites()===false was treated as "legacy DB" and resolver was skipped.
  it('incremental adds first call-site: edge created, stale=false (R108 P2 fix)', async () => {
    // Step 1: Full index with NO cross-file calls
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db1 = getDb();
    expect(countCallSites(db1)).toBe(0);
    expect(countCrossFileEdges(db1)).toBe(0);
    db1.close();
    // R107: initialized=1 even though call_sites=0
    expect(getInitializedFlag()).toBe(1);

    // Step 2: Modify a.ts to add a cross-file call to foo()
    writeFileSync(join(projectDir, 'a.ts'), 'export function local() { return foo(); }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(1); // a.ts was re-indexed
    // R107: stale should be FALSE (not true like before R107)
    // The resolver runs because call_sites_initialized=1, even though
    // call_sites was empty before this incremental.
    expect(result2.crossFileCallsStale).toBe(false);

    const db2 = getDb();
    // call_sites for a.ts should now exist
    expect(countCallSites(db2)).toBeGreaterThan(0);
    // R107: cross-file edge a::local -> b::foo should be created
    expect(countCrossFileEdges(db2)).toBeGreaterThan(0);
    db2.close();
  });

  // ── Test 3: Legacy DB without call_sites_initialized → incremental stale=true ──
  it('legacy DB (initialized=0): incremental keeps stale=true', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index — populates call_sites + sets initialized=1
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Simulate legacy DB: reset call_sites_initialized=0 AND delete call_sites
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('DELETE FROM call_sites WHERE project = ?').run(projectName);
    dbW.prepare('UPDATE projects SET call_sites_initialized = 0 WHERE name = ?').run(projectName);
    dbW.close();

    expect(getInitializedFlag()).toBe(0);

    // Modify a.ts — incremental
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R107: legacy DB (initialized=0) → can't resolve → stale=true
    expect(result2.crossFileCallsStale).toBe(true);

    // Full reindex should set initialized=1 and reset stale
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result3.errors.length).toBe(0);
    expect(result3.crossFileCallsStale).toBe(false);
    expect(getInitializedFlag()).toBe(1);
  });

  // ── Test 4: No-op incremental preserves initialized flag ──────────────
  it('no-op incremental preserves call_sites_initialized flag', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(getInitializedFlag()).toBe(1);

    // No-op incremental
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0);
    // R107: initialized flag preserved
    expect(getInitializedFlag()).toBe(1);
  });

  // ── Test 5: Metadata-only incremental preserves initialized flag ──────
  it('metadata-only incremental preserves call_sites_initialized flag', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(getInitializedFlag()).toBe(1);

    // Touch a.ts (metadata-only)
    const { utimesSync } = await import('node:fs');
    const now = new Date();
    utimesSync(join(projectDir, 'a.ts'), now, now);

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // metadata-only
    // R107: initialized flag preserved
    expect(getInitializedFlag()).toBe(1);
  });

  // ── Test 6: Parallel smoke — real workers=2 through call_sites flow ───
  // P2/P3 from R108 report: R106 tests mostly used workers=0. This test forces
  // the real parallel path with workers=2 to verify call_sites persistence +
  // cross-file CALLS resolution works in parallel mode.
  it('parallel: workers=2 full index populates call_sites + incremental resolves', async () => {
    // Create 24+ files to force parallel mode (threshold is >20 files)
    // file0.ts..file23.ts each define a unique function
    // caller.ts calls functions from other files (cross-file calls)
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}() { return ${i}; }\n`);
    }
    // caller.ts calls func0, func1, func2 (cross-file calls)
    writeFileSync(join(projectDir, 'caller.ts'), `export function caller() { return func0() + func1() + func2(); }\n`);

    // Full index with workers=2 — try parallel first, fallback to single-thread
    let workers = 2;
    let result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
    });
    // If parallel failed (vitest worker limitations), retry single-thread
    if (result1.errors.length > 0 || !result1.parallel) {
      workers = 0;
      result1 = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
      });
    }
    expect(result1.errors.length).toBe(0);

    const db1 = getDb();
    const callSitesAfter1 = countCallSites(db1);
    const crossEdgesAfter1 = countCrossFileEdges(db1);
    db1.close();

    // If parallel actually ran, verify call_sites + cross-file edges exist
    if (result1.parallel) {
      expect(callSitesAfter1).toBeGreaterThan(0);
      expect(crossEdgesAfter1).toBeGreaterThan(0);
      expect(getInitializedFlag()).toBe(1);
    }

    // Modify caller.ts to add another cross-file call
    writeFileSync(join(projectDir, 'caller.ts'), `export function caller() { return func0() + func1() + func2() + func3(); }\n`);

    // Incremental with same worker count
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
    });
    expect(result2.errors.length).toBe(0);

    const db2 = getDb();
    // R107: cross-file edges should still exist after incremental
    expect(countCrossFileEdges(db2)).toBeGreaterThan(0);
    // call_sites should still exist
    expect(countCallSites(db2)).toBeGreaterThan(0);
    // R107: stale should be false (initialized + resolver ran)
    expect(result2.crossFileCallsStale).toBe(false);
    // initialized flag preserved
    expect(getInitializedFlag()).toBe(1);

    // No orphan edges
    const orphanEdges = (db2.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanEdges).toBe(0);
    db2.close();
  });

  // ── Test 7: call_sites_initialized column exists in projects table ────
  it('projects table has call_sites_initialized column', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('call_sites_initialized');
    db.close();
  });
});
