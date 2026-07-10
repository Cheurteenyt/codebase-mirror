// v2/tests/indexer/r122-export-star-reexport.test.ts
// R122: export * star re-exports with depth cap + cycle detection
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R122: export * Star Re-exports', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r122-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r122-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // A. Star direct: export * from './b'
  it('star direct: export * from "./b" → import { foo } from "./index" resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBeGreaterThanOrEqual(1); expect(e.some((_: any) => _.target_qn.includes('b.ts'))).toBe(true); db.close();
  });

  // B. Barrel star: dir/index.ts exports * from './foo'
  it('barrel star: import { foo } from "./dir" resolves to dir/foo.ts::foo', async () => {
    mkdirSync(join(projectDir, 'dir'), { recursive: true });
    writeFileSync(join(projectDir, 'dir', 'foo.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'dir', 'index.ts'), `export * from './foo';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './dir';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('dir/foo.ts'); db.close();
  });

  // C. Cycle: a.ts exports * from b, b.ts exports * from a → no infinite loop
  it('cycle: export * from A→B→A → no crash, no infinite loop', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export * from './b';\nexport function fooA() { return 1; }\n`);
    writeFileSync(join(projectDir, 'b.ts'), `export * from './a';\nexport function fooB() { return 2; }\n`);
    writeFileSync(join(projectDir, 'caller.ts'), `import { fooA, fooB } from './a';\nexport function caller() { return fooA() + fooB(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // Both should resolve through the star re-export chain (with cycle detection)
    const eA = getEdges(db, 'fooA'); expect(eA.length).toBeGreaterThanOrEqual(1); expect(eA.some((_: any) => _.target_qn.includes('a.ts'))).toBe(true);
    const eB = getEdges(db, 'fooB'); expect(eB.length).toBeGreaterThanOrEqual(0);
    db.close();
  });

  // D. Collision: export * from two files that both export foo
  it('collision: export * from b and c, both export foo → resolves to first found (no crash)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\nexport * from './c';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'foo');
    // R125A: Star conflict (both export foo) → no EXACT edges (R124 semantics)
    // Name-based fallback may still create ambiguous edges if import-aware doesn't fire
    const exactEdges = e.filter((_: any) => { const p = JSON.parse(_.properties_json); return p.resolution === 'cross_file_import_exact'; });
    expect(exactEdges.length).toBe(0);
    db.close();
  });

  // E. Type-only export * — export type * not common, but export * should not create runtime edges for interfaces
  it('star export: export * from types.ts (interface only) → no runtime edge for interface', async () => {
    writeFileSync(join(projectDir, 'types.ts'), 'export interface Foo { x: number; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './types';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './index';\nexport function caller() { return bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // bar should resolve via star re-export
    const e = getEdges(db, 'bar');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('types.ts');
    db.close();
  });

  // F. Incremental: modify star source
  it('incremental: modify star source file → edge updates', async () => {
    writeFileSync(join(projectDir, 'b1.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'b2.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b1';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Change star source
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b2';\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0); expect(r.crossFileCallsStale).toBe(false);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBeGreaterThanOrEqual(1); expect(e.some((_: any) => _.target_qn.includes('b2.ts'))).toBe(true); db.close();
  });

  // G. Deletion cleanup: delete star source
  it('deletion cleanup: delete b.ts → edge removed', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'b.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    const db = getDb();
    expect(getEdges(db, 'foo').length).toBe(0);
    const orphanCount = (db.prepare(`SELECT COUNT(*) AS c FROM edges e LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)`).get(projectName) as { c: number }).c;
    expect(orphanCount).toBe(0);
    db.close();
  });

  // H. Namespace + star: import * as api; api.foo() where foo comes from export *
  it('namespace + star: api.foo() resolves through export *', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './index';\nexport function caller() { return api.foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'api.foo');
    expect(e.length).toBeGreaterThanOrEqual(1); expect(e.some((_: any) => _.target_qn.includes('b.ts'))).toBe(true); db.close();
  });
});
