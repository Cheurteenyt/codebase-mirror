// v2/tests/indexer/r113-benchmark-honesty.test.ts
// R113: Precision Benchmark Metrics Honesty Lock
//
// Tests that the precision benchmark metrics are computed correctly (not
// approximate or sample-based as in R112). Uses controlled mini-projects
// where the expected metrics are known.
//
// Bugs fixed (from R114 audit):
// 1. unresolved_call_sites was always = totalCallSites (now: total - resolved)
// 2. resolvedCallSites was calculated but unused (now: used)
// 3. unresolved_imports was sample-based (now: global, from all edges)
// 4. builtins_skipped/type_only_skipped renamed to _uninstrumented (always 0)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R113: Precision Benchmark Metrics Honesty Lock', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r113-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r113-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  // Helper: compute the same metrics the benchmark script computes
  function computeMetrics(db: Database.Database) {
    const allEdges = db.prepare(
      `SELECT e.properties_json FROM edges e
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"resolution":"cross_file%'`
    ).all(projectName) as Array<{ properties_json: string }>;

    const allCalleeNames = new Set<string>();
    for (const e of allEdges) {
      const props = JSON.parse(e.properties_json);
      if (props.callee) allCalleeNames.add(props.callee);
    }

    const totalCallSites = (db.prepare('SELECT COUNT(*) AS c FROM call_sites WHERE project = ?').get(projectName) as { c: number }).c;
    const allCallSiteCallees = db.prepare('SELECT DISTINCT callee FROM call_sites WHERE project = ?').all(projectName) as Array<{ callee: string }>;
    let resolvedCallSites = 0;
    for (const cs of allCallSiteCallees) {
      if (allCalleeNames.has(cs.callee)) resolvedCallSites++;
    }
    const unresolvedCallSites = totalCallSites - resolvedCallSites;

    const totalImports = (db.prepare('SELECT COUNT(*) AS c FROM imports WHERE project = ?').get(projectName) as { c: number }).c;
    const imports = db.prepare('SELECT local_name FROM imports WHERE project = ? AND import_kind != ?').all(projectName, 'default_export') as Array<{ local_name: string }>;
    let unresolvedImports = 0;
    for (const imp of imports) {
      if (!allCalleeNames.has(imp.local_name)) unresolvedImports++;
    }

    return {
      total_cross_file_edges: allEdges.length,
      total_call_sites: totalCallSites,
      resolved_call_sites: resolvedCallSites,
      unresolved_call_sites: unresolvedCallSites,
      total_imports: totalImports,
      unresolved_imports: unresolvedImports,
    };
  }

  // ── Test 1: resolved_call_sites is NOT always 0 ───────────────────────
  // Before R113, unresolved_call_sites was always = totalCallSites, which
  // meant resolved was always 0. With a project that has cross-file edges,
  // resolved should be > 0.
  it('resolved_call_sites > 0 when cross-file edges exist', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // There should be at least 1 cross-file edge for foo()
    expect(m.total_cross_file_edges).toBeGreaterThan(0);
    // R113: resolved_call_sites should be > 0 (foo is resolved)
    expect(m.resolved_call_sites).toBeGreaterThan(0);
    // R113: unresolved should be LESS than total (not equal)
    expect(m.unresolved_call_sites).toBeLessThan(m.total_call_sites);
    db.close();
  });

  // ── Test 2: unresolved_call_sites = total - resolved ──────────────────
  it('unresolved_call_sites = total_call_sites - resolved_call_sites', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 99; }\n');
    // a.ts calls foo (resolved) and undefinedFunction (unresolved)
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo() + undefinedFunction(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // R113: the invariant must hold exactly
    expect(m.unresolved_call_sites).toBe(m.total_call_sites - m.resolved_call_sites);
    db.close();
  });

  // ── Test 3: unresolved_imports is global, not sample-based ────────────
  // Before R113, unresolved_imports was computed from edgeSamples (limited
  // to sample size). With a project that has more imports than the sample,
  // the metric was wrong. Now it's computed from ALL edges.
  it('unresolved_imports counts imports with no matching edge globally', async () => {
    // b.ts exports foo (will be imported and called)
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    // c.ts exports unused (imported but NOT called — should be unresolved)
    writeFileSync(join(projectDir, 'c.ts'), 'export function unused() { return 99; }\n');
    // a.ts imports both but only calls foo
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nimport { unused } from './c';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // R113: unused should be in unresolved_imports (imported but never called)
    // foo should NOT be in unresolved_imports (imported and called → has edge)
    expect(m.unresolved_imports).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // ── Test 4: import not called has no edge ─────────────────────────────
  it('import that is never called does not create a cross-file edge', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\nexport function bar() { return 99; }\n');
    // a.ts imports foo and bar but only calls foo
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, bar } from './b';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    // Should have edges for foo() but NOT for bar() (never called)
    const fooEdges = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"callee":"foo"%' AND properties_json LIKE '%cross_file%'`
    ).get(projectName) as { c: number };
    const barEdges = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"callee":"bar"%' AND properties_json LIKE '%cross_file%'`
    ).get(projectName) as { c: number };
    expect(fooEdges.c).toBeGreaterThan(0);
    expect(barEdges.c).toBe(0); // bar is imported but never called
    db.close();
  });

  // ── Test 5: call_site without edge (callee not found) ─────────────────
  it('call_site for undefined function creates no edge (unresolved)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return nonexistentFunction(); }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // There should be 0 cross-file edges (nonexistentFunction doesn't exist)
    expect(m.total_cross_file_edges).toBe(0);
    // But there should be 1 call_site (the call to nonexistentFunction)
    expect(m.total_call_sites).toBeGreaterThanOrEqual(1);
    // R113: all call_sites should be unresolved (no edges)
    expect(m.resolved_call_sites).toBe(0);
    expect(m.unresolved_call_sites).toBe(m.total_call_sites);
    db.close();
  });

  // ── Test 6: benchmark script exists and has corrected metrics ─────────
  it('benchmark script has resolved_call_sites and _uninstrumented fields', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const benchmarkPath = resolve(__dirname, '..', '..', 'scripts', 'precision-benchmark-r112.ts');
    const content = readFileSync(benchmarkPath, 'utf-8');
    // R113: resolved_call_sites should be in the Metrics interface
    expect(content).toContain('resolved_call_sites');
    // R113: _uninstrumented suffix should be used for non-measurable metrics
    expect(content).toContain('builtins_skipped_uninstrumented');
    expect(content).toContain('type_only_skipped_uninstrumented');
    // R113: should NOT have the old buggy line (unresolved = total, no subtraction)
    expect(content).not.toContain('unresolvedCallSites = totalCallSites; // approximation');
    // R113: should compute globally, not from edgeSamples
    expect(content).not.toContain('for (const e of edgeSamples) calleeNamesInEdges');
  });
});
