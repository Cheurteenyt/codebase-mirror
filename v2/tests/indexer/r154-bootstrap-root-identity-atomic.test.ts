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

  it('ALIAS-R154-01b: same project name + different root → fresh history (no cross-root matching)', async () => {
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
    // from projectDir-A must NOT match (different root_fingerprint).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDirB, incremental: true, useWasm: true, workers: 0 });
    // R154: the broken alias in projectDirB has no matching history (different root),
    // so no protection needed. The index should succeed without stale.
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
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

  it('regression: CURRENT_DISCOVERY_POLICY_VERSION is 2 (R155)', () => {
    expect(CURRENT_DISCOVERY_POLICY_VERSION).toBe(2);
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
