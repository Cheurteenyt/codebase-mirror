// v2/tests/indexer/r135-builtin-truth-lock.test.ts
// R135: Builtin Truth Lock + export type { Foo as default }
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R135: Builtin Truth Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r135-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r135-${Date.now()}`;
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
       FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"' || ? || '"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>;
  }

  // ── IDX-R135-01: node:fake must invalidate the module ──────────────────

  it('export * from node:fake → 0 edges (invalid builtin, IDX-R135-01)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:fake';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R135: node:fake is NOT a valid builtin → module invalid → 0 edges
    expect(getEdges(db, 'local').length).toBe(0);
    db.close();
  });

  // ── IDX-R135-01 positive: valid builtins still work ─────────────────────

  it('export * from node:fs → valid, local resolves (IDX-R135-01 positive)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:fs';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'local').length).toBe(1);
    db.close();
  });

  it('export * from node:test → valid (prefix-only builtin)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:test';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R135: node:test is a valid prefix-only builtin (not in builtinModules array
    // but isBuiltin('node:test') returns true)
    expect(getEdges(db, 'local').length).toBe(1);
    db.close();
  });

  it('export * from fs (bare builtin) → valid', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'fs';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'local').length).toBe(1);
    db.close();
  });

  it('export * from node:definitely_not_real → 0 edges (invalid builtin)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:definitely_not_real';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'local').length).toBe(0);
    db.close();
  });

  // ── IDX-R135-02: export type { Foo as default } ─────────────────────────

  it('export type { Foo as default } + export default function → 0 edges (IDX-R135-02)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `type Foo = { x: number };\n` +
      `export type { Foo as default };\n` +
      `export default function make() { return 1; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R135: tsc rejects with TS2323. The top-level type-only statement is now
    // inspected for default specifiers → type_only_default persisted → collision.
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  // ── R134 preserved: inline type-only default still works ────────────────

  it('export { type Foo as default } + export default function → 0 edges (R134 preserved)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `type Foo = { x: number };\n` +
      `export { type Foo as default };\n` +
      `export default function make() { return 1; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });
});
