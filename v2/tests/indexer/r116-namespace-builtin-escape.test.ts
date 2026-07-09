import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
describe('R116: Namespace Builtin-Method Escape Hatch', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'r116-')); projectDir = join(tmpDir, 'project'); cacheDir = join(tmpDir, 'cache'); mkdirSync(projectDir, { recursive: true }); mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true }); projectName = `r116-${Date.now()}`; process.env.XDG_CACHE_HOME = cacheDir; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); delete process.env.XDG_CACHE_HOME; });
  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) { return db.prepare(`SELECT t.qualified_name AS target_qn, e.properties_json FROM edges e JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND e.type = 'CALLS' AND e.properties_json LIKE '%"callee":"' || ? || '"%' AND e.properties_json LIKE '%cross_file%'`).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>; }
  it('namespace import: api.get() resolves via namespace', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function get() { return 1; }\n'); writeFileSync(join(projectDir, 'c.ts'), 'export function get() { return 99; }\n'); writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.get(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'api.get'); expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(JSON.parse(e[0].properties_json).resolution).toBe('cross_file_namespace_exact'); db.close();
  });
  it('namespace import: api.set(), api.has(), api.delete_() all resolve', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function set() { return 1; }\nexport function has() { return 2; }\nexport function delete_() { return 3; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function set() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.set() + api.has() + api.delete_(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb();
    for (const m of ['api.set', 'api.has', 'api.delete_']) { const e = getEdges(db, m); expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(JSON.parse(e[0].properties_json).resolution).toBe('cross_file_namespace_exact'); }
    db.close();
  });
  it('namespace import: api.delete() call_site collected but no edge (export alias limitation)', async () => {
    // R118: api.delete() is valid JS/TS syntax (delete is only reserved as unary operator).
    // tree-sitter parses it as member_expression → callee='api.delete', call_kind='member_call'.
    // The call_site IS collected. However, the namespace resolver can't resolve it because
    // `export { _delete as delete }` creates a node with name='_delete' (the local name),
    // not 'delete' (the export alias). The resolver looks up cs.last_segment ('delete') in
    // fileSyms (keyed by node.name), which only has '_delete'.
    // This is a known limitation: the indexer doesn't track export aliases for symbol lookup.
    // Phase 3 would need export alias tracking to resolve api.delete() → _delete.
    writeFileSync(join(projectDir, 'api.ts'), 'const _delete = () => 1;\nexport { _delete as delete };\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.delete(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb();
    // The call_site IS collected (api.delete, member_call)
    const cs = db.prepare("SELECT callee, call_kind FROM call_sites WHERE project = ?").all(projectName);
    expect(cs.length).toBe(1);
    expect(cs[0].callee).toBe('api.delete');
    expect(cs[0].call_kind).toBe('member_call');
    // No cross-file edge created (export alias not tracked)
    expect(getEdges(db, 'api.delete').length).toBe(0);
    db.close();
  });
  it('non-namespace: arr.map() still filtered', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function map() { return 1; }\n'); writeFileSync(join(projectDir, 'a.ts'), `const arr = [1, 2, 3];\nexport function caller() { return arr.map(x => x); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb(); expect(getEdges(db, 'arr.map').length).toBe(0); db.close();
  });
  it('console.log() still filtered', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function log() { return 1; }\n'); writeFileSync(join(projectDir, 'a.ts'), `export function caller() { console.log("x"); return 1; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb(); expect(getEdges(db, 'console.log').length).toBe(0); db.close();
  });
  it('namespace import: api.map() resolves via namespace', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function map() { return 1; }\n'); writeFileSync(join(projectDir, 'c.ts'), 'export function map() { return 99; }\n'); writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.map(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb(); const e = getEdges(db, 'api.map'); expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(JSON.parse(e[0].properties_json).resolution).toBe('cross_file_namespace_exact'); db.close();
  });
  it('namespace import: api.then() resolves', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function then() { return 1; }\nexport function resolve() { return 2; }\n'); writeFileSync(join(projectDir, 'c.ts'), 'export function then() { return 99; }\n'); writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.then() + api.resolve(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 }); expect(r.errors.length).toBe(0);
    const db = getDb(); for (const m of ['api.then', 'api.resolve']) { const e = getEdges(db, m); expect(e.length).toBe(1); expect(e[0].target_qn).toContain('api.ts'); expect(JSON.parse(e[0].properties_json).resolution).toBe('cross_file_namespace_exact'); } db.close();
  });
  it('orphan edges = 0', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function get() { return 1; }\nexport function map() { return 2; }\n'); writeFileSync(join(projectDir, 'c.ts'), 'export function get() { return 99; }\n'); writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.get() + api.map(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb(); const o = (db.prepare(`SELECT COUNT(*) AS c FROM edges e LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)`).get(projectName) as { c: number }).c; expect(o).toBe(0); db.close();
  });
});
