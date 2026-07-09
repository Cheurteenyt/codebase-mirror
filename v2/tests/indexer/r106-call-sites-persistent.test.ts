// v2/tests/indexer/r106-call-sites-persistent.test.ts
// R106: Call-sites Persistent Table — Phase 1.
//
// Tests that the persistent call_sites table enables cross-file CALLS resolution
// in incremental mode (without requiring a full reindex).
//
// Required scenarios from the GPT 5.5 R106 audit report:
//   1. full a.ts -> b.ts creates CALLS
//   2. modify the caller a.ts and incremental updates the CALLS
//   3. modify the target b.ts and incremental keeps/resolves correctly
//   4. delete b.ts cleans up call_sites/edges
//   5. metadata-only does not rebuild unnecessarily
//   6. no-op changes nothing
//   7. ambiguity cap 5 preserved
//   8. builtins/member-call filters preserved
//   9. orphan_edges = 0
//  10. stats match
//  11. (extra) deletion-only fast path: skips extraction, rebuilds cross-file
//  12. (extra) legacy DB without call_sites: incremental marks stale=true

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { initIndexerSchema } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R106: Call-sites Persistent Table — Phase 1', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r106-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r106-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function countCrossFileEdges(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
  }

  function countCallSites(db: Database.Database, filePath?: string): number {
    if (filePath) {
      return (db.prepare("SELECT COUNT(*) AS c FROM call_sites WHERE project = ? AND file_path = ?").get(projectName, filePath) as { c: number }).c;
    }
    return (db.prepare("SELECT COUNT(*) AS c FROM call_sites WHERE project = ?").get(projectName) as { c: number }).c;
  }

  function countOrphanEdges(db: Database.Database): number {
    return (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
  }

  // ── Test 1: full a.ts → b.ts creates CALLS ────────────────────────────
  it('full index: a.ts calls b.ts → cross-file CALLS edge created + call_sites populated', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    // Cross-file CALLS edge exists
    expect(countCrossFileEdges(db)).toBeGreaterThan(0);
    // call_sites table is populated
    expect(countCallSites(db)).toBeGreaterThan(0);
    // call_sites for a.ts specifically (caller calls foo)
    expect(countCallSites(db, 'a.ts')).toBeGreaterThan(0);
    db.close();
  });

  // ── Test 2: modify caller a.ts → incremental updates CALLS ────────────
  it('incremental: modify caller a.ts → cross-file CALLS updated, stale=false', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db1 = getDb();
    const edgesBefore = countCrossFileEdges(db1);
    const callSitesBefore = countCallSites(db1);
    db1.close();
    expect(edgesBefore).toBeGreaterThan(0);
    expect(callSitesBefore).toBeGreaterThan(0);

    // Modify a.ts — add another call to foo
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + foo(); }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R106: stale should be false because call_sites was populated and resolver ran
    expect(result2.crossFileCallsStale).toBe(false);

    const db2 = getDb();
    const edgesAfter = countCrossFileEdges(db2);
    // call_sites for a.ts should still exist (re-inserted with new content)
    expect(countCallSites(db2, 'a.ts')).toBeGreaterThan(0);
    // Cross-file edges should still exist (foo is still defined in b.ts)
    expect(edgesAfter).toBeGreaterThan(0);
    // No orphan edges
    expect(countOrphanEdges(db2)).toBe(0);
    db2.close();
  });

  // ── Test 3: modify target b.ts → incremental keeps/resolves correctly ─
  it('incremental: modify target b.ts → cross-file CALLS still resolved, stale=false', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify b.ts (the target) — change implementation, keep function name
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 99; }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R106: stale=false because call_sites is populated and resolver ran
    expect(result2.crossFileCallsStale).toBe(false);

    const db = getDb();
    // Cross-file edge a→b should still exist (foo still defined in b.ts)
    expect(countCrossFileEdges(db)).toBeGreaterThan(0);
    // call_sites for a.ts should still exist (unchanged file, call_sites preserved)
    expect(countCallSites(db, 'a.ts')).toBeGreaterThan(0);
    // No orphan edges
    expect(countOrphanEdges(db)).toBe(0);
    db.close();
  });

  // ── Test 4: delete b.ts → call_sites/edges cleaned up ─────────────────
  it('incremental: delete target b.ts → call_sites/edges for b.ts cleaned up', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete b.ts
    unlinkSync(join(projectDir, 'b.ts'));

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);

    const db = getDb();
    // call_sites for b.ts should be gone
    expect(countCallSites(db, 'b.ts')).toBe(0);
    // call_sites for a.ts should still exist (a.ts wasn't deleted)
    expect(countCallSites(db, 'a.ts')).toBeGreaterThan(0);
    // No orphan edges
    expect(countOrphanEdges(db)).toBe(0);
    // No nodes for b.ts
    const bNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    expect(bNodes).toBe(0);
    db.close();
  });

  // ── Test 5: metadata-only does not rebuild unnecessarily ──────────────
  it('metadata-only: no files re-indexed, call_sites unchanged, stale preserved', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db1 = getDb();
    const callSitesBefore = countCallSites(db1);
    const edgesBefore = countCrossFileEdges(db1);
    db1.close();

    // Touch a.ts (metadata-only)
    const now = new Date();
    utimesSync(join(projectDir, 'a.ts'), now, now);

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // metadata-only: no files re-indexed

    const db2 = getDb();
    // call_sites should be unchanged (no re-extraction)
    expect(countCallSites(db2)).toBe(callSitesBefore);
    // cross-file edges should be unchanged
    expect(countCrossFileEdges(db2)).toBe(edgesBefore);
    db2.close();
  });

  // ── Test 6: no-op changes nothing ─────────────────────────────────────
  it('no-op incremental: nothing changes, call_sites/edges preserved', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db1 = getDb();
    const callSitesBefore = countCallSites(db1);
    const edgesBefore = countCrossFileEdges(db1);
    const nodesBefore = (db1.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    db1.close();

    // No-op incremental (no changes at all)
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0);

    const db2 = getDb();
    expect(countCallSites(db2)).toBe(callSitesBefore);
    expect(countCrossFileEdges(db2)).toBe(edgesBefore);
    const nodesAfter = (db2.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore);
    db2.close();
  });

  // ── Test 7: ambiguity cap 5 preserved ─────────────────────────────────
  it('incremental: ambiguity cap 5 preserved with persistent call_sites', async () => {
    // Create 7 files each defining foo()
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function foo() { return ${i}; }\n`);
    }
    writeFileSync(join(projectDir, 'caller.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify caller.ts — incremental
    writeFileSync(join(projectDir, 'caller.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);

    const db = getDb();
    // Cross-file CALLS edges for foo should be capped at 5
    const fooEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%\"callee\":\"foo\"%' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
    expect(fooEdges).toBeLessThanOrEqual(5);
    db.close();
  });

  // ── Test 8: builtins/member-call filters preserved ────────────────────
  it('incremental: builtins filter preserved (console.log, arr.map not matched)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function log() { return 1; }\nexport function map() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { console.log("x"); const arr = [1]; arr.map(x => x); return log(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify b.ts — incremental
    writeFileSync(join(projectDir, 'b.ts'), 'export function log() { return 3; }\nexport function map() { return 4; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);

    const db = getDb();
    // console.log should NOT create a cross-file edge to b::log
    const consoleLogEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%console.log%'").get(projectName) as { c: number }).c;
    expect(consoleLogEdges).toBe(0);
    // arr.map should NOT create a cross-file edge to b::map
    const arrMapEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%arr.map%'").get(projectName) as { c: number }).c;
    expect(arrMapEdges).toBe(0);
    // But log() as identifier_call SHOULD create an edge
    const logEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%\"callee\":\"log\"%'").get(projectName) as { c: number }).c;
    expect(logEdges).toBeGreaterThan(0);
    db.close();
  });

  // ── Test 9: orphan_edges = 0 after incremental ────────────────────────
  it('incremental with call_sites: orphan edges = 0, stats match', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + bar(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify a.ts — incremental
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + bar() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);

    const db = getDb();
    // No orphan edges
    expect(countOrphanEdges(db)).toBe(0);

    // Stats match: projects.node_count/edge_count == actual COUNT in DB
    const stats = db.prepare("SELECT node_count, edge_count FROM projects WHERE name = ?").get(projectName) as { node_count: number; edge_count: number };
    const actualNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?").get(projectName) as { c: number }).c;
    const actualEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ?").get(projectName) as { c: number }).c;
    expect(stats.node_count).toBe(actualNodes);
    expect(stats.edge_count).toBe(actualEdges);
    db.close();
  });

  // ── Test 10: deletion-only fast path skips extraction ─────────────────
  it('deletion-only fast path: skips extraction, rebuilds cross-file CALLS, stale=false', async () => {
    // Create files where c.ts calls into a.ts and b.ts
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function funcB() { return 2; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function caller() { return funcA() + funcB(); }\n');

    // Full index
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);

    // Delete a.ts (deletion-only: no other files changed)
    unlinkSync(join(projectDir, 'a.ts'));

    const t0 = Date.now();
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    const elapsed = Date.now() - t0;

    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // no files extracted
    expect(result2.skipped).toBe(2); // b.ts and c.ts skipped
    // R106: deletion-only fast path rebuilds cross-file CALLS → stale=false
    // (Before R106, this was true because deletion made the graph stale)
    expect(result2.crossFileCallsStale).toBe(false);

    const db = getDb();
    // a.ts nodes/hashes/call_sites gone
    const aNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'a.ts') as { c: number }).c;
    expect(aNodes).toBe(0);
    const aHashes = (db.prepare("SELECT COUNT(*) AS c FROM file_hashes WHERE project = ? AND file_path = ?").get(projectName, 'a.ts') as { c: number }).c;
    expect(aHashes).toBe(0);
    const aCallSites = countCallSites(db, 'a.ts');
    expect(aCallSites).toBe(0);
    // c.ts call_sites preserved (c.ts wasn't deleted)
    expect(countCallSites(db, 'c.ts')).toBeGreaterThan(0);
    // No orphan edges
    expect(countOrphanEdges(db)).toBe(0);
    // Cross-file CALLS to funcB should still exist (b.ts still exists)
    const funcBEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%funcB%'").get(projectName) as { c: number }).c;
    expect(funcBEdges).toBeGreaterThan(0);
    db.close();

    // Performance: deletion-only should be fast (< 2s even in CI)
    // This is a smoke check, not a rigorous benchmark.
    expect(elapsed).toBeLessThan(5000);
  });

  // ── Test 11: legacy DB without call_sites → incremental marks stale ───
  it('legacy DB without call_sites: incremental marks stale=true (forces full reindex)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index — populates call_sites + sets call_sites_initialized=1
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Simulate legacy DB: delete all call_sites AND reset call_sites_initialized=0
    // R107: the initialized flag is the authoritative legacy signal.
    // Just deleting call_sites rows is not enough — the flag must also be reset.
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('DELETE FROM call_sites WHERE project = ?').run(projectName);
    dbW.prepare('UPDATE projects SET call_sites_initialized = 0 WHERE name = ?').run(projectName);
    dbW.close();

    // Modify a.ts — incremental
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R107: legacy DB (call_sites_initialized=0) → can't resolve → stale=true
    expect(result2.crossFileCallsStale).toBe(true);

    // Full reindex should populate call_sites, set initialized=1, and reset stale
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result3.errors.length).toBe(0);
    expect(result3.crossFileCallsStale).toBe(false);

    const db = getDb();
    expect(countCallSites(db)).toBeGreaterThan(0);
    // R107: initialized flag should be 1 after full reindex
    const initRow = (db.prepare("SELECT call_sites_initialized FROM projects WHERE name = ?").get(projectName) as { call_sites_initialized?: number });
    expect(initRow.call_sites_initialized).toBe(1);
    db.close();
  });

  // ── Test 12: call_sites table has correct schema (indexes) ────────────
  it('call_sites table: schema + index idx_call_sites_project_file exists', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function f() { return 1; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    // Verify table exists
    const tableExists = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='call_sites'").get() as { c: number }).c;
    expect(tableExists).toBe(1);

    // Verify index exists
    const indexExists = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_call_sites_project_file'").get() as { c: number }).c;
    expect(indexExists).toBe(1);

    // Verify columns
    const cols = db.prepare('PRAGMA table_info(call_sites)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('project');
    expect(colNames).toContain('file_path');
    expect(colNames).toContain('source_qn');
    expect(colNames).toContain('callee');
    expect(colNames).toContain('last_segment');
    expect(colNames).toContain('call_kind');
    expect(colNames).toContain('line');
    db.close();
  });
});
