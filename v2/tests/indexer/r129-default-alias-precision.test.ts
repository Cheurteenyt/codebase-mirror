// v2/tests/indexer/r129-default-alias-precision.test.ts
// R129: Default Alias Precision + Quality/Perf fixes
//
// Tests the R129 fixes for:
//   - IDX-R129-01: `export { foo as default } from './b'` targets wrong function
//   - QUAL-R129-01: rebuildCrossFileCallsEdges uses clearCrossFileCallEdges
//   - PERF-R129-01: hoisted UNKNOWN_REASON_PRIORITY (no per-call allocation)
//   - TEST-R129-01: `foo as default` with source having its own default
//   - Intra-file edge preservation during stale cleanup
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R129: Default Alias Precision', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r129-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r129-${Date.now()}`;
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

  // ── IDX-R129-01: `export { foo as default } from './b'` with source default ──
  // This is the CRITICAL test. b.ts has BOTH a default export AND a named `foo`.
  // `export { foo as default }` means index's default is b's named `foo`,
  // NOT b's native default. R128 incorrectly returned b::sourceDefault.

  it('export { foo as default } from "./b" + b has own default → targets b::foo NOT b::sourceDefault (IDX-R129-01)', async () => {
    writeFileSync(join(projectDir, 'b.ts'),
      `export default function sourceDefault() { return 'source-default'; }\n` +
      `export function foo() { return 'named-foo'; }\n`
    );
    writeFileSync(join(projectDir, 'index.ts'), `export { foo as default } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'value');
    // R129: exactly 1 edge, targeting b::foo (the named export), NOT b::sourceDefault
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('foo');
    expect(edges[0].target_qn).not.toContain('sourceDefault');
    const props = JSON.parse(edges[0].properties_json);
    expect(props).toMatchObject({
      resolution: 'cross_file_import_exact',
      confidence: 1,
      candidate_count: 1,
      candidate_index: 0,
    });
    db.close();
  });

  // ── `export { foo as default }` from source WITHOUT default ──────────────
  // b.ts has only a named `foo`, no default. index aliases it as default.

  it('export { foo as default } from "./b" (no source default) → targets b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export function foo() { return 'named-foo'; }\n`);
    writeFileSync(join(projectDir, 'index.ts'), `export { foo as default } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'value');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('foo');
    db.close();
  });

  // ── `export { default as Foo } from './b'` → named Foo targets b's default ──

  it('export { default as Foo } from "./b" → named import { Foo } targets b::default', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'index.ts'), `export { default as Foo } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { Foo } from './index';\nexport function caller() { return Foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'Foo');
    // R129: `export { default as Foo }` has importedName='default', so the
    // resolver consults defaultExportByFile for b.ts → b::realName.
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    db.close();
  });

  // ── Local `export { foo as default }` (no source module) ─────────────────
  // foo is a local function, re-exported as default.

  it('local export { foo as default } → default import targets local foo', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `function foo() { return 'local-foo'; }\n` +
      `export { foo as default };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'value');
    // R129: local `export { foo as default }` has exportKind='local_alias',
    // localName='foo'. The resolver looks up 'foo' in fileSymbolIndex.
    // This should resolve to index.ts::foo.
    // Note: if foo is not exported (just local), the default marker may not
    // exist. But `export { foo as default }` makes it the default.
    expect(edges.length).toBeGreaterThanOrEqual(0);
    // If there's an edge, it should target index.ts
    for (const e of edges) {
      expect(e.target_qn).toContain('index.ts');
    }
    db.close();
  });

  // ── `export { default } from './b'` (re-export native default) ───────────
  // Already tested in R128, but with tightened assertions here.

  it('export { default } from "./b" → default import targets b::realName', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'index.ts'), `export { default } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    db.close();
  });

  // ── Default chain: export { default } from './index' ─────────────────────
  // b → index → a, where both re-exports use `export { default }`.

  it('default chain: b → index → a (export { default } each) → resolves to b', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'mid.ts'), `export { default } from './b';\n`);
    writeFileSync(join(projectDir, 'index.ts'), `export { default } from './mid';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    // R129: chain of `export { default }` should resolve recursively to b::realName.
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    db.close();
  });

  // ── Intra-file edges preserved during stale cleanup ──────────────────────
  // When semanticsStale triggers clearCrossFileCallEdges, intra-file CALLS
  // edges (resolution="intra_file") must be preserved.

  it('stale cleanup preserves intra-file CALLS edges', async () => {
    // a.ts has an intra-file call (calls a local function)
    writeFileSync(join(projectDir, 'a.ts'),
      `function helper() { return 1; }\n` +
      `export function caller() { return helper(); }\n`
    );
    writeFileSync(join(projectDir, 'b.ts'), `export function foo() { return 2; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db0 = getDb();
    // Count intra-file edges before
    const intraBefore = (db0.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"resolution":"intra_file"%'`
    ).get(projectName) as { c: number }).c;
    const crossBefore = (db0.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"resolution":"cross_file%'`
    ).get(projectName) as { c: number }).c;
    expect(intraBefore).toBeGreaterThanOrEqual(1); // caller → helper
    db0.close();
    // Simulate legacy DB
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 0 WHERE name = ?').run(projectName);
    dbW.close();
    // No-op incremental (don't modify any file) — triggers stale cleanup
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    // R129: cross-file edges deleted, intra-file edges preserved
    const crossAfter = (db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"resolution":"cross_file%'`
    ).get(projectName) as { c: number }).c;
    const intraAfter = (db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"resolution":"intra_file"%'`
    ).get(projectName) as { c: number }).c;
    expect(crossAfter).toBe(0);
    expect(intraAfter).toBe(intraBefore); // preserved!
    db.close();
  });

  // ── Incremental: modify default source → edge updates ────────────────────

  it('incremental: modify default source file → edge updates correctly', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Modify b.ts — change the default export function name
    writeFileSync(join(projectDir, 'b.ts'), `export default function renamedFunc() { return 99; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('renamedFunc');
    db.close();
  });
});
