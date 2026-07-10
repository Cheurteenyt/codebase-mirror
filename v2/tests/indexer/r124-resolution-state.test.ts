// v2/tests/indexer/r124-resolution-state.test.ts
// R124: Resolution state machine — resolved/missing/ambiguous/unknown
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R124: Resolution State Machine', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r124-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r124-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });

  // Known P1 limitations (IDX-R125-01, IDX-R125-02)
  it.todo('private-only file (no export tracking) must not fall back globally — IDX-R125-01');
  it.todo('unresolved import source must be terminal — IDX-R125-02');
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // IDX-R124-01: Star conflict should NOT produce ANY edges (no name-based fallback)
  it('star conflict: both export foo → 0 total edges (no fallback)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\nexport * from './c';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R125B: star conflict → 0 TOTAL edges (ESM SyntaxError, no fallback)
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // IDX-R124-02: export function foo() wins over export * from './b'
  it('direct export wins: export function foo() + export * from b → local foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export function foo() { return 2; }\nexport * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const e = getEdges(db, 'foo');
    // R124: explicit export function foo() in index.ts should win over star from b
    expect(e.length).toBeGreaterThanOrEqual(1);
    expect(e.some((_: any) => _.target_qn.includes('index.ts'))).toBe(true);
    db.close();
  });

  // IDX-R124-03: Private symbol should NOT be resolved via import
  it('private symbol: import { hidden } from barrel with export * → no edge', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'function hidden() { return 1; }\nexport function visible() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { hidden } from './index';\nexport function caller() { return hidden(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R125B: hidden is private → 0 TOTAL edges
    expect(getEdges(db, 'hidden').length).toBe(0);
    db.close();
  });

  // IDX-R124-04: Nested ambiguity should propagate
  it('nested ambiguity: inner.ts has star conflict, index.ts has star from inner → no exact edge', async () => {
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'd.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'inner.ts'), `export * from './c';\nexport * from './d';\n`);
    writeFileSync(join(projectDir, 'e.ts'), 'export function foo() { return 3; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './inner';\nexport * from './e';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R124: inner has ambiguous foo, index has inner(ambiguous) + e(resolved)
    // Overall: ambiguous → no exact edge, no name-based fallback
    // R125B: nested ambiguity → 0 TOTAL edges
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // IDX-R124-05: Multiple stars with distinct names should all resolve (order-independent)
  it('multiple stars order-independent: export * from b + export * from c → both resolve', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './c';\nexport * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, bar } from './index';\nexport function caller() { return foo() + bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'foo').some((_: any) => _.target_qn.includes('b.ts'))).toBe(true);
    expect(getEdges(db, 'bar').some((_: any) => _.target_qn.includes('c.ts'))).toBe(true);
    db.close();
  });
});
