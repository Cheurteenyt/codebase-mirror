// v2/tests/indexer/r153-alias-history.test.ts
// R153: Alias History + Historical Target Safety + Warning Propagation
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION, loadAliasHistory, computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';

describe('R153: Alias History + Historical Target Safety', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r153-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r153-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── DATA-R153-01: File alias valid → broken → restored ───────────────

  it('DATA-R153-01a: file alias valid → target absent → old target preserved (incremental)', async () => {
    // Run 1: alias points to a valid file. Target indexed.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    const r1 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r1.errors.length).toBe(0);
    expect(r1.crossFileCallsStale).toBe(false);

    // Verify alias_history was populated.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const history = loadAliasHistory(db, projectName, computeRootFingerprint(projectDir));
    db.close();
    expect(history.size).toBe(1);
    const entry = history.get('alias.ts');
    expect(entry).toBeDefined();
    expect(entry!.canonicalTarget).toBe('real.ts');
    expect(entry!.targetKind).toBe('file');

    // Run 2: temporarily remove the target. Alias is now broken.
    // The OLD target's data (real.ts) must NOT be deleted.
    unlinkSync(join(projectDir, 'real.ts'));
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R153: the broken alias was historically valid → hasUncertainty → stale.
    expect(r2.crossFileCallsStale).toBe(true);
    expect(r2.errors.length).toBe(0);
    // The old target's data must still be in the DB.
    const db2 = new Database(dbPath, { readonly: true });
    const nodes = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'real.ts') as { c: number };
    db2.close();
    expect(nodes.c).toBeGreaterThan(0);
  });

  it('DATA-R153-01b: file alias valid → target absent → restored → fresh', async () => {
    // Run 1: alias valid, target indexed.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: target temporarily absent.
    unlinkSync(join(projectDir, 'real.ts'));
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.crossFileCallsStale).toBe(true);

    // Run 3: target restored. Incremental should succeed and be fresh.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    const r3 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r3.errors.length).toBe(0);
    expect(r3.crossFileCallsStale).toBe(false);
  });

  it('DATA-R153-01c: file alias valid → target absent → full aborts to preserve graph', async () => {
    // Run 1: alias valid.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: target absent. Full mode must abort (hasUncertainty from history).
    unlinkSync(join(projectDir, 'real.ts'));
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r2.crossFileCallsStale).toBe(true);
    // R155 (OUTCOME-R155-01): STALE outcome must NOT carry errors. The contract
    // is errors>0 → FAILED. R154 put the uncertainty message in errors[] AND
    // set outcome='STALE'. R155 uses errors=[] and outcome='STALE'. The
    // human-readable reason is in the DB's last_index_error (set by
    // markProjectStalePreservingGraph).
    expect(r2.errors.length).toBe(0);
    expect(r2.outcome).toBe('STALE');
  });

  // ── DATA-R153-01: Directory alias valid → broken → restored ──────────

  it('DATA-R153-01d: directory alias valid → target absent → subtree preserved (incremental)', async () => {
    // Run 1: alias points to a valid directory with files inside.
    mkdirSync(join(projectDir, 'realdir'));
    writeFileSync(join(projectDir, 'realdir', 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'realdir', 'b.ts'), 'export function b() { return 2; }\n');
    symlinkSync(join(projectDir, 'realdir'), join(projectDir, 'aliasdir'));
    const r1 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r1.errors.length).toBe(0);

    // Verify alias_history has target_kind=directory.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const history = loadAliasHistory(db, projectName, computeRootFingerprint(projectDir));
    db.close();
    const entry = history.get('aliasdir');
    expect(entry).toBeDefined();
    expect(entry!.targetKind).toBe('directory');

    // Run 2: temporarily rename the directory. Alias is broken.
    renameSync(join(projectDir, 'realdir'), join(projectDir, 'realdir.bak'));
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r2.crossFileCallsStale).toBe(true);

    // The old subtree files must still be in the DB.
    const db2 = new Database(dbPath, { readonly: true });
    const nodesA = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'realdir/a.ts') as { c: number };
    const nodesB = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'realdir/b.ts') as { c: number };
    db2.close();
    expect(nodesA.c).toBeGreaterThan(0);
    expect(nodesB.c).toBeGreaterThan(0);
  });

  // ── DATA-R153-02: ELOOP historical ───────────────────────────────────

  it('DATA-R153-02a: alias valid → ELOOP → old target preserved (incremental)', async () => {
    // Run 1: alias valid.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: replace alias with a loop AND remove the target.
    // R154 (ALIAS-R154-03): if the target is still visible, no protection
    // is needed. To test the historical protection, we must remove the target
    // so it's genuinely absent from the current discovery.
    unlinkSync(join(projectDir, 'real.ts'));
    unlinkSync(join(projectDir, 'alias.ts'));
    symlinkSync(join(projectDir, 'alias.ts'), join(projectDir, 'alias.ts')); // self-loop
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R153+R154: ELOOP on a historically-valid alias, target absent → hasUncertainty → stale.
    expect(r2.crossFileCallsStale).toBe(true);
    expect(r2.errors.length).toBe(0);

    // Old target's data must still be in the DB.
    const dbPath = defaultCodeDbPath(projectName);
    const db2 = new Database(dbPath, { readonly: true });
    const nodes = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'real.ts') as { c: number };
    db2.close();
    expect(nodes.c).toBeGreaterThan(0);
  });

  // ── No history → no protection (R152 behavior preserved) ─────────────

  it('DATA-R153-01e: broken symlink with no history → warning only, no stale', async () => {
    // First full with a broken symlink (never seen valid before).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.total).toBeGreaterThan(0);
  });

  it('DATA-R153-01f: unrelated deletion still works when alias is broken', async () => {
    // Run 1: two files + alias to one of them.
    writeFileSync(join(projectDir, 'keep.ts'), 'export function keep() { return 1; }\n');
    writeFileSync(join(projectDir, 'delete-me.ts'), 'export function del() { return 2; }\n');
    symlinkSync(join(projectDir, 'keep.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: delete the unrelated file AND break the alias target.
    unlinkSync(join(projectDir, 'delete-me.ts'));
    unlinkSync(join(projectDir, 'keep.ts'));
    const r2 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    // R153: broken alias with history → hasUncertainty → stale.
    expect(r2.crossFileCallsStale).toBe(true);
    // The unrelated deletion IS still processed (it's not protected).
    // The protected target (keep.ts) is preserved.
    const dbPath = defaultCodeDbPath(projectName);
    const db2 = new Database(dbPath, { readonly: true });
    const keepNodes = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'keep.ts') as { c: number };
    const deleteNodes = db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?').get(projectName, 'delete-me.ts') as { c: number };
    db2.close();
    expect(keepNodes.c).toBeGreaterThan(0);  // protected by alias history
    expect(deleteNodes.c).toBe(0);            // unrelated, deleted normally
  });

  // ── OBS-R153-01: Warning propagation in all return paths ─────────────

  it('OBS-R153-01a: dry-run includes warnings field', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, dryRun: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.total).toBeGreaterThan(0);
    expect(r.warnings!.countsByCode['ENOENT']).toBeGreaterThan(0);
  });

  // ── OBS-R153-02: All warning codes carry paths ───────────────────────

  it('OBS-R153-02a: ENOENT (broken symlink) carries root-relative path', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const d = discoverSourceFilesStructured(projectDir);
    const enoentSamples = d.warningSamples.filter(s => s.code === 'ENOENT');
    expect(enoentSamples.length).toBeGreaterThan(0);
    expect(enoentSamples[0].path).toBe('broken.ts');
    expect(enoentSamples[0].path.startsWith('/')).toBe(false);
  });

  it('OBS-R153-02b: ELOOP carries root-relative path', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'loop.ts'), join(projectDir, 'loop.ts')); // self-loop
    const d = discoverSourceFilesStructured(projectDir);
    const eloopSamples = d.warningSamples.filter(s => s.code === 'ELOOP');
    expect(eloopSamples.length).toBeGreaterThan(0);
    expect(eloopSamples[0].path).toBe('loop.ts');
    expect(eloopSamples[0].path.startsWith('/')).toBe(false);
  });

  // ── OUTCOME-R153-01: Typed outcome field ─────────────────────────────

  it('OUTCOME-R153-01a: clean index → outcome=SUCCESS', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
  });

  it('OUTCOME-R153-01b: index with broken symlink (no history) → outcome=SUCCESS_WITH_WARNINGS', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS_WITH_WARNINGS');
  });

  it('OUTCOME-R153-01c: stale (historical alias broken) → outcome=STALE', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 42; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
  });

  // ── API-R153-01: globalDeletionUncertainty deprecated ────────────────

  it('API-R153-01a: globalDeletionUncertainty always false for broken symlinks (R152+R153)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const d = discoverSourceFilesStructured(projectDir);
    // R152+: broken symlinks don't set globalDeletionUncertainty.
    // R153: kept for backward compat, always false.
    expect(d.globalDeletionUncertainty).toBe(false);
  });

  it('API-R153-01b: resolvedAliases and brokenAliases populated', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const d = discoverSourceFilesStructured(projectDir);
    expect(d.resolvedAliases.length).toBe(1);
    expect(d.resolvedAliases[0].aliasPath).toBe('alias.ts');
    expect(d.resolvedAliases[0].canonicalTarget).toBe('real.ts');
    expect(d.resolvedAliases[0].targetKind).toBe('file');
    expect(d.brokenAliases.length).toBe(1);
    expect(d.brokenAliases[0].aliasPath).toBe('broken.ts');
    expect(d.brokenAliases[0].code).toBe('ENOENT');
  });

  // ── Regression ────────────────────────────────────────────────────────

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9 (R184)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
  });

  it('regression: alias_history table persists across full reindex (R153)', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Full reindex — alias_history must NOT be cleared.
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const history = loadAliasHistory(db, projectName, computeRootFingerprint(projectDir));
    db.close();
    expect(history.size).toBe(1);
    expect(history.get('alias.ts')).toBeDefined();
  });

  it('regression: removed alias is garbage-collected from alias_history', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Remove the alias.
    unlinkSync(join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const history = loadAliasHistory(db, projectName, computeRootFingerprint(projectDir));
    db.close();
    // The removed alias should be garbage-collected.
    expect(history.has('alias.ts')).toBe(false);
  });
});
