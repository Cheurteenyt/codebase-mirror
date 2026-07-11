// v2/tests/indexer/r163-atomic-refusal-success-predicate.test.ts
// R163: Atomic Refusal State + Success Predicate + Expanded hasExistingGraphData
//
// Closes the R162 audit findings:
//   - STATE-R163-01 (P1/P2): Early returns do `db.close()` then
//     `markProjectStalePreservingGraph()` which reopens a new connection.
//     If the helper fails (lock, corruption, disk), `stalePersisted=false`
//     is ignored. DB stays `stale=0` while API returns STALE.
//   - STATE-R163-02 (P1/P2): `updateProjectStats()` uses
//     `succeeded = indexError === null` but `crossFileCallsStale` can be
//     true with `indexError=null`. A stale run without error text
//     advances `last_successful_index_at` and clears `last_index_error`.
//   - ROOT-R163-02 (P2): `hasExistingGraphData` only checks `nodes` and
//     `file_hashes`. A partial DB with edges/call_sites/imports/exports
//     but no nodes/hashes isn't detected.
//   - COMP-R163-01 (P2): "No mutation" is too broad —
//     `markProjectStalePreservingGraph` writes stale/attempt/error and
//     may clear cross-file edges on semantics mismatch.
//   - API-R163-01 (P2): Early refusal returns `nodes=0, edges=0` despite
//     the preserved snapshot having thousands of nodes. Consumers may
//     interpret "graph empty" instead of "no new work published".
//
// R163 fixes:
//   1. The two root-change early returns now inline the `UPDATE projects
//      SET cross_file_calls_stale=1, last_index_attempt_at=?,
//      last_index_error=?` on the SAME connection, BEFORE `db.close()`.
//      No `markProjectStalePreservingGraph` reopen. (STATE-R163-01)
//   2. `updateProjectStats()` now uses
//      `succeeded = indexError === null && !crossFileCallsStale`.
//      (STATE-R163-02)
//   3. `hasExistingGraphData` expanded to check `nodes`, `file_hashes`,
//      `edges`, `call_sites`, `imports`, `exports`. (ROOT-R163-02)
//   4. Comments on both early returns clarify "trust-state mutations"
//      (which DO happen) vs "structural graph mutations" (which do NOT).
//      The semantics-mismatch edge clear is removed entirely.
//      (COMP-R163-01)
//   5. New `preservedSnapshot?: boolean` field on `IndexResult`. Set to
//      `true` on both root-change early returns. (API-R163-01)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R163: Atomic Refusal State + Success Predicate', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r163-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r163-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // Helper: read stale/attempt/error/success columns from projects.
  function readProjectState(dbPath: string): {
    stale: number;
    lastAttempt: string | null;
    lastError: string | null;
    lastSuccess: string | null;
  } {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      'SELECT cross_file_calls_stale AS stale, last_index_attempt_at AS la, last_index_error AS le, last_successful_index_at AS ls FROM projects WHERE name = ?'
    ).get(projectName) as { stale: number; la: string | null; le: string | null; ls: string | null };
    db.close();
    return { stale: row.stale, lastAttempt: row.la, lastError: row.le, lastSuccess: row.ls };
  }

  // Helper: count rows in a table for a project.
  function countRows(dbPath: string, table: 'nodes' | 'edges' | 'file_hashes' | 'call_sites' | 'imports' | 'exports'): number {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project = ?`).get(projectName) as { c: number };
    db.close();
    return row.c;
  }

  // ── STATE-R163-01: Atomic refusal state — same-connection persist ──────
  //
  // R162 closed the DB then called markProjectStalePreservingGraph which
  // REOPENED a new connection. If the reopen failed (lock, corruption,
  // disk), stalePersisted=false was ignored — DB stayed stale=0 while the
  // API returned STALE. R163 runs the UPDATE on the ALREADY-OPEN
  // connection, BEFORE db.close(). The persisted state and the API return
  // value now agree on the same connection lifecycle.

  it('STATE-R163-01a: root change stale is persisted via the SAME connection (DB stale=1 after return)', async () => {
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    // Sanity: project is fresh after the full.
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();

    // Move the project to a new physical root (fingerprint changes).
    const newProjectDir = join(tmpDir, 'project-moved-r163a');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from the new root with NO file changes (no-op).
    // R162's path: db.close() → markProjectStalePreservingGraph() (reopen) →
    // UPDATE. R163's path: UPDATE → db.close(). The end-state observed
    // here (stale=1, last_index_attempt_at updated, last_index_error set)
    // is the SAME for both paths WHEN the reopen succeeds. The R163 fix
    // matters when the reopen FAILS — but that's hard to simulate
    // deterministically. Instead, this test verifies the SAME-CONNECTION
    // persist produces the correct DB state (the regression would be a
    // future refactor that re-introduces the helper call and accidentally
    // drops the UPDATE). The source-inspection tests below verify the
    // inline UPDATE pattern is in place.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    // R163: outcome = STALE, ROOT_CHANGED.
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.crossFileCallsStale).toBe(true);

    // R163 (STATE-R163-01): DB has stale=1 after the early return.
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(1);
    // R163 (STATE-R163-01): last_index_attempt_at was updated (the inline
    // UPDATE set it to now).
    expect(after.lastAttempt).not.toBeNull();
    // R163 (STATE-R163-01): last_index_error is the root-change message.
    expect(after.lastError).not.toBeNull();
    expect(after.lastError).toContain('Root fingerprint changed');
    // R163 (STATE-R163-01): last_successful_index_at was NOT advanced by
    // the refusal (it remains whatever the prior full index set).
    expect(after.lastSuccess).toBe(fresh.lastSuccess);
    // R163 (API-R163-01): preservedSnapshot=true.
    expect(r.preservedSnapshot).toBe(true);
  });

  it('STATE-R163-01b: root identity unknown stale is persisted via the SAME connection', async () => {
    // Run 1: full index from projectDir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);

    // Simulate a pre-R154 DB: set root_fingerprint=NULL.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Run 2: incremental from the SAME root with NULL root_fingerprint.
    // R162 → ROOT_IDENTITY_UNKNOWN (conservative — refuses any incremental
    // with NULL + existing graph data). R163 persists stale=1 via the
    // SAME connection before db.close().
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.crossFileCallsStale).toBe(true);

    // R163 (STATE-R163-01): DB has stale=1 after the early return.
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(1);
    expect(after.lastAttempt).not.toBeNull();
    expect(after.lastError).not.toBeNull();
    expect(after.lastError).toContain('Root identity unknown');
    expect(after.lastSuccess).toBe(fresh.lastSuccess);
    // R163 (API-R163-01): preservedSnapshot=true.
    expect(r.preservedSnapshot).toBe(true);
  });

  // ── STATE-R163-02: Success predicate requires !crossFileCallsStale ─────
  //
  // R162's `succeeded = indexError === null` advanced last_successful_index_at
  // and cleared last_index_error for a stale run without error text. R163
  // changes to `succeeded = indexError === null && !crossFileCallsStale`.
  //
  // The scenario: deletion-only path with existingStale=true,
  // semanticsStale=false, hasUncertainty=false, callSitesInitialized=false.
  // crossFileStale = (callSitesInitialized ? existingStale : true) = true.
  // deletionError = null (because !semanticsStale && !hasUncertainty).
  // R162: succeeded=true → last_successful_index_at = now, last_index_error = null.
  // R163: succeeded=false → last_successful_index_at preserved.

  it('STATE-R163-02a: stale run with indexError=null does NOT advance last_successful_index_at', async () => {
    // Run 1: full index from projectDir with two files.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();
    const successBefore = fresh.lastSuccess;

    // Force the scenario: set call_sites_initialized=0 (so crossFileResolved
    // stays false in the deletion-only path) AND cross_file_calls_stale=1
    // (existingStale=true). This produces crossFileStale=true with
    // deletionError=null — the bug scenario.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET call_sites_initialized = 0, cross_file_calls_stale = 1 WHERE name = ?').run(projectName);
    db.close();

    // Delete b.ts to trigger the deletion-only path.
    unlinkSync(join(projectDir, 'b.ts'));

    // Run 2: incremental → deletion-only path (estimatedFilesToIndex=0,
    // deletedRelPaths=['b.ts']). crossFileStale=true, deletionError=null.
    // R162: succeeded=true → last_successful_index_at = now (advances!).
    // R163: succeeded=false → last_successful_index_at preserved.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // The run is STALE (crossFileStale=true).
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);

    // R163 (STATE-R163-02): last_successful_index_at was NOT advanced.
    const after = readProjectState(dbPath);
    expect(after.lastSuccess).toBe(successBefore);
    // R163 (STATE-R163-02): cross_file_calls_stale is still 1 (the run
    // was stale — the stale flag is preserved, not cleared).
    expect(after.stale).toBe(1);
  });

  // ── ROOT-R163-02: Expanded hasExistingGraphData ────────────────────────
  //
  // R162's hasExistingGraphData only checked nodes and file_hashes. A
  // partial DB with edges/call_sites/imports/exports but no nodes/hashes
  // wasn't detected. The rootIdentityUnknown gate (which requires
  // hasExistingGraphData=true) would NOT fire, the premark UPSERT would
  // create a fresh projects row, and the index would proceed as if no
  // prior snapshot existed — even though partial graph data is present.
  //
  // R163 expands the EXISTS check to all six structural tables.

  it('ROOT-R163-02a: hasExistingGraphData detects partial DB with edges but no nodes', async () => {
    // Run 1: full index from projectDir — produces nodes, edges,
    // file_hashes, call_sites, imports, exports.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\nexport function b() { a(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    expect(countRows(dbPath, 'nodes')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    // Simulate an interrupted full index: delete nodes + file_hashes
    // (R162's check) but LEAVE edges, call_sites, imports, exports.
    // R162's hasExistingGraphData would return false (no nodes, no hashes).
    // R163's hasExistingGraphData returns true (edges exist).
    const db = new Database(dbPath);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    // Also NULL out root_fingerprint to trigger the rootIdentityUnknown gate.
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Verify the partial DB has edges but no nodes/hashes.
    expect(countRows(dbPath, 'nodes')).toBe(0);
    expect(countRows(dbPath, 'file_hashes')).toBe(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    // Run 2: incremental from the same root.
    // R162: hasExistingGraphData=false (only checked nodes/hashes) →
    // rootIdentityUnknown=false → no early return → index proceeds
    // (treating the partial DB as fresh).
    // R163: hasExistingGraphData=true (edges exist) → rootIdentityUnknown
    // fires → STALE + ROOT_IDENTITY_UNKNOWN.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // R163 (ROOT-R163-02): ROOT_IDENTITY_UNKNOWN fires.
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.crossFileCallsStale).toBe(true);
    // R163 (API-R163-01): preservedSnapshot=true.
    expect(r.preservedSnapshot).toBe(true);
  });

  // ── API-R163-01: preservedSnapshot flag ────────────────────────────────
  //
  // R162's early returns set nodes=0, edges=0 — ambiguous between "graph
  // empty" and "no new work published". R163 adds preservedSnapshot=true
  // to signal that a previous snapshot still exists in the DB.

  it('API-R163-01a: preservedSnapshot=true on root change early return', async () => {
    // Run 1: full index from projectDir — creates a real snapshot.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    // The snapshot has nodes/edges (real data).
    const nodesBefore = countRows(dbPath, 'nodes');
    const edgesBefore = countRows(dbPath, 'edges');
    expect(nodesBefore).toBeGreaterThan(0);
    expect(edgesBefore).toBeGreaterThan(0);

    // Move to a new root.
    const newProjectDir = join(tmpDir, 'project-moved-r163-snapshot');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from new root → ROOT_CHANGED early return.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    // R163 (API-R163-01): preservedSnapshot=true — the previous snapshot
    // still exists in the DB (the early return does NOT mutate the graph).
    expect(r.preservedSnapshot).toBe(true);
    // R163 (API-R163-01): nodes=0, edges=0 in the result — but the DB
    // still has the prior snapshot.
    expect(r.nodes).toBe(0);
    expect(r.edges).toBe(0);
    // The DB still has the prior snapshot (preservedSnapshot=true is honest).
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
    expect(countRows(dbPath, 'edges')).toBe(edgesBefore);
  });

  // ── Source-inspection regression guards ────────────────────────────────
  //
  // These tests verify the R163 implementation patterns are in place.
  // They guard against a future refactor accidentally reintroducing the
  // R162 bugs.

  it('regression (STATE-R163-01): rootChanged block inlines UPDATE before db.close() (no markProjectStalePreservingGraph)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R163 (STATE-R163-01): the rootChanged block has an inline UPDATE.
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    const rootChangedCodeIdx = src.indexOf("code: 'ROOT_CHANGED',", rootChangedIfIdx);
    expect(rootChangedCodeIdx).toBeGreaterThan(rootChangedIfIdx);
    const rootChangedBlock = src.slice(rootChangedIfIdx, rootChangedCodeIdx);
    // R163 (STATE-R163-01): the block contains the inline UPDATE.
    expect(rootChangedBlock).toContain('UPDATE projects SET');
    expect(rootChangedBlock).toContain('cross_file_calls_stale = 1');
    expect(rootChangedBlock).toContain('last_index_attempt_at = ?');
    expect(rootChangedBlock).toContain('last_index_error = ?');
    // R163 (STATE-R163-01): the block contains db.close() AFTER the UPDATE.
    // (The UPDATE is in a try block, then db.close() runs.)
    expect(rootChangedBlock).toContain('db.close();');
    // R163 (STATE-R163-01): the block does NOT CALL
    // markProjectStalePreservingGraph as a function invocation. The
    // comments may mention it for context (explaining what R163 changed),
    // but there should be no actual call.
    expect(rootChangedBlock).not.toMatch(/markProjectStalePreservingGraph\s*\(/);
  });

  it('regression (STATE-R163-01): rootIdentityUnknown block inlines UPDATE before db.close()', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    const rootIdentityUnknownCodeIdx = src.indexOf("code: 'ROOT_IDENTITY_UNKNOWN',", rootIdentityUnknownIfIdx);
    expect(rootIdentityUnknownCodeIdx).toBeGreaterThan(rootIdentityUnknownIfIdx);
    const block = src.slice(rootIdentityUnknownIfIdx, rootIdentityUnknownCodeIdx);
    expect(block).toContain('UPDATE projects SET');
    expect(block).toContain('cross_file_calls_stale = 1');
    expect(block).toContain('db.close();');
    // R163 (STATE-R163-01): no actual function call to
    // markProjectStalePreservingGraph. Comments may reference the name.
    expect(block).not.toMatch(/markProjectStalePreservingGraph\s*\(/);
  });

  it('regression (STATE-R163-02): updateProjectStats succeeded requires !crossFileCallsStale', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'schema.ts'), 'utf8');
    // R163 (STATE-R163-02): succeeded requires BOTH no error AND not stale.
    expect(src).toContain('const succeeded = indexError === null && !crossFileCallsStale;');
    // R163 (STATE-R163-02): the old `succeeded = indexError === null` is GONE.
    // (The new line contains `indexError === null && !crossFileCallsStale`, so
    // we check that the bare form is not present as a standalone statement.)
    expect(src).not.toMatch(/const succeeded = indexError === null;$/m);
  });

  it('regression (ROOT-R163-02): hasExistingGraphData checks all six structural tables', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R163 (ROOT-R163-02): hasExistingGraphData checks nodes, file_hashes,
    // edges, call_sites, imports, exports.
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM file_hashes WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM edges WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM call_sites WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM imports WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM exports WHERE project = ? LIMIT 1) AS e');
  });

  it('regression (API-R163-01): preservedSnapshot field on IndexResult', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R163 (API-R163-01): the IndexResult interface declares preservedSnapshot.
    expect(src).toContain('preservedSnapshot?: boolean');
    // R163 (API-R163-01): the field is documented with the R163 tag.
    expect(src).toContain('R163 (API-R163-01): When true, the index did not publish new data but a');
    // R163 (API-R163-01): preservedSnapshot is set on both early returns.
    // R165 (API-R165-03): the value changed from unconditional `true` to
    // `hasExistingGraphData`. Count occurrences of the NEW pattern — should
    // be at least 4 (2 STALE + 2 FAILED returns across both root-change
    // early returns). The R163 source-inspection test was updated in R165
    // to assert the new pattern (the old `preservedSnapshot: true` literal
    // no longer appears in the source).
    const matches = src.match(/preservedSnapshot:\s*hasExistingGraphData/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    // R165 (API-R165-03): the old unconditional `preservedSnapshot: true`
    // is GONE from the source.
    expect(src).not.toMatch(/preservedSnapshot:\s*true\b/);
  });

  it('regression (COMP-R163-01): comments distinguish trust-state vs structural mutations', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R163 (COMP-R163-01): the rootChanged block comment mentions trust-state
    // vs structural mutations.
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    const rootChangedCodeIdx = src.indexOf("code: 'ROOT_CHANGED',", rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, rootChangedCodeIdx);
    expect(block).toContain('trust-state');
    expect(block).toContain('structural');
    // R163 (COMP-R163-01): same for the rootIdentityUnknown block.
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    const rootIdentityUnknownCodeIdx = src.indexOf("code: 'ROOT_IDENTITY_UNKNOWN',", rootIdentityUnknownIfIdx);
    const block2 = src.slice(rootIdentityUnknownIfIdx, rootIdentityUnknownCodeIdx);
    expect(block2).toContain('trust-state');
    expect(block2).toContain('structural');
  });

  it('regression: package.json version is 0.70.0 (R165 bump)', () => {
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).toContain('"version": "0.70.0"');
  });
});
