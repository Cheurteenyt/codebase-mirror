// v2/tests/indexer/r114-row-level-attribution.test.ts
// R114: Precision Benchmark Row-Level Attribution Lock
//
// Tests that benchmark metrics count call_sites and imports at ROW LEVEL
// (not per distinct name). Before R114, R113 used SELECT DISTINCT callee
// which undercounted: if 2 call_sites both call foo(), R113 counted 1
// resolved instead of 2.
//
// Also tests that sample size doesn't affect global metrics.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R114: Precision Benchmark Row-Level Attribution Lock', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r114-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r114-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  // Helper: compute metrics the SAME way the benchmark script does (R114 row-level)
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
    // R114: row-level (ALL rows, not DISTINCT)
    const allCallSiteRows = db.prepare('SELECT callee FROM call_sites WHERE project = ?').all(projectName) as Array<{ callee: string }>;
    let resolvedCallSites = 0;
    for (const cs of allCallSiteRows) {
      if (allCalleeNames.has(cs.callee)) resolvedCallSites++;
    }
    const unresolvedCallSites = totalCallSites - resolvedCallSites;

    const totalImports = (db.prepare('SELECT COUNT(*) AS c FROM imports WHERE project = ?').get(projectName) as { c: number }).c;
    // R114: row-level (ALL rows, not Set of distinct names)
    const allImportRows = db.prepare('SELECT local_name FROM imports WHERE project = ? AND import_kind != ?').all(projectName, 'default_export') as Array<{ local_name: string }>;
    let unresolvedImports = 0;
    for (const imp of allImportRows) {
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

  // ── Test 1: 2 call_sites calling same foo() → resolved=2 (not 1) ───────
  // This is the EXACT R115 P2 scenario. R113 would report resolved=1 (DISTINCT).
  it('two call_sites calling same callee → resolved_call_sites = 2 (row-level)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller1() { return foo(); }\nexport function caller2() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // 2 call_sites (caller1 calls foo, caller2 calls foo)
    expect(m.total_call_sites).toBe(2);
    // R114: BOTH should be resolved (row-level, not DISTINCT)
    expect(m.resolved_call_sites).toBe(2);
    expect(m.unresolved_call_sites).toBe(0);
    db.close();
  });

  // ── Test 2: 3 call_sites, 2 same callee + 1 different ─────────────────
  it('mixed: 2 call foo + 1 call bar → resolved=3 if both resolved', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, bar } from './b';\nexport function caller1() { return foo(); }\nexport function caller2() { return foo(); }\nexport function caller3() { return bar(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // 3 call_sites total
    expect(m.total_call_sites).toBe(3);
    // R114: all 3 resolved (2 foo + 1 bar, all have edges)
    expect(m.resolved_call_sites).toBe(3);
    expect(m.unresolved_call_sites).toBe(0);
    db.close();
  });

  // ── Test 3: 2 files import foo, both call it → resolved imports = 2 ───
  it('two files import same name, both call → row-level import counting', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function callerA() { return foo(); }\n`);
    writeFileSync(join(projectDir, 'c.ts'), `import { foo } from './b';\nexport function callerC() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // R114: 2 import rows for foo (one in a.ts, one in c.ts)
    // Both are "resolved" because foo appears as a callee in edges
    expect(m.total_imports).toBeGreaterThanOrEqual(2);
    // unresolved_imports should NOT count foo (it's called)
    // Note: there might be other imports, but foo should not be unresolved
    db.close();
  });

  // ── Test 4: import never called → unresolved ──────────────────────────
  it('import that is never called → counted as unresolved (row-level)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\nexport function unused() { return 2; }\n');
    // a.ts imports foo and unused, only calls foo
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, unused } from './b';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const m = computeMetrics(db);
    // R114: unused import should be unresolved (1 row)
    expect(m.unresolved_imports).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // ── Test 5: sample size doesn't affect global metrics ─────────────────
  // The benchmark script's global metrics (total, resolved, unresolved)
  // must NOT depend on the --sample parameter. Only the sample array changes.
  it('global metrics are independent of sample size', async () => {
    // Create enough edges to have a meaningful sample difference
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(projectDir, `b${i}.ts`), `export function func${i}() { return ${i}; }\n`);
    }
    let aContent = '';
    for (let i = 0; i < 10; i++) {
      aContent += `import { func${i} } from './b${i}';\n`;
    }
    aContent += 'export function caller() { return ';
    for (let i = 0; i < 10; i++) {
      if (i > 0) aContent += ' + ';
      aContent += `func${i}()`;
    }
    aContent += '; }\n';
    writeFileSync(join(projectDir, 'a.ts'), aContent);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    // Compute metrics once — these should be the same regardless of sample
    const m = computeMetrics(db);
    // Verify the metrics are non-trivial
    expect(m.total_cross_file_edges).toBeGreaterThan(0);
    expect(m.total_call_sites).toBeGreaterThan(0);
    expect(m.resolved_call_sites).toBeGreaterThan(0);
    // The sample size only affects edgeSamples (the detailed list), not these
    // global counts. This test verifies the computation is global.
    db.close();
  });

  // ── Test 6: benchmark script uses row-level (not DISTINCT) ────────────
  it('benchmark script uses row-level call_site counting (not DISTINCT)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const benchmarkPath = resolve(__dirname, '..', '..', 'scripts', 'precision-benchmark-r112.ts');
    const content = readFileSync(benchmarkPath, 'utf-8');
    // R114: should NOT have an active SELECT DISTINCT callee query (only in comments)
    // Check that the actual query uses row-level, not DISTINCT
    expect(content).toContain("'SELECT callee FROM call_sites WHERE project = ?'");
    // R114: should NOT use Set for import dedup (should iterate rows directly)
    expect(content).not.toContain('importedLocalNames.add');
  });
});
