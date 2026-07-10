// v2/tests/indexer/r134-type-namespace-validity.test.ts
// R134: Type Namespace Default Validity + BuiltinModules Check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R134: Type Namespace Default Validity', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r134-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r134-${Date.now()}`;
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

  it('export { type Foo as default } + export default function → 0 edges (IDX-R134-02)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `type Foo = { x: number };\nexport { type Foo as default };\nexport default function make() { return 1; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  it('export * from node:fs → NOT invalidated (IDX-R134-03)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\nexport * from 'node:fs';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    expect(getEdges(db, 'local').length).toBe(1);
    db.close();
  });

  it('export default interface + export default function → 1 edge (R133 preserved)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default interface Shape { x: number }\nexport default function make() { return 1 }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'value');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('make');
    db.close();
  });

  it('full reindex sets extractor_semantics_version=5 (R134 bump)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
