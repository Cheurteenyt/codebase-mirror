// v2/tests/indexer/r133-type-value-default-lock.test.ts
// R133: Type/Value Default Lock + Test Fix
//
// Tests the R133 fixes for:
//   - IDX-R133-02: default interface + default function (valid TS, was false invalid)
//   - IDX-R133-03: interface merging (valid TS, was false invalid)
//   - IDX-R133-04: type default + value alias default (valid TS, was false invalid)
//   - TEST-R133-01: some-package test corrected to use node:fs builtin
//   - Semantics version bump v3→v4
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R133: Type/Value Default Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r133-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r133-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) {
    return db.prepare(
      `SELECT t.qualified_name AS target_qn, e.properties_json
       FROM edges e
       JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"' || ? || '"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>;
  }

  // ── IDX-R133-02: default interface + default function ───────────────────
  // TypeScript allows this — interface is type-only, function is runtime.
  // R132 counted both → false invalid_duplicate_export.

  it('export default interface + export default function → 1 edge (valid TS, IDX-R133-02)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default interface Shape { x: number }\n` +
      `export default function make() { return 1 }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R133: interface is type-only (count=0 for interface), function is runtime (count=1).
    // Total runtime count = 1 → NOT a duplicate. The default import should resolve.
    const edges = getEdges(db, 'value');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    expect(edges[0].target_qn).toContain('make');
    db.close();
  });

  // ── IDX-R133-03: interface merging ──────────────────────────────────────
  // Two `export default interface Shape` are valid TS (interfaces merge).

  it('two export default interfaces (merging) + local export → 1 edge (IDX-R133-03)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default interface Shape { x: number }\n` +
      `export default interface Shape { y: number }\n` +
      `export function local() { return 1 }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R133: both interfaces are type-only (count=0 each). No runtime default
    // collision. local should resolve normally.
    const edges = getEdges(db, 'local');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    db.close();
  });

  // ── IDX-R133-04: type default + value alias default ─────────────────────
  // `export default interface` + `export { make as default }` is valid TS.

  it('export default interface + export { make as default } → 1 edge (IDX-R133-04)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default interface Shape { x: number }\n` +
      `function make() { return 1 }\n` +
      `export { make as default };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R133: interface is type-only (count=0). `export { make as default }` is
    // a binding with exportedName='default'. count=0 → no collision with binding.
    // The default import resolves via the binding → make.
    const edges = getEdges(db, 'value');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    expect(edges[0].target_qn).toContain('make');
    db.close();
  });

  // ── Positive control: two runtime defaults still invalid ────────────────
  // This was fixed in R132 and must still work after R133.

  it('two export default functions → 0 edges (runtime duplicate, IDX-R132-06 preserved)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default function a() { return 1; }\n` +
      `export default function b() { return 2; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R133: both are runtime defaults (count=2) → invalid_duplicate_export.
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  // ── Positive control: single default function ───────────────────────────

  it('single export default function → 1 edge (positive control)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    db.close();
  });

  // ── Semantics version bump v4 ───────────────────────────────────────────

  it('full reindex sets extractor_semantics_version=4 (R133 bump)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
