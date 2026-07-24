// v2/tests/indexer/r151-broken-symlink-liveness.test.ts
// R151: Broken Symlink Liveness Lock + Warning Samples + Empty RelTarget
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { discoverSourceFilesWasm, discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import Database from 'better-sqlite3';

describe('R151: Broken Symlink Liveness', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r151-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r151-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
    delete process.env.NODE_ENV;
  });

  // ── AVAIL-R151-01: First full with broken symlink succeeds ────────────

  it('AVAIL-R151-01a: first full with broken symlink succeeds (no existing graph)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    expect(r.nodes).toBeGreaterThan(0);
  });

  it('AVAIL-R151-01b: second full with broken symlink succeeds (R152 idempotence)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Now add a broken symlink and run another full.
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // R152: Second full WITH existing graph also succeeds (idempotence).
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
  });

  // ── OBS-R151-01: Warning samples with paths ───────────────────────────

  it('OBS-R151-01a: broken symlink warning includes relative path (R152, R153 runtime)', async () => {
    // R153 (TEST-R153-03): converted from source inspection to runtime test.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.samples.length).toBeGreaterThan(0);
    const enoentSamples = r.warnings!.samples.filter(s => s.code === 'ENOENT');
    expect(enoentSamples.length).toBeGreaterThan(0);
    expect(enoentSamples[0].path).toBe('broken.ts');
    expect(enoentSamples[0].path.startsWith('/')).toBe(false);
  });

  it('OBS-R151-01b: DiscoveryResult includes warningSamples (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'wasm-extractor.ts'), 'utf-8'
    );
    expect(source).toContain('warningSamples: Array<{ path: string; code: string }>');
  });

  // ── OBS-R151-02: Fast-path messages include globalDeletionUncertainty ─

  it('OBS-R151-02a: fast-path indexError includes broken symlinks info (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf-8'
    );
    // R151: fast-path indexError for uncertainty includes globalDeletionUncertainty.
    expect(source).toContain('broken symlinks');
  });

  // ── DATA-R151-01: Empty relTarget → globalDeletionUncertainty ──────────

  it('DATA-R151-01a: empty relTarget sets globalDeletionUncertainty (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf-8'
    );
    expect(source).toContain("uncertainSubtrees.some(s => s === '')");
  });

  // ── Regression ────────────────────────────────────────────────────────

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9 (R184)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
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
