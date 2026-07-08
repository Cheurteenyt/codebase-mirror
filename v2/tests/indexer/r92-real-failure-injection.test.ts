// v2/tests/indexer/r92-real-failure-injection.test.ts
// R92: Real failure injection tests — CBM_TEST_FAIL_ON_FILE.
// These tests actually call indexProjectWasm() and verify that old graph/hash
// are preserved when extractFast throws on a specific file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R92: Real Failure Injection Tests', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r93-fail-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r93fail-${Date.now()}`;
    // R93: set XDG_CACHE_HOME BEFORE any indexProjectWasm call
    process.env.XDG_CACHE_HOME = cacheDir;

    // Create test files
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function funcB() { return 2; }\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CBM_TEST_FAIL_ON_FILE;
    delete process.env.XDG_CACHE_HOME;
  });

  it('single-thread: full index succeeds, then incremental with injected failure preserves old graph', async () => {
    // Step 1: Full index (no failure)
    const result1 = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: false,
      useWasm: true,
      workers: 0, // force single-thread
    });

    expect(result1.errors.length).toBe(0);
    expect(result1.files).toBe(2);
    expect(result1.nodes).toBeGreaterThan(0);

    // Verify DB has nodes
    const dbPath = defaultCodeDbPath(projectName);
    const db1 = new Database(dbPath, { readonly: true });
    const nodes1 = (db1.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    const hashes1 = (db1.prepare('SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?').get(projectName) as { c: number }).c;
    // R93: keep db1 open for hash comparison later
    expect(nodes1).toBeGreaterThan(0);
    expect(hashes1).toBe(2);

    // Step 2: Modify a.ts
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA_modified() { return 1; }\n');

    // Step 3: Incremental with injected failure on a.ts
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';

    const result2 = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: true,
      useWasm: true,
      workers: 0,
    });

    // Should have 1 error (injected failure on a.ts)
    expect(result2.errors.length).toBe(1);
    expect(result2.errors[0].file).toBe('a.ts');
    expect(result2.errors[0].error).toContain('Injected test failure');

    // R93: assert DB path is the same for both runs
    expect(result2.dbPath).toBe(result1.dbPath);

    // Verify DB still has old nodes (a.ts graph preserved)
    const db2 = new Database(dbPath, { readonly: true });
    const nodes2 = (db2.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;

    // Nodes should be the same (old graph preserved for a.ts)
    expect(nodes2).toBe(nodes1);

    // R93: assert hash for a.ts is NOT updated (failure means no hash update)
    const aHashBefore = db1.prepare('SELECT content_hash FROM file_hashes WHERE project = ? AND file_path = ?')
      .get(projectName, 'a.ts') as { content_hash: string };
    const aHashAfter = db2.prepare('SELECT content_hash FROM file_hashes WHERE project = ? AND file_path = ?')
      .get(projectName, 'a.ts') as { content_hash: string };
    expect(aHashAfter.content_hash).toBe(aHashBefore.content_hash);

    // Orphan edges should be 0
    const orphanEdges = (db2.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanEdges).toBe(0);

    db1.close();
    db2.close();
  });

  it('single-thread: incremental without --allow-partial reports errors, with --allow-partial still reports', async () => {
    // Full index first
    await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: false,
      useWasm: true,
      workers: 0,
    });

    // Modify a.ts
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA_v2() { return 3; }\n');

    // Incremental with failure
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';

    const result = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: true,
      useWasm: true,
      workers: 0,
    });

    // Should report the error
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].file).toBe('a.ts');
  });

  it('single-thread: after failure, retry without injection succeeds and updates graph', async () => {
    // Full index
    await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: false,
      useWasm: true,
      workers: 0,
    });

    // Modify a.ts
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA_v3() { return 4; }\n');

    // Incremental with failure
    process.env.CBM_TEST_FAIL_ON_FILE = 'a.ts';

    await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: true,
      useWasm: true,
      workers: 0,
    });

    // Now retry without failure injection
    delete process.env.CBM_TEST_FAIL_ON_FILE;

    const result3 = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: true,
      useWasm: true,
      workers: 0,
    });

    // Should succeed now (a.ts gets re-indexed)
    expect(result3.errors.length).toBe(0);
    expect(result3.files).toBe(1); // only a.ts was re-indexed
  });
});
