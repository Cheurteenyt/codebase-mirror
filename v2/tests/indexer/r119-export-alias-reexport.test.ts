// v2/tests/indexer/r119-export-alias-reexport.test.ts
// R119: Export Alias / Re-export Tracking
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R119: Export Alias / Re-export Tracking', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r119-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r119-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // A. Export alias local — import { bar } resolves to foo
  it('export alias: import { bar } from "./api" resolves to api::foo', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'function foo() { return 1; }\nexport { foo as bar };\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './api';\nexport function caller() { return bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'bar');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(e[0].target_qn).toContain('foo');
    expect(e[0].target_qn).not.toContain('c.ts'); db.close();
  });

  // B. Namespace + export alias — api.delete() resolves to _delete
  it('namespace + export alias: api.delete() resolves to _delete', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function _delete() { return 1; }\nexport { _delete as delete };\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function delete_() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.delete(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'api.delete');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(e[0].target_qn).toContain('_delete');
    expect(e[0].target_qn).not.toContain('c.ts');
    expect(JSON.parse(e[0].properties_json).resolution).toBe('cross_file_namespace_exact'); db.close();
  });

  // C. Disambiguation — api.delete() only points to api.ts::_delete, not c.ts
  it('disambiguation: api.delete() does not fall back to c.ts', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function _delete() { return 1; }\nexport { _delete as delete };\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function delete_() {}\nexport function deleteFn() {}\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.delete(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'api.delete');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); db.close();
  });

  // D. Re-export named — export { foo } from './b'
  it('re-export named: import { foo } from "./index" resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b';\n`);
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('b.ts'); expect(e[0].target_qn).not.toContain('c.ts'); db.close();
  });

  // E. Re-export alias — export { foo as bar } from './b'
  it('re-export alias: import { bar } from "./index" resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo as bar } from './b';\n`);
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './index';\nexport function caller() { return bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'bar');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('b.ts'); expect(e[0].target_qn).toContain('foo'); db.close();
  });

  // F. Barrel folder — import { foo } from './dir' via dir/index.ts
  it('barrel folder: import { foo } from "./dir" resolves to dir/foo.ts::foo', async () => {
    mkdirSync(join(projectDir, 'dir'), { recursive: true });
    writeFileSync(join(projectDir, 'dir', 'foo.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'dir', 'index.ts'), `export { foo } from './foo';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './dir';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('dir/foo.ts'); db.close();
  });

  // G. Incremental — modify re-export target
  it('incremental: modify re-export target → edge updates', async () => {
    writeFileSync(join(projectDir, 'b1.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'b2.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b1';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Modify index.ts to re-export from b2
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b2';\n`);
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.errors.length).toBe(0); expect(r2.crossFileCallsStale).toBe(false);
    const db = getDb(); const e = getEdges(db, 'foo');
    expect(e.length).toBe(1); expect(e[0].target_qn).toContain('b2.ts'); db.close();
  });

  // H. Deletion cleanup — delete b.ts, edges removed
  it('deletion cleanup: delete re-exported file → stale edges removed', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'b.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    const db = getDb();
    const orphanCount = (db.prepare(`SELECT COUNT(*) AS c FROM edges e LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)`).get(projectName) as { c: number }).c;
    expect(orphanCount).toBe(0); db.close();
  });

  // I. Type-only exports don't create runtime edges
  it('type-only export: export type { Foo } does not create runtime edge', async () => {
    writeFileSync(join(projectDir, 'types.ts'), 'export interface Foo { x: number; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export type { Foo } from './types';\nexport { bar } from './types';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './index';\nexport function caller() { return bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // bar should resolve via re-export, Foo should NOT create any edge
    const e = getEdges(db, 'bar'); expect(e.length).toBe(1); expect(e[0].target_qn).toContain('types.ts');
    db.close();
  });
});
