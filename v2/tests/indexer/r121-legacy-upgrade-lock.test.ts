// v2/tests/indexer/r121-legacy-upgrade-lock.test.ts
// R121: Export Tracking Legacy Upgrade Hygiene Lock
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { initIndexerSchema } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R121: Export Tracking Legacy Upgrade Hygiene Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r121-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r121-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }

  // A. Legacy DB: exports table empty, incremental on caller only
  // Export alias NOT resolved until full reindex (documented limitation)
  it('legacy DB upgrade: empty exports → alias NOT resolved, no crash, stale=false', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport { foo as bar };\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './api';\nexport function caller() { return bar(); }\n`);
    // Full index (populates exports)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate legacy: delete all exports for the project
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    dbW.close();
    // Modify a.ts only — incremental (api.ts unchanged, exports not backfilled)
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './api';\nexport function caller() { return bar() + 1; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R121: stale should be false (resolver ran, just couldn't resolve alias)
    // The resolver falls back to fileSyms.get('bar') which doesn't find 'foo'
    // (because the node name is 'foo', not 'bar'). So no edge is created for bar.
    // But the resolver DID run (crossFileCallsResolved=true), so stale=false.
    expect(r.crossFileCallsStale).toBe(false);
    // No edge for bar (alias not resolved without exports table)
    const db = getDb();
    const barEdges = getEdges(db, 'bar');
    // bar() can't resolve because exports table is empty (no alias mapping)
    // and fileSyms.get('bar') returns undefined (node name is 'foo')
    expect(barEdges.length).toBe(0);
    db.close();
  });

  // B. Full reindex after legacy upgrade → alias resolved
  it('legacy DB upgrade: full reindex → alias resolved correctly', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport { foo as bar };\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { bar } from './api';\nexport function caller() { return bar(); }\n`);
    // Full index (populates exports)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate legacy: delete exports
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    dbW.close();
    // Full reindex (backfills exports)
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // Now alias should resolve
    const db = getDb();
    const barEdges = getEdges(db, 'bar');
    expect(barEdges.length).toBe(1);
    expect(barEdges[0].target_qn).toContain('api.ts');
    expect(barEdges[0].target_qn).toContain('foo');
    db.close();
  });

  // C. hasExports() returns correct values
  it('hasExports(): returns false when empty, true when populated', async () => {
    const { hasExports } = await import('../../src/indexer/cross-file-resolver.js');
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport { foo as bar };\n');
    // Before indexing: no DB
    // After full index: exports populated
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    expect(hasExports(db, projectName)).toBe(true);
    // Delete exports
    db.close();
    const dbW = new Database(defaultCodeDbPath(projectName));
    dbW.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    expect(hasExports(dbW, projectName)).toBe(false);
    dbW.close();
  });
});
