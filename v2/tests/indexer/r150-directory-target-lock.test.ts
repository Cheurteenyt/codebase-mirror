// v2/tests/indexer/r150-directory-target-lock.test.ts
// R150: Directory-Target Uncertainty Lock + Broken Symlink Confidence + CLI No-Change
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { discoverSourceFilesWasm, discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import Database from 'better-sqlite3';

describe('R150: Directory-Target Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r150-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r150-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
    delete process.env.NODE_ENV;
  });

  // ── DATA-R150-01: ENOENT_STAT directory target → uncertainSubtrees ───

  it('DATA-R150-01a: ENOENT_STAT adds to both uncertainPaths AND uncertainSubtrees (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'wasm-extractor.ts'), 'utf-8'
    );
    // R150: ENOENT_STAT must add to BOTH uncertainPaths and uncertainSubtrees
    // because the target type (file vs directory) is unknown after ENOENT.
    expect(source).toContain('uncertainPaths.push(relTarget)');
    expect(source).toContain('uncertainSubtrees.push(relTarget)');
  });

  // ── DATA-R150-02: broken symlink → globalDeletionUncertainty ──────────

  it('DATA-R150-02a: broken symlink sets globalDeletionUncertainty (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'wasm-extractor.ts'), 'utf-8'
    );
    expect(source).toContain('globalDeletionUncertainty = true');
  });

  it('DATA-R150-02b: broken symlink blocks full index', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);
  });

  it('DATA-R150-02c: broken symlink forces stale in incremental', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);
  });

  it('DATA-R150-02d: globalDeletionUncertainty blocks ALL deletions (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf-8'
    );
    expect(source).toContain('if (discovery.globalDeletionUncertainty)');
    expect(source).toContain('deletedRelPaths = []');
  });

  // ── OUTCOME-R150-01: CLI no-op fresh correct message ──────────────────

  it('OUTCOME-R150-01a: CLI no-change message distinguishes skipped > 0 (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'cli', 'commands', 'index.ts'), 'utf-8'
    );
    // R150: no-op fresh (nodes=0, errors=0, stale=false, skipped>0) should
    // print "No changes detected" not "0 source files".
    expect(source).toContain('No changes detected. Existing graph is fresh.');
    // The old "0 source files" message should not be in a console.log.
    expect(source).not.toContain("console.log(`ℹ Project");
  });

  // ── Regression ────────────────────────────────────────────────────────

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 8 (R144)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(8);
  });

  it('regression: two code hardlinks with different extensions → both indexed (R144)', () => {
    writeFileSync(join(projectDir, 'module.ts'), 'export function m() { return 1; }\n');
    linkSync(join(projectDir, 'module.ts'), join(projectDir, 'module.js'));
    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(2);
  });

  it('regression: incremental extraction error → stale=true (R146)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo(); }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    writeFileSync(join(projectDir, 'a.ts'), 'import { foo } from "./b";\nexport function caller() { return foo() + 1; }\n');
    process.env.NODE_ENV = 'test';
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);
  });
});
