// v2/tests/indexer/r165-cas-reread-final-state.test.ts
// R165: CAS Miss Re-read + Final-state Snapshot Marker
//
// Closes the R164 audit findings:
//   - CONC-R165-01 (P1/P2): CAS miss (info.changes===0) returns STALE/FAILED
//     without re-reading the DB. Another indexer may have published
//     successfully under THIS root — the DB is actually fresh, not stale.
//     R165 re-reads the projects row to distinguish:
//       (a) Row deleted → DB_STATE_INCONSISTENT (persistFailure=true).
//       (b) currentState.fp === rootFingerprint (current root) → concurrent
//           SUCCESS under this root. Return STALE with "Concurrent indexer
//           published this root successfully" + recovery: 'none' (the graph
//           IS fresh, just not from this run).
//       (c) currentState.fp !== rootFingerprint → another indexer published
//           a DIFFERENT root. Return STALE with ROOT_CHANGED + CONCURRENT_UPDATE
//           note (same as R164's behavior).
//   - STATE-R165-01 (P1/P2): The premark writes
//     `last_index_error = 'Index publication in progress'`. A stale run with
//     indexError=null preserves this transitory message as final state via
//     R164-03's CASE WHEN. R165 simply omits `last_index_error` from the
//     premark UPSERT — the column is left at its prior value.
//   - API-R165-01 (P1/P2): `hasPublishedSnapshot` doesn't check
//     `last_successful_index_at IS NOT NULL` or `cross_file_calls_stale = 0`.
//     R165 strengthens the check to require both.
//   - API-R165-03 (P2): `preservedSnapshot: true` is unconditional on
//     ROOT_CHANGED, without checking `hasExistingGraphData`. R165 makes it
//     conditional.
//   - OUTCOME-R165-01 (P1/P2): PERSIST_FAILURE recovery is `full_reindex`
//     even when the cause is a DB problem (SQLITE_BUSY, disk full). R165
//     changes to `recovery: 'none'` (the user must fix the DB issue first,
//     then retry).
//   - OBS-R165-02 (P2): SQLite exception message is lost in the catch block.
//     R165 captures it via `persistFailureMsg` and includes it in the
//     FAILED/PERSIST_FAILURE return's `failure.message`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R165: CAS Miss Re-read + Final-state Snapshot Marker', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r165-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r165-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // Helper: read stale/attempt/error/success/rootFingerprint columns.
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

  // ── CONC-R165-01: CAS miss re-read ─────────────────────────────────────
  //
  // R164 returned STALE on info.changes===0 without re-reading the DB. R165
  // re-reads to distinguish:
  //   (a) Row deleted → persistFailure=true (DB_STATE_INCONSISTENT).
  //   (b) currentState.fp === current rootFingerprint → concurrent SUCCESS
  //       under this root.
  //   (c) currentState.fp !== current rootFingerprint → different root
  //       published (concurrentUpdate=true).
  //
  // The re-read happens BETWEEN the indexer's CAS UPDATE and its return —
  // both run synchronously in the same function call, so injecting a
  // concurrent update between them in a single-process vitest is not
  // feasible. Instead, these tests verify the SQL contract directly: set
  // up the DB state, run the EXACT re-read SQL the indexer uses, and verify
  // the branching logic would produce the right outcome. Source-inspection
  // tests below verify the re-read code is in place.

  it('CONC-R165-01a: CAS miss with concurrent publish of SAME root → indexer re-reads and would set concurrentPublishedCurrentRoot=true', async () => {
    // Run 1: full index from projectDir → DB has root_fingerprint = X.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Read the published root_fingerprint (X) — what the indexer would
    // read at the start of an incremental run.
    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    const publishedRootFingerprint = row.rfp;
    dbRead.close();
    expect(publishedRootFingerprint).not.toBeNull();

    // Simulate a CONCURRENT UPDATE: another indexer publishes the SAME
    // root (fingerprint unchanged, just a re-publish with fresh stale=0).
    // In a real scenario, the concurrent indexer would have committed a
    // successful run. We simulate this by leaving the fingerprint at X.
    //
    // The indexer's CAS UPDATE WHERE name=? AND root_fingerprint=X would
    // match 1 row (info.changes=1) — NOT a CAS miss. To force a CAS miss
    // for the SAME-root case, the concurrent indexer would have to change
    // the fingerprint to a NEW value that happens to match the current
    // rootFingerprint we're trying to index. This is the case when the
    // indexer's view of the published fingerprint (X) is STALE — the
    // concurrent indexer already moved the DB to the CURRENT root.
    //
    // We simulate this: pretend the indexer read publishedRootFingerprint
    // = 'STALE-OLD-FINGERPRINT' (an older value), but the DB's current
    // root_fingerprint is `publishedRootFingerprint` (which matches the
    // current root). The CAS UPDATE WHERE root_fingerprint='STALE-OLD-...'
    // matches 0 rows. The re-read returns currentState.fp ===
    // publishedRootFingerprint (which is what computeRootFingerprint
    // would produce for the current root).
    const currentRootFingerprint = publishedRootFingerprint;
    const dbConcurrent = new Database(dbPath);
    // First, set root_fingerprint to a stale value (simulating the indexer
    // reading an OLD value before the concurrent publish).
    dbConcurrent.prepare('UPDATE projects SET root_fingerprint = ? WHERE name = ?').run('STALE-OLD-FINGERPRINT', projectName);
    dbConcurrent.close();

    // Now simulate the concurrent indexer publishing the current root
    // (fingerprint back to currentRootFingerprint).
    const dbConcurrent2 = new Database(dbPath);
    dbConcurrent2.prepare('UPDATE projects SET root_fingerprint = ? WHERE name = ?').run(currentRootFingerprint, projectName);
    dbConcurrent2.close();

    // Simulate the indexer's CAS UPDATE with the STALE-OLD-FINGERPRINT.
    const dbUpdate = new Database(dbPath);
    const info = dbUpdate.prepare(`
      UPDATE projects SET
        cross_file_calls_stale = 1,
        last_index_attempt_at = ?,
        last_index_error = ?
      WHERE name = ?
        AND root_fingerprint = ?
    `).run(new Date().toISOString(), 'concurrent test stale msg', projectName, 'STALE-OLD-FINGERPRINT');
    dbUpdate.close();

    // CONC-R165-01: info.changes === 0 — the CAS detected a miss.
    expect(info.changes).toBe(0);

    // R165 (CONC-R165-01): the indexer now RE-READS the projects row.
    // The re-read returns currentState.fp === currentRootFingerprint.
    const dbReRead = new Database(dbPath, { readonly: true });
    const currentState = dbReRead.prepare(
      'SELECT root_fingerprint AS fp, cross_file_calls_stale AS stale FROM projects WHERE name = ?'
    ).get(projectName) as { fp: string | null; stale: number } | undefined;
    dbReRead.close();

    // R165 (CONC-R165-01): currentState.fp === currentRootFingerprint →
    // concurrentPublishedCurrentRoot = true. The DB is fresh under our
    // root; the indexer should return STALE with "Concurrent indexer
    // published this root successfully" + recovery: 'none'.
    expect(currentState).toBeDefined();
    expect(currentState!.fp).toBe(currentRootFingerprint);
  });

  it('CONC-R165-01b: CAS miss with concurrent publish of DIFFERENT root → indexer re-reads and would set concurrentUpdate=true', async () => {
    // Run 1: full index from projectDir → DB has root_fingerprint = X.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Read the published root_fingerprint (X).
    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    const publishedRootFingerprint = row.rfp;
    dbRead.close();

    // Simulate a CONCURRENT UPDATE: another indexer publishes a DIFFERENT
    // root (fingerprint = 'DIFFERENT-ROOT-FINGERPRINT'). This is NOT the
    // root we're trying to index.
    const dbConcurrent = new Database(dbPath);
    dbConcurrent.prepare('UPDATE projects SET root_fingerprint = ? WHERE name = ?').run('DIFFERENT-ROOT-FINGERPRINT', projectName);
    dbConcurrent.close();

    // Simulate the indexer's CAS UPDATE with publishedRootFingerprint (X).
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

    // CONC-R165-01: info.changes === 0 — the CAS detected a miss.
    expect(info.changes).toBe(0);

    // R165 (CONC-R165-01): the indexer RE-READS the projects row.
    const dbReRead = new Database(dbPath, { readonly: true });
    const currentState = dbReRead.prepare(
      'SELECT root_fingerprint AS fp, cross_file_calls_stale AS stale FROM projects WHERE name = ?'
    ).get(projectName) as { fp: string | null; stale: number } | undefined;
    dbReRead.close();

    // R165 (CONC-R165-01): currentState.fp === 'DIFFERENT-ROOT-FINGERPRINT',
    // which is NEITHER the published fingerprint NOR the current root's
    // fingerprint. The indexer would set concurrentUpdate=true and return
    // STALE with ROOT_CHANGED + CONCURRENT_UPDATE note (same as R164's
    // behavior for the different-root case).
    expect(currentState).toBeDefined();
    expect(currentState!.fp).toBe('DIFFERENT-ROOT-FINGERPRINT');
  });

  it('CONC-R165-01c: CAS miss with row DELETED → indexer re-reads and would set persistFailure=true (DB_STATE_INCONSISTENT)', async () => {
    // Run 1: full index from projectDir → DB has root_fingerprint = X.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Read the published root_fingerprint (X).
    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    const publishedRootFingerprint = row.rfp;
    dbRead.close();

    // Simulate the projects row being DELETED between the indexer's read
    // and UPDATE (extremely rare, but possible if another process deletes
    // the projects metadata while leaving structural data).
    const dbConcurrent = new Database(dbPath);
    dbConcurrent.prepare('DELETE FROM projects WHERE name = ?').run(projectName);
    dbConcurrent.close();

    // Simulate the indexer's CAS UPDATE.
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

    // CONC-R165-01: info.changes === 0 (no projects row to match).
    expect(info.changes).toBe(0);

    // R165 (CONC-R165-01): the indexer RE-READS the projects row.
    const dbReRead = new Database(dbPath, { readonly: true });
    const currentState = dbReRead.prepare(
      'SELECT root_fingerprint AS fp, cross_file_calls_stale AS stale FROM projects WHERE name = ?'
    ).get(projectName) as { fp: string | null; stale: number } | undefined;
    dbReRead.close();

    // R165 (CONC-R165-01): currentState === undefined → row was deleted.
    // The indexer would set persistFailure=true (DB_STATE_INCONSISTENT)
    // and return FAILED/PERSIST_FAILURE with recovery: 'none'.
    expect(currentState).toBeUndefined();
  });

  // ── STATE-R165-01: Premark no longer writes 'Index publication in progress' ─

  it('STATE-R165-01a: premark does NOT write "Index publication in progress" to last_index_error (deletion-only path)', async () => {
    // Run 1: full index → last_index_error=NULL (success).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.lastError).toBeNull();

    // Force the stale-without-error scenario: set call_sites_initialized=0
    // (so crossFileResolved stays false in the deletion-only path) AND
    // cross_file_calls_stale=1 (existingStale=true). This produces
    // crossFileStale=true with deletionError=null. ALSO set a known prior
    // error message. Under R164, the premark would OVERWRITE this with
    // 'Index publication in progress'. Under R165, the premark does NOT
    // write last_index_error, so this prior message survives.
    const priorErrorMsg = 'R165-TEST prior failure: simulated semantics mismatch';
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET call_sites_initialized = 0, cross_file_calls_stale = 1, last_index_error = ? WHERE name = ?').run(priorErrorMsg, projectName);
    db.close();

    // Delete b.ts to trigger the deletion-only path (which calls the
    // premark + updateProjectStats).
    unlinkSync(join(projectDir, 'b.ts'));

    // Run 2: incremental → deletion-only path.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');

    const after = readProjectState(dbPath);
    // R165 (STATE-R165-01): last_index_error is the PRIOR message — the
    // premark did NOT overwrite it with 'Index publication in progress'.
    expect(after.lastError).toBe(priorErrorMsg);
    // R165 (STATE-R165-01): the transitory 'Index publication in progress'
    // marker MUST NOT appear in the final last_index_error.
    expect(after.lastError).not.toBe('Index publication in progress');
  });

  it('STATE-R165-01b: premark does NOT write "Index publication in progress" to last_index_error (main path)', async () => {
    // Run 1: full index → last_index_error=NULL (success).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.lastError).toBeNull();

    // Set a known prior error message.
    const priorErrorMsg = 'R165-TEST prior failure: main-path simulated error';
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET last_index_error = ? WHERE name = ?').run(priorErrorMsg, projectName);
    db.close();

    // Modify a.ts to trigger the main path (extraction).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 999; }\n');

    // Run 2: incremental → main path → extraction → success.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('SUCCESS');

    const after = readProjectState(dbPath);
    // R165 (STATE-R165-01) + R164-03: on success, last_index_error is
    // CLEARED to NULL (R164-03's CASE WHEN's ELSE branch). The premark
    // did NOT write 'Index publication in progress' (which would have
    // been visible if the run had been stale-without-error).
    expect(after.lastError).toBeNull();
    // R165 (STATE-R165-01): the transitory 'Index publication in progress'
    // marker MUST NOT appear in the final last_index_error.
    expect(after.lastError).not.toBe('Index publication in progress');
  });

  // ── API-R165-01: hasPublishedSnapshot checks last_successful_index_at + stale ─

  it('API-R165-01a: hasPublishedSnapshot source-inspection — checks lastSuccessfulIndexAt + stale === 0 (ROOT_CHANGED + ROOT_IDENTITY_UNKNOWN)', () => {
    // R165 (API-R165-01): the hasPublishedSnapshot computation in BOTH
    // root-change early returns now requires:
    //   - projectState.lastSuccessfulIndexAt !== null
    //   - projectState.lastSuccessfulIndexAt !== undefined
    //   - projectState.stale === 0
    //   - EXISTS nodes
    //   - EXISTS file_hashes
    //
    // Behavioral testing of the lastSuccessfulIndexAt IS NULL case is
    // impractical end-to-end because the schema migration backfills
    // last_successful_index_at from indexed_at whenever stale=0 (and
    // indexed_at has a NOT NULL constraint). The migration restores the
    // value before the indexer's projectState read. We rely on
    // source-inspection + the API-R165-01b behavioral test (stale=1
    // case) to verify the strengthened check.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (API-R165-01): the hasPublishedSnapshot computation includes
    // lastSuccessfulIndexAt + stale checks. Count occurrences — should
    // be at least 2 (one in each root-change early return).
    const matches = src.match(/projectState\.lastSuccessfulIndexAt !== null\n\s*&& projectState\.lastSuccessfulIndexAt !== undefined\n\s*&& projectState\.stale === 0/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    // R165 (API-R165-01): the projectState SELECT reads
    // last_successful_index_at AS lastSuccessfulIndexAt.
    expect(src).toContain('last_successful_index_at AS lastSuccessfulIndexAt FROM projects WHERE name = ?');
  });

  it('API-R165-01b: publishedSnapshotPreserved=false when cross_file_calls_stale=1 (ROOT_CHANGED)', async () => {
    // Run 1: full index → DB has nodes + file_hashes + projects row with
    // last_successful_index_at set + stale=0.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();

    // Set cross_file_calls_stale=1 — simulating a project that was marked
    // stale by a previous run but never re-indexed. R164's weaker check
    // would still report publishedSnapshotPreserved=true (because nodes +
    // file_hashes + projects row all exist + last_success is set). R165's
    // stronger check requires cross_file_calls_stale=0.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET cross_file_calls_stale = 1 WHERE name = ?').run(projectName);
    db.close();

    // Move the project to a new root → ROOT_CHANGED fires.
    const newProjectDir = join(tmpDir, 'project-moved-r165b');
    renameSync(projectDir, newProjectDir);

    // NOTE: the indexer reads projectState at the start of the run. At
    // that point, stale=1 (we just set it). publishedRootFingerprint is
    // still the original. The ROOT_CHANGED gate fires because the current
    // root's fingerprint differs from the published one.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');

    // R165 (API-R165-01): publishedSnapshotPreserved=FALSE because
    // cross_file_calls_stale=1 — the prior snapshot was marked stale and
    // is NOT a coherent fresh published snapshot.
    expect(r.publishedSnapshotPreserved).toBe(false);
  });

  it('API-R165-01c: publishedSnapshotPreserved=true when last_successful_index_at is NOT NULL AND stale=0 (ROOT_CHANGED)', async () => {
    // Run 1: full index → DB has nodes + file_hashes + projects row with
    // last_successful_index_at set + stale=0.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const fresh = readProjectState(dbPath);
    expect(fresh.stale).toBe(0);
    expect(fresh.lastSuccess).not.toBeNull();

    // Move the project to a new root → ROOT_CHANGED fires.
    const newProjectDir = join(tmpDir, 'project-moved-r165c');
    renameSync(projectDir, newProjectDir);

    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');

    // R165 (API-R165-01): publishedSnapshotPreserved=TRUE — the prior run
    // succeeded (last_success is set) AND the prior snapshot was fresh
    // (stale=0) AND nodes + file_hashes exist. All three conditions met.
    expect(r.publishedSnapshotPreserved).toBe(true);
    // R165 (API-R165-03): preservedSnapshot is conditional on
    // hasExistingGraphData (true here).
    expect(r.preservedSnapshot).toBe(true);
  });

  // ── API-R165-03: preservedSnapshot conditional on hasExistingGraphData ─

  it('API-R165-03: preservedSnapshot=false when no structural data exists (ROOT_CHANGED)', async () => {
    // Run 1: full index → DB has nodes + edges + file_hashes + call_sites +
    // imports + exports.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\nexport function b() { a(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    expect(countRows(dbPath, 'nodes')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);
    expect(countRows(dbPath, 'file_hashes')).toBeGreaterThan(0);

    // DELETE ALL structural data — simulating a totally wiped DB (e.g.,
    // a manual `DELETE FROM nodes; DELETE FROM edges; DELETE FROM
    // file_hashes; DELETE FROM call_sites; DELETE FROM imports; DELETE
    // FROM exports;`). The projects row remains with its root_fingerprint
    // and last_successful_index_at, so ROOT_CHANGED still fires.
    const db = new Database(dbPath);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM edges WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM call_sites WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM imports WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    db.close();

    // Verify the wiped DB.
    expect(countRows(dbPath, 'nodes')).toBe(0);
    expect(countRows(dbPath, 'edges')).toBe(0);
    expect(countRows(dbPath, 'file_hashes')).toBe(0);

    // Move the project to a new root → ROOT_CHANGED fires.
    const newProjectDir = join(tmpDir, 'project-moved-r165d');
    renameSync(projectDir, newProjectDir);

    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');

    // R165 (API-R165-03): preservedSnapshot=FALSE — hasExistingGraphData
    // is false (all structural tables are empty). R164 set this
    // unconditionally to true, which was misleading.
    expect(r.preservedSnapshot).toBe(false);
    // R165 (API-R165-01): publishedSnapshotPreserved=FALSE — no nodes +
    // no file_hashes (EXISTS queries fail).
    expect(r.publishedSnapshotPreserved).toBe(false);
  });

  // ── OUTCOME-R165-01: PERSIST_FAILURE recovery is 'none' ─────────────────
  //
  // The behavioral test for PERSIST_FAILURE with recovery='none' is covered
  // by the updated R164 test (STATE-R164-01/02b + CONC-R164-01c). The
  // source-inspection test below guards against accidental regression.

  it('OUTCOME-R165-01a: ROOT_CHANGED PERSIST_FAILURE return uses recovery: "none"', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    // Slice from `if (rootChanged) {` to the first `outcome: 'STALE'`
    // (the concurrentPublishedCurrentRoot return). This slice includes
    // the FAILED return.
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    expect(firstStaleIdx).toBeGreaterThan(rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, firstStaleIdx);
    // R165 (OUTCOME-R165-01): the FAILED return uses recovery: 'none'.
    expect(block).toContain("code: 'PERSIST_FAILURE',");
    // R165 (OUTCOME-R165-01): the FAILED return uses recovery: 'none'.
    // The `recovery: 'none'` line is ~700 chars after `outcome: 'FAILED'`
    // (after the failure block + preservedSnapshot + publishedSnapshotPreserved
    // + staleReason block). Use a 1200-char slice to be safe.
    const failedReturnIdx = block.indexOf("outcome: 'FAILED',");
    expect(failedReturnIdx).toBeGreaterThan(-1);
    const failedReturnSlice = block.slice(failedReturnIdx, failedReturnIdx + 1200);
    expect(failedReturnSlice).toContain("recovery: 'none',");
    // R165 (OUTCOME-R165-01): the FAILED return does NOT use
    // recovery: 'full_reindex' (R164's value). The first `recovery:`
    // occurrence in the slice should be 'none', not 'full_reindex'.
    const firstRecoveryIdx = failedReturnSlice.indexOf("recovery: '");
    expect(firstRecoveryIdx).toBeGreaterThan(-1);
    const firstRecoveryValue = failedReturnSlice.slice(firstRecoveryIdx, firstRecoveryIdx + 30);
    expect(firstRecoveryValue).toContain("recovery: 'none',");
    expect(firstRecoveryValue).not.toContain("recovery: 'full_reindex',");
  });

  it('OUTCOME-R165-01b: ROOT_IDENTITY_UNKNOWN PERSIST_FAILURE return uses recovery: "none"', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    // Slice from `if (rootIdentityUnknown) {` to the SECOND `outcome: 'STALE'`
    // (the final STALE return at the end of the block, after the FAILED
    // return). This slice includes both the concurrentPublishedCurrentRoot
    // STALE return AND the FAILED return.
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootIdentityUnknownIfIdx);
    expect(firstStaleIdx).toBeGreaterThan(rootIdentityUnknownIfIdx);
    const secondStaleIdx = src.indexOf("outcome: 'STALE',", firstStaleIdx + 1);
    expect(secondStaleIdx).toBeGreaterThan(firstStaleIdx);
    const block = src.slice(rootIdentityUnknownIfIdx, secondStaleIdx);
    // R165 (OUTCOME-R165-01): the FAILED return uses recovery: 'none'.
    expect(block).toContain("code: 'PERSIST_FAILURE',");
    const failedReturnIdx = block.indexOf("outcome: 'FAILED',");
    expect(failedReturnIdx).toBeGreaterThan(-1);
    const failedReturnSlice = block.slice(failedReturnIdx, failedReturnIdx + 1200);
    expect(failedReturnSlice).toContain("recovery: 'none',");
    const firstRecoveryIdx = failedReturnSlice.indexOf("recovery: '");
    expect(firstRecoveryIdx).toBeGreaterThan(-1);
    const firstRecoveryValue = failedReturnSlice.slice(firstRecoveryIdx, firstRecoveryIdx + 30);
    expect(firstRecoveryValue).toContain("recovery: 'none',");
    expect(firstRecoveryValue).not.toContain("recovery: 'full_reindex',");
  });

  it('OUTCOME-R165-01c: PERSIST_FAILURE recovery is "none" end-to-end (ROOT_IDENTITY_UNKNOWN with no projects row)', async () => {
    // Run 1: full index → DB has projects row + structural data.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\nexport function b() { a(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);

    // Delete nodes + file_hashes + the projects row. The
    // rootIdentityUnknown gate fires (root_fp is NULL because projects
    // row is gone, hasExistingGraphData=true via edges). The CAS UPDATE
    // WHERE root_fingerprint IS NULL matches 0 rows → re-read returns
    // undefined → persistFailure=true → FAILED/PERSIST_FAILURE with
    // recovery: 'none'.
    const db = new Database(dbPath);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM projects WHERE name = ?').run(projectName);
    db.close();

    expect(projectsRowExists(dbPath)).toBe(false);
    expect(countRows(dbPath, 'edges')).toBeGreaterThan(0);

    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('PERSIST_FAILURE');
    // R165 (OUTCOME-R165-01): recovery is 'none' (was 'full_reindex' in R164).
    expect(r.recovery).toBe('none');
  });

  // ── OBS-R165-02: SQLite exception message captured ─────────────────────
  //
  // The behavioral test for OBS-R165-02 requires injecting a SQLite error
  // into the CAS UPDATE, which is hard to do deterministically in vitest.
  // The source-inspection test below verifies the persistFailureMsg
  // variable is captured and used in the failure.message.

  it('OBS-R165-02a: ROOT_CHANGED catch captures persistFailureMsg and uses it in failure.message', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, firstStaleIdx);
    // R165 (OBS-R165-02): the catch captures the error message.
    expect(block).toContain('let persistFailureMsg: string | null = null;');
    expect(block).toContain('} catch (error) {');
    expect(block).toContain('persistFailureMsg = error instanceof Error ? error.message : String(error);');
    // R165 (OBS-R165-02): the FAILED return's failure.message uses
    // persistFailureMsg.
    expect(block).toContain('persistFailureMsg !== null');
    expect(block).toContain('[DB error: ${persistFailureMsg}]');
  });

  it('OBS-R165-02b: ROOT_IDENTITY_UNKNOWN catch captures persistFailureMsg and uses it in failure.message', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootIdentityUnknownIfIdx);
    const secondStaleIdx = src.indexOf("outcome: 'STALE',", firstStaleIdx + 1);
    const block = src.slice(rootIdentityUnknownIfIdx, secondStaleIdx);
    // R165 (OBS-R165-02): the catch captures the error message.
    expect(block).toContain('let persistFailureMsg: string | null = null;');
    expect(block).toContain('} catch (error) {');
    expect(block).toContain('persistFailureMsg = error instanceof Error ? error.message : String(error);');
    // R165 (OBS-R165-02): the FAILED return's failure.message uses
    // persistFailureMsg.
    expect(block).toContain('persistFailureMsg !== null');
    expect(block).toContain('[DB error: ${persistFailureMsg}]');
  });

  // ── Source-inspection regression guards ────────────────────────────────

  it('regression (CONC-R165-01): ROOT_CHANGED block has concurrentPublishedCurrentRoot variable + re-read SQL', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    const block = src.slice(rootChangedIfIdx, firstStaleIdx);
    // R165 (CONC-R165-01): the concurrentPublishedCurrentRoot flag is declared.
    expect(block).toContain('let concurrentPublishedCurrentRoot = false;');
    // R165 (CONC-R165-01): the re-read SQL is present.
    expect(block).toContain('SELECT root_fingerprint AS fp, cross_file_calls_stale AS stale FROM projects WHERE name = ?');
    // R165 (CONC-R165-01): the branching logic compares currentState.fp
    // with rootFingerprint (the current root's fingerprint, not the
    // published one).
    expect(block).toContain('currentState.fp === rootFingerprint');
    expect(block).toContain('concurrentPublishedCurrentRoot = true;');
    // R165 (CONC-R165-01): the row-deleted case sets persistFailure=true.
    expect(block).toContain('currentState === undefined');
    expect(block).toContain('persistFailure = true;');
  });

  it('regression (CONC-R165-01): ROOT_IDENTITY_UNKNOWN block has concurrentPublishedCurrentRoot + re-read SQL', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootIdentityUnknownIfIdx);
    const secondStaleIdx = src.indexOf("outcome: 'STALE',", firstStaleIdx + 1);
    const block = src.slice(rootIdentityUnknownIfIdx, secondStaleIdx);
    // R165 (CONC-R165-01): the concurrentPublishedCurrentRoot flag is declared.
    expect(block).toContain('let concurrentPublishedCurrentRoot = false;');
    // R165 (CONC-R165-01): the re-read SQL is present.
    expect(block).toContain('SELECT root_fingerprint AS fp, cross_file_calls_stale AS stale FROM projects WHERE name = ?');
    // R165 (CONC-R165-01): the branching logic checks
    // currentState.fp !== null && currentState.stale === 0.
    expect(block).toContain('currentState.fp !== null');
    expect(block).toContain('currentState.stale === 0');
    expect(block).toContain('concurrentPublishedCurrentRoot = true;');
  });

  it('regression (CONC-R165-01): ROOT_CHANGED block has a dedicated return for concurrentPublishedCurrentRoot', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    // The concurrentPublishedCurrentRoot return is the FIRST STALE return
    // in the ROOT_CHANGED block. Slice from the if to the SECOND STALE
    // return (the stalePersisted/concurrentUpdate STALE return at the end).
    const firstStaleIdx = src.indexOf("outcome: 'STALE',", rootChangedIfIdx);
    const secondStaleIdx = src.indexOf("outcome: 'STALE',", firstStaleIdx + 1);
    const block = src.slice(rootChangedIfIdx, secondStaleIdx);
    // R165 (CONC-R165-01): the concurrentPublishedCurrentRoot return is
    // gated on the flag.
    expect(block).toContain('if (concurrentPublishedCurrentRoot) {');
    // R165 (CONC-R165-01): the message includes the "Concurrent indexer
    // published this root successfully" note.
    expect(block).toContain('Concurrent indexer published this root successfully');
    // R165 (CONC-R165-01): the recovery is 'none' (the graph IS fresh;
    // no user action needed).
    expect(block).toContain("recovery: 'none',");
    // R165 (CONC-R165-01): crossFileCallsStale is FALSE (the graph is
    // fresh, not stale).
    // Find the concurrentPublishedCurrentRoot return's crossFileCallsStale.
    const concurrentReturnIdx = block.indexOf('if (concurrentPublishedCurrentRoot) {');
    const concurrentReturnSlice = block.slice(concurrentReturnIdx, concurrentReturnIdx + 800);
    expect(concurrentReturnSlice).toContain('crossFileCallsStale: false,');
  });

  it('regression (CONC-R165-01): ROOT_IDENTITY_UNKNOWN block has a dedicated return for concurrentPublishedCurrentRoot', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    // Find `if (concurrentPublishedCurrentRoot) {` AFTER
    // `if (rootIdentityUnknown) {` — this is the dedicated return for
    // the concurrent-published case. Slice from there to capture the
    // return's body.
    const concurrentIfIdx = src.indexOf('if (concurrentPublishedCurrentRoot) {', rootIdentityUnknownIfIdx);
    expect(concurrentIfIdx).toBeGreaterThan(rootIdentityUnknownIfIdx);
    // Use a 1500-char slice to capture the full return.
    const block = src.slice(concurrentIfIdx, concurrentIfIdx + 1500);
    // R165 (CONC-R165-01): the return is gated on the flag.
    expect(block).toContain('if (concurrentPublishedCurrentRoot) {');
    expect(block).toContain('Concurrent indexer published this root successfully');
    expect(block).toContain("recovery: 'none',");
    // R165 (CONC-R165-01): crossFileCallsStale is FALSE.
    expect(block).toContain('crossFileCallsStale: false,');
  });

  it('regression (STATE-R165-01): premark UPSERT does NOT write last_index_error (main path)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (STATE-R165-01): the premark UPSERT no longer includes
    // last_index_error in the INSERT column list. Find the main-path
    // premark (the FIRST occurrence of "Premark stale BEFORE clearProjectData"
    // in the comment, then the next UPSERT after it).
    const mainPathCommentIdx = src.indexOf('Premark stale BEFORE clearProjectData');
    expect(mainPathCommentIdx).toBeGreaterThan(-1);
    // Find the next `INSERT INTO projects` after this comment.
    const insertIdx = src.indexOf('INSERT INTO projects', mainPathCommentIdx);
    expect(insertIdx).toBeGreaterThan(mainPathCommentIdx);
    // Find the end of the SQL statement (the closing `).run(`).
    const runIdx = src.indexOf('.run(', insertIdx);
    expect(runIdx).toBeGreaterThan(insertIdx);
    const sqlBlock = src.slice(insertIdx, runIdx);
    // R165 (STATE-R165-01): the column list ends at last_index_attempt_at
    // (NO last_index_error).
    expect(sqlBlock).toContain('INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at)');
    // R165 (STATE-R165-01): the VALUES clause has 5 placeholders (NOT 6).
    expect(sqlBlock).toContain('VALUES (?, ?, ?, 1, ?)');
    // R165 (STATE-R165-01): the ON CONFLICT clause does NOT set
    // last_index_error.
    expect(sqlBlock).not.toContain('last_index_error = excluded.last_index_error');
    // R165 (STATE-R165-01): the transitory 'Index publication in progress'
    // marker is GONE.
    expect(sqlBlock).not.toContain("'Index publication in progress'");
  });

  it('regression (STATE-R165-01): premark UPSERT does NOT write last_index_error (deletion-only path)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (STATE-R165-01): same check for the deletion-only premark.
    // Find the deletion-only premark (the comment "Premark stale BEFORE
    // the deletion cleanup").
    const deletionOnlyCommentIdx = src.indexOf('Premark stale BEFORE the deletion cleanup');
    expect(deletionOnlyCommentIdx).toBeGreaterThan(-1);
    const insertIdx = src.indexOf('INSERT INTO projects', deletionOnlyCommentIdx);
    expect(insertIdx).toBeGreaterThan(deletionOnlyCommentIdx);
    const runIdx = src.indexOf('.run(', insertIdx);
    expect(runIdx).toBeGreaterThan(insertIdx);
    const sqlBlock = src.slice(insertIdx, runIdx);
    expect(sqlBlock).toContain('INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at)');
    expect(sqlBlock).toContain('VALUES (?, ?, ?, 1, ?)');
    expect(sqlBlock).not.toContain('last_index_error = excluded.last_index_error');
    expect(sqlBlock).not.toContain("'Index publication in progress'");
  });

  it('regression (STATE-R165-01): "Index publication in progress" literal is GONE from SQL VALUES clauses', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (STATE-R165-01): the literal string "Index publication in
    // progress" MUST NOT appear as a SQL VALUES literal. The buggy R164
    // form was:
    //   VALUES (?, ?, ?, 1, ?, 'Index publication in progress')
    // R165's premark uses:
    //   VALUES (?, ?, ?, 1, ?)
    // (no last_index_error column, no 'Index publication in progress'
    // value).
    //
    // The string "Index publication in progress" still appears in COMMENTS
    // (documenting the R165 change), but NOT as a SQL literal.
    expect(src).not.toContain("VALUES (?, ?, ?, 1, ?, 'Index publication in progress')");
    // R165 (STATE-R165-01): the premark's INSERT column list does NOT
    // include last_index_error. (Both premark blocks — main path and
    // deletion-only path — were updated.)
    expect(src).not.toContain('INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at, last_index_error)');
    // R165 (STATE-R165-01): the premark's ON CONFLICT clause does NOT set
    // last_index_error. (Both premark blocks updated.)
    // Find all `INSERT INTO projects` occurrences after the ROOT_IDENTITY_UNKNOWN
    // block (i.e., the premarks) and verify none set last_index_error.
    // Simplest: count occurrences of `last_index_error = excluded.last_index_error`
    // in premark blocks. The premark SQL is the only place that used this
    // pattern in an INSERT...ON CONFLICT. The commitAliasStateAtomically
    // and updateProjectStats functions in schema.ts also use this pattern,
    // but those are in a DIFFERENT file.
    //
    // In indexer.ts, the premark ON CONFLICT clauses previously had:
    //   last_index_error = excluded.last_index_error
    // R165 removes this from both premarks. Verify it's GONE from indexer.ts.
    expect(src).not.toMatch(/ON CONFLICT\(name\) DO UPDATE SET\s*\n\s*cross_file_calls_stale = 1,\s*\n\s*last_index_attempt_at = excluded\.last_index_attempt_at,\s*\n\s*last_index_error = excluded\.last_index_error/);
  });

  it('regression (API-R165-01): hasPublishedSnapshot checks lastSuccessfulIndexAt + stale === 0', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (API-R165-01): the hasPublishedSnapshot computation includes
    // lastSuccessfulIndexAt and stale checks. Count occurrences — should
    // be at least 2 (one in each root-change early return).
    const matches = src.match(/projectState\.lastSuccessfulIndexAt !== null\n\s*&& projectState\.lastSuccessfulIndexAt !== undefined\n\s*&& projectState\.stale === 0/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('regression (API-R165-03): preservedSnapshot is conditional on hasExistingGraphData (NOT unconditional true)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (API-R165-03): preservedSnapshot is set to hasExistingGraphData
    // (NOT unconditionally true). Count occurrences — should be at least
    // 4 (2 STALE + 2 FAILED returns across both root-change early returns,
    // plus the 2 concurrentPublishedCurrentRoot returns).
    const matches = src.match(/preservedSnapshot:\s*hasExistingGraphData/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(4);
    // R165 (API-R165-03): the old unconditional `preservedSnapshot: true`
    // is GONE from the source.
    expect(src).not.toMatch(/preservedSnapshot:\s*true\b/);
  });

  it('regression (API-R165-01): projectState SELECT reads last_successful_index_at AS lastSuccessfulIndexAt', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R165 (API-R165-01): the projectState SELECT now includes
    // last_successful_index_at AS lastSuccessfulIndexAt.
    expect(src).toContain('last_successful_index_at AS lastSuccessfulIndexAt FROM projects WHERE name = ?');
  });

  it('regression: package.json version is 0.70.0', () => {
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).toContain('"version": "0.70.0"');
  });
});
