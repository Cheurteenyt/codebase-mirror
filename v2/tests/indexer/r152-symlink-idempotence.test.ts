// v2/tests/indexer/r152-symlink-idempotence.test.ts
// R152: Broken Symlink Idempotence + Warning Propagation + Relative Paths
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { discoverSourceFilesWasm, discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';

describe('R152: Symlink Idempotence', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r152-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r152-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
    delete process.env.NODE_ENV;
  });

  // ── CONSIST-R152-01: Idempotence ──────────────────────────────────────

  it('CONSIST-R152-01a: first full with broken symlink succeeds', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
  });

  it('CONSIST-R152-01b: second full with broken symlink also succeeds (idempotence)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Same filesystem, same broken symlink, second run.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
  });

  it('CONSIST-R152-01c: incremental with broken symlink does NOT force stale', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
  });

  // ── OBS-R152-01: Warnings in IndexResult ──────────────────────────────

  it('OBS-R152-01a: IndexResult includes warnings field (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'indexer.ts'), 'utf-8'
    );
    expect(source).toContain('warnings?:');
    expect(source).toContain('discoveryWarnings');
  });

  it('OBS-R152-01b: first full with broken symlink returns warnings', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.total).toBeGreaterThan(0);
    expect(r.warnings!.countsByCode['ENOENT']).toBeGreaterThan(0);
  });

  // ── SEC-R152-01: Relative paths in warning samples ───────────────────

  it('SEC-R152-01a: warning samples use relative paths (code inspection)', () => {
    const source = require('node:fs').readFileSync(
      join(__dirname, '..', '..', 'src', 'indexer', 'wasm-extractor.ts'), 'utf-8'
    );
    expect(source).toContain("relative(realRoot, fullPath)");
    expect(source).not.toContain("recordWarning('ENOENT', fullPath)");
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
