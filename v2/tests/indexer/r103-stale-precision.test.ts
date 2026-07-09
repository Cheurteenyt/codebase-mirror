// v2/tests/indexer/r103-stale-precision.test.ts
// R103: Test that metadata-only incremental does NOT set crossFileCallsStale=true.
// A touch/mtime-only change doesn't modify the graph, so cross-file CALLS remain valid.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R103: Stale Flag Precision — metadata-only does not set stale', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r103-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r103-${Date.now()}`;
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

  it('metadata-only touch does not set stale when graph was clean', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index — stale = false
    const result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result1.errors.length).toBe(0);
    expect(result1.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);

    // Touch a.ts (change mtime only, content unchanged)
    const now = new Date();
    utimesSync(join(projectDir, 'a.ts'), now, now);

    // Incremental — should be metadata-only, files=0, stale should remain false
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.files).toBe(0); // metadata-only: no files re-indexed
    expect(result2.skipped).toBeGreaterThan(0);
    // R103: stale should NOT be true — graph didn't change
    expect(result2.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });

  it('real content change sets stale, then metadata-only preserves stale', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(getStaleFromDB()).toBe(false);

    // Real content change → stale = true
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.files).toBeGreaterThan(0); // file was re-indexed
    expect(result2.crossFileCallsStale).toBe(true);
    expect(getStaleFromDB()).toBe(true);

    // Now touch b.ts (metadata-only) — stale should STILL be true (preserved)
    const now = new Date();
    utimesSync(join(projectDir, 'b.ts'), now, now);
    const result3 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result3.files).toBe(0); // metadata-only
    // R103: stale preserved from previous run (monotonic)
    expect(result3.crossFileCallsStale).toBe(true);
    expect(getStaleFromDB()).toBe(true);

    // Full reindex resets
    const result4 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result4.crossFileCallsStale).toBe(false);
    expect(getStaleFromDB()).toBe(false);
  });
});
