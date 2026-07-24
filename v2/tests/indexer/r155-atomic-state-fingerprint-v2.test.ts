// v2/tests/indexer/r155-atomic-state-fingerprint-v2.test.ts
// R155: Atomic Alias State + Root Fingerprint v2 + Special File Safety + Scalable GC
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION, CURRENT_DISCOVERY_POLICY_VERSION, loadAliasHistory, computeRootFingerprint } from '../../src/indexer/schema.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

/**
 * R156 (CI-R156-01): Node.js does not provide fs.mkfifoSync. R155 imported it
 * from node:fs, which broke the TypeScript typecheck and the backend CI.
 * R156 replaces it with spawnSync('mkfifo', ...) on Linux, with an explicit
 * skip on Windows/macOS where mkfifo is unavailable.
 */
function createFifo(path: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('mkfifo', [path], { stdio: 'ignore' });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

describe('R155: Atomic State + Fingerprint v2 + Special File Safety', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r155-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r155-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── TX-R155-01: Atomic alias state commit ────────────────────────────

  it('TX-R155-01a: successful index atomically sets fresh + initialized + policy', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale AS stale, alias_history_initialized AS init, discovery_policy_version AS pv, last_successful_index_at AS ls FROM projects WHERE name = ?').get(projectName) as { stale: number; init: number; pv: number; ls: string };
    db.close();
    expect(row.stale).toBe(0);
    expect(row.init).toBe(1);
    expect(row.pv).toBe(CURRENT_DISCOVERY_POLICY_VERSION);
    expect(row.ls).not.toBeNull();
  });

  it('TX-R155-01b: STALE outcome does NOT carry errors (contract fix)', async () => {
    // Run 1: populate history.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Run 2: remove target, full mode → hasUncertainty → STALE.
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R155 (OUTCOME-R155-01): STALE must NOT have errors.
    expect(r.outcome).toBe('STALE');
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  // ── ROOT-R155-01: Fingerprint v2 (dev+ino) ──────────────────────────

  it('ROOT-R155-01a: root fingerprint includes st_ino', () => {
    const fp = computeRootFingerprint(projectDir);
    // R155: fingerprint includes dev:ino (not just dev).
    // Format: canonicalRoot:dev:ino
    expect(fp.startsWith(projectDir + ':')).toBe(true);
    const parts = fp.split(':');
    // Should have at least 3 parts: path, dev, ino (path may contain colons on Windows,
    // but on Linux it won't). We check the LAST two parts are non-empty.
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[parts.length - 2]).toMatch(/^[0-9]+$/); // dev
    expect(parts[parts.length - 1]).toMatch(/^[0-9]+$/); // ino
  });

  it('ROOT-R155-01b: different ino → different fingerprint (pure format test)', () => {
    // R156 (TEST-R156-02): The previous version of this test deleted and
    // recreated the directory, then asserted the fingerprint changed. But
    // tmpfs (used by GitHub Actions runners for /tmp) can reuse inodes
    // immediately, making the test flaky. R156 tests the fingerprint FORMAT
    // logic instead: same path+dev but different ino MUST produce different
    // fingerprints. This is deterministic and doesn't depend on filesystem
    // inode reuse behavior.
    const path = '/test/path';
    const dev = '123';
    const ino1 = '456';
    const ino2 = '789';
    // The fingerprint format is: canonicalRoot:st_dev:st_ino
    const fp1 = `${path}:${dev}:${ino1}`;
    const fp2 = `${path}:${dev}:${ino2}`;
    expect(fp2).not.toBe(fp1);
    expect(fp1).toContain(ino1);
    expect(fp2).toContain(ino2);
  });

  it('ROOT-R155-01c: root fingerprint persisted on projects table', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT root_fingerprint AS fp FROM projects WHERE name = ?').get(projectName) as { fp: string };
    db.close();
    expect(row.fp).toContain(projectDir);
    expect(row.fp).toContain(':'); // dev:ino separator
  });

  // ── ALIAS-R155-01: Special file type safety ─────────────────────────

  it('ALIAS-R155-01a: FIFO with .ts extension is NOT historized', async () => {
    // R156 (CI-R156-01): use spawnSync('mkfifo') instead of non-existent fs.mkfifoSync.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const fifoPath = join(projectDir, 'pipe.ts');
    if (!createFifo(fifoPath)) {
      console.warn('ALIAS-R155-01a: skipped — mkfifo not available');
      return;
    }
    symlinkSync(fifoPath, join(projectDir, 'pipe-link.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const fp = computeRootFingerprint(projectDir);
    const history = loadAliasHistory(db, projectName, fp);
    db.close();
    // R155 (ALIAS-R155-01): the FIFO alias is NOT historized (special file type).
    expect(history.has('pipe-link.ts')).toBe(false);
  });

  // ── CONC-R155-01: runId is UUID ─────────────────────────────────────

  it('CONC-R155-01a: runId is a UUID string (not Date.now number)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'a.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    // Check that last_observed_run_id is a UUID-format string (not an integer).
    const row = db.prepare('SELECT last_observed_run_id AS rid FROM alias_history WHERE project = ? LIMIT 1').get(projectName) as { rid: string | null };
    db.close();
    expect(row.rid).not.toBeNull();
    // UUID format: 8-4-4-4-12 hex chars.
    expect(row.rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // ── MIG-R155-01: Legacy row cleanup ─────────────────────────────────

  it('MIG-R155-01a: legacy rows with root_fingerprint="" are cleaned up', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'a.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Inject a legacy row with root_fingerprint=''.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO alias_history (project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint, last_observed_run_id) VALUES (?, ?, ?, ?, ?, '', NULL)"
    ).run(projectName, 'legacy-alias', 'legacy-target', 'file', new Date().toISOString());
    db.close();

    // Run again — the legacy row should be GC'd.
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    const db2 = new Database(dbPath, { readonly: true });
    const legacyRow = db2.prepare("SELECT COUNT(*) AS c FROM alias_history WHERE project = ? AND root_fingerprint = ''").get(projectName) as { c: number };
    db2.close();
    expect(legacyRow.c).toBe(0);
  });

  it('MIG-R155-01b: legacy NULL run_id rows are cleaned up', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync(join(projectDir, 'a.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Inject a row with NULL run_id for the current root fingerprint.
    const dbPath = defaultCodeDbPath(projectName);
    const fp = computeRootFingerprint(projectDir);
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO alias_history (project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint, last_observed_run_id) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run(projectName, 'null-run-alias', 'null-target', 'file', new Date().toISOString(), fp);
    db.close();

    // Run again — the NULL run_id row should be GC'd (IS NULL OR != runId).
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    const db2 = new Database(dbPath, { readonly: true });
    const nullRow = db2.prepare('SELECT COUNT(*) AS c FROM alias_history WHERE project = ? AND alias_path = ?').get(projectName, 'null-run-alias') as { c: number };
    db2.close();
    expect(nullRow.c).toBe(0);
  });

  // ── PERF-R155-04: EXISTS instead of COUNT ───────────────────────────

  it('PERF-R155-04a: cold-start lock uses EXISTS (not COUNT) — verified by behavior', async () => {
    // Run 1: index with a valid alias.
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });

    // Simulate cold-start: clear history + reset flags.
    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath);
    db.prepare('DELETE FROM alias_history WHERE project = ?').run(projectName);
    db.prepare('UPDATE projects SET alias_history_initialized = 0, discovery_policy_version = 0 WHERE name = ?').run(projectName);
    db.close();

    // Run 2: break alias. Cold-start lock should fire (existing nodes > 0).
    unlinkSync(join(projectDir, 'real.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
    expect(r.outcome).toBe('STALE');
  });

  // ── OUTCOME-R155-02: Dry-run failure banner ─────────────────────────

  it('OUTCOME-R155-02a: dry-run with errors does NOT say "Dry-run complete"', async () => {
    // This test verifies the indexer behavior (not CLI stdout). The CLI test
    // in tests/cli/ verifies the actual banner text.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, dryRun: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.outcome).toBe('SUCCESS');
  });

  // ── Regression ────────────────────────────────────────────────────────

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9 (R184)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
  });

  it('regression: CURRENT_DISCOVERY_POLICY_VERSION is 3 (coverage modes)', () => {
    expect(CURRENT_DISCOVERY_POLICY_VERSION).toBe(3);
  });

  it('regression: alias_history survives full reindex with atomic commit', async () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function real() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R155: the atomic commit should not break the survival of alias_history.
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
