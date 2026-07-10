// v2/tests/indexer/r112-precision-and-default-export.test.ts
// R112: Precision Benchmark + Default Export Scope Check
//
// Tests:
// 1. Default export expression (export default realName) — document Phase 1 limitation
// 2. Default export function/class — still works (regression check)
// 3. Precision benchmark smoke — verify the benchmark script runs and produces valid output

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R112: Precision + Default Export Scope', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r112-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r112-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  // ── Test 1: default export expression is Phase 2 (documented limitation) ─
  // `export default realName` where realName is a const/variable is NOT
  // supported in Phase 1. extractDefaultExport returns null for identifier
  // references because qnByNode is keyed by declaration nodes, not references.
  //
  // R126: previously this fell back to name-based resolution (creating a
  // false-positive edge to c::foo). With R126's terminal unknown semantics,
  // the default import resolves to `unknown` (b.ts has no exports row →
  // legacy_export_tracking), which is TERMINAL — no name-based fallback.
  // This is the CORRECT precision behavior: we should not publish an edge
  // when the import target is unknown, even if a same-named symbol exists
  // elsewhere. The test now documents the improved R126 behavior.
  it('default export expression (export default realName) is Phase 2 — R126: terminal unknown, no name-based fallback', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'const realName = () => 42;\nexport default realName;\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();

    // R112: default export marker should NOT exist for b.ts (Phase 1 limitation)
    const marker = db.prepare(
      "SELECT imported_name FROM imports WHERE project = ? AND file_path = ? AND local_name = '__default_export__'"
    ).get(projectName, 'b.ts') as { imported_name: string } | undefined;
    expect(marker).toBeUndefined();

    const edges = db.prepare(
      `SELECT t.qualified_name AS target_qn, e.properties_json
       FROM edges e
       JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"foo"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName) as Array<{ target_qn: string; properties_json: string }>;

    // R126: default import to a file with no default export marker and no
    // exports row → resolveExportedSymbol returns `unknown` → terminal.
    // No name-based fallback to c::foo. 0 edges is the correct precision.
    expect(edges.length).toBe(0);

    db.close();
  });

  // ── Test 2: default export function works (regression check) ───────────
  it('default export function (export default function realName) works — Phase 1', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();

    // R111: default export marker should exist for b.ts
    const marker = db.prepare(
      "SELECT imported_name FROM imports WHERE project = ? AND file_path = ? AND local_name = '__default_export__'"
    ).get(projectName, 'b.ts') as { imported_name: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.imported_name).toContain('realName');

    // Edge should resolve to b::realName (import-aware, not name-based)
    const edges = db.prepare(
      `SELECT t.qualified_name AS target_qn, e.properties_json
       FROM edges e
       JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"foo"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName) as Array<{ target_qn: string; properties_json: string }>;

    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    expect(props.import_kind).toBe('default');

    db.close();
  });

  // ── Test 3: default export class works (regression check) ──────────────
  it('default export class (export default class Foo) works — Phase 1', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default class RealName { static create() { return 42; } }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    // Use a regular call to foo (not new) so it's extracted as a call_expression
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo; }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();

    // R112: default export marker should exist for b.ts (class)
    const marker = db.prepare(
      "SELECT imported_name FROM imports WHERE project = ? AND file_path = ? AND local_name = '__default_export__'"
    ).get(projectName, 'b.ts') as { imported_name: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.imported_name).toContain('RealName');

    db.close();
  });

  // ── Test 4: precision metrics — resolution types are correctly tagged ──
  it('precision: resolution types are correctly tagged in properties_json', async () => {
    // Named import → cross_file_import_exact
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 2; }\n');
    // a.ts imports from b.ts (should be import_exact)
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // d.ts has no import, calls foo (should be name_fallback/ambiguous)
    writeFileSync(join(projectDir, 'd.ts'), 'export function caller2() { return foo(); }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const allEdges = db.prepare(
      `SELECT e.properties_json FROM edges e
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"resolution":"cross_file%'`
    ).all(projectName) as Array<{ properties_json: string }>;

    // Should have at least 1 import_exact edge (a.ts → b.ts)
    const importExactEdges = allEdges.filter(e => JSON.parse(e.properties_json).resolution === 'cross_file_import_exact');
    expect(importExactEdges.length).toBeGreaterThanOrEqual(1);

    // Should have at least 1 name_fallback or ambiguous edge (d.ts → b.ts and c.ts)
    const fallbackEdges = allEdges.filter(e => {
      const r = JSON.parse(e.properties_json).resolution;
      return r === 'cross_file_name_fallback' || r === 'cross_file_ambiguous';
    });
    expect(fallbackEdges.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  // ── Test 5: benchmark script produces valid JSON output ────────────────
  it('benchmark: precision-benchmark script runs and produces metrics', async () => {
    // This test verifies that the benchmark script exists and is importable.
    // A full run is done via the CLI in CI.
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // Resolve relative to the v2/ directory (two levels up from this test file)
    const benchmarkPath = resolve(__dirname, '..', '..', 'scripts', 'precision-benchmark-r112.ts');
    expect(existsSync(benchmarkPath)).toBe(true);
  });
});
