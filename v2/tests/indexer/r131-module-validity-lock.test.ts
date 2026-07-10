// v2/tests/indexer/r131-module-validity-lock.test.ts
// R131: Module Validity Lock — global duplicate detection, default marker
// collision, star source preflight, extractor dedup removal
//
// Tests the R131 fixes for:
//   - IDX-R131-01: collision on ANY name invalidates ALL imports from the module
//   - IDX-R131-02: direct declaration + export clause no longer deduplicated
//   - IDX-R131-03: default marker + default binding collision detected
//   - IDX-R131-04: unresolved star source invalidates the module
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R131: Module Validity Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r131-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r131-${Date.now()}`;
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

  // ── IDX-R131-01: Collision on ANY name invalidates ALL imports ──────────

  it('duplicate on bar → import of foo also 0 edges (global invalidity)', async () => {
    writeFileSync(join(projectDir, 'b.ts'),
      `export function foo() { return 1; }\n` +
      `export function bar() { return 2; }\n`
    );
    writeFileSync(join(projectDir, 'c.ts'), `export function bar() { return 3; }\n`);
    writeFileSync(join(projectDir, 'index.ts'),
      `export { foo } from './b';\n` +
      `export { bar } from './b';\n` +
      `export { bar } from './c';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: bar has a duplicate → the ENTIRE module is invalid.
    // Even though foo has only one binding, ESM rejects the module.
    // 0 edges for foo.
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── IDX-R131-02: Direct declaration + export clause ─────────────────────
  // (already tested in R130 file, but verified here too)

  it('export function foo() + export { foo } → 0 edges (ESM Duplicate)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function foo() { return 1; }\n` +
      `export { foo };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── IDX-R131-02 positive: export default function foo() + export { foo } ─
  // This IS valid ESM (exported names are 'default' and 'foo' — distinct).

  it('export default function foo() + export { foo } → 1 edge (valid ESM)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default function foo() { return 1; }\n` +
      `export { foo };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: 'default' and 'foo' are distinct exported names → valid ESM.
    // The named import { foo } should resolve to index.ts::foo.
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    db.close();
  });

  // ── IDX-R131-03: Default marker + default binding collision ─────────────

  it('export default function foo() + export { foo as default } → 0 edges (Duplicate default)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default function foo() { return 1; }\n` +
      `export { foo as default };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: both a default marker AND a default binding exist → Duplicate
    // export of 'default'. 0 edges.
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  it('export default function local() + export { default } from "./b" → 0 edges', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function bFn() { return 1; }\n`);
    writeFileSync(join(projectDir, 'index.ts'),
      `export default function local() { return 2; }\n` +
      `export { default } from './b';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: default marker (from `export default function local`) + default
    // binding (from `export { default } from './b'`) → Duplicate default.
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  // ── IDX-R131-04: Unresolved star source invalidates module ──────────────

  it('named export + export * from missing → 0 edges (ERR_MODULE_NOT_FOUND)', async () => {
    writeFileSync(join(projectDir, 'good.ts'), `export function foo() { return 1; }\n`);
    writeFileSync(join(projectDir, 'index.ts'),
      `export { foo } from './good';\n` +
      `export * from './missing';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: star source './missing' is unresolved → ESM ERR_MODULE_NOT_FOUND.
    // Even though foo is available via named re-export, the module is invalid.
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── IDX-R131-04 positive: named export + export * from valid source ─────

  it('named export + export * from valid source → 1 edge (valid module)', async () => {
    writeFileSync(join(projectDir, 'good.ts'), `export function foo() { return 1; }\n`);
    writeFileSync(join(projectDir, 'other.ts'), `export function bar() { return 2; }\n`);
    writeFileSync(join(projectDir, 'index.ts'),
      `export { foo } from './good';\n` +
      `export * from './other';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R131: all sources resolve → valid module. foo resolves via named re-export.
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('good.ts');
    db.close();
  });

  // ── Positive control: valid module with single export ───────────────────

  it('valid module with single export → 1 edge (positive control)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export function foo() { return 42; }\n`);
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    db.close();
  });

  // ── Semantics version bump ──────────────────────────────────────────────

  it('full reindex sets extractor_semantics_version=CURRENT (R131/R132 bump)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
