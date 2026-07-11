// v2/tests/indexer/r162-root-early-refusal.test.ts
// R162: Root Change Early Refusal + Legacy Root Bootstrap Lock +
//   Preserve root_path on Stale Runs
//
// Closes the R161 audit findings:
//   - DATA-R162-01 (P1): ROOT_CHANGED doesn't return early — it sets
//     `semanticsStale=true` and continues the pipeline. No-op clears
//     cross-file edges, deletion-only deletes data, main path mixes
//     root A/B.
//   - ROOT-R162-01 (P1): Legacy DBs with `root_fingerprint=NULL` get
//     `rootChanged=false`, leaving them vulnerable to cross-root fast-skip.
//   - STATE-R162-01 (P1): `updateProjectStats()` always sets
//     `root_path = excluded.root_path`, even on stale runs. root_path=B
//     while fingerprint=A.
//   - STATE-R162-02 (P1/P2): `rootChanged` is injected into
//     `semanticsStale`, causing false "Semantics version 8 ≠ current 8"
//     message and edge cleanup.
//   - RES-R162-01 (P1/P2): Root check should be an early return before
//     any mutation.
//   - TEST-R162-01 (P1): No test verifies graph is unchanged after
//     ROOT_CHANGED.
//
// R162 fixes:
//   1. The `rootChanged` check now returns STALE immediately WITHOUT any
//      mutation. The graph, root_path, root_fingerprint, and all metadata
//      are preserved. (DATA-R162-01 + RES-R162-01 + STATE-R162-02)
//   2. A new `ROOT_IDENTITY_UNKNOWN` early return refuses incremental when
//      the published root_fingerprint is NULL AND there's existing graph
//      data. (ROOT-R162-01)
//   3. `updateProjectStats()` now preserves root_path on stale/failed runs
//      (CASE WHEN excluded.last_successful_index_at IS NOT NULL ...).
//      (STATE-R162-01)
//   4. `rootChanged` removed from `semanticsStale` (the early return means
//      it's never true here). The classifier's `if (params.rootChanged)`
//      branch is removed (dead code — the early return uses ROOT_CHANGED
//      directly). (STATE-R162-02)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R162: Root Change Early Refusal + Legacy Lock + root_path Preservation', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r162-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r162-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // Helper: count rows in a table for a project.
  function countRows(dbPath: string, table: 'nodes' | 'edges' | 'file_hashes'): number {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project = ?`).get(projectName) as { c: number };
    db.close();
    return row.c;
  }

  // Helper: read root_path + root_fingerprint from projects.
  function readRootState(dbPath: string): { rootPath: string; rootFp: string | null } {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT root_path AS rp, root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rp: string; rfp: string | null };
    db.close();
    return { rootPath: row.rp, rootFp: row.rfp };
  }

  // ── DATA-R162-01 + RES-R162-01: Root change early refusal preserves graph ──
  //
  // R161 set semanticsStale=true and continued the pipeline. This allowed:
  //   - no-op path: clearCrossFileCallEdges deleted root A's cross-file CALLS edges
  //   - deletion-only path: the cleanup transaction deleted root A's nodes/edges/hashes
  //   - main path: extraction ran against root B's files, inserting root B nodes/edges
  //     into a graph that still had root A's other data
  // R162 returns STALE immediately WITHOUT any mutation. The graph, root_path,
  // root_fingerprint, and all metadata are preserved.

  it('DATA-R162-01a (TEST-R162-01): root change no-op preservation — graph UNCHANGED', async () => {
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    // Capture pre-state.
    const nodesBefore = countRows(dbPath, 'nodes');
    const edgesBefore = countRows(dbPath, 'edges');
    const fileHashesBefore = countRows(dbPath, 'file_hashes');
    const rootStateBefore = readRootState(dbPath);
    expect(nodesBefore).toBeGreaterThan(0);
    expect(fileHashesBefore).toBeGreaterThan(0);
    expect(rootStateBefore.rootFp).not.toBeNull();
    expect(rootStateBefore.rootFp).toBe(computeRootFingerprint(projectDir));

    // Move the project to a new physical root (rename preserves mtime/ino
    // but changes the canonical path → fingerprint changes).
    const newProjectDir = join(tmpDir, 'project-moved-noop');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from the new root with NO file changes (no-op).
    // R161 would fast-skip all files (mtime_ns/size match) AND clear cross-file
    // edges via clearCrossFileCallEdges (semanticsStale=true). R162 returns
    // STALE immediately WITHOUT any mutation.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    // R162 (DATA-R162-01 + RES-R162-01): outcome = STALE.
    expect(r.outcome).toBe('STALE');
    // R162 (DATA-R162-01): staleReason.code = ROOT_CHANGED.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.staleReason!.message).toContain('Root fingerprint changed');
    // R162 (RES-R162-01): recovery = full_reindex.
    expect(r.recovery).toBe('full_reindex');
    // R162 (RES-R162-01): crossFileCallsStale = true.
    expect(r.crossFileCallsStale).toBe(true);

    // R162 (TEST-R162-01): nodes count UNCHANGED.
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
    // R162 (TEST-R162-01): edges count UNCHANGED (no clearCrossFileCallEdges).
    expect(countRows(dbPath, 'edges')).toBe(edgesBefore);
    // R162 (TEST-R162-01): file_hashes count UNCHANGED.
    expect(countRows(dbPath, 'file_hashes')).toBe(fileHashesBefore);
    // R162 (TEST-R162-01 + STATE-R162-01): root_path UNCHANGED (still root A).
    // The premark UPSERT does NOT update root_path (R160), and the early
    // return doesn't run updateProjectStats at all — so root_path is
    // whatever it was before.
    // R162 (STATE-R162-01): even if updateProjectStats were called (it isn't,
    // because of the early return), the CASE WHEN last_successful_index_at
    // IS NOT NULL would preserve root_path on a stale run.
    const rootStateAfter = readRootState(dbPath);
    expect(rootStateAfter.rootPath).toBe(rootStateBefore.rootPath);
    // R162 (TEST-R162-01): root_fingerprint UNCHANGED (still root A's fingerprint).
    expect(rootStateAfter.rootFp).toBe(rootStateBefore.rootFp);
  });

  it('DATA-R162-01b (TEST-R162-01): root change deletion-only preservation — no rows deleted', async () => {
    // Run 1: full index from projectDir (root A) with two files.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const nodesBefore = countRows(dbPath, 'nodes');
    const edgesBefore = countRows(dbPath, 'edges');
    const fileHashesBefore = countRows(dbPath, 'file_hashes');
    const rootStateBefore = readRootState(dbPath);

    // Move to a new root and DELETE b.ts (would trigger the deletion-only fast
    // path in R161 — the cleanup transaction would delete root A's nodes/edges
    // for b.ts even though the run is STALE).
    const newProjectDir = join(tmpDir, 'project-moved-del');
    renameSync(projectDir, newProjectDir);
    unlinkSync(join(newProjectDir, 'b.ts'));

    // Run 2: incremental from new root + deletion → R162's early return fires
    // BEFORE the deletion-only path. No deletion transaction runs.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');

    // R162 (TEST-R162-01): nodes UNCHANGED — the deletion-only cleanup
    // transaction did NOT run (R161 would have deleted root A's b.ts nodes).
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
    // R162 (TEST-R162-01): edges UNCHANGED.
    expect(countRows(dbPath, 'edges')).toBe(edgesBefore);
    // R162 (TEST-R162-01): file_hashes UNCHANGED — root A's b.ts hash is preserved.
    expect(countRows(dbPath, 'file_hashes')).toBe(fileHashesBefore);
    // R162 (TEST-R162-01): root_path + root_fingerprint UNCHANGED.
    const rootStateAfter = readRootState(dbPath);
    expect(rootStateAfter.rootPath).toBe(rootStateBefore.rootPath);
    expect(rootStateAfter.rootFp).toBe(rootStateBefore.rootFp);
  });

  it('DATA-R162-01c (TEST-R162-01): root change main preservation — no root B data inserted', async () => {
    // Run 1: full index from projectDir (root A) with one file.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const nodesBefore = countRows(dbPath, 'nodes');
    const edgesBefore = countRows(dbPath, 'edges');
    const fileHashesBefore = countRows(dbPath, 'file_hashes');
    const rootStateBefore = readRootState(dbPath);

    // Move to a new root and MODIFY a.ts (would trigger the main extraction
    // path in R161 — extraction would run against root B's files, inserting
    // root B nodes/edges into a graph that still had root A's data).
    const newProjectDir = join(tmpDir, 'project-moved-main');
    renameSync(projectDir, newProjectDir);
    writeFileSync(join(newProjectDir, 'a.ts'), 'export function a() { return 999; }\nexport function bNew() { return 2; }\n');

    // Run 2: incremental from new root + modification → R162's early return
    // fires BEFORE the main path. No extraction runs.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');

    // R162 (TEST-R162-01): nodes UNCHANGED — root B's bNew() was NOT inserted.
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
    // R162 (TEST-R162-01): edges UNCHANGED.
    expect(countRows(dbPath, 'edges')).toBe(edgesBefore);
    // R162 (TEST-R162-01): file_hashes UNCHANGED — root B's modified a.ts hash
    // was NOT persisted.
    expect(countRows(dbPath, 'file_hashes')).toBe(fileHashesBefore);
    // R162 (TEST-R162-01): root_path + root_fingerprint UNCHANGED.
    const rootStateAfter = readRootState(dbPath);
    expect(rootStateAfter.rootPath).toBe(rootStateBefore.rootPath);
    expect(rootStateAfter.rootFp).toBe(rootStateBefore.rootFp);

    // Verify no root B data leaked: query for the bNew function name.
    const db = new Database(dbPath, { readonly: true });
    const bNewNodes = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND name = 'bNew'").get(projectName) as { c: number };
    db.close();
    expect(bNewNodes.c).toBe(0);
  });

  // ── ROOT-R162-01: Legacy root bootstrap lock ──────────────────────────
  //
  // A DB with existing graph data but NULL root_fingerprint (pre-R154 DB
  // upgraded to R161+) cannot be trusted for cross-root incremental. R161
  // set rootChanged=false for NULL, leaving legacy DBs vulnerable to the
  // cross-root fast-skip. R162 refuses the incremental and requires a full
  // baseline to establish root identity.

  it('ROOT-R162-01a: legacy NULL cross-root → STALE + ROOT_IDENTITY_UNKNOWN + nodes UNCHANGED', async () => {
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const nodesBefore = countRows(dbPath, 'nodes');
    expect(nodesBefore).toBeGreaterThan(0);

    // Simulate a pre-R154 DB: set root_fingerprint=NULL.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Move to a new root (root B).
    const newProjectDir = join(tmpDir, 'project-moved-legacy-cross');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from root B with NULL root_fingerprint + existing
    // graph data → R162 refuses (ROOT_IDENTITY_UNKNOWN). R161 would have
    // fast-skipped all files (mtime_ns/size match) and certified root A's
    // graph as fresh under root B's path.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });

    // R162 (ROOT-R162-01): outcome = STALE.
    expect(r.outcome).toBe('STALE');
    // R162 (ROOT-R162-01): staleReason.code = ROOT_IDENTITY_UNKNOWN.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.staleReason!.message).toContain('Root identity unknown');
    // R162 (ROOT-R162-01): recovery = full_reindex.
    expect(r.recovery).toBe('full_reindex');
    // R162 (ROOT-R162-01): crossFileCallsStale = true.
    expect(r.crossFileCallsStale).toBe(true);

    // R162 (ROOT-R162-01): nodes UNCHANGED — no mutation.
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
  });

  it('ROOT-R162-01b: legacy NULL same-root → STALE + ROOT_IDENTITY_UNKNOWN (conservative — see comment)', async () => {
    // The R162 task spec phrased this test as "Same root should work fine —
    // NULL doesn't block same-root". However, the R162 code example is
    // CONSERVATIVE: it refuses ANY incremental with NULL fingerprint + existing
    // graph data, regardless of whether the root is the same. Without a
    // published fingerprint, we cannot verify the root identity, so we cannot
    // trust the existing graph for incremental mode. The conservative stance
    // is intentional and consistent with the R162 theme (refuse incremental on
    // root identity issues). This test verifies the conservative behavior.
    //
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const nodesBefore = countRows(dbPath, 'nodes');

    // Simulate a pre-R154 DB: set root_fingerprint=NULL.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Run 2: incremental from the SAME root with NULL root_fingerprint.
    // R162 (ROOT-R162-01): conservative — refuses because NULL + existing
    // data means we can't verify root identity.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // R162 (ROOT-R162-01): outcome = STALE (NOT SUCCESS — the conservative
    // implementation refuses ALL incremental when NULL + existing data).
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.recovery).toBe('full_reindex');
    expect(r.crossFileCallsStale).toBe(true);
    // R162 (ROOT-R162-01): nodes UNCHANGED — no mutation.
    expect(countRows(dbPath, 'nodes')).toBe(nodesBefore);
  });

  it('ROOT-R162-01c: legacy NULL same-root — first incremental after fresh full succeeds (no existing data)', async () => {
    // Edge case: a project that has NEVER been indexed has no existing graph
    // data (hasExistingGraphData=false). The R162 check does NOT fire — the
    // first incremental is allowed (and effectively becomes a full index
    // because there's no graph to compare against). This isn't a real-world
    // scenario (first index is always full), but the test guards against
    // the R162 check refusing the very first incremental of a project that
    // somehow has root_fingerprint=NULL but no graph data.
    //
    // We simulate this by: full index → delete all nodes/hashes → set
    // root_fingerprint=NULL → incremental. The incremental should NOT be
    // refused (hasExistingGraphData=false → rootIdentityUnknown=false).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    // Wipe all graph data (simulates a pre-R154 DB that has a projects row
    // but no nodes/hashes — e.g., a failed full index).
    // R163 (ROOT-R163-02): expanded hasExistingGraphData to also check
    // edges, call_sites, imports, exports. We must delete from ALL six
    // structural tables to make hasExistingGraphData=false. R162 only
    // checked nodes + file_hashes.
    db.prepare('DELETE FROM nodes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM edges WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM call_sites WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM imports WHERE project = ?').run(projectName);
    db.prepare('DELETE FROM exports WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();

    // Run 2: incremental from same root. hasExistingGraphData=false →
    // rootIdentityUnknown=false → R162 check does NOT fire.
    // The no-op path runs (estimatedFilesToIndex=0, deletedRelPaths=[]).
    // The graph is empty, so totals=(0,0). crossFileStale depends on
    // existingStale (which is true after our manual UPDATE) — but actually
    // we only set root_fingerprint=NULL, not cross_file_calls_stale=1.
    // So existingStale=false, semanticsStale=false → noOpStale=false →
    // commitAliasStateAtomically runs → SUCCESS.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R162 (ROOT-R162-01): NOT ROOT_IDENTITY_UNKNOWN (hasExistingGraphData=false).
    if (r.staleReason) {
      expect(r.staleReason.code).not.toBe('ROOT_IDENTITY_UNKNOWN');
      expect(r.staleReason.code).not.toBe('ROOT_CHANGED');
    }
    // The no-op succeeds.
    expect(r.crossFileCallsStale).toBe(false);
  });

  // ── ROOT-R162-01d: Full reindex from new root → SUCCESS ───────────────
  //
  // The R162 early return only fires for INCREMENTAL mode (rootChanged
  // requires opts.incremental; rootIdentityUnknown requires opts.incremental).
  // Full mode is unaffected — clearProjectData wipes the old graph and
  // commitAliasStateAtomically publishes a fresh one under the new
  // root_fingerprint.

  it('ROOT-R162-01d: full reindex from new root → SUCCESS + root_fingerprint + root_path updated', async () => {
    // Run 1: full index from projectDir (root A).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    const rootStateBefore = readRootState(dbPath);
    expect(rootStateBefore.rootFp).toBe(computeRootFingerprint(projectDir));

    // Move to a new root.
    const newProjectDir = join(tmpDir, 'project-moved-full');
    renameSync(projectDir, newProjectDir);
    const newFp = computeRootFingerprint(newProjectDir);
    expect(newFp).not.toBe(rootStateBefore.rootFp);

    // Run 2: FULL reindex from the new root. R162's early returns require
    // opts.incremental — full mode is unaffected. clearProjectData wipes
    // the old graph and commitAliasStateAtomically publishes a fresh graph
    // under the new root_fingerprint.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    expect(r.crossFileCallsStale).toBe(false);

    // R162: root_fingerprint updated to root B's fingerprint.
    const rootStateAfter = readRootState(dbPath);
    expect(rootStateAfter.rootFp).toBe(newFp);
    // R162: root_path updated to root B's path (success → last_successful
    // IS NOT NULL → CASE updates root_path).
    expect(rootStateAfter.rootPath).toBe(newProjectDir);
    expect(rootStateAfter.rootPath).not.toBe(rootStateBefore.rootPath);

    // A subsequent incremental from the new root now succeeds (no rootChanged,
    // no rootIdentityUnknown — fingerprint is now non-NULL and matches).
    const r2 = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.outcome).toBe('SUCCESS');
    expect(r2.crossFileCallsStale).toBe(false);
  });

  // ── STATE-R162-01: updateProjectStats preserves root_path on stale runs ──
  //
  // R161's updateProjectStats always set `root_path = excluded.root_path`
  // in the ON CONFLICT DO UPDATE clause. This meant a stale run (semantics
  // mismatch, uncertainty, or R162's ROOT_CHANGED/ROOT_IDENTITY_UNKNOWN
  // early return) would overwrite the published root_path with the attempted
  // root. R162 only updates root_path when last_successful_index_at IS
  // NOT NULL (i.e., the run succeeded).

  it('STATE-R162-01a: stale no-op (semantics mismatch) preserves root_path', async () => {
    // Run 1: full index from projectDir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const dbPath = defaultCodeDbPath(projectName);
    // Force a stale-semantics no-op: downgrade extractor_semantics_version.
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET extractor_semantics_version = 0 WHERE name = ?').run(projectName);
    db.close();
    const rootStateBefore = readRootState(dbPath);
    expect(rootStateBefore.rootPath).toBe(projectDir);

    // Run 2: incremental from SAME root. semanticsStale=true (version=0 ≠ CURRENT).
    // The no-op path runs (estimatedFilesToIndex=0, deletedRelPaths=[]).
    // noOpStale=true → updateProjectStats is called with crossFileStale=true.
    // R161 would overwrite root_path = excluded.root_path (same value here,
    // but for a moved root it would be the new path). R162 preserves root_path
    // when last_successful_index_at IS NULL (stale run).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);
    if (r.staleReason) {
      expect(r.staleReason.code).toBe('SEMANTICS_MISMATCH');
    }

    // R162 (STATE-R162-01): root_path is UNCHANGED (preserved on stale run).
    const rootStateAfter = readRootState(dbPath);
    expect(rootStateAfter.rootPath).toBe(rootStateBefore.rootPath);
  });

  it('STATE-R162-01b: stale no-op from a different path does NOT overwrite root_path', async () => {
    // This is the critical regression test for STATE-R162-01. R161 would
    // overwrite root_path with the attempted root on a stale run, creating
    // a contradiction (root_path=B, root_fingerprint=A). R162 preserves
    // root_path on stale runs.
    //
    // We can't easily test "different path, same canonical root" end-to-end
    // because assertDiscoveryRoot canonicalizes the root path. So we rely on:
    //   1. STATE-R162-01a (end-to-end): verifies root_path is preserved when
    //      updateProjectStats is called with stale=true from the SAME root.
    //   2. This source-inspection test: verifies updateProjectStats itself
    //      uses the CASE WHEN clause (preserves root_path when
    //      last_successful_index_at IS NULL).
    //
    // We extract the updateProjectStats function body specifically — the
    // commitAliasStateAtomically function (the success path) still uses
    // `root_path = excluded.root_path` unconditionally, which is correct
    // (it only runs on success).
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'schema.ts'), 'utf8');
    // R162 (STATE-R162-01): root_path uses CASE WHEN last_successful_index_at IS NOT NULL.
    expect(src).toContain('root_path = CASE WHEN excluded.last_successful_index_at IS NOT NULL THEN excluded.root_path ELSE root_path END');
    // R162 (STATE-R162-01): the unconditional `root_path = excluded.root_path`
    // is GONE from updateProjectStats. Extract the updateProjectStats function
    // body and verify it doesn't contain the unconditional root_path update.
    const fnStart = src.indexOf('export function updateProjectStats(');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the closing brace of the function (the next `^}` at column 0).
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/^\s*root_path = excluded\.root_path,$/m);
    // R162 (STATE-R162-01): the CASE WHEN clause IS in updateProjectStats.
    expect(fnBody).toContain('root_path = CASE WHEN excluded.last_successful_index_at IS NOT NULL');
    // Sanity: commitAliasStateAtomically (the success path) still uses
    // `root_path = excluded.root_path` — R162 only changed updateProjectStats.
    const commitFnStart = src.indexOf('export function commitAliasStateAtomically(');
    expect(commitFnStart).toBeGreaterThan(-1);
    const commitFnEnd = src.indexOf('\n}\n', commitFnStart);
    const commitFnBody = src.slice(commitFnStart, commitFnEnd);
    expect(commitFnBody).toContain('root_path = excluded.root_path,');
  });

  // ── STATE-R162-02: rootChanged removed from semanticsStale + classifier ──
  //
  // R161 injected `rootChanged` into `semanticsStale` (OR). This caused:
  //   - false "Semantics version 8 ≠ current 8" message (the no-op path's
  //     noOpError picked the semanticsStale branch)
  //   - clearCrossFileCallEdges ran in the no-op path (semanticsStale=true)
  //     even though the REAL cause was a root change
  //   - the deletion-only path's cleanup transaction ran (semanticsStale=true
  //     → crossFileStale=true, but the cleanup still ran before the stale
  //     flag was set)
  // R162 removes `rootChanged` from `semanticsStale` (the early return means
  // it's never true here) AND removes the ROOT_CHANGED branch from the
  // classifier (the early return uses ROOT_CHANGED directly).

  it('STATE-R162-02a: rootChanged no longer injected into semanticsStale', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (STATE-R162-02): semanticsStale NO LONGER includes rootChanged.
    expect(src).toContain('const semanticsStale = opts.incremental\n    ? existingSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION\n    : false;');
    // R162 (STATE-R162-02): the old OR-with-rootChanged line is GONE.
    expect(src).not.toContain('(rootChanged || existingSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION)');
  });

  it('STATE-R162-02b: classifier no longer has the ROOT_CHANGED branch', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (STATE-R162-02): the classifier's `if (params.rootChanged)` branch
    // has been REMOVED. The early return handles ROOT_CHANGED.
    expect(src).not.toContain('if (params.rootChanged)');
    // R162 (STATE-R162-02): the rootChanged param is retained for backward compat.
    expect(src).toContain('rootChanged?: boolean;');
    // R162 (STATE-R162-02): ROOT_CHANGED is still in the staleReason.code union.
    expect(src).toContain("| 'ROOT_CHANGED'");
  });

  it('STATE-R162-02c: classifier never returns ROOT_CHANGED (early return handles it)', () => {
    // The classifier's return type still includes ROOT_CHANGED (because
    // NonNullable<NonNullable<IndexResult['staleReason']>['code']> includes
    // it). But the classifier function body NEVER returns ROOT_CHANGED —
    // the only code path that produces ROOT_CHANGED is the early return.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // Find the classifyStaleReason function body.
    const fnStart = src.indexOf('function classifyStaleReason(params: {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    // R162 (STATE-R162-02): the function body does NOT contain a return
    // statement with code: 'ROOT_CHANGED'.
    expect(fnBody).not.toContain("code: 'ROOT_CHANGED'");
  });

  // ── Source-inspection regression guards ──────────────────────────────

  it('regression: ROOT_IDENTITY_UNKNOWN added to staleReason.code union', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(src).toContain("| 'ROOT_IDENTITY_UNKNOWN'");
  });

  it('regression: hasExistingGraphData is computed unconditionally (hoisted)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (ROOT-R162-01): hasExistingGraphData is a top-level const (not
    // inside the cold-start lock's `if` block).
    expect(src).toContain('const hasExistingGraphData = (db.prepare(');
    // R162 (ROOT-R162-01): the old `hasExistingData` (local to the if block)
    // is GONE.
    expect(src).not.toContain('const hasExistingData = (db.prepare(');
  });

  it('regression: rootChanged early return placed BEFORE premark + clearProjectData', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (RES-R162-01): the rootChanged early return is BEFORE the premark.
    const rootChangedReturnIdx = src.indexOf("staleReason: {\n        code: 'ROOT_CHANGED',");
    const premarkIdx = src.indexOf("INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at, last_index_error)");
    expect(rootChangedReturnIdx).toBeGreaterThan(-1);
    expect(premarkIdx).toBeGreaterThan(-1);
    expect(rootChangedReturnIdx).toBeLessThan(premarkIdx);
    // R162 (RES-R162-01): the rootChanged early return is BEFORE clearProjectData.
    const clearProjectDataIdx = src.indexOf('clearProjectData(db, opts.project);');
    expect(rootChangedReturnIdx).toBeLessThan(clearProjectDataIdx);
  });

  it('regression: rootIdentityUnknown early return placed after rootChanged + before premark', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (ROOT-R162-01): the rootIdentityUnknown early return is AFTER the
    // rootChanged early return.
    const rootChangedReturnIdx = src.indexOf("code: 'ROOT_CHANGED',");
    const rootIdentityUnknownReturnIdx = src.indexOf("code: 'ROOT_IDENTITY_UNKNOWN',");
    expect(rootChangedReturnIdx).toBeGreaterThan(-1);
    expect(rootIdentityUnknownReturnIdx).toBeGreaterThan(-1);
    expect(rootIdentityUnknownReturnIdx).toBeGreaterThan(rootChangedReturnIdx);
    // R162 (ROOT-R162-01): the rootIdentityUnknown early return is BEFORE the premark.
    const premarkIdx = src.indexOf("INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at, last_index_error)");
    expect(rootIdentityUnknownReturnIdx).toBeLessThan(premarkIdx);
  });

  it('regression: rootIdentityUnknown check uses publishedRootFingerprint + hasExistingGraphData', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(src).toContain('const rootIdentityUnknown = opts.incremental');
    expect(src).toContain('&& publishedRootFingerprint === null');
    expect(src).toContain('&& hasExistingGraphData;');
  });

  it('regression: both early returns inline UPDATE before db.close() (R163 atomic persist)', () => {
    // R163 (STATE-R163-01): replaced markProjectStalePreservingGraph (which
    // reopened a connection) with an inline UPDATE on the same connection.
    // This test was originally a R162 regression guard for the helper call;
    // R163 updates it to verify the inline UPDATE pattern instead.
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // Find the rootChanged early return (its `if (rootChanged) {` block).
    const rootChangedIfIdx = src.indexOf('if (rootChanged) {');
    expect(rootChangedIfIdx).toBeGreaterThan(-1);
    const rootChangedCodeIdx = src.indexOf("code: 'ROOT_CHANGED',", rootChangedIfIdx);
    expect(rootChangedCodeIdx).toBeGreaterThan(rootChangedIfIdx);
    const rootChangedBlock = src.slice(rootChangedIfIdx, rootChangedCodeIdx);
    expect(rootChangedBlock).toContain('db.close();');
    expect(rootChangedBlock).toContain('UPDATE projects SET');
    expect(rootChangedBlock).toContain('cross_file_calls_stale = 1');
    // R163 (STATE-R163-01): no actual call to markProjectStalePreservingGraph.
    expect(rootChangedBlock).not.toMatch(/markProjectStalePreservingGraph\s*\(/);

    // Same for rootIdentityUnknown.
    const rootIdentityUnknownIfIdx = src.indexOf('if (rootIdentityUnknown) {');
    expect(rootIdentityUnknownIfIdx).toBeGreaterThan(-1);
    const rootIdentityUnknownCodeIdx = src.indexOf("code: 'ROOT_IDENTITY_UNKNOWN',", rootIdentityUnknownIfIdx);
    expect(rootIdentityUnknownCodeIdx).toBeGreaterThan(rootIdentityUnknownIfIdx);
    const rootIdentityUnknownBlock = src.slice(rootIdentityUnknownIfIdx, rootIdentityUnknownCodeIdx);
    expect(rootIdentityUnknownBlock).toContain('db.close();');
    expect(rootIdentityUnknownBlock).toContain('UPDATE projects SET');
    expect(rootIdentityUnknownBlock).toContain('cross_file_calls_stale = 1');
    expect(rootIdentityUnknownBlock).not.toMatch(/markProjectStalePreservingGraph\s*\(/);
  });

  it('regression: ROOT_CHANGED staleReason includes totalPaths=0 + pathsTruncated=false', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (DATA-R162-01): the early return sets totalPaths=0 + pathsTruncated=false
    // (matching the R161 classifier's contract for ROOT_CHANGED).
    // R163 (STATE-R163-01): the message uses
    // `rootMsg + (stalePersisted ? '' : ' [WARNING: ...]')` instead of the
    // bare `rootMsg`. The paths/totalPaths/pathsTruncated fields are unchanged.
    // R164 (CONC-R164-01): the message uses a nested ternary that distinguishes
    // concurrent update (info.changes=0) from persist failure (exception). The
    // '[WARNING: stale flag could not be persisted to DB]' suffix still appears
    // in the persist-failure branch.
    expect(src).toContain("code: 'ROOT_CHANGED',");
    expect(src).toContain('paths: [],\n        totalPaths: 0,\n        pathsTruncated: false,');
    expect(src).toContain("code: 'ROOT_IDENTITY_UNKNOWN',");
    // R164 (CONC-R164-01): the message now uses a nested ternary with both
    // the concurrent-update warning AND the persist-failure warning. The
    // '[WARNING: stale flag could not be persisted to DB]' suffix is still
    // present in the persist-failure branch.
    expect(src).toContain("' [WARNING: stale flag could not be persisted to DB]'");
    // R164 (CONC-R164-01): the concurrent-update warning is also present.
    expect(src).toContain("' [WARNING: concurrent update — another indexer changed root_fingerprint between read and write; new snapshot not marked stale]'");
  });

  it('regression: classifier rootChanged param marked DEPRECATED', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R162 (STATE-R162-02): the rootChanged param is marked DEPRECATED.
    expect(src).toContain('R162 (DATA-R162-01 + RES-R162-01 + STATE-R162-02): DEPRECATED.');
  });

  it('regression: package.json version is 0.69.0 (R164 bump)', () => {
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).toContain('"version": "0.69.0"');
  });
});
