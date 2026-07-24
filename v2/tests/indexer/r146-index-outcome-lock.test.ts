// v2/tests/indexer/r146-index-outcome-lock.test.ts
// R146: Index Outcome Lock + Legacy Timestamp Backfill + Discovery Race Warnings
//
// Covers the confirmed findings of the R145 audit:
//   - STATE-R146-01 (P1): incremental extraction errors force stale=true
//   - STATE-R146-02 (P1/P2): backfill last_successful_index_at from indexed_at
//   - DISC-R146-01 (P1/P2): lstat ENOENT + regular realpath ENOENT → warning

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, existsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { discoverSourceFilesWasm, discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';
import { getGraphStatus } from '../../src/intelligence/graph-status.js';
import { CodeGraphReader, defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import Database from 'better-sqlite3';

describe('R146: Index Outcome Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r146-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r146-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
    delete process.env.NODE_ENV;
  });

  // ── STATE-R146-01: incremental extraction errors force stale ─────────

  it('STATE-R146-01a: incremental with extraction error → stale=true, last_success unchanged', async () => {
    // 1. Build a valid graph with cross-file edges.
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const successBefore = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string }).s;
    db.close();

    // 2. Modify a.ts and inject a failure via CBM_TEST_FAIL_ON_FILE.
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo() + 1; }\n');
    process.env.NODE_ENV = 'test';
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';

    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // 3. R146: extraction errors MUST force stale=true regardless of resolver.
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);

    // 4. last_successful_index_at must NOT have changed.
    db = new Database(dbPath, { readonly: true });
    const successAfter = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string | null }).s;
    const errorAfter = (db.prepare('SELECT last_index_error AS e FROM projects WHERE name = ?').get(projectName) as { e: string | null }).e;
    expect(successAfter).toBe(successBefore); // unchanged
    expect(errorAfter).not.toBeNull();         // error recorded
    db.close();
  });

  it('STATE-R146-01b: incremental without errors → stale=false, last_success updated', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const successBefore = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string }).s;
    db.close();

    // Modify a.ts (no failure injection).
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo() + 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);

    // last_successful_index_at should have been updated (success).
    db = new Database(dbPath, { readonly: true });
    const successAfter = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string }).s;
    const errorAfter = (db.prepare('SELECT last_index_error AS e FROM projects WHERE name = ?').get(projectName) as { e: string | null }).e;
    expect(successAfter).not.toBe(successBefore); // updated
    expect(errorAfter).toBeNull();                 // no error
    db.close();
  });

  // ── STATE-R146-02: backfill last_successful_index_at from indexed_at ──

  it('STATE-R146-02a: migration backfills last_successful_index_at from indexed_at', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);

    // Simulate a pre-R144 DB by clearing last_successful_index_at.
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET last_successful_index_at = NULL WHERE name = ?').run(projectName);
    dbW.close();

    // Verify it's NULL.
    let db = new Database(dbPath, { readonly: true });
    let success = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string | null }).s;
    expect(success).toBeNull();
    db.close();

    // Run another index — the migration should backfill.
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });

    // R146: last_successful_index_at should now be backfilled from indexed_at.
    db = new Database(dbPath, { readonly: true });
    success = (db.prepare('SELECT last_successful_index_at AS s FROM projects WHERE name = ?').get(projectName) as { s: string | null }).s;
    expect(success).not.toBeNull();
    db.close();
  });

  // ── DISC-R146-01: lstat ENOENT + regular realpath ENOENT → warning ────

  it('DISC-R146-01a: broken symlink (ENOENT) is tracked as warning, discovery complete', () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const result = discoverSourceFilesStructured(projectDir);
    expect(result.complete).toBe(true);
    expect(result.totalWarnings).toBeGreaterThan(0);
    expect(result.warningCountsByCode['ENOENT']).toBeGreaterThan(0);
  });

  it('DISC-R146-01b: subdir EACCES is still fatal (not warning)', () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'subdir', 'b.ts'), 'export function b() { return 2; }\n');
    chmodSync(join(projectDir, 'subdir'), 0o000);
    try {
      const result = discoverSourceFilesStructured(projectDir);
      expect(result.complete).toBe(false);
      expect(result.totalErrors).toBeGreaterThan(0);
      expect(result.countsByCode['EACCES']).toBeGreaterThan(0);
    } finally {
      chmodSync(join(projectDir, 'subdir'), 0o755);
    }
  });

  // ── Regression: R145 findings stay fixed ──────────────────────────────

  it('regression: dry-run does not write DB (R145 DRY-R145-01)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    const dbStatBefore = (await import('node:fs')).statSync(dbPath);
    const bogusRoot = join(tmpDir, 'nonexistent');
    await indexProjectWasm({ project: projectName, rootPath: bogusRoot, incremental: false, useWasm: true, workers: 0, dryRun: true });
    const dbStatAfter = (await import('node:fs')).statSync(dbPath);
    expect(dbStatAfter.mtimeMs).toBe(dbStatBefore.mtimeMs);
  });

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9 (R184)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
  });

  it('regression: two code hardlinks with different extensions → both indexed (R144 IDX-R144-01)', () => {
    writeFileSync(join(projectDir, 'module.ts'), 'export function m() { return 1; }\n');
    linkSync(join(projectDir, 'module.ts'), join(projectDir, 'module.js'));
    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(2);
  });
});
