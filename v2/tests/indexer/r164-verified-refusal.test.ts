// v2/tests/indexer/r164-verified-refusal.test.ts
// R164: Verified Refusal State + Snapshot Contract
//
// Closes the R163 audit findings:
//   - STATE-R164-01 (P1/P2): The stale write catch block swallowed errors
//     and returned STALE regardless. If the UPDATE threw (SQLITE_BUSY, disk
//     full, corruption), the API returned STALE but the DB stayed stale=0.
//     Should return FAILED/PERSIST_FAILURE.
//   - STATE-R164-02 (P1/P2): `stalePersisted = true` was set after `.run()`
//     without checking `info.changes`. If the projects row doesn't exist
//     (partial DB), UPDATE affects 0 rows but stalePersisted is still true.
//   - CONC-R164-01 (P1/P2): No CAS (compare-and-swap) between projectState
//     read and UPDATE. Another indexer can publish between the two, then the
//     stale UPDATE marks the fresh snapshot as stale.
//   - STATE-R164-03 (P2): `last_index_error = excluded.last_index_error`
//     clears the previous diagnostic when a stale run has indexError=null.
//   - API-R164-01 (P1/P2): `preservedSnapshot=true` on a partial DB
//     (edges-only, no nodes/hashes) is misleading — it's not a coherent
//     published snapshot.
//
// R164 fixes:
//   1. The ROOT_CHANGED early return now uses a CAS UPDATE
//      (`WHERE name = ? AND root_fingerprint = ?`) and checks
//      `info.changes === 1`. If `info.changes === 0` (concurrent update),
//      it returns STALE with a CONCURRENT_UPDATE note. If the UPDATE threw,
//      it returns FAILED/PERSIST_FAILURE. (STATE-R164-01 + STATE-R164-02 +
//      CONC-R164-01)
//   2. The ROOT_IDENTITY_UNKNOWN early return uses a CAS UPDATE
//      (`WHERE name = ? AND root_fingerprint IS NULL`) and checks
//      `info.changes === 1`. If `info.changes === 0` (no projects row with
//      NULL fingerprint — either missing row or concurrent publish), it
//      returns FAILED/PERSIST_FAILURE. If the UPDATE threw, same.
//      (STATE-R164-01 + STATE-R164-02 + CONC-R164-01)
//   3. `updateProjectStats()` now uses a CASE WHEN on `last_index_error`:
//      when the run is stale AND the new error is NULL, preserve the prior
//      error. Otherwise use the new value. (STATE-R164-03)
//   4. New `publishedSnapshotPreserved?: boolean` field on `IndexResult`.
//      Set on both root-change early returns alongside `preservedSnapshot`.
//      `preservedSnapshot=true` means structural data exists and was not
//      modified. `publishedSnapshotPreserved=true` means a coherent
//      published snapshot exists (nodes AND file_hashes AND projects row).
//      (API-R164-01)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { updateProjectStats } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R164: Verified Refusal State + Snapshot Contract', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r164-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r164-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    rootFp: string | null;
  } {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      'SELECT cross_file_calls_stale AS stale, last_index_attempt_at AS la, last_index_error AS le, last_successful_index_at AS ls, root_fingerprint AS rfp FROM projects WHERE name = ?'
    ).get(projectName) as { stale: number; la: string | null; le: string | null; ls: string | null; rfp: string | null } | undefined;
    db.close();
    if (!row) {
      return { stale: -1, lastAttempt: null, lastError: null, lastSuccess: null, rootFp: null };
    }
    return { stale: row.stale, lastAttempt: row.la, lastError: row.le, lastSuccess: row.ls, rootFp: row.rfp };
  }

  // Helper: count rows in a table for a project.
  function countRows(dbPath: string, table: 'nodes' | 'edges' | 'file_hashes' | 'call_sites' | 'imports' | 'exports'): number {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project = ?`).get(projectName) as { c: number };
    db.close();
    return row.c;
  }

  // Helper: check whether a projects row exists.
  function projectsRowExists(dbPath: string): boolean {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT EXISTS(SELECT 1 FROM projects WHERE name = ?) AS e').get(projectName) as { e: number };
    db.close();
    return row.e === 1;
  }

  // ── STATE-R164-01 + STATE-R164-02: Root change stale persists via same ──
  //    connection with info.changes check
  //
  // R163 set `stalePersisted = true` after `.run()` without checking
  // `info.changes`. R164 sets `stalePersisted = info.changes === 1`. In the
  // single-process case (no concurrent update), the projects row exists and
  // the CAS WHERE clause matches → info.changes = 1 → stalePersisted = true →
  // STALE return.

  it('STATE-R164-01/02a: root change stale persists via same connection (DB stale=1, info.changes=1)', async () => {
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();
    expect(fresh.rootFp).not.toBeNull();

    // Move the project to a new physical root (fingerprint changes).
    const newProjectDir = join(tmpDir, 'project-moved-r164a');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from the new root.
    // R164 (STATE-R164-02): the CAS UPDATE matches the projects row (the
    // fingerprint hasn't changed between read and UPDATE) → info.changes=1
    // → stalePersisted=true → STALE return.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    // R164: outcome = STALE (no concurrent update, no persist failure).
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.crossFileCallsStale).toBe(true);

    // R164 (STATE-R164-01): no failure field (the persist succeeded).
    expect(r.failure).toBeUndefined();

    // R164 (STATE-R164-02): DB has stale=1 (info.changes was 1, so the
    // UPDATE actually wrote).
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(1);
    expect(after.lastAttempt).not.toBeNull();
    expect(after.lastError).not.toBeNull();
    expect(after.lastError).toContain('Root fingerprint changed');
    // R164 (STATE-R164-02): last_successful_index_at was NOT advanced.
    expect(after.lastSuccess).toBe(fresh.lastSuccess);
    // R164 (STATE-R164-02): root_fingerprint UNCHANGED (the CAS UPDATE does
    // NOT modify root_fingerprint — only trust-state columns).
    expect(after.rootFp).toBe(fresh.rootFp);

    // R164 (API-R164-01): preservedSnapshot=true (structural data exists,
    // not modified). publishedSnapshotPreserved=true (coherent snapshot
    // exists — nodes + file_hashes + projects row).
    expect(r.preservedSnapshot).toBe(true);
    expect(r.publishedSnapshotPreserved).toBe(true);
  });

  // ── CONC-R164-01: CAS on fingerprint detects concurrent update ──────────
  //
  // R163 had no CAS between projectState read and UPDATE. Another indexer
  // could publish between the two, then the stale UPDATE marked the fresh
  // snapshot as stale. R164 adds `WHERE name = ? AND root_fingerprint = ?`.
  // If info.changes === 0, another indexer changed the state between read
  // and write — we don't mark the new snapshot stale.
  //
  // Testing the CAS end-to-end requires injecting a DB change BETWEEN the
  // indexer's read and its UPDATE (which run synchronously in the same
  // function call). That's not feasible in a single-process vitest. Instead,
  // this test verifies the CAS SQL contract directly: prepare the DB
  // state, simulate the concurrent fingerprint change, then run the EXACT
  // CAS UPDATE statement the indexer uses (same SQL, same parameters) and
  // verify info.changes === 0. This proves the CAS pattern detects the
  // concurrent update — the indexer's code path uses this exact statement.

  it('CONC-R164-01a: CAS UPDATE returns info.changes=0 when root_fingerprint changed between read and write', async () => {
    // Run 1: full index from projectDir → DB has root_fingerprint = X.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Simulate the indexer's READ step: read the published root_fingerprint.
    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    const publishedRootFingerprint = row.rfp;
    dbRead.close();
    expect(publishedRootFingerprint).not.toBeNull();

    // Simulate a CONCURRENT UPDATE: another indexer publishes between our
    // read and our UPDATE, changing root_fingerprint to a new value.
    const dbConcurrent = new Database(dbPath);
    dbConcurrent.prepare('UPDATE projects SET root_fingerprint = ? WHERE name = ?').run('CONCURRENT-PUBLISHED-FINGERPRINT', projectName);
    dbConcurrent.close();

    // Verify the concurrent update took effect.
    const dbVerify = new Database(dbPath, { readonly: true });
    const rowVerify = dbVerify.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    dbVerify.close();
    expect(rowVerify.rfp).toBe('CONCURRENT-PUBLISHED-FINGERPRINT');

    // Now simulate the indexer's CAS UPDATE — using the STALE
    // publishedRootFingerprint we read BEFORE the concurrent update. This
    // is the exact SQL statement from the R164 rootChanged block.
    const dbUpdate = new Database(dbPath);
    const info = dbUpdate.prepare(`
      UPDATE projects SET
        cross_file_calls_stale = 1,
        last_index_attempt_at = ?,
        last_index_error = ?
      WHERE name = ?
        AND root_fingerprint = ?
    `).run(new Date().toISOString(), 'concurrent test stale msg', projectName, publishedRootFingerprint);
    dbUpdate.close();

    // R164 (CONC-R164-01): info.changes === 0 — the CAS detected that the
    // fingerprint changed between our read and our UPDATE. The (possibly
    // fresh) snapshot was NOT marked stale.
    expect(info.changes).toBe(0);

    // R164 (CONC-R164-01): the DB's stale flag was NOT set (the CAS UPDATE
    // was a no-op). The concurrent indexer's fresh publication is preserved.
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(0);
    // R164 (CONC-R164-01): root_fingerprint is still the concurrent value.
    expect(after.rootFp).toBe('CONCURRENT-PUBLISHED-FINGERPRINT');
  });

  it('CONC-R164-01b: CAS UPDATE returns info.changes=1 when fingerprint UNCHANGED (normal single-process case)', async () => {
    // Counter-test: when NO concurrent update happens, the CAS matches and
    // info.changes === 1. This is the normal single-process case.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Read the published fingerprint.
    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    const publishedRootFingerprint = row.rfp;
    dbRead.close();

    // NO concurrent update — run the CAS UPDATE immediately.
    const dbUpdate = new Database(dbPath);
    const info = dbUpdate.prepare(`
      UPDATE projects SET
        cross_file_calls_stale = 1,
        last_index_attempt_at = ?,
        last_index_error = ?
      WHERE name = ?
        AND root_fingerprint = ?
    `).run(new Date().toISOString(), 'normal stale msg', projectName, publishedRootFingerprint);
    dbUpdate.close();

    // R164 (CONC-R164-01): info.changes === 1 — the CAS matched, the UPDATE
    // wrote.
    expect(info.changes).toBe(1);

    // The DB's stale flag IS set.
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(1);
  });

  // ── STATE-R164-01 + STATE-R164-02 + CONC-R164-01: ROOT_IDENTITY_UNKNOWN ─
  //
  // R164 uses `WHERE name = ? AND root_fingerprint IS NULL` for the
  // ROOT_IDENTITY_UNKNOWN CAS. If info.changes === 0, either the projects
  // row is gone (no metadata despite structural data — partial DB) OR
  // another indexer populated root_fingerprint (concurrent publish). Both
  // are treated as PERSIST_FAILURE (we can't confirm the refusal was
  // recorded). The test below simulates "no projects row" by deleting it
  // after a full index (keeping edges so hasExistingGraphData=true).

  it('STATE-R164-01/02b + CONC-R164-01c: root identity unknown with no projects row → FAILED/PERSIST_FAILURE', async () => {
    // Run 1: full index from projectDir → DB has projects row + nodes +
    // edges + file_hashes + call_sites + imports + exports.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\nexport function b() { a(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    expect(countRows(dbPath, 'nodes')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    // Simulate a partial DB: delete nodes + file_hashes (R163's
    // hasExistingGraphData expanded to also check edges, so edges alone
    // still satisfy it). Then DELETE the projects row entirely. The
    // rootIdentityUnknown gate fires (publishedRootFingerprint=null,
    // hasExistingGraphData=true via edges). The CAS UPDATE
    // `WHERE name=? AND root_fingerprint IS NULL` matches 0 rows (no
    // projects row at all) → info.changes=0 → persistFailure=true →
    // FAILED/PERSIST_FAILURE.
    const db = new Database(dbPath);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM projects WHERE name = ?').run(projectName);
    db.close();

    // Verify the partial DB state.
    expect(projectsRowExists(dbPath)).toBe(false);
    expect(countRows(dbPath, 'nodes')).toBe(0);
    expect(countRows(dbPath, 'file_hashes')).toBe(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    // Run 2: incremental from same root → rootIdentityUnknown fires.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // R164 (STATE-R164-01 + STATE-R164-02 + CONC-R164-01): outcome = FAILED
    // with PERSIST_FAILURE (the CAS UPDATE matched 0 rows — no projects row
    // to mark stale).
    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('PERSIST_FAILURE');
    expect(r.failure!.phase).toBe('root-refusal-state');
    expect(r.failure!.message).toContain('Could not persist stale state');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.crossFileCallsStale).toBe(true);
    // R165 (OUTCOME-R165-01): recovery is 'none' (was 'full_reindex'). A
    // full_reindex recommendation when the DB write itself failed is
    // circular — the user must fix the DB issue first, then retry.
    expect(r.recovery).toBe('none');

    // R164 (API-R164-01): preservedSnapshot=true (structural data — edges —
    // exists and was not modified by the early return). The early return
    // does NOT touch nodes/edges/file_hashes/imports/exports/call_sites.
    expect(r.preservedSnapshot).toBe(true);
    // R164 (API-R164-01): publishedSnapshotPreserved=false — there's no
    // coherent snapshot (no projects row, no nodes, no file_hashes). This
    // is exactly the API-R164-01 distinction: a partial DB is NOT a
    // coherent published snapshot even though structural data exists.
    expect(r.publishedSnapshotPreserved).toBe(false);

    // R164 (STATE-R164-02): no projects row was created by the early return
    // (the CAS UPDATE was a no-op; the early return does NOT premark).
    expect(projectsRowExists(dbPath)).toBe(false);
    // R164 (STATE-R164-01): edges UNCHANGED — no structural mutation.
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);
  });

  // ── STATE-R164-03: Preserve last_index_error on stale runs without error ─
  //
  // R163-02 prevented `last_successful_index_at` from advancing on a stale
  // run with no error text. But the UPSERT's
  // `last_index_error = excluded.last_index_error` still CLEARED the prior
  // error when indexError=null was passed. R164 changes the clause to a
  // CASE WHEN: when the run is stale (excluded.cross_file_calls_stale=1)
  // AND the new error is NULL, preserve the prior `last_index_error`.
  //
  // The cleanest way to test this is to call `updateProjectStats` directly
  // with a known prior `last_index_error` and verify it's preserved. The
  // end-to-end deletion-only path also exercises this, but the premark
  // UPSERT (which runs BEFORE the deletion-only path's `updateProjectStats`
  // call) overwrites `last_index_error` with 'Index publication in
  // progress' — so the end-to-end test can only verify the premark value
  // is preserved, not an arbitrary prior error. The direct test below
  // verifies the CASE WHEN preserves an arbitrary prior error.

  it('STATE-R164-03a: last_index_error preserved on stale run with indexError=null (direct updateProjectStats call)', async () => {
    // Run 1: full index from projectDir → DB has projects row with
    // last_index_error=NULL (success).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();
    expect(fresh.lastError).toBeNull();  // success → no error

    // Simulate a prior failed run: set last_index_error to a diagnostic
    // message. This is the message we expect to be PRESERVED when
    // updateProjectStats is called with crossFileCallsStale=true AND
    // indexError=null.
    const priorErrorMsg = 'Prior failure: semantics version mismatch (simulated)';
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET last_index_error = ? WHERE name = ?').run(priorErrorMsg, projectName);
    db.close();

    // Verify the prior error is set.
    const withPrior = readProjectState(dbPath);
    expect(withPrior.lastError).toBe(priorErrorMsg);
    const successBefore = withPrior.lastSuccess;

    // Call updateProjectStats DIRECTLY with crossFileCallsStale=true AND
    // indexError=null — the R164-03 bug scenario. Without R164-03's CASE
    // WHEN, this would CLEAR last_index_error to NULL. With R164-03, the
    // prior error is preserved.
    const dbDirect = new Database(dbPath);
    updateProjectStats(
      dbDirect,
      projectName,
      projectDir,
      10,  // nodeCount (arbitrary)
      5,   // edgeCount (arbitrary)
      true,  // crossFileCallsStale=true (stale run)
      true,  // callSitesInitialized
      8,     // extractorSemanticsVersion (CURRENT)
      null,  // indexError=null — the bug scenario
      null,  // aliasHistoryInitialized (preserve)
      null,  // discoveryPolicyVersion (preserve)
      null,  // rootFingerprint (preserve)
    );
    dbDirect.close();

    // R164 (STATE-R164-03): last_index_error is PRESERVED — the prior
    // diagnostic is NOT cleared by the stale-without-error update.
    const after = readProjectState(dbPath);
    expect(after.lastError).toBe(priorErrorMsg);
    // R163-02 (carryover): last_successful_index_at was NOT advanced
    // (succeeded = indexError === null && !crossFileCallsStale = false).
    expect(after.lastSuccess).toBe(successBefore);
    // R164 (STATE-R164-03): cross_file_calls_stale is 1 (the stale flag
    // was written — updateProjectStats sets it to excluded value).
    expect(after.stale).toBe(1);
  });

  it('STATE-R164-03a-end-to-end: deletion-only stale-without-error run does NOT clear last_index_error', async () => {
    // End-to-end variant: the deletion-only path's updateProjectStats call
    // (crossFileStale=true, deletionError=null) does NOT clear the prior
    // last_index_error.
    //
    // R165 (STATE-R165-01): the premark UPSERT no longer writes
    // `last_index_error = 'Index publication in progress'`. So the prior
    // `last_index_error` (whatever it was before the run) is preserved
    // through the premark, and then the CASE WHEN in updateProjectStats
    // preserves it again (crossFileStale=true, indexError=null). To test
    // this end-to-end, we set a known prior error message BEFORE Run 2
    // and assert it survives the deletion-only run.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.lastError).toBeNull();
    const successBefore = fresh.lastSuccess;

    // R165 (STATE-R165-01): set a known prior error message. Under R164,
    // the premark would OVERWRITE this with 'Index publication in progress'
    // and the test would assert that premark value was preserved. Under
    // R165, the premark does NOT write last_index_error, so this prior
    // message survives the premark AND the updateProjectStats CASE WHEN.
    const priorErrorMsg = 'Prior failure: semantics version mismatch (simulated)';
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET call_sites_initialized = 0, cross_file_calls_stale = 1, last_index_error = ? WHERE name = ?').run(priorErrorMsg, projectName);
    db.close();

    // Delete b.ts to trigger the deletion-only path.
    unlinkSync(join(projectDir, 'b.ts'));

    // Run 2: incremental → deletion-only path.
    // R165 (STATE-R165-01): premark does NOT write last_index_error.
    // Then updateProjectStats(crossFileStale=true, deletionError=null).
    // R164-03 CASE WHEN: last_index_error is PRESERVED (not cleared to NULL).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);

    const after = readProjectState(dbPath);
    // R164 (STATE-R164-03) + R165 (STATE-R165-01): last_index_error is the
    // PRIOR message — the premark no longer overwrites it with 'Index
    // publication in progress', and the CASE WHEN preserves it on a
    // stale-without-error run.
    expect(after.lastError).not.toBeNull();
    expect(after.lastError).toBe(priorErrorMsg);
    // R165 (STATE-R165-01): the transitory 'Index publication in progress'
    // marker is GONE — it must NOT appear in the final last_index_error.
    expect(after.lastError).not.toBe('Index publication in progress');
    // R163-02 (carryover): last_successful_index_at was NOT advanced.
    expect(after.lastSuccess).toBe(successBefore);
    // R164 (STATE-R164-03): cross_file_calls_stale is still 1.
    expect(after.stale).toBe(1);
  });

  it('STATE-R164-03b: last_index_error is CLEARED on success (CASE WHEN does not over-preserve)', async () => {
    // Counter-test: on a SUCCESSFUL run, last_index_error MUST be cleared
    // (set to NULL). The CASE WHEN only preserves when
    // `excluded.cross_file_calls_stale=1 AND excluded.last_index_error IS
    // NULL`. On success, cross_file_calls_stale=0, so the ELSE branch
    // applies — last_index_error = excluded.last_index_error = NULL.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Set a prior error message.
    const priorErrorMsg = 'Prior failure: semantics version mismatch (simulated)';
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET last_index_error = ? WHERE name = ?').run(priorErrorMsg, projectName);
    db.close();

    // Modify a.ts to trigger the main path (extraction).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 999; }\n');

    // Run 2: incremental → main path → extraction → success.
    // crossFileCallsStale=false, indexError=null → succeeded=true →
    // last_successful_index_at=now, last_index_error=NULL.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('SUCCESS');
    expect(r.crossFileCallsStale).toBe(false);

    // R164 (STATE-R164-03): last_index_error is CLEARED on success.
    const after = readProjectState(dbPath);
    expect(after.lastError).toBeNull();
  });

  // ── API-R164-01: publishedSnapshotPreserved ─────────────────────────────
  //
  // R163 added `preservedSnapshot=true` to signal that a previous snapshot
  // exists in the DB. But on a partial DB (edges-only, no nodes/hashes),
  // `preservedSnapshot=true` is misleading — there's no coherent published
  // snapshot to query. R164 adds `publishedSnapshotPreserved` to distinguish
  // "structural data exists" from "a coherent published snapshot exists".

  it('API-R164-01a: publishedSnapshotPreserved=false on partial DB (edges-only, no nodes/hashes)', async () => {
    // Run 1: full index from projectDir — produces nodes, edges, file_hashes,
    // call_sites, imports, exports, and a projects row.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\nexport function b() { a(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    expect(countRows(dbPath, 'nodes')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'file_hashes')).toBeGreaterThan(0);
    expect(projectsRowExists(dbPath)).toBe(true);

    // Simulate an interrupted full index: delete nodes + file_hashes
    // (so no coherent snapshot) but LEAVE edges (so hasExistingGraphData=true
    // via the R163 expansion). Also NULL out root_fingerprint to trigger
    // the rootIdentityUnknown gate.
    const db = new Database(dbPath);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Verify the partial DB.
    expect(countRows(dbPath, 'nodes')).toBe(0);
    expect(countRows(dbPath, 'file_hashes')).toBe(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    // Run 2: incremental from same root → rootIdentityUnknown fires.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.crossFileCallsStale).toBe(true);

    // R164 (API-R164-01): preservedSnapshot=true — structural data (edges)
    // exists and was not modified.
    expect(r.preservedSnapshot).toBe(true);
    // R164 (API-R164-01): publishedSnapshotPreserved=FALSE — there is no
    // coherent published snapshot (no nodes, no file_hashes). This is the
    // key distinction: a partial DB is NOT a coherent snapshot.
    expect(r.publishedSnapshotPreserved).toBe(false);

    // The projects row still exists (R164's CAS UPDATE matched it because
    // root_fingerprint IS NULL) → stalePersisted=true → STALE (not FAILED).
    expect(projectsRowExists(dbPath)).toBe(true);
    // R164 (STATE-R164-02): DB stale=1 (the CAS UPDATE wrote).
    const after = readProjectState(dbPath);
    expect(after.stale).toBe(1);
  });

  it('API-R164-01b: publishedSnapshotPreserved=true on coherent DB (nodes + hashes + projects row)', async () => {
    // Run 1: full index → DB has nodes + edges + file_hashes + call_sites +
    // imports + exports + projects row with non-NULL root_fingerprint.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const nodesBefore = countRows(dbPath, 'nodes');
    const edgesBefore = countRows(dbPath, 'edges');
    const hashesBefore = countRows(dbPath, 'file_hashes');
    expect(nodesBefore).toBeGreaterThan(0);
    expect(edgesBefore).toBeGreaterThan(0);
    expect(hashesBefore).toBeGreaterThan(0);
    expect(projectsRowExists(dbPath)).toBe(true);

    // Move to a new root → ROOT_CHANGED fires.
    const newProjectDir = join(tmpDir, 'project-moved-r164-coherent');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from new root.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');

    // R164 (API-R164-01): preservedSnapshot=true — structural data exists
    // and was not modified.
    expect(r.preservedSnapshot).toBe(true);
    // R164 (API-R164-01): publishedSnapshotPreserved=TRUE — the DB has a
    // coherent published snapshot (nodes + file_hashes + projects row).
    expect(r.publishedSnapshotPreserved).toBe(true);

    // The DB still has the prior coherent snapshot (no structural mutation).
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
    expect(countRows(dbPath, 'edges')).toBe(edgesBefore);
    expect(countRows(dbPath, 'file_hashes')).toBe(hashesBefore);
    expect(projectsRowExists(dbPath)).toBe(true);
  });

  // ── Source-inspection regression guards ────────────────────────────────

  it('regression (STATE-R164-01): ROOT_CHANGED block returns FAILED/PERSIST_FAILURE on persist exception', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R164 (STATE-R164-01): the rootChanged block has a persistFailure flag.
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    // Find the STALE return (the second `outcome: 'STALE'` after the if).
    const staleReturnIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    expect(staleReturnIdx).toBeGreaterThan(rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, staleReturnIdx);
    // R164 (STATE-R164-01): the persistFailure flag is set in the catch.
    expect(block).toContain('let persistFailure = false;');
    expect(block).toContain('persistFailure = true;');
    // R164 (STATE-R164-01): the FAILED return is gated on persistFailure.
    expect(block).toContain('if (persistFailure) {');
    expect(block).toContain("outcome: 'FAILED',");
    expect(block).toContain("code: 'PERSIST_FAILURE',");
    expect(block).toContain("phase: 'root-refusal-state',");
  });

  it('regression (STATE-R164-02): ROOT_CHANGED block checks info.changes === 1', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    const staleReturnIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, staleReturnIdx);
    // R164 (STATE-R164-02): stalePersisted is set based on info.changes.
    expect(block).toContain('const info =');
    expect(block).toContain('if (info.changes === 1) {');
    expect(block).toContain('stalePersisted = true;');
    // R164 (STATE-R164-02): the old `stalePersisted = true` after `.run()` is GONE.
    expect(block).not.toMatch(/\.run\([^)]*\);\s*stalePersisted = true;/);
  });

  it('regression (CONC-R164-01): ROOT_CHANGED CAS WHERE clause includes root_fingerprint = ?', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R164 (CONC-R164-01): the rootChanged block has the CAS WHERE clause.
    // Slice from `if (rootChanged) {` to the STALE return's `recovery: 'full_reindex'`
    // (which appears in both FAILED and STALE returns — the SECOND occurrence is
    // the STALE return's, after the message we want to verify).
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    // Find the SECOND `recovery: 'full_reindex'` after `if (rootChanged) {`
    // (the first is in the FAILED return, the second is in the STALE return).
    const firstRecoveryIdx = src.indexOf("recovery: 'full_reindex',", rootChangedIfIdx);
    expect(firstRecoveryIdx).toBeGreaterThan(rootChangedIfIdx);
    const secondRecoveryIdx = src.indexOf("recovery: 'full_reindex',", firstRecoveryIdx + 1);
    expect(secondRecoveryIdx).toBeGreaterThan(firstRecoveryIdx);
    const block = src.slice(rootChangedIfIdx, secondRecoveryIdx);
    // R164 (CONC-R164-01): the CAS WHERE clause includes root_fingerprint = ?.
    expect(block).toContain('WHERE name = ?');
    expect(block).toContain('AND root_fingerprint = ?');
    // R164 (CONC-R164-01): the CAS UPDATE passes publishedRootFingerprint.
    expect(block).toContain('publishedRootFingerprint');
    // R164 (CONC-R164-01): the concurrentUpdate flag is set when info.changes !== 1.
    expect(block).toContain('let concurrentUpdate = false;');
    expect(block).toContain('concurrentUpdate = true;');
    // R164 (CONC-R164-01): the STALE return's message uses a nested ternary
    // that distinguishes concurrent update from persist failure.
    expect(block).toContain('concurrentUpdate');
    expect(block).toContain("' [WARNING: concurrent update");
    expect(block).toContain("' [WARNING: stale flag could not be persisted to DB]");
  });

  it('regression (STATE-R164-01/02 + CONC-R164-01): ROOT_IDENTITY_UNKNOWN block uses CAS WHERE root_fingerprint IS NULL and returns FAILED on info.changes=0', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    // The block has TWO STALE returns and ONE FAILED return. R165 added a
    // concurrentPublishedCurrentRoot STALE return BEFORE the FAILED return.
    // To slice a block that includes the FAILED return, we need to find the
    // SECOND `outcome: 'STALE'` (the final STALE return at the end of the
    // block, which is the stalePersisted=true case). The slice from
    // `if (rootIdentityUnknown) {` to that second STALE return includes
    // both the concurrentPublishedCurrentRoot STALE return AND the FAILED
    // return.
    const firstStaleReturnIdx = src.indexOf("outcome: 'STALE',", rootIdentityUnknownIfIdx);
    expect(firstStaleReturnIdx).toBeGreaterThan(rootIdentityUnknownIfIdx);
    const staleReturnIdx = src.indexOf("outcome: 'STALE',", firstStaleReturnIdx + 1);
    expect(staleReturnIdx).toBeGreaterThan(firstStaleReturnIdx);
    const block = src.slice(rootIdentityUnknownIfIdx, staleReturnIdx);
    // R164 (CONC-R164-01): the CAS WHERE clause includes root_fingerprint IS NULL.
    expect(block).toContain('WHERE name = ?');
    expect(block).toContain('AND root_fingerprint IS NULL');
    // R164 (STATE-R164-02): stalePersisted is set based on info.changes.
    expect(block).toContain('const info =');
    expect(block).toContain('if (info.changes === 1) {');
    expect(block).toContain('stalePersisted = true;');
    // R164 (STATE-R164-01 + CONC-R164-01): the FAILED return is gated on
    // `!stalePersisted || persistFailure` (covers both exception and
    // info.changes=0).
    expect(block).toContain('if (!stalePersisted || persistFailure) {');
    expect(block).toContain("outcome: 'FAILED',");
    expect(block).toContain("code: 'PERSIST_FAILURE',");
    expect(block).toContain("phase: 'root-refusal-state',");
  });

  it('regression (STATE-R164-03): updateProjectStats uses CASE WHEN for last_index_error preservation', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'schema.ts'), 'utf8');
    // R164 (STATE-R164-03): the updateProjectStats function uses a CASE WHEN
    // for last_index_error.
    const fnStart = src.indexOf('export function updateProjectStats(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    // R164 (STATE-R164-03): the CASE WHEN preserves last_index_error when
    // the run is stale AND the new error is NULL.
    expect(fnBody).toContain('last_index_error = CASE');
    expect(fnBody).toContain('WHEN excluded.cross_file_calls_stale = 1 AND excluded.last_index_error IS NULL');
    expect(fnBody).toContain('THEN last_index_error');
    expect(fnBody).toContain('ELSE excluded.last_index_error');
    expect(fnBody).toContain('END,');
    // R164 (STATE-R164-03): the old unconditional
    // `last_index_error = excluded.last_index_error` is GONE from
    // updateProjectStats.
    expect(fnBody).not.toMatch(/^\s*last_index_error = excluded\.last_index_error,$/m);
    // Sanity: commitAliasStateAtomically (the success path) still uses the
    // unconditional `last_index_error = excluded.last_index_error` — R164
    // only changed updateProjectStats.
    const commitFnStart = src.indexOf('export function commitAliasStateAtomically(');
    expect(commitFnStart).toBeGreaterThan(-1);
    const commitFnEnd = src.indexOf('\n}\n', commitFnStart);
    const commitFnBody = src.slice(commitFnStart, commitFnEnd);
    expect(commitFnBody).toContain('last_index_error = excluded.last_index_error,');
  });

  it('regression (API-R164-01): publishedSnapshotPreserved field on IndexResult + hasPublishedSnapshot computed in both early returns', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R164 (API-R164-01): the IndexResult interface declares publishedSnapshotPreserved.
    expect(src).toContain('publishedSnapshotPreserved?: boolean');
    // R164 (API-R164-01): the field is documented with the R164 tag.
    expect(src).toContain('R164 (API-R164-01): Distinguishes "structural data exists" from');
    // R164 (API-R164-01): hasPublishedSnapshot is computed in BOTH early
    // returns. Count occurrences of the computation — should be at least 2.
    const matches = src.match(/const hasPublishedSnapshot = projectState !== undefined/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    // R164 (API-R164-01): hasPublishedSnapshot checks both nodes AND file_hashes.
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ? LIMIT 1) AS e');
    expect(src).toContain('SELECT EXISTS(SELECT 1 FROM file_hashes WHERE project = ? LIMIT 1) AS e');
    // R164 (API-R164-01): publishedSnapshotPreserved is set on BOTH early
    // returns (and on the FAILED returns). Count occurrences — should be
    // at least 4 (2 STALE + 2 FAILED).
    const setMatches = src.match(/publishedSnapshotPreserved:\s*hasPublishedSnapshot/g);
    expect(setMatches).not.toBeNull();
    expect(setMatches!.length).toBeGreaterThanOrEqual(4);
  });

  it('regression: package.json version is 0.70.0 (R165 bump)', () => {
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).toContain('"version": "0.70.0"');
  });
});
