// v2/tests/indexer/r154-bootstrap-root-identity-atomic.test.ts
// R154: Bootstrap + Root Identity + Atomic State + Contribution + Visibility
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION, CURRENT_DISCOVERY_POLICY_VERSION, loadAliasHistory, computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R154: Bootstrap + Root Identity + Atomic State', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r154-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r154-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── MIG-R154-01: Cold-start lock ─────────────────────────────────────

  it('MIG-R154-01a: DB with nodes but no alias_history → cold-start lock on broken alias', async () => {
    // Run 1: index a project with a valid alias (populates alias_history + marks initialized).
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Simulate a cold-start: clear alias_history AND reset alias_history_initialized=0.
    // This simulates a DB that was indexed by R152 (has nodes, semantics=8) but
    // never had alias_history populated.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();

    // Run 2: break the alias. Cold-start lock should fire (history not initialized,
    // broken alias present, existing nodes > 0).
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R154: cold-start lock → hasUncertainty → stale.
    expect(r.crossFileCallsStale).toBe(true);
    // The old target's data must be preserved (no deletions allowed).
    const db2 = new Database(dbPath, { readonly: true });
    const nodes = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'real.ts') as { c: number };
    db2.close();
    expect(nodes.c).toBeGreaterThan(0);
  });

  it('MIG-R154-01b: successful run sets alias_history_initialized=1', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT alias_history_initialized AS init, discovery_policy_version AS pv FROM projects WHERE name = ?').get(projectName) as { init: number; pv: number };
    db.close();
    expect(row.init).toBe(1);
    expect(row.pv).toBe(CURRENT_DISCOVERY_POLICY_VERSION);
  });

  it('MIG-R154-01c: cold-start lock does NOT fire on first-ever index (no existing nodes)', async () => {
    // First-ever index with a broken symlink — no existing graph, no history.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R154: cold-start lock only fires when existing nodes > 0. First index has 0 nodes.
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    expect(r.outcome).toBe('SUCCESS_WITH_WARNINGS');
  });

  // ── ALIAS-R154-01: Root fingerprint ──────────────────────────────────

  it('ALIAS-R154-01a: root_fingerprint is persisted on projects table', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT root_fingerprint AS fp FROM projects WHERE name = ?').get(projectName) as { fp: string | null };
    db.close();
    expect(row.fp).not.toBeNull();
    expect(row.fp).toContain(projectDir);
  });

  it('ALIAS-R154-01b (R161 override): same project name + different root → ROOT_CHANGED stale (was: fresh history, no cross-root matching)', async () => {
    // R154's contract: alias_history is namespaced by root_fingerprint so
    // projectDir-B's broken alias does NOT match projectDir-A's history.
    // R154 verified this by running an incremental from projectDir-B and
    // asserting crossFileCallsStale=false (no protection needed → no stale).
    //
    // R161 (ROOT-R161-01): incremental from a different root is now refused
    // — the published snapshot's root fingerprint ≠ the current root
    // fingerprint. crossFileCallsStale is true and staleReason is
    // ROOT_CHANGED. The R154 namespacing contract is still preserved (the
    // alias_history doesn't match — see the ALIAS-R154-01c test below for
    // the namespacing assertion on a fresh history lookup), but R161 adds
    // a NEW invariant on top: the user must run a full reindex under the
    // new root before the graph can be certified fresh.
    //
    // Run 1: index projectDir-A with an alias.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Create a second project directory (different root, same project name).
    const projectDirB = join(tmpDir, 'projectB');
    mkdirSync(projectDirB, { recursive: true });
    writeFileSync(join(projectDirB, 'other.ts'), 'export function other() { return 2; }\n');
    // Add a broken alias in projectDirB.
    symlinkSync('/nonexistent', join(projectDirB, 'alias.ts'));

    // Run 2: index projectDirB with the SAME project name. The alias_history
    // from projectDir-A must NOT match (different root_fingerprint). But R161
    // also refuses the incremental because the root changed.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDirB, incremental: true, useWasm: true, workers: 0 });
    // R154: no errors (the broken alias in projectDirB doesn't trigger
    // historical-target protection — different root_fingerprint, no history).
    expect(r.errors.length).toBe(0);
    // R161 (ROOT-R161-01): crossFileCallsStale=true (was false in R154-R160).
    expect(r.crossFileCallsStale).toBe(true);
    // R161 (ROOT-R161-01): staleReason is ROOT_CHANGED.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('ROOT_CHANGED');
    expect(r.recovery).toBe('full_reindex');
  });

  it('ALIAS-R154-01b-full: FULL reindex from different root → SUCCESS + fresh history (no cross-root matching)', async () => {
    // Companion to ALIAS-R154-01b: this test verifies the R154 namespacing
    // contract using a FULL reindex (which R161 allows even when the root
    // changed). The full reindex clears the old graph and publishes a fresh
    // one under the new root_fingerprint. The broken alias in projectDirB
    // has no matching history (different root_fingerprint), so it's a
    // warning only — no stale, no historical-target protection.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    const projectDirB = join(tmpDir, 'projectB-full');
    mkdirSync(projectDirB, { recursive: true });
    writeFileSync(join(projectDirB, 'other.ts'), 'export function other() { return 2; }\n');
    symlinkSync('/nonexistent', join(projectDirB, 'alias.ts'));

    // Run 2: FULL reindex from projectDirB. R161's rootChanged check only
    // applies to incremental mode; full mode is unaffected.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDirB, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R154: the broken alias in projectDirB has no matching history (different
    // root_fingerprint), so no historical-target protection. The index
    // succeeds with warnings (the broken alias is a warning, not a blocker).
    expect(r.crossFileCallsStale).toBe(false);
    // R154: the new root_fingerprint is now persisted.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDirB);
    const row = db.prepare('SELECT root_fingerprint AS rfp FROM projects WHERE name = ?').get(projectName) as { rfp: string };
    db.close();
    expect(row.rfp).toBe(fp);
  });

  // ── ALIAS-R154-02: Contribution filter ───────────────────────────────

  it('ALIAS-R154-02a: alias to .txt file (non-contributive) is NOT historized', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'notes.txt'), 'just notes\n');
    symlinkSync(join(projectDir, 'notes.txt'), join(projectDir, 'notes-link.txt'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    // R154: the .txt alias is non-contributive (detectLanguage returns null for .txt),
    // so it should NOT be in alias_history.
    expect(history.has('notes-link.txt')).toBe(false);
  });

  it('ALIAS-R154-02b: alias to empty directory (non-contributive) is NOT historized', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    mkdirSync(join(projectDir, 'emptydir'));
    symlinkSync(join(projectDir, 'emptydir'), join(projectDir, 'emptydir-link'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    // R154: the empty directory alias is non-contributive (no discovered files under it).
    expect(history.has('emptydir-link')).toBe(false);
  });

  it('ALIAS-R154-02c: alias to .ts file (contributive) IS historized', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    expect(history.has('alias.ts')).toBe(true);
    expect(history.get('alias.ts')!.targetKind).toBe('file');
  });

  // ── ALIAS-R154-03: Target visibility check ───────────────────────────

  it('ALIAS-R154-03a: broken alias + target still visible directly → no stale', async () => {
    // Run 1: alias valid.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: break the alias BUT keep real.ts visible directly.
    unlinkSync(join(projectDir, 'alias.ts'));
    symlinkSync('/nonexistent', join(projectDir, 'alias.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R154: real.ts is still in currentRelPaths, so no protection needed.
    // The broken alias is a warning only, not stale.
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    expect(r.outcome).toBe('SUCCESS_WITH_WARNINGS');
  });

  it('ALIAS-R154-03b: broken alias + target visible via second alias → no stale', async () => {
    // Run 1: two aliases to the same target.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'aliasA.ts'));
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'aliasB.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: break aliasA but keep aliasB valid.
    unlinkSync(join(projectDir, 'aliasA.ts'));
    symlinkSync('/nonexistent', join(projectDir, 'aliasA.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R154: real.ts is still discoverable via aliasB, so no protection needed.
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
  });

  // ── OUTCOME-R154-01: --allow-partial contract ────────────────────────

  it('OUTCOME-R154-01a: cold-start lock on full → STALE (not FAILED)', async () => {
    // Run 1: populate history.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Simulate cold-start.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();

    // Run 2: full mode with broken alias. Cold-start lock → full uncertainty abort.
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R154 (OUTCOME-R154-02): outcome is STALE, not FAILED.
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);
  });

  // ── SCHEMA-R154-01: CHECK constraint on target_kind ──────────────────

  it('SCHEMA-R154-01a: target_kind CHECK rejects invalid values', async () => {
    // R155 (TEST-R155-01): fixed non-awaited Promise. The test is now async
    // and awaits the indexProjectWasm call before asserting.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    try {
      // Attempt to insert an invalid target_kind — should throw due to CHECK constraint.
      expect(() => {
        db.prepare(
          "INSERT INTO alias_history (project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(projectName, 'x', 'y', 'invalid_kind', new Date().toISOString(), 'fp');
      }).toThrow();
    } finally {
      db.close();
    }
  });

  // ── Regression ────────────────────────────────────────────────────────

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 8 (no bump)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(8);
  });

  it('regression: CURRENT_DISCOVERY_POLICY_VERSION is 3 (coverage modes)', () => {
    expect(CURRENT_DISCOVERY_POLICY_VERSION).toBe(3);
  });

  it('regression: alias_history survives full reindex (R153+R154)', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    expect(history.size).toBe(1);
    expect(history.get('alias.ts')).toBeDefined();
  });
});
