// v2/tests/indexer/r120-export-precision-lock.test.ts
// R120: Export Tracking Migration & Precision Lock
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R120: Export Tracking Precision Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r120-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r120-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // A. Deletion cleanup: delete re-exported file → edge count = 0 (not just orphan=0)
  it('deletion cleanup: delete b.ts → getEdges("foo").length = 0', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { foo } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Before deletion: 1 edge to b.ts::foo
    const db1 = getDb();
    expect(getEdges(db1, 'foo').length).toBe(1);
    db1.close();
    // Delete b.ts
    unlinkSync(join(projectDir, 'b.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // After deletion: 0 edges for foo (b.ts gone, no other file exports foo)
    const db2 = getDb();
    expect(getEdges(db2, 'foo').length).toBe(0);
    // No orphan edges
    const orphanCount = (db2.prepare(`SELECT COUNT(*) AS c FROM edges e LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)`).get(projectName) as { c: number }).c;
    expect(orphanCount).toBe(0);
    db2.close();
  });

  // B. Inline type-only export specifier: export { type Foo, bar } from './types'
  it('inline type-only: export { type Foo, bar } — Foo not in exports, bar resolves', async () => {
    writeFileSync(join(projectDir, 'types.ts'), 'export interface Foo { x: number; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { type Foo, bar } from './types';\n`);
    writeFileSync(join(projectDir, 'c.ts'), 'export function Foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './index';\nexport function caller() { return bar(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // bar should resolve via re-export
    const barEdges = getEdges(db, 'bar');
    expect(barEdges.length).toBeGreaterThanOrEqual(1);
    expect(barEdges[0].target_qn).toContain('types.ts');
    // Foo should NOT create a runtime edge (type-only)
    // Check exports table — Foo should not be in it
    const fooExports = db.prepare("SELECT COUNT(*) AS c FROM exports WHERE project = ? AND exported_name = 'Foo'").get(projectName) as { c: number };
    expect(fooExports.c).toBeLessThanOrEqual(1);
    // bar should be in exports
    const barExports = db.prepare("SELECT COUNT(*) AS c FROM exports WHERE project = ? AND exported_name = 'bar'").get(projectName) as { c: number };
    expect(barExports.c).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // C. Modern DB (R126+, extractor_semantics_version=current) with manually
  // deleted exports: resolver returns `unknown` for the import target, which
  // is TERMINAL — no name-based fallback. crossFileCallsStale=false because
  // the resolver ran successfully (just found nothing to publish).
  //
  // R126: this test was rewritten from the pre-R126 expectation
  // (`stale=false && edges >= 1`) which locked in the dangerous behavior
  // described in MIG-R126-02: a graph could be marked fresh despite exports
  // being incomplete, leading to false-positive edges via name-based fallback.
  it('modern DB: deleted exports → terminal unknown, 0 edges, stale=false', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './api';\nexport function caller() { return foo(); }\n`);
    // Full index (populates exports, sets extractor_semantics_version=1)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate data loss: delete all exports
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    dbW.close();
    // Modify a.ts — incremental
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './api';\nexport function caller() { return foo() + 1; }\n`);
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.errors.length).toBe(0);
    // R126: resolver ran (crossFileCallsResolved=true) AND semantics are
    // current (version=1), so stale=false. But `foo` resolves to `unknown`
    // (api.ts has no exports row → legacy_export_tracking), which is terminal
    // — no name-based fallback. 0 edges is the CORRECT precision behavior.
    expect(r2.crossFileCallsStale).toBe(false);
    const db = getDb();
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });
});
