// v2/tests/indexer/r102-stale-monotonicity.test.ts
// R102: Test that cross_file_calls_stale is monotonic — once true, stays true
// until full reindex. No-op incremental must NOT reset it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R102: Stale Flag Monotonicity', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r102-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r102-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getStaleFromDB(): boolean {
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const row = db.prepare('SELECT cross_file_calls_stale FROM projects WHERE name = ?').get(projectName) as { cross_file_calls_stale?: number } | undefined;
    db.close();
    return row?.cross_file_calls_stale === 1;
  }

  it('full → incremental changed → no-op preserves stale → full resets', async () => {
    // Create files
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Step 1: Full index — stale = false
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // Step 2: Modify a.ts — incremental, stale = true
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.crossFileCallsStale).toBe(true);
    expect(getStaleFromDB()).toBe(true);

    // Step 3: No-op incremental — stale must STILL be true (not reset)
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result3.errors.length).toBe(0);
    expect(result3.crossFileCallsStale).toBe(true); // R102: must preserve existing stale
    expect(getStaleFromDB()).toBe(true); // R102: DB must still say stale

    // Step 4: Full reindex — stale = false (reset)
    const result4 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result4.errors.length).toBe(0);
    expect(result4.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });
});
