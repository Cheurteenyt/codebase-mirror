// v2/tests/indexer/r139-unified-path-containment.test.ts
// R139: Unified Path Containment — P0 vault write + P1 discovery symlink
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { safeRealpath, assertPathInsideRoot } from '../../src/utils/safe-path.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R139: Unified Path Containment', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r139-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r139-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── SEC-R139-01: Discovery must not follow symlinks outside root ────────

  it('discovery: symlink to external directory is NOT traversed', async () => {
    // Create an external directory with a .ts file
    const externalDir = join(tmpDir, 'external');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'secret.ts'), 'export const secret = "leaked";\n');
    // Create a symlink inside the project pointing to the external directory
    symlinkSync(externalDir, join(projectDir, 'external-link'));
    // Create a normal file in the project
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // The secret file should NOT be indexed — it's outside the project root
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const nodes = db.prepare('SELECT file_path FROM nodes WHERE project = ?').all(projectName) as Array<{ file_path: string }>;
    const paths = nodes.map(n => n.file_path);
    expect(paths.some(p => p.includes('secret'))).toBe(false);
    expect(paths.some(p => p.includes('external-link'))).toBe(false);
    db.close();
  });

  it('discovery: symlink cycle does NOT cause infinite loop or duplicates', async () => {
    // Create a cycle: project/a/loop -> project/a
    mkdirSync(join(projectDir, 'a'), { recursive: true });
    symlinkSync(join(projectDir, 'a'), join(projectDir, 'a', 'loop'));
    writeFileSync(join(projectDir, 'a', 'real.ts'), 'export function real() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    // This should complete without hanging
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const realFiles = db.prepare("SELECT DISTINCT file_path FROM nodes WHERE project = ? AND file_path LIKE '%real.ts'").all(projectName) as Array<{ file_path: string }>;
    // R140: With visitedDirs for ALL directories, the file should be indexed
    // exactly once (no duplicate via the symlink cycle).
    expect(realFiles.length).toBe(1);
    db.close();
  });

  it('discovery: internal symlink to directory IS traversed', async () => {
    // Create an internal symlink: project/link -> project/subdir
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'subdir', 'inner.ts'), 'export function inner() { return 1; }\n');
    symlinkSync(join(projectDir, 'subdir'), join(projectDir, 'link'));
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // The inner file should be indexed (via either the symlink or the real path)
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const nodes = db.prepare('SELECT file_path FROM nodes WHERE project = ?').all(projectName) as Array<{ file_path: string }>;
    const paths = nodes.map(n => n.file_path);
    // inner.ts should be found at least once
    expect(paths.some(p => p.includes('inner'))).toBe(true);
    db.close();
  });

  // ── SEC-CARRY-01: safeRealpath with non-existent descendants ────────────

  it('safeRealpath: non-existent path under symlink is resolved to real ancestor', () => {
    // Create a symlink inside the project
    const target = join(tmpDir, 'target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(projectDir, 'link'));
    // The path projectDir/link/deep/note.md doesn't exist
    // safeRealpath should resolve to target/deep/note.md (following the symlink)
    const result = safeRealpath(join(projectDir, 'link', 'deep', 'note.md'));
    // The result should contain 'target' (the symlink target), not 'projectDir/link'
    expect(result).toContain('target');
    expect(result).not.toContain('link');
  });

  it('assertPathInsideRoot: rejects path that escapes via symlink with 101+ descendants (SEC-R140-01)', () => {
    // R140: The P0 bypass was: nearestExistingAncestor had a depth cap of 100.
    // After 100 iterations it returned null → safeRealpath fell back to lexical
    // resolve → assertPathInsideRoot accepted the path → writeNote wrote outside vault.
    // R140 fix: no cap, fail-closed throw.
    const root = join(tmpDir, 'vault-deep');
    const external = join(tmpDir, 'external-deep');
    mkdirSync(root, { recursive: true });
    mkdirSync(external, { recursive: true });
    // Create a symlink inside root pointing to external
    symlinkSync(external, join(root, 'escape'));
    // Build a path with 101 non-existent descendants under the symlink
    const segments = ['escape'];
    for (let i = 0; i < 101; i++) segments.push(`d${i}`);
    segments.push('note.md');
    const relPath = segments.join('/');
    // R140: This MUST throw — no lexical fallback, no depth cap bypass
    expect(() => {
      assertPathInsideRoot(root, relPath);
    }).toThrow();
  });

  it('assertPathInsideRoot: rejects path that escapes via symlink', () => {
    // Create root and an external target
    const root = join(tmpDir, 'vault');
    const external = join(tmpDir, 'external');
    mkdirSync(root, { recursive: true });
    mkdirSync(external, { recursive: true });
    // Create a symlink inside root pointing to external
    symlinkSync(external, join(root, 'escape'));
    // A path like root/escape/deep/note.md should be rejected
    expect(() => {
      assertPathInsideRoot(root, 'escape/deep/note.md');
    }).toThrow(/Path traversal rejected/);
  });

  it('assertPathInsideRoot: allows internal path', () => {
    const root = join(tmpDir, 'vault2');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'note.md'), 'test');
    // A normal path inside root should work
    expect(() => {
      assertPathInsideRoot(root, 'note.md');
    }).not.toThrow();
  });

  // ── TEST-R139-07: Pin CURRENT_EXTRACTOR_SEMANTICS_VERSION ───────────────

  it('schema contract: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9', () => {
    // R139: A single test that pins the exact version. Other tests use the
    // constant dynamically — this one catches accidental changes.
    // R141: Bumped from 6 → 7 (discovery policy lock).
    // R144: Bumped from 7 → 8 (hardlink language contract).
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
  });
});
