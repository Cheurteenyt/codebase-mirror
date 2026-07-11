// v2/tests/indexer/r161-root-snapshot-identity.test.ts
// R161: Root Snapshot Identity Lock + Historical Alias Path Precision +
//   Fast-Path totalPaths/pathsTruncated + Unified MAX_STALE_PATHS
//
// Closes the R160 audit findings:
//   - ROOT-R161-01 (P1): Incremental doesn't compare the current root
//     fingerprint with the published snapshot's root fingerprint. A root
//     change with preserved metadata (same relative paths, mtime_ns, size)
//     can fast-skip all files and certify the old graph as fresh. R161
//     adds a `rootChanged` check in the projectState query, forces
//     `semanticsStale=true` when rootChanged, and adds a `ROOT_CHANGED`
//     staleReason code (checked FIRST by the classifier, before cold-start
//     lock) with `recovery: 'full_reindex'`.
//   - API-R161-02 (P1/P2): For HISTORICAL_ALIAS_BROKEN, the classifier
//     received ALL broken aliases (`discovery.brokenAliases.map(...)`),
//     not just the effective historical ones whose targets are genuinely
//     absent. R161 adds a separate `historicalBrokenAliasPaths` param;
//     HISTORICAL_ALIAS_BROKEN now surfaces only the effective historical
//     aliases. COLD_START_LOCK still uses `brokenAliasPaths` (all broken —
//     every broken alias is suspect when history is uninitialized).
//   - OBS-R161-01 (P2): Fast paths didn't expose totalPaths/pathsTruncated.
//     R161 adds these to the classifier's return type and all three callers
//     pass them through to the staleReason field.
//   - OBS-R161-03 (P2): Two separate MAX_STALE_PATHS constants (one in
//     classifier, one in full-uncertainty builder). R161 hoists to a single
//     module-level constant.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R161: Root Snapshot Identity Lock + Path Precision', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r161-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r161-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── ROOT-R161-01: Root snapshot identity lock ─────────────────────────
  //
  // R160's projectState only read stale/initialized/version — the root
  // fingerprint comparison was missing entirely. A root change with
  // preserved metadata (same relative paths, mtime_ns, size) would
  // fast-skip all files and certify the old graph as fresh. R161 adds the
  // fingerprint comparison and refuses incremental publication when the
  // root fingerprint differs from the published snapshot's.

  it('ROOT-R161-01a: incremental from new root (no-op) → STALE + ROOT_CHANGED + full_reindex', async () => {
    // Run 1: full index from projectDir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Capture the published root_fingerprint.
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    let row = db.prepare('SELECT root_fingerprint AS fp, root_path AS rp FROM projects WHERE name = ?').get(projectName) as { fp: string; rp: string };
    db.close();
    const publishedFp = row.fp;
    expect(publishedFp).not.toBeNull();
    expect(publishedFp).toBe(computeRootFingerprint(projectDir));

    // Move the project to a new physical root (rename preserves mtime/ino
    // but changes the canonical path → fingerprint changes).
    const newProjectDir = join(tmpDir, 'project-moved');
    renameSync(projectDir, newProjectDir);

    // Run 2: incremental from the new root with NO file changes (no-op).
    // R160 would fast-skip all files (mtime_ns/size match) and certify the
    // old graph as fresh. R161 detects the fingerprint mismatch and refuses.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    // R161 (ROOT-R161-01): crossFileCallsStale is true (was false in R160).
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (ROOT-R161-01): staleReason is ROOT_CHANGED with full_reindex recovery.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.staleReason!.message).toContain('Root fingerprint changed');
    expect(r.recovery).toBe('full_reindex');
    // R161 (ROOT-R161-01): outcome is STALE (no errors, but crossFileCallsStale).
    expect(r.outcome).toBe('STALE');
    // R161 (ROOT-R161-01): the published root_fingerprint is NOT overwritten
    // (the graph is not certified fresh, so commitAliasStateAtomically is
    // not called). updateProjectStats preserves the old root_fingerprint
    // when the run is not successful (succeeded=false → rootFingerprint=null
    // → CASE preserves old value).
    db = new Database(dbPath, { readonly: true });
    row = db.prepare('SELECT root_fingerprint AS fp FROM projects WHERE name = ?').get(projectName) as { fp: string };
    db.close();
    expect(row.fp).toBe(publishedFp);
  });

  it('ROOT-R161-01b: incremental from new root (with changes) → ROOT_CHANGED staleReason on main path', async () => {
    // Same scenario as 01a but with a file modification so the MAIN path
    // runs (not the no-op path). R161 must still refuse to publish fresh.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Move to new root.
    const newProjectDir = join(tmpDir, 'project-moved-main');
    renameSync(projectDir, newProjectDir);
    // Modify a.ts so estimatedFilesToIndex > 0 (main path, not no-op).
    writeFileSync(join(newProjectDir, 'a.ts'), 'export function a() { return 2; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    // R161 (ROOT-R161-01): crossFileCallsStale=true (semanticsStale=true
    // because rootChanged=true forces it).
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (ROOT-R161-01): staleReason is ROOT_CHANGED (classifier checks
    // rootChanged FIRST, before cold-start lock and semantics mismatch).
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');
  });

  it('ROOT-R161-01c: incremental from new root (deletion-only) → ROOT_CHANGED staleReason on deletion-only path', async () => {
    // Same scenario but with a deletion so the DELETION-ONLY fast path runs.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Move to new root.
    const newProjectDir = join(tmpDir, 'project-moved-del');
    renameSync(projectDir, newProjectDir);
    // Delete b.ts so the deletion-only fast path runs (estimatedFilesToIndex=0,
    // deletedRelPaths.length > 0).
    unlinkSync(join(newProjectDir, 'b.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    // R161 (ROOT-R161-01): crossFileCallsStale=true.
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (ROOT-R161-01): staleReason is ROOT_CHANGED.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');
  });

  it('ROOT-R161-01d: full reindex from new root → SUCCESS + fresh graph under new root', async () => {
    // Run 1: full index from projectDir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    let row = db.prepare('SELECT root_fingerprint AS fp FROM projects WHERE name = ?').get(projectName) as { fp: string };
    db.close();
    const oldFp = row.fp;

    // Move to a new root.
    const newProjectDir = join(tmpDir, 'project-moved-full');
    renameSync(projectDir, newProjectDir);
    const newFp = computeRootFingerprint(newProjectDir);
    expect(newFp).not.toBe(oldFp);

    // Run 2: FULL reindex from the new root. R161's rootChanged check
    // requires `opts.incremental` — full mode is unaffected. clearProjectData
    // wipes the old graph and commitAliasStateAtomically publishes a fresh
    // graph under the new root_fingerprint.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    expect(r.crossFileCallsStale).toBe(false);
    // The root_fingerprint is updated to the new root's fingerprint.
    db = new Database(dbPath, { readonly: true });
    row = db.prepare('SELECT root_fingerprint AS fp FROM projects WHERE name = ?').get(projectName) as { fp: string };
    db.close();
    expect(row.fp).toBe(newFp);
    // A subsequent incremental from the new root now succeeds (no rootChanged).
    const r2 = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.crossFileCallsStale).toBe(false);
    expect(r2.outcome).toBe('SUCCESS');
  });

  it('ROOT-R161-01e: same root incremental → SUCCESS (rootChanged=false, normal no-op)', async () => {
    // Regression guard: R161 must NOT trigger ROOT_CHANGED when the root is
    // the same. The published root_fingerprint matches the current root
    // fingerprint, so rootChanged=false and the no-op path succeeds.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: incremental from the SAME root with no changes (no-op).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    expect(r.crossFileCallsStale).toBe(false);
    // R161 (ROOT-R161-01): no staleReason (no stale).
    expect(r.staleReason).toBeUndefined();
  });

  it('ROOT-R161-01f (R162 override): NULL root_fingerprint + existing graph → ROOT_IDENTITY_UNKNOWN (was: rootChanged=false, cold-start preserved)', async () => {
    // R161 originally treated NULL root_fingerprint as "no published snapshot
    // to compare against" → rootChanged=false, so the R154 cold-start behavior
    // was preserved (the project was upgraded by the next successful full
    // index, not by an incremental ROOT_CHANGED refusal). The R161 test
    // asserted that the no-op succeeded (crossFileCallsStale=false).
    //
    // R162 (ROOT-R162-01): this is no longer the behavior. A DB with existing
    // graph data but NULL root_fingerprint (pre-R154 DB upgraded to R161+)
    // cannot be trusted for cross-root incremental. R161 set rootChanged=false
    // for NULL, leaving legacy DBs vulnerable to the cross-root fast-skip
    // (a root change with preserved metadata would fast-skip all files and
    // certify the old graph as fresh). R162 refuses the incremental and
    // requires a full baseline to establish root identity.
    //
    // This test now asserts the R162 behavior: NULL + existing graph data
    // → ROOT_IDENTITY_UNKNOWN + full_reindex. The no-op no longer succeeds.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate a pre-R154 DB: set root_fingerprint=NULL.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET root_fingerprint = NULL WHERE name = ?').run(projectName);
    db.close();
    // Run 2: incremental from the SAME root.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R162 (ROOT-R162-01): outcome = STALE (NOT SUCCESS — R162 conservatively
    // refuses ALL incremental when NULL fingerprint + existing graph data,
    // regardless of whether the root is the same).
    expect(r.outcome).toBe('STALE');
    // R162 (ROOT-R162-01): staleReason.code = ROOT_IDENTITY_UNKNOWN (not ROOT_CHANGED).
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_IDENTITY_UNKNOWN');
    expect(r.staleReason!.message).toContain('Root identity unknown');
    // R162 (ROOT-R162-01): recovery = full_reindex.
    expect(r.recovery).toBe('full_reindex');
    expect(r.crossFileCallsStale).toBe(true);
  });

  it('ROOT-R161-01g: rootChanged takes precedence over cold-start lock in classifier', async () => {
    // When BOTH rootChanged AND cold-start lock are true, the classifier
    // must return ROOT_CHANGED (checked first). The user must run a full
    // reindex under the new root before any other state can be trusted.
    // Setup: a project with existing data but alias_history_initialized=0
    // (cold-start state) AND a root change.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Reset history (cold-start state) and add a broken symlink so
    // coldStartLock would fire if rootChanged weren't checked first.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();
    // Move to a new root.
    const newProjectDir = join(tmpDir, 'project-moved-coldstart');
    renameSync(projectDir, newProjectDir);
    // Add a broken symlink so the cold-start lock conditions are met.
    symlinkSync('/nonexistent', join(newProjectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (ROOT-R161-01): ROOT_CHANGED wins (checked first).
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');
    // R161 (ROOT-R161-01): NOT COLD_START_LOCK.
    expect(r.staleReason!.code).not.toBe('COLD_START_LOCK');
  });

  // ── API-R161-02: Historical alias path precision ──────────────────────
  //
  // R160's classifier received ALL broken aliases for both
  // HISTORICAL_ALIAS_BROKEN and COLD_START_LOCK. R161 splits:
  //   - HISTORICAL_ALIAS_BROKEN → historicalBrokenAliasPaths (only effective
  //     historical aliases whose targets are genuinely absent).
  //   - COLD_START_LOCK → brokenAliasPaths (all broken — every broken alias
  //     is suspect when history is uninitialized).

  it('API-R161-02a: HISTORICAL_ALIAS_BROKEN paths only include effective historical aliases (not all broken)', async () => {
    // Set up TWO broken aliases in Run 2:
    //   - alias.ts → real.ts (historical, target absent after unlinking real.ts → effective historical)
    //   - fresh-broken.ts → /nonexistent (never had a valid target → no history entry → not historical)
    // R160 would surface BOTH alias.ts and fresh-broken.ts in
    // staleReason.paths (it used discovery.brokenAliases). R161 surfaces
    // ONLY alias.ts (it uses effectiveHistoricalBrokenAliases).
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    // fresh-broken.ts is broken from the start (target /nonexistent doesn't
    // exist). It will be a warning in Run 1 (no history entry because the
    // target is not contributive — /nonexistent has no supported language).
    symlinkSync('/nonexistent', join(projectDir, 'fresh-broken.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: break alias.ts by unlinking real.ts. Now:
    //   - alias.ts is broken, has a history entry (real.ts), target absent → effective historical
    //   - fresh-broken.ts is broken, no history entry → not effective historical
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (API-R161-02): staleReason is HISTORICAL_ALIAS_BROKEN.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    // R161 (API-R161-02): paths contains ONLY alias.ts (effective historical),
    // NOT fresh-broken.ts (no history entry).
    expect(r.staleReason!.paths.some(p => p.includes('alias.ts'))).toBe(true);
    expect(r.staleReason!.paths.some(p => p.includes('fresh-broken.ts'))).toBe(false);
  });

  it('API-R161-02b: HISTORICAL_ALIAS_BROKEN paths exclude aliases whose target is still visible', async () => {
    // Set up TWO historical aliases pointing to the same target:
    //   - aliasA.ts → real.ts
    //   - aliasB.ts → real.ts
    // Run 2: break aliasA.ts (repoint to /nonexistent). real.ts is still
    // discoverable via aliasB.ts (and directly). So:
    //   - historicalBrokenAliases = [aliasA.ts] (has history entry)
    //   - effectiveHistoricalBrokenAliases = [] (target real.ts still visible)
    // No HISTORICAL_ALIAS_BROKEN staleReason at all (the broken alias is a
    // warning only — its target's data is still in currentRelPaths).
    // This test verifies the R154 visibility filter is preserved by R161's
    // historicalBrokenAliasPaths (was already correct in R160 because R160
    // used brokenAliasPaths which contained ALL broken aliases, but
    // hasEffectiveHistoricalBrokenAliases was false so the classifier
    // didn't return HISTORICAL_ALIAS_BROKEN).
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'aliasA.ts'));
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'aliasB.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: break aliasA.ts (repoint to /nonexistent). real.ts is still
    // discoverable via aliasB.ts.
    unlinkSync(join(projectDir, 'aliasA.ts'));
    symlinkSync('/nonexistent', join(projectDir, 'aliasA.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R154 (ALIAS-R154-03): no stale (target still visible).
    expect(r.crossFileCallsStale).toBe(false);
    // R161 (API-R161-02): no HISTORICAL_ALIAS_BROKEN staleReason (the
    // visibility filter excluded aliasA.ts from effectiveHistoricalBrokenAliases).
    if (r.staleReason) {
      expect(r.staleReason.code).not.toBe('HISTORICAL_ALIAS_BROKEN');
    }
  });

  // ── OBS-R161-01: totalPaths/pathsTruncated on fast paths ──────────────
  //
  // R159 added totalPaths + pathsTruncated only to the hand-rolled
  // full-uncertainty return. The classifier (used by no-op, deletion-only,
  // main paths) didn't carry these — consumers couldn't display
  // "(showing 100 of N)" for fast-path staleReasons. R161 adds them to the
  // classifier's return type and all three callers pass them through.

  it('OBS-R161-01a: no-op HISTORICAL_ALIAS_BROKEN → totalPaths/pathsTruncated present (not truncated)', async () => {
    // Single broken alias → totalPaths=1, pathsTruncated=false (or undefined).
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    if (r.staleReason && r.staleReason.code === 'HISTORICAL_ALIAS_BROKEN') {
      // R161 (OBS-R161-01): totalPaths is set.
      expect(r.staleReason.totalPaths).toBeDefined();
      expect(r.staleReason.totalPaths).toBe(1);
      // R161 (OBS-R161-01): pathsTruncated is false (under 100 cap).
      expect(r.staleReason.pathsTruncated).toBe(false);
    }
  });

  it('OBS-R161-01b: no-op HISTORICAL_ALIAS_BROKEN with 150 aliases → totalPaths=150, pathsTruncated=true', async () => {
    // 150 broken aliases → totalPaths=150, pathsTruncated=true, paths.length=100.
    writeFileSync(join(projectDir, 'util.ts'), 'export function util() { return 1; }\n');
    for (let i = 0; i < 150; i++) {
      symlinkSync(join(projectDir, 'util.ts'), join(projectDir, `alias${i}.ts`));
    }
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'util.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    if (r.staleReason && (r.staleReason.code === 'HISTORICAL_ALIAS_BROKEN' || r.staleReason.code === 'COLD_START_LOCK')) {
      // R161 (OBS-R161-01): totalPaths is the full count (150).
      expect(r.staleReason.totalPaths).toBe(150);
      // R161 (OBS-R161-01): pathsTruncated is true.
      expect(r.staleReason.pathsTruncated).toBe(true);
      // R161 (OBS-R161-01): paths is capped at 100.
      expect(r.staleReason.paths.length).toBe(100);
    }
  });

  it('OBS-R161-01c (R162 override): ROOT_CHANGED staleReason has empty paths + totalPaths=0/pathsTruncated=false (was: undefined)', async () => {
    // R161 originally returned ROOT_CHANGED via the classifier with paths=[],
    // totalPaths=undefined, pathsTruncated=undefined (the classifier omitted
    // these fields for ROOT_CHANGED because they weren't applicable to a
    // fingerprint mismatch).
    //
    // R162 (DATA-R162-01 + RES-R162-01): ROOT_CHANGED is now emitted by an
    // EARLY RETURN in the indexer (not the classifier). The early return
    // sets paths=[], totalPaths=0, pathsTruncated=false explicitly. The
    // fields are 0/false rather than undefined because the early return
    // uses an object literal that includes all fields (matching the shape
    // of other early returns like the full-uncertainty return). Consumers
    // can still distinguish ROOT_CHANGED from path-surfacing staleReasons
    // by code (ROOT_CHANGED never has paths) — the 0/false values are
    // semantically equivalent to undefined for this code.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const newProjectDir = join(tmpDir, 'project-moved-meta');
    renameSync(projectDir, newProjectDir);
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    // R162 (DATA-R162-01): paths is empty.
    expect(r.staleReason!.paths).toEqual([]);
    // R162 (DATA-R162-01): totalPaths=0 + pathsTruncated=false (R162 early
    // return sets these explicitly).
    expect(r.staleReason!.totalPaths).toBe(0);
    expect(r.staleReason!.pathsTruncated).toBe(false);
  });

  // ── Source-inspection regression guards ──────────────────────────────
  //
  // These guard against accidental removal of the R161 changes.

  it('regression: projectState query reads root_fingerprint AS rootFingerprint', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (ROOT-R161-01): the projectState SELECT now includes root_fingerprint.
    // R165 (API-R165-01): the SELECT ALSO reads last_successful_index_at
    // AS lastSuccessfulIndexAt (used by hasPublishedSnapshot). The exact
    // column list now ends with `last_successful_index_at AS
    // lastSuccessfulIndexAt FROM projects WHERE name = ?`.
    expect(src).toContain('root_fingerprint AS rootFingerprint');
    expect(src).toContain('last_successful_index_at AS lastSuccessfulIndexAt FROM projects WHERE name = ?');
  });

  it('regression (R162 override): rootChanged computed + early return + semanticsStale NO LONGER includes rootChanged', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (ROOT-R161-01): rootChanged is computed (still present in R162).
    expect(src).toContain('const publishedRootFingerprint = projectState?.rootFingerprint ?? null;');
    expect(src).toContain('const rootChanged = opts.incremental && publishedRootFingerprint !== null && publishedRootFingerprint !== rootFingerprint;');
    // R162 (DATA-R162-01 + RES-R162-01): the rootChanged EARLY RETURN is
    // present (returns STALE with ROOT_CHANGED before any mutation).
    expect(src).toContain("code: 'ROOT_CHANGED',");
    // R162 (STATE-R162-02): semanticsStale NO LONGER includes rootChanged.
    // The old OR-with-rootChanged line is GONE.
    expect(src).not.toContain('(rootChanged || existingSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION)');
    // R162 (STATE-R162-02): the new semanticsStale line uses only the version check.
    expect(src).toContain('const semanticsStale = opts.incremental\n    ? existingSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION\n    : false;');
  });

  it('regression: staleReason.code union includes ROOT_CHANGED', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(src).toContain("| 'ROOT_CHANGED'");
  });

  it('regression (R162 override): classifier NO LONGER has the ROOT_CHANGED branch (early return handles it)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (ROOT-R161-01): the classifier had `if (params.rootChanged)` BEFORE
    // the coldStartLock check.
    // R162 (STATE-R162-02): the classifier's `if (params.rootChanged)` branch
    // has been REMOVED. ROOT_CHANGED is now emitted by an EARLY RETURN in the
    // indexer, BEFORE the classifier is ever called. The classifier's
    // `rootChanged` param is retained for backward compatibility but is
    // always false in practice.
    expect(src).not.toContain('if (params.rootChanged)');
    // R162 (STATE-R162-02): the coldStartLock check is still present.
    expect(src).toContain('if (coldStartLock)');
    // R162 (STATE-R162-02): the rootChanged param is retained (deprecated).
    expect(src).toContain('rootChanged?: boolean;');
  });

  it('regression: classifier accepts historicalBrokenAliasPaths + uses it for HISTORICAL_ALIAS_BROKEN', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (API-R161-02): classifier accepts historicalBrokenAliasPaths.
    expect(src).toContain('historicalBrokenAliasPaths?: string[];');
    // R161 (API-R161-02): HISTORICAL_ALIAS_BROKEN uses historicalBrokenAliasPaths.
    expect(src).toContain('const capped = cap(params.historicalBrokenAliasPaths ?? params.brokenAliasPaths ?? [])');
  });

  it('regression: MAX_STALE_PATHS is module-level (no local duplicate)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (OBS-R161-03): module-level constant exists at column 0.
    expect(src).toContain('const MAX_STALE_PATHS = 100;');
    // R161 (OBS-R161-03): no local (indented) duplicate declarations.
    const localMatches = src.match(/^ {4,}const MAX_STALE_PATHS = 100;/gm) ?? [];
    expect(localMatches.length).toBe(0);
  });

  it('regression: classifier cap() returns metadata { paths, totalPaths, pathsTruncated }', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (OBS-R161-01): cap() returns an object with paths + totalPaths + pathsTruncated.
    expect(src).toContain('function cap(paths: string[]): { paths: string[]; totalPaths: number; pathsTruncated: boolean }');
    expect(src).toContain('const totalPaths = paths.length;');
    expect(src).toContain('const pathsTruncated = totalPaths > MAX_STALE_PATHS;');
  });

  it('regression: classifier return type includes totalPaths + pathsTruncated', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R161 (OBS-R161-01): the classifier's return type includes totalPaths + pathsTruncated.
    expect(src).toContain('paths: string[]; totalPaths?: number; pathsTruncated?: boolean } | undefined');
  });

  it('regression (R165 override): package.json version is 0.70.0', () => {
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).toContain('"version": "0.70.0"');
  });
});
