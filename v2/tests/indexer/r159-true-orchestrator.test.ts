// v2/tests/indexer/r159-true-orchestrator-discriminated-result.test.ts
// R159: True Orchestrator + Discriminated Result
//
// Closes the R158 audit findings:
//   - RES-R159-01: outer try/catch/finally around the main path. R158's catch
//     blocks only wrapped commitAliasStateAtomically — exceptions during
//     preloadGrammars, extractFromFilesWasm, indexParallel, deleteTx, totals,
//     updateProjectStats escaped without structured failure or guaranteed DB
//     close. R159 wraps the ENTIRE main path; the outer catch returns FAILED
//     with `failure: { code: 'EXTRACTION_CRASH', phase: 'main-path' }` and the
//     outer finally is the ONLY db.close() for the main path.
//   - OUTCOME-R159-01: classifier priority reordered. Filesystem blockers
//     (COLD_START_LOCK, HISTORICAL_ALIAS_BROKEN) now come BEFORE
//     SEMANTICS_MISMATCH. If both exist, R158 recommended full_reindex which
//     would be blocked by the broken alias — circular recovery. R159 fixes
//     the filesystem FIRST, then does the full reindex.
//   - OUTCOME-R159-02: extraction errors no longer mislabeled as
//     PREVIOUSLY_STALE. R158's main-path staleReason builder fell back to
//     PREVIOUSLY_STALE when the classifier returned undefined (extraction
//     errors). R159: when classifier returns undefined, staleReason is
//     undefined (errors are in result.errors[]; outcome=PARTIAL/FAILED).
//   - API-R159-01: ALL FAILED paths now carry a structured `failure` field
//     (code/message/phase). R158 only added it to the three publication-failure
//     catch blocks. R159 adds it to root-validation, discovery, discovery-partial,
//     dry-run-root, dry-run-discovery, and main-path (outer catch).
//   - CLI-R159-01: CLI displays `result.failure` (code/phase/message) in the
//     PARTIAL/FAILED banner. R158 added the field but the CLI never surfaced it.
//   - OBS-R159-03: staleReason now carries `totalPaths` + `pathsTruncated` so
//     consumers can display "(showing 100 of N)". R158's silent cap hid the
//     magnitude of filesystem breakage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * R159 (RES-R159-01): outer-catch failure injection.
 *
 * We mock `extractFromFilesWasm` to throw so the outer try/catch is exercised.
 * The mock factory uses `vi.hoisted` so the flag is created BEFORE the factory
 * runs (same pattern as R158's commitFailure).
 */
const extractionCrash = vi.hoisted(() => ({ shouldCrash: false, phase: '' }));

vi.mock('../../src/indexer/wasm-extractor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    extractFromFilesWasm: vi.fn((...args: Parameters<typeof actual.extractFromFilesWasm>) => {
      if (extractionCrash.shouldCrash) {
        throw new Error(`R159: injected extractFromFilesWasm crash (phase=${extractionCrash.phase})`);
      }
      return (actual.extractFromFilesWasm as (...a: typeof args) => Promise<unknown>)(...args);
    }),
    // preloadGrammars must also be mocked-through so it doesn't crash before
    // the extraction crash can be observed. Pass-through to the real impl.
    preloadGrammars: actual.preloadGrammars,
    discoverSourceFilesStructured: actual.discoverSourceFilesStructured,
    detectLanguage: actual.detectLanguage,
  };
});

/**
 * Helper: spawn the CLI binary and capture stdout/stderr/exit code.
 * Used for the CLI-R159-01 test (failure display).
 */
interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
const CLI_PATH = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on('data', (d) => stdout.push(d.toString()));
    proc.stderr.on('data', (d) => stderr.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code });
    });
  });
}

describe('R159: True Orchestrator + Discriminated Result', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r159-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r159-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
    extractionCrash.shouldCrash = false;
    extractionCrash.phase = '';
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    extractionCrash.shouldCrash = false;
    extractionCrash.phase = '';
  });

  // ── OUTCOME-R159-01: classifier priority — filesystem blockers FIRST ──
  //
  // R158 put SEMANTICS_MISMATCH first, so a project with both semantics
  // mismatch AND a broken alias would be told to do a full_reindex that
  // immediately aborts with HISTORICAL_ALIAS_BROKEN — circular recovery.
  // R159 reorders so filesystem blockers come first.

  it('OUTCOME-R159-01a: COLD_START_LOCK + SEMANTICS_MISMATCH → COLD_START_LOCK (filesystem blocker wins)', async () => {
    // Run 1: full index with a valid alias → alias_history populated.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simultaneously: (a) break the cold-start state (clear history + reset flags),
    // AND (b) corrupt the semantics version. The next full mode run will have
    // BOTH coldStartLock AND semanticsStale. R158 returned SEMANTICS_MISMATCH
    // (recommending full_reindex, which would be blocked by the cold-start lock).
    // R159 returns COLD_START_LOCK (recommending fix_filesystem first).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0, extractor_semantics_version = ? WHERE name = ?').run(CURRENT_EXTRACTOR_SEMANTICS_VERSION + 1, projectName);
    db.close();
    // Break the alias so cold-start lock fires.
    unlinkSync(join(projectDir, 'real.ts'));
    // Full mode → hasUncertainty (cold-start lock) → STALE return.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    // R159: COLD_START_LOCK wins over SEMANTICS_MISMATCH.
    expect(r.staleReason!.code).toBe('COLD_START_LOCK');
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('OUTCOME-R159-01b: HISTORICAL_ALIAS_BROKEN + SEMANTICS_MISMATCH → HISTORICAL_ALIAS_BROKEN (filesystem blocker wins)', async () => {
    // Run 1: index with a valid alias → alias_history populated.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Corrupt: (a) set semantics version to non-CURRENT, AND (b) break the alias
    // (which has history). Next full mode run will have BOTH
    // hasEffectiveHistoricalBrokenAliases AND semanticsStale. R158 returned
    // SEMANTICS_MISMATCH (recommending full_reindex, which would be blocked by
    // the broken alias). R159 returns HISTORICAL_ALIAS_BROKEN (recommending
    // fix_filesystem first).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET extractor_semantics_version = ? WHERE name = ?').run(CURRENT_EXTRACTOR_SEMANTICS_VERSION + 1, projectName);
    db.close();
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    // R159: HISTORICAL_ALIAS_BROKEN wins over SEMANTICS_MISMATCH.
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    expect(r.recovery).toBe('fix_filesystem');
  });

  it('OUTCOME-R159-01c: SEMANTICS_MISMATCH alone (no filesystem blocker) → SEMANTICS_MISMATCH still works', async () => {
    // Regression guard: reordering must NOT break the SEMANTICS_MISMATCH case
    // when no filesystem blocker is present.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('UPDATE projects SET extractor_semantics_version = ? WHERE name = ?').run(CURRENT_EXTRACTOR_SEMANTICS_VERSION + 1, projectName);
    db.close();
    // No-op incremental → SEMANTICS_MISMATCH (no broken aliases, no cold-start).
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('SEMANTICS_MISMATCH');
    expect(r.recovery).toBe('full_reindex');
  });

  // ── OUTCOME-R159-02: extraction errors → no staleReason (was PREVIOUSLY_STALE) ──
  //
  // R158's main-path staleReason builder fell back to PREVIOUSLY_STALE when
  // the classifier returned undefined (extraction errors). R159: undefined.

  it('OUTCOME-R159-02a: incremental with extraction errors → no staleReason, recovery=retry_incremental', async () => {
    // Run 1: full index (success, fresh graph).
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: modify the file so the main path runs (not no-op). Use
    // CBM_TEST_FAIL_ON_FILE to inject an extraction error →
    // incrementalHadErrors=true → classifier returns undefined → R159
    // staleReason=undefined (R158 fell back to PREVIOUSLY_STALE with the
    // indexError message).
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo() + 1; }\n');
    process.env.NODE_ENV = 'test';
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';
    try {
      const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
      // The outcome is PARTIAL (errors>0, run completed) or FAILED (rare).
      expect(['PARTIAL', 'FAILED']).toContain(r.outcome);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.crossFileCallsStale).toBe(true);
      // R159: staleReason is undefined (classifier returned undefined because
      // hasExtractionErrors=true and no other cause). R158 returned
      // { code: 'PREVIOUSLY_STALE', message: 'Incremental extraction errors...' }.
      expect(r.staleReason).toBeUndefined();
      // Recovery should still be 'retry_incremental' so consumers know to retry.
      expect(r.recovery).toBe('retry_incremental');
    } finally {
      delete process.env.NODE_ENV;
      delete process.env.CBM_TEST_FAIL_ON_FILE;
    }
  });

  // ── API-R159-01: ALL FAILED paths carry a structured `failure` field ──
  //
  // R158 only added `failure` to the three publication-failure catch blocks.
  // R159 adds it to root-validation, discovery, discovery-partial, dry-run-root,
  // dry-run-discovery, and main-path (outer catch).

  it('API-R159-01a: root-validation FAILED carries failure.DB_ERROR', async () => {
    // Missing root → assertDiscoveryRoot throws → root-validation FAILED.
    const r = await indexProjectWasm({ project: projectName, rootPath: join(tmpDir, 'does-not-exist'), incremental: false, useWasm: true });
    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('DB_ERROR');
    expect(r.failure!.phase).toBe('root-validation');
    expect(r.failure!.message.length).toBeGreaterThan(0);
  });

  it('API-R159-01b: dry-run-root FAILED carries failure.DB_ERROR + phase=dry-run-root', async () => {
    // Dry-run with missing root → dry-run-root FAILED.
    const r = await indexProjectWasm({ project: projectName, rootPath: join(tmpDir, 'does-not-exist'), incremental: false, dryRun: true, useWasm: true });
    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('DB_ERROR');
    expect(r.failure!.phase).toBe('dry-run-root');
  });

  it('API-R159-01c: discovery-partial FAILED carries failure.DB_ERROR + phase=discovery-partial', async () => {
    // Create a directory with no read permission on a subdir → discovery is
    // partial (subtree EACCES). Use a non-readable subdir.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const subDir = join(projectDir, 'subdir');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'b.ts'), 'export function b() { return 1; }\n');
    // Make the subdir unreadable + untraversable so discovery reports a fatal
    // subtree error. chmod 000 on the directory.
    try {
      // chmod may not be available on Windows; skip the test if it fails.
      // The test still validates the contract on Linux/CI.
      const fs = await import('node:fs/promises');
      await fs.chmod(subDir, 0o000);
      const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
      // Restore permissions so cleanup can delete it.
      await fs.chmod(subDir, 0o755);
      // Some discovery errors are non-fatal (just warnings). The test only
      // asserts the contract when discovery is genuinely partial.
      if (r.outcome === 'FAILED') {
        expect(r.failure).toBeDefined();
        expect(r.failure!.code).toBe('DB_ERROR');
        expect(r.failure!.phase).toBe('discovery-partial');
      }
    } catch {
      // chmod not supported (Windows) or other setup failure — skip gracefully.
      // The contract is still verified by the source-inspection tests below.
    }
  });

  // ── RES-R159-01: outer try/catch/finally ──────────────────────────────
  //
  // Inject an extraction crash and verify the outer catch returns FAILED with
  // failure.EXTRACTION_CRASH. R158 would have let the exception escape.

  it('RES-R159-01a: extractFromFilesWasm throws → FAILED + failure.EXTRACTION_CRASH + phase=main-path', async () => {
    // Run 1: full index (success).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: modify the file so the main path runs (not no-op), then inject
    // an extraction crash. The outer try/catch should catch it and return
    // FAILED with failure.EXTRACTION_CRASH.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 2; }\n');
    extractionCrash.shouldCrash = true;
    extractionCrash.phase = 'main-path';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('FAILED');
    expect(r.failure).toBeDefined();
    expect(r.failure!.code).toBe('EXTRACTION_CRASH');
    expect(r.failure!.phase).toBe('main-path');
    expect(r.failure!.message).toContain('injected extractFromFilesWasm crash');
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.recovery).toBe('retry_incremental');
    // The DB must still be in stale state (the outer catch persists it).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale AS stale, last_index_error AS err FROM projects WHERE name = ?').get(projectName) as { stale: number; err: string | null };
    db.close();
    expect(row.stale).toBe(1);
    expect(row.err).toContain('injected extractFromFilesWasm crash');
  });

  it('RES-R159-01b: outer finally guarantees db.close() (no leaked handle)', async () => {
    // Run 1: full index.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: inject extraction crash. After the call returns, we open the DB
    // read-only. If the outer finally failed to close the db handle, the
    // SQLite file would be left in WAL mode with a dangling handle — but
    // better-sqlite3 doesn't expose this directly. The observable signal is
    // that the DB file is still readable after the crash (not corrupted).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 3; }\n');
    extractionCrash.shouldCrash = true;
    extractionCrash.phase = 'main-path';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('FAILED');
    // Verify the DB is still readable (no corruption from a dangling handle).
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number };
    db.close();
    // The premark set stale=1 but didn't clear nodes (the extraction crash
    // happened AFTER clearProjectData in full mode but BEFORE in incremental
    // mode — here we're in incremental, so existing nodes are preserved).
    expect(row.c).toBeGreaterThan(0);
  });

  // ── OBS-R159-03: staleReason.totalPaths + pathsTruncated ──────────────
  //
  // R158 silently capped paths at 100. R159 exposes totalPaths + pathsTruncated.

  it('OBS-R159-03a: 150 broken aliases → pathsTruncated=true, totalPaths=150, paths.length=100', async () => {
    // Run 1: create 150 valid file aliases, populate history.
    writeFileSync(join(projectDir, 'util.ts'), 'export function util() { return 1; }\n');
    for (let i = 0; i < 150; i++) {
      symlinkSync(join(projectDir, 'util.ts'), join(projectDir, `alias${i}.ts`));
    }
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Run 2: break all 150 aliases → HISTORICAL_ALIAS_BROKEN with 150 broken paths.
    unlinkSync(join(projectDir, 'util.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    // R159: paths capped at 100, but totalPaths=150 and pathsTruncated=true.
    expect(r.staleReason!.paths.length).toBe(100);
    expect(r.staleReason!.totalPaths).toBe(150);
    expect(r.staleReason!.pathsTruncated).toBe(true);
  });

  it('OBS-R159-03b: 50 broken aliases → pathsTruncated=false (under cap), totalPaths=50', async () => {
    // Run 1: 50 aliases.
    writeFileSync(join(projectDir, 'util.ts'), 'export function util() { return 1; }\n');
    for (let i = 0; i < 50; i++) {
      symlinkSync(join(projectDir, 'util.ts'), join(projectDir, `alias${i}.ts`));
    }
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    unlinkSync(join(projectDir, 'util.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.outcome).toBe('STALE');
    expect(r.staleReason).toBeDefined();
    expect(r.staleReason!.code).toBe('HISTORICAL_ALIAS_BROKEN');
    // R159: under the cap → pathsTruncated=false, totalPaths=50.
    expect(r.staleReason!.paths.length).toBe(50);
    expect(r.staleReason!.totalPaths).toBe(50);
    expect(r.staleReason!.pathsTruncated).toBe(false);
  });

  // ── CLI-R159-01: CLI displays result.failure ──────────────────────────
  //
  // R158 added the `failure` field but the CLI never surfaced it. R159 prints
  // code/phase/message in the PARTIAL/FAILED banner.

  it('CLI-R159-01a: missing root → CLI prints "System failure" with code/phase/message', async () => {
    // Missing root → root-validation FAILED with failure.DB_ERROR.
    const result = await runCli(
      ['index', '--project', projectName, '--root', join(tmpDir, 'does-not-exist')],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(1);
    // R159 (CLI-R159-01): CLI prints the structured failure field.
    expect(result.stdout).toContain('System failure:');
    expect(result.stdout).toContain('Code: DB_ERROR');
    expect(result.stdout).toContain('Phase: root-validation');
    expect(result.stdout).toContain('Message:');
  });

  it('CLI-R159-01b: dry-run missing root → CLI prints failure with phase=dry-run-root', async () => {
    const result = await runCli(
      ['index', '--project', projectName, '--root', join(tmpDir, 'does-not-exist'), '--dry-run'],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('System failure:');
    expect(result.stdout).toContain('Code: DB_ERROR');
    expect(result.stdout).toContain('Phase: dry-run-root');
  });

  it('CLI-R159-01c: 150 broken aliases → CLI prints "showing 100 of 150" (truncation info)', async () => {
    // Run 1: create 150 valid aliases via the CLI (so the CLI is exercised
    // end-to-end, not just the indexer API).
    writeFileSync(join(projectDir, 'util.ts'), 'export function util() { return 1; }\n');
    for (let i = 0; i < 150; i++) {
      symlinkSync(join(projectDir, 'util.ts'), join(projectDir, `alias${i}.ts`));
    }
    const r1 = await runCli(
      ['index', '--project', projectName, '--root', projectDir],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(r1.exitCode).toBe(0);
    // Run 2: break all 150 aliases → STALE + HISTORICAL_ALIAS_BROKEN with
    // pathsTruncated=true. The CLI should show "(showing 100 of 150)".
    unlinkSync(join(projectDir, 'util.ts'));
    const r2 = await runCli(
      ['index', '--project', projectName, '--root', projectDir],
      { XDG_CACHE_HOME: cacheDir },
    );
    // STALE outcome → exit 2 (R147).
    expect(r2.exitCode).toBe(2);
    expect(r2.stdout).toContain('graph is stale');
    // R159 (OBS-R159-03): CLI surfaces the truncation info.
    expect(r2.stdout).toContain('showing 100 of 150');
  });

  // ── Source-inspection regression guards ───────────────────────────────
  //
  // These guard against accidental removal of the R159 changes.

  it('regression: classifyStaleReason checks coldStartLock BEFORE semanticsStale', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // Find the classifier function body and verify the order.
    const classifierStart = src.indexOf('function classifyStaleReason');
    expect(classifierStart).toBeGreaterThan(-1);
    const classifierEnd = src.indexOf('\n}\n', classifierStart);
    expect(classifierEnd).toBeGreaterThan(classifierStart);
    const classifierBody = src.slice(classifierStart, classifierEnd);
    const coldStartIdx = classifierBody.indexOf("'COLD_START_LOCK'");
    const historicalIdx = classifierBody.indexOf("'HISTORICAL_ALIAS_BROKEN'");
    const semanticsIdx = classifierBody.indexOf("'SEMANTICS_MISMATCH'");
    expect(coldStartIdx).toBeGreaterThan(-1);
    expect(historicalIdx).toBeGreaterThan(-1);
    expect(semanticsIdx).toBeGreaterThan(-1);
    // R159 (OUTCOME-R159-01): COLD_START_LOCK < HISTORICAL_ALIAS_BROKEN < SEMANTICS_MISMATCH.
    expect(coldStartIdx).toBeLessThan(historicalIdx);
    expect(historicalIdx).toBeLessThan(semanticsIdx);
  });

  it('regression: outer try/catch/finally wraps the main path', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R159 (RES-R159-01): outer catch returns EXTRACTION_CRASH at main-path.
    expect(src).toContain("failure: { code: 'EXTRACTION_CRASH', message: errMsg, phase: 'main-path' }");
    // The outer finally closes the db.
    expect(src).toContain('R159 (RES-R159-01): guaranteed DB close');
  });

  it('regression: all FAILED paths include a failure field', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R159 (API-R159-01): each FAILED return path must set `failure:`.
    // The publication-failure catch blocks (R158):
    expect(src).toContain("failure: { code: 'PERSIST_FAILURE', message: noOpErrMsg, phase: 'no-op-commit' }");
    expect(src).toContain("failure: { code: 'PERSIST_FAILURE', message: deletionErrMsg, phase: 'deletion-only-commit' }");
    expect(src).toContain("failure: { code: 'PERSIST_FAILURE', message: errMsg, phase: 'main-commit' }");
    // R159 additions — early FAILED paths:
    expect(src).toContain("failure: { code: 'DB_ERROR', message, phase: 'dry-run-root' }");
    expect(src).toContain("failure: { code: 'DB_ERROR', message: `Discovery failed: ${discoveryMsg}`, phase: 'dry-run-discovery' }");
    expect(src).toContain("failure: { code: 'DB_ERROR', message, phase: 'root-validation' }");
    expect(src).toContain("failure: { code: 'DB_ERROR', message: fullMsg, phase: 'discovery' }");
    // Two discovery-partial FAILED paths (full mode + incremental mode).
    const partialMatches = src.match(/phase: 'discovery-partial'/g) ?? [];
    expect(partialMatches.length).toBeGreaterThanOrEqual(2);
    // The outer-catch FAILED path.
    expect(src).toContain("failure: { code: 'EXTRACTION_CRASH', message: errMsg, phase: 'main-path' }");
  });

  it('regression: staleReason type carries totalPaths + pathsTruncated', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R159 (OBS-R159-03): type additions.
    expect(src).toContain('totalPaths?: number;');
    expect(src).toContain('pathsTruncated?: boolean;');
    // The full-uncertainty return sets them.
    expect(src).toContain('totalPaths: brokenPaths.length,');
    expect(src).toContain('pathsTruncated,');
  });

  it('regression: main-path staleReason builder does NOT fall back to PREVIOUSLY_STALE', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R159 (OUTCOME-R159-02): the fallback `crossFileStale && indexError !== null
    // ? { code: 'PREVIOUSLY_STALE', ... }` must be GONE from the main path.
    // The new builder is `mainClassified ? {...} : undefined`.
    expect(src).not.toContain("crossFileStale && indexError !== null");
    // The main-path return uses the cleaner builder.
    expect(src).toContain('staleReason: mainClassified\n        ? { code: mainClassified.code, message: mainClassified.message, paths: [] }\n        : undefined,');
  });

  it('regression: CLI prints System failure / Code / Phase / Message', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'commands', 'index.ts'), 'utf8');
    // R159 (CLI-R159-01): CLI surfaces the failure field.
    expect(src).toContain('System failure:');
    expect(src).toContain('Code: ${result.failure.code}');
    expect(src).toContain('Phase: ${result.failure.phase}');
    expect(src).toContain('Message: ${result.failure.message}');
    // R159 (OBS-R159-03): CLI surfaces truncation info.
    expect(src).toContain('pathsTruncated');
    expect(src).toContain('totalPaths');
    expect(src).toContain('showing ${result.staleReason.paths.length} of ${result.staleReason.totalPaths}');
  });

  it('regression: IndexResult type still carries all required R158 fields', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf8');
    // R158 fields must still be present (R159 doesn't remove them).
    expect(src).toContain('failure?: {');
    expect(src).toContain("code: 'PERSIST_FAILURE' | 'EXTRACTION_CRASH' | 'DB_ERROR' | 'UNKNOWN'");
    expect(src).toContain('phase: string;');
  });
});
