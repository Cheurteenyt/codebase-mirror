// v2/tests/indexer/r128-stale-edge-dominance.test.ts
// R128: Stale Edge Dominance + Default Import Resolution Fix
//
// Tests the R128 fixes for:
//   - MIG-R128-01: no-op stale doesn't delete existing edges
//   - MIG-R128-02: initialized=false bypasses stale cleanup
//   - IDX-R128-01: explicit `export { default } from` doesn't resolve
//   - IDX-R128-02: default via star with named homonym → false edge
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R128: Stale Edge Dominance + Default Fix', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r128-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r128-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
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
  function getAllCrossFileEdges(db: Database.Database): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS'
         AND properties_json LIKE '%"resolution":"cross_file%'`
    ).get(projectName) as { c: number };
    return row.c;
  }

  // Helper: simulate a legacy R125A-style DB (version=0, missing star rows)
  function simulateLegacyDb() {
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare("DELETE FROM exports WHERE project = ? AND export_kind = 'star_re_export'").run(projectName);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 0 WHERE name = ?').run(projectName);
    dbW.close();
  }

  // ── MIG-R128-01: No-op stale must delete existing edges ─────────────────

  it('no-op stale → existing cross-file edges deleted (MIG-R128-01)', async () => {
    // Full index produces a cross-file edge
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Verify edge exists
    const db0 = getDb();
    expect(getEdges(db0, 'foo').length).toBeGreaterThanOrEqual(1);
    const edgesBefore = getAllCrossFileEdges(db0);
    expect(edgesBefore).toBeGreaterThanOrEqual(1);
    db0.close();
    // Simulate legacy DB
    simulateLegacyDb();
    // No-op incremental (don't modify any file)
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(true);
    // R128: no-op must DELETE stale cross-file edges, not just set the flag
    const db = getDb();
    expect(getAllCrossFileEdges(db)).toBe(0);
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── MIG-R128-02: initialized=false must not bypass stale cleanup ────────

  it('initialized=false + version 0 → stale cleanup still runs (MIG-R128-02)', async () => {
    // Full index
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Verify edge exists
    const db0 = getDb();
    expect(getEdges(db0, 'foo').length).toBeGreaterThanOrEqual(1);
    db0.close();
    // Simulate: version=0 AND initialized=false (like after a partial full index)
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 0, call_sites_initialized = 0 WHERE name = ?').run(projectName);
    dbW.close();
    // Modify a.ts — incremental. The old code checked !callSitesInitialized
    // first, skipping the stale cleanup. R128 checks semanticsStale first.
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo() + 1; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(true);
    // R128: stale semantics must delete cross-file edges even when
    // call_sites_initialized=false. Previously the !initialized branch
    // skipped cleanup, leaving old edges readable.
    const db = getDb();
    expect(getAllCrossFileEdges(db)).toBe(0);
    db.close();
  });

  // ── IDX-R128-01: Explicit default re-export ─────────────────────────────

  it('export { default } from "./b" → default import resolves (IDX-R128-01)', async () => {
    // b.ts has a default export; index.ts re-exports it explicitly
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export { default } from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R128/R129: `export { default } from './b'` creates a re_export_named
    // binding with importedName='default'. The resolver consults
    // defaultExportByFile for b.ts and returns b::realName.
    // R129: tightened from >=1 to ===1 with exact metadata.
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    const props = JSON.parse(edges[0].properties_json);
    expect(props).toMatchObject({
      resolution: 'cross_file_import_exact',
      confidence: 1,
      candidate_count: 1,
      candidate_index: 0,
    });
    db.close();
  });

  // ── IDX-R128-02: Default via star with named homonym ────────────────────

  it('default via star + named homonym → 0 edges (IDX-R128-02)', async () => {
    // b.ts has `export default function foo()` AND `export { foo }`
    // index.ts has `export * from './b'` — this does NOT propagate default
    // a.ts imports default from index — ESM invalid (no default export)
    writeFileSync(join(projectDir, 'b.ts'), 'export default function foo() { return 1; }\nexport { foo };\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R128: default import resolves 'default'. The star guard (R127) returns
    // missing for 'default'. So no edge should be created for this ESM-invalid
    // import. Previously the resolver asked for cs.callee='foo', traversed
    // the star, found the named export 'foo', and created a false edge.
    const edges = getEdges(db, 'foo');
    // Filter to edges from a.ts::caller (the default import call)
    const callerEdges = edges.filter((e: any) => {
      const props = JSON.parse(e.properties_json);
      // The callee is 'foo' (the local name of the default import)
      return props.callee === 'foo';
    });
    expect(callerEdges.length).toBe(0);
    db.close();
  });

  // ── Positive control: direct default import still works ─────────────────

  it('direct default import (import foo from "./b") → 1 exact edge (positive control)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    // R129: tightened from >=1 to ===1 with exact metadata.
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    const props = JSON.parse(edges[0].properties_json);
    expect(props).toMatchObject({
      resolution: 'cross_file_import_exact',
      confidence: 1,
      candidate_count: 1,
    });
    db.close();
  });

  // ── Positive control: default export function (not expression) ──────────

  it('default export function with named function → resolves via default marker', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // The default export marker should exist for b.ts
    const marker = db.prepare(
      "SELECT imported_name FROM imports WHERE project = ? AND file_path = ? AND local_name = '__default_export__'"
    ).get(projectName, 'b.ts') as { imported_name: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.imported_name).toContain('realName');
    db.close();
  });

  // ── Deletion-only stale: edges cleaned ──────────────────────────────────

  it('deletion-only stale → cross-file edges cleaned (MIG-R128-02 variant)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Verify edges exist
    const db0 = getDb();
    expect(getAllCrossFileEdges(db0)).toBeGreaterThanOrEqual(1);
    db0.close();
    // Simulate legacy DB
    simulateLegacyDb();
    // Delete c.ts — deletion-only incremental
    unlinkSync(join(projectDir, 'c.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(true);
    // R128: deletion-only with stale semantics must clean cross-file edges
    const db = getDb();
    expect(getAllCrossFileEdges(db)).toBe(0);
    db.close();
  });
});
