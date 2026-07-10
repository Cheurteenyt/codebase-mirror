// v2/tests/indexer/r123-star-precision.test.ts
// R123: Star export precision — multiple stars don't collide, conflicts return undefined
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R123: Star Export Precision', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r123-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r123-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // A. Multiple star exports DON'T collide — both foo and bar resolve
  it('multiple stars: export * from b + export * from c → both foo and bar resolve', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\nexport * from './c';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, bar } from './index';\nexport function caller() { return foo() + bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const fooEdges = getEdges(db, 'foo');
    expect(fooEdges.length).toBeGreaterThanOrEqual(1);
    expect(fooEdges.some((_: any) => _.target_qn.includes('b.ts'))).toBe(true);
    const barEdges = getEdges(db, 'bar');
    expect(barEdges.length).toBeGreaterThanOrEqual(1);
    expect(barEdges.some((_: any) => _.target_qn.includes('c.ts'))).toBe(true);
    db.close();
  });

  // B. Star conflict: both b and c export foo → no exact edge (ESM would throw)
  it('star conflict: both export foo → no exact resolution (ambiguous conflict)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\nexport * from './c';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    // R123: star conflict should NOT produce an exact edge
    // The resolver returns undefined for conflicting star exports
    // Name-based fallback may still create edges (ambiguous), but no exact
    const exactEdges = edges.filter((_: any) => {
      const props = JSON.parse(_.properties_json);
      return props.resolution === 'cross_file_import_exact';
    });
    expect(exactEdges.length).toBe(0);
    db.close();
  });

  // C. Explicit export wins over star
  it('explicit export wins: export { foo } from b + export * from c → foo from b', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 2; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b';\nexport * from './c';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBeGreaterThanOrEqual(1);
    // At least one edge should point to b.ts (explicit export wins)
    expect(edges.some((_: any) => _.target_qn.includes('b.ts'))).toBe(true);
    db.close();
  });

  // D. Star order doesn't matter
  it('star order: export * from c first, then b → both resolve', async () => {
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
