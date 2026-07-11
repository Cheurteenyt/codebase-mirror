// v2/tests/indexer/r158-publication-orchestrator-classifier.test.ts
// R158: Publication Orchestrator + Unified staleReason Classifier + failure field
//
// Closes the R157 audit findings:
//   - OBS-R158-01/02/03: classifyStaleReason unified classifier used by ALL
//     stale return paths (no-op, deletion-only, main) so the codes/messages/
//     recovery are consistent. R157 hand-rolled staleCode in each path with
//     inconsistent priority and missed HISTORICAL_ALIAS_BROKEN + COLD_START_LOCK.
//   - OUTCOME-R158-01: structured `failure` field on IndexResult so FAILED
//     outcomes carry the specific failure (PERSIST_FAILURE, phase). R157 put
//     the error message in staleReason.message but the `errors[]` array was
//     empty, making programmatic diagnosis hard.
//   - PERF-R158-01: staleReason.paths capped at 100 so a repo with thousands
//     of broken symlinks doesn't produce a multi-MB IndexResult.
//   - ROOT-R158-01: premark UPSERT now updates root_path too, so a project
//     reconfigured to a new root has its root_path updated atomically.
//   - SYNC-R158-01/02: sync-graph-ui-to-gitlab.yml hardened (full fetch,
//     remove_source_branch on PUT, fail-loudly if MR_COUNT > 1).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION, computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

/**
 * R158 (OUTCOME-R158-01): Commit failure injection.
 *
 * vi.hoisted lets the mock factory close over a mutable flag without breaking
 * vitest's hoisting rules. The factory itself is hoisted, but vi.hoisted
 * ensures the flag object is created BEFORE the factory runs.
 */
const commitFailure = vi.hoisted(() => ({ shouldFail: false, phase: '' }));

vi.mock('../../src/indexer/schema.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    commitAliasStateAtomically: vi.fn((...args: Parameters<typeof actual.commitAliasStateAtomically>) => {
      if (commitFailure.shouldFail) {
        throw new Error(`R158: injected commitAliasStateAtomically failure (phase=${commitFailure.phase})`);
      }
      return (actual.commitAliasStateAtomically as (...a: typeof args) => void)(...args);
    }),
  };
});

describe('R158: Publication Orchestrator + Unified Classifier', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r158-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r158-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
    commitFailure.shouldFail = false;
    commitFailure.phase = '';
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    commitFailure.shouldFail = false;
    commitFailure.phase = '';
  });

  // ── OBS-R158-01: classifyStaleReason returns correct code per cause ──
  //
  // The classifyStaleReason function is a private helper in indexer.ts, but
  // its behavior is observable through IndexResult.staleReason.code on every
  // stale return path. These tests trigger each cause and verify the code.

  it('OBS-R158-01a: no-op with stale semantics → SEMANTICS_MISMATCH', async () => {
    // Run 1: full index (certifies CURRENT semantics).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Corrupt: set the semantics version to something other than CURRENT.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET extractor_semantics_version = ? WHERE name = ?').run(CURRENT_EXTRACTOR_SEMANTICS_VERSION + 1, projectName);
    db.close();
    // Run 2: no-op incremental. classifyStaleReason → SEMANTICS_MISMATCH.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('SEMANTICS_MISMATCH');
    expect(r.staleReason!.message.length).toBeGreaterThan(0);
    expect(r.recovery).toBe('full_reindex');
  });

  it('OBS-R158-01b: full mode with historically-broken alias → HISTORICAL_ALIAS_BROKEN', async () => {
    // Run 1: index with a valid alias → alias_history populated.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: remove target, full mode → HISTORICAL_ALIAS_BROKEN.
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('OBS-R158-01c: full mode with uninitialized history + broken alias → COLD_START_LOCK', async () => {
    // Run 1: index with a valid alias → alias_history populated + initialized=1.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate cold-start: clear history + reset flags (existing nodes remain).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();
    // Run 2: break alias, full mode → COLD_START_LOCK (history not initialized,
    // broken aliases present, existing nodes present).
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('COLD_START_LOCK');
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('OBS-R158-01d: no-op with stale flag → PREVIOUSLY_STALE', async () => {
    // Run 1: full index (success, no stale).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Manually set stale=1 (simulating a prior failed run).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET cross_file_calls_stale = 1 WHERE name = ?').run(projectName);
    db.close();
    // Run 2: no-op incremental → PREVIOUSLY_STALE (no semantics mismatch, no
    // uncertainty, no broken aliases, call_sites initialized).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('PREVIOUSLY_STALE');
    expect(r.recovery).toBe('full_reindex');
  });

  // ── OUTCOME-R158-01: FAILED outcome carries structured `failure` field ──

  it('OUTCOME-R158-01a: no-op publication failure → FAILED + failure field, errors empty', async () => {
    // Run 1: full index to populate history + nodes.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: no-op incremental with injected commit failure.
    commitFailure.shouldFail = true;
    commitFailure.phase = 'no-op';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('FAILED');
    // errors[] stays empty — publication failure is NOT a per-file error.
    expect(r.errors.length).toBe(0);
    // The failure field carries the structured diagnostic.
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('PERSIST_FAILURE');
    expect(r.failure!.message).toContain('injected commitAliasStateAtomically failure');
    expect(r.failure!.phase).toBe('no-op-commit');
    // staleReason still surfaces PERSIST_FAILURE for the CLI banner.
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('PERSIST_FAILURE');
  });

  it('OUTCOME-R158-01b: deletion-only publication failure → FAILED + failure.deletion-only-commit', async () => {
    // Run 1: full index.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: delete a file so the deletion-only path runs.
    unlinkSync(join(projectDir, 'a.ts'));
    commitFailure.shouldFail = true;
    commitFailure.phase = 'deletion-only';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('FAILED');
    expect(r.errors.length).toBe(0);
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('PERSIST_FAILURE');
    expect(r.failure!.phase).toBe('deletion-only-commit');
  });

  it('OUTCOME-R158-01c: main publication failure → FAILED + failure.main-commit', async () => {
    // Run 1: full index with a single file.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: modify a file so the main path runs (not no-op).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 2; }\n');
    commitFailure.shouldFail = true;
    commitFailure.phase = 'main';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('PERSIST_FAILURE');
    expect(r.failure!.phase).toBe('main-commit');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('PERSIST_FAILURE');
  });

  // ── PERF-R158-01: staleReason.paths capped at 100 ────────────────────

  it('PERF-R158-01: staleReason.paths is capped at 100 (150+ broken aliases)', async () => {
    // Run 1: create 150 valid file aliases, populate history.
    writeFileSync(join(projectDir, 'util.ts'), 'export function util() { return 1; }\n');
    for (let i = 0; i < 150; i++) {
      symlinkSync(join(projectDir, 'util.ts'), join(projectDir, `alias${i}.ts`));
    }
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: remove the target so ALL 150 aliases become broken with absent
    // target. Full mode → STALE + HISTORICAL_ALIAS_BROKEN. Without the cap,
    // staleReason.paths would have 150 entries; with the cap, exactly 100.
    unlinkSync(join(projectDir, 'util.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    // R158 (PERF-R158-01): paths capped at MAX_STALE_PATHS=100.
    expect(r.staleReason!.paths.length).toBeLessThanOrEqual(100);
    expect(r.staleReason!.paths.length).toBe(100);
  });

  // ── ROOT-R158-01: premark UPSERT updates root_path ───────────────────

  it('ROOT-R158-01a: premark UPSERT updates root_path when project root changes', async () => {
    // Run 1: index from projectDir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Move the project to a new root, keeping the same project name + DB.
    const newProjectDir = join(tmpDir, 'project-moved');
    renameSync(projectDir, newProjectDir);
    // Run 2: re-index from the new root. The premark UPSERT must update
    // root_path to the new path. R157's premark did NOT include root_path in
    // the ON CONFLICT DO UPDATE SET clause, so the row kept the old path.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('SUCCESS');
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT root_path AS rp FROM projects WHERE name = ?').get(projectName) as { rp: string };
    db.close();
    // R158: root_path is updated to the new path.
    expect(row.rp).toBe(newProjectDir);
    expect(row.rp).not.toBe(projectDir);
  });

  it('ROOT-R158-01b: premark UPSERT also updates root_path on the deletion-only path', async () => {
    // Run 1: index from projectDir with two files.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function b() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Move to a new root.
    const newProjectDir = join(tmpDir, 'project-moved2');
    renameSync(projectDir, newProjectDir);
    // Delete b.ts so the next run hits the deletion-only fast path.
    unlinkSync(join(newProjectDir, 'b.ts'));
    // Run 2: incremental from new root + deletion → deletion-only path.
    const r = await indexProjectWasm({ project: projectName, rootPath: newProjectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(false);
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT root_path AS rp FROM projects WHERE name = ?').get(projectName) as { rp: string };
    db.close();
    // R158: root_path is updated by the deletion-only premark UPSERT too.
    expect(row.rp).toBe(newProjectDir);
  });

  // ── Regression: IndexResult type carries `failure?` field ────────────

  it('regression: IndexResult type carries `failure?: { code, message, phase }`', () => {
    // R158 (OUTCOME-R158-01): the IndexResult interface must declare the
    // failure field. This source-inspection test guards against accidental
    // removal of the field (a regression would silently break programmatic
    // consumers that rely on failure.code for triage).
    // R160 (API-R160-03): the type union was expanded from
    //   'PERSIST_FAILURE' | 'EXTRACTION_CRASH' | 'DB_ERROR' | 'UNKNOWN'
    // to
    //   'ROOT_ERROR' | 'DISCOVERY_ERROR' | 'DISCOVERY_PARTIAL' | 'DB_ERROR' |
    //   'RESOLVER_ERROR' | 'EXTRACTION_CRASH' | 'PERSIST_FAILURE' | 'UNKNOWN'
    const indexerSrc = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(indexerSrc).toContain('failure?: {');
    expect(indexerSrc).toContain("'ROOT_ERROR'");
    expect(indexerSrc).toContain("'DISCOVERY_ERROR'");
    expect(indexerSrc).toContain("'DISCOVERY_PARTIAL'");
    expect(indexerSrc).toContain("'RESOLVER_ERROR'");
    expect(indexerSrc).toContain("'EXTRACTION_CRASH'");
    expect(indexerSrc).toContain("'PERSIST_FAILURE'");
    expect(indexerSrc).toContain("'DB_ERROR'");
    expect(indexerSrc).toContain("'UNKNOWN'");
    expect(indexerSrc).toContain('message: string');
    expect(indexerSrc).toContain('phase: string');
  });

  it('regression: all three catch blocks include a `failure:` field', () => {
    // Source-inspection guard: R158 adds `failure: { code: 'PERSIST_FAILURE', ... }`
    // to all three catch blocks (no-op, deletion-only, main). A regression that
    // removes any of them would silently degrade programmatic diagnosis.
    const indexerSrc = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(indexerSrc).toContain("failure: { code: 'PERSIST_FAILURE', message: noOpErrMsg, phase: 'no-op-commit' }");
    expect(indexerSrc).toContain("failure: { code: 'PERSIST_FAILURE', message: deletionErrMsg, phase: 'deletion-only-commit' }");
    expect(indexerSrc).toContain("failure: { code: 'PERSIST_FAILURE', message: errMsg, phase: 'main-commit' }");
  });

  it('regression: classifyStaleReason is defined and called by all three paths', () => {
    // Source-inspection guard: R158 introduces classifyStaleReason and uses it
    // in no-op, deletion-only, and main paths. A regression that goes back to
    // hand-rolled staleCode would re-introduce the inconsistency.
    const indexerSrc = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(indexerSrc).toContain('function classifyStaleReason(params: {');
    // Each call site is identifiable by its surrounding variable name.
    expect(indexerSrc).toContain('const noOpClassified = noOpStale');
    expect(indexerSrc).toContain('const deletionClassified = crossFileStale');
    expect(indexerSrc).toContain('const mainClassified = crossFileStale');
  });

  it('regression: staleReason.paths cap is in place (MAX_STALE_PATHS = 100)', () => {
    const indexerSrc = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    expect(indexerSrc).toContain('const MAX_STALE_PATHS = 100');
    expect(indexerSrc).toContain('const cappedPaths = brokenPaths.slice(0, MAX_STALE_PATHS)');
  });

  it('regression: premark UPSERT does NOT update root_path (R160 STATE-R160-02)', () => {
    // R158 (ROOT-R158-01): the premark UPSERT set root_path = excluded.root_path
    // so a project reconfigured to a new root had its root_path updated
    // atomically with the premark.
    // R160 (STATE-R160-02): REMOVED `root_path = excluded.root_path` from BOTH
    // premark UPSERT blocks (main path + deletion-only path). The premark
    // should NOT update root_path — only the final commit (via
    // commitAliasStateAtomically or updateProjectStats) should update
    // root_path on success. The premark represents an ATTEMPTED root, not a
    // confirmed snapshot root. If the premark updated root_path and the index
    // then failed, the DB would record the attempted (possibly broken) root
    // as the project's root_path, misleading Graph Status and the next run's
    // root_fingerprint computation.
    const indexerSrc = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // The premark is identifiable by the 'Index publication in progress'
    // literal in the INSERT VALUES. The final commit UPSERTs (in schema.ts)
    // DO legitimately use `root_path = excluded.root_path` because they are
    // the success path. We extract the two premark blocks (in indexer.ts)
    // and verify they don't contain the root_path update in the actual SQL.
    const premarkMarker = "'Index publication in progress'";
    let cursor = 0;
    let premarkCount = 0;
    while (true) {
      const idx = indexerSrc.indexOf(premarkMarker, cursor);
      if (idx === -1) break;
      premarkCount++;
      // Extract a window around the marker (the SQL block is ~500 chars).
      const block = indexerSrc.slice(idx - 400, idx + 200);
      // R160 (STATE-R160-02): the premark block must NOT contain
      // root_path = excluded.root_path in the ON CONFLICT DO UPDATE clause
      // (with the trailing comma to avoid matching comments).
      expect(block).not.toContain('root_path = excluded.root_path,');
      cursor = idx + 1;
    }
    // There must be at least 2 premark blocks (main path + deletion-only).
    expect(premarkCount).toBeGreaterThanOrEqual(2);
  });

  it('regression: sync-graph-ui workflow no longer uses --depth=1 fetch', () => {
    const workflowPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'sync-graph-ui-to-gitlab.yml');
    expect(existsSync(workflowPath)).toBe(true);
    const yml = readFileSync(workflowPath, 'utf8');
    // R158 (SYNC-R158-01): full fetch (no --depth=1) so merge-base works.
    expect(yml).toContain('git fetch origin main');
    expect(yml).not.toContain('git fetch origin main --depth=1');
    // R158 (SYNC-R158-02): remove_source_branch=true on PUT too.
    // Count occurrences of remove_source_branch=true — should be at least 2
    // (POST create + PUT update).
    const matches = yml.match(/remove_source_branch=true/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // R158: fail loudly if MR_COUNT > 1.
    expect(yml).toContain('MR_COUNT" -eq 1');
    expect(yml).toContain('MR_COUNT open MRs for source branch');
  });
});
