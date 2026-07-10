// v2/tests/indexer/r127-semantics-gate-fast-paths.test.ts
// R127: Semantics Gate Fast Paths + Full Publication Atomicity
//
// Tests the R127 fixes for:
//   - MIG-R127-01: no-op incremental bypasses version check
//   - MIG-R127-02: deletion-only can reset stale=false
//   - MIG-R127-03: legacy edges still published when version stale
//   - DATA-R127-01: full partial falsely certified as current
//   - IDX-R127-01: namespace import called as function → false edge
//   - IDX-R127-02: default must not traverse export *
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R127: Semantics Gate Fast Paths', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r127-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r127-${Date.now()}`;
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
  function getVersion(db: Database.Database): number {
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v?: number } | undefined;
    return row?.v ?? 0;
  }
  function getStale(db: Database.Database): boolean {
    const row = db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s?: number } | undefined;
    return row?.s === 1;
  }

  // Helper: simulate a legacy R125A-style DB (version=0, missing star rows)
  function simulateLegacyDb() {
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare("DELETE FROM exports WHERE project = ? AND export_kind = 'star_re_export'").run(projectName);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 0 WHERE name = ?').run(projectName);
    dbW.close();
  }

  // ── MIG-R127-01: No-op incremental bypasses version check ───────────────

  it('no-op incremental + version 0 → stale=true (MIG-R127-01)', async () => {
    // Full index → version=CURRENT
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate legacy DB
    simulateLegacyDb();
    // No-op incremental (don't modify any file)
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R127: no-op must respect semanticsStale → stale=true
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    expect(getVersion(db)).toBe(0); // version preserved (not upgraded)
    expect(getStale(db)).toBe(true);
    db.close();
  });

  // ── MIG-R127-02: Deletion-only can reset stale=false ────────────────────

  it('deletion-only + version 0 → stale=true (MIG-R127-02)', async () => {
    // Full index with 2 files
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate legacy DB
    simulateLegacyDb();
    // Delete c.ts only (deletion-only incremental)
    unlinkSync(join(projectDir, 'c.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R127: deletion-only must respect semanticsStale → stale=true
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    expect(getVersion(db)).toBe(0); // version preserved
    expect(getStale(db)).toBe(true);
    db.close();
  });

  // ── MIG-R127-03: Legacy edges not published when version stale ──────────

  it('incremental with changed file + version 0 → no cross-file edges published (MIG-R127-03)', async () => {
    // Full index
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // Add a decoy so name-based fallback could match if the resolver ran with semanticsCurrent=false
    writeFileSync(join(projectDir, 'decoy.ts'), 'export function foo() { return 99; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Verify we have an edge initially
    const db0 = getDb();
    const initialEdges = getEdges(db0, 'foo');
    expect(initialEdges.length).toBeGreaterThanOrEqual(1);
    db0.close();
    // Simulate legacy DB
    simulateLegacyDb();
    // Delete all cross-file edges to simulate clean state
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare(`DELETE FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%"resolution":"cross_file%'`).run(projectName);
    dbW.close();
    // Modify a.ts — incremental with stale version
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo() + 1; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R127: stale semantics → no cross-file edges published (resolver skipped)
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    // No cross-file edges for foo (resolver was skipped, existing edges deleted)
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── DATA-R127-01: Full partial falsely certified ────────────────────────

  it('full index with extraction error → not certified as current (DATA-R127-01)', async () => {
    // a.ts is valid, b.ts will fail
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function bar() { return 2; }\n');
    // Inject failure on b.ts
    process.env.CBM_TEST_FAIL_ON_FILE = 'b.ts';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Should have at least one error
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    // R127: full mode with errors must NOT certify as current
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    expect(getVersion(db)).toBe(0); // not CURRENT
    // call_sites_initialized should be false (don't trust partial extraction)
    const initRow = db.prepare('SELECT call_sites_initialized AS i FROM projects WHERE name = ?').get(projectName) as { i?: number } | undefined;
    expect(initRow?.i).toBe(0);
    db.close();
  });

  // ── IDX-R127-01: Namespace import called as function ────────────────────

  it('namespace import called as function → 0 edges, no decoy fallback (IDX-R127-01)', async () => {
    // lib.ts exports foo; caller.ts imports * as api and calls api() (not callable)
    // decoy.ts exports a function named api to tempt name-based fallback
    writeFileSync(join(projectDir, 'lib.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'decoy.ts'), 'export function api() { return 99; }\n');
    writeFileSync(join(projectDir, 'caller.ts'), `import * as api from './lib';\nexport function caller() { return api(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R127: api is a namespace import, not callable. The resolver must NOT
    // fall through to name-based fallback and match decoy.ts::api.
    // 0 edges for 'api' is correct (ESM would throw TypeError at runtime).
    expect(getEdges(db, 'api').length).toBe(0);
    db.close();
  });

  // ── IDX-R127-02: Default must not traverse export * ─────────────────────

  it('default export does not traverse export * (IDX-R127-02)', async () => {
    // b.ts has a default export; index.ts re-exports * from b
    // a.ts imports default from index — ESM does NOT propagate default through *
    writeFileSync(join(projectDir, 'b.ts'), 'export default function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'index.ts'), `export * from './b';\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R127: default should NOT resolve through export *. The default export
    // marker for index.ts would not exist (index doesn't have its own default).
    // The import resolves to unknown (no default marker) → terminal (R126).
    // No edge should be created via star traversal of 'default'.
    // We check that no edge targets b.ts::foo via a star path.
    const edges = getEdges(db, 'foo');
    // There may be 0 edges (terminal unknown) — that's correct.
    // The key assertion: no edge with resolution='cross_file_import_exact'
    // that targets b.ts via a star path (which would be the bug).
    for (const e of edges) {
      const props = JSON.parse(e.properties_json);
      // If there IS an edge, it must NOT claim to be an exact import resolution
      // through the star barrel — that would be the IDX-R127-02 bug.
      if (props.resolution === 'cross_file_import_exact' && e.target_qn.includes('b.ts')) {
        // This is only acceptable if it came from b.ts DIRECTLY (not via index.ts star)
        // Since a.ts imports from './index', not './b', this would be a bug.
        throw new Error(`IDX-R127-02 regression: edge to b.ts::foo via star traversal of default`);
      }
    }
    db.close();
  });

  // ── Positive control: full reindex still works after all fixes ──────────

  it('full reindex → version=CURRENT, stale=false (positive control)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    const db = getDb();
    expect(getVersion(db)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getStale(db)).toBe(false);
    // Edge should exist
    expect(getEdges(db, 'foo').length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  // ── MIG-R127-03 positive: incremental with current version publishes edges ──

  it('incremental with current version → edges published, stale=false', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // Full index first
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Modify a.ts — incremental with current version
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo() + 1; }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // Current version → resolver runs, edges published, stale=false
    expect(r.crossFileCallsStale).toBe(false);
    const db = getDb();
    expect(getEdges(db, 'foo').length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
