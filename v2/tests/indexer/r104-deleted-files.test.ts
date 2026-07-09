// v2/tests/indexer/r104-deleted-files.test.ts
// R104: Test that deleted files are cleaned up in incremental mode.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R104: Incremental Deleted Files Cleanup', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r104-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r104-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  it('deleted file is cleaned up from nodes, edges, and file_hashes', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function funcB() { return 2; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db1 = getDb();
    const bNodesBefore = (db1.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    const bHashBefore = (db1.prepare("SELECT COUNT(*) AS c FROM file_hashes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    expect(bNodesBefore).toBeGreaterThan(0);
    expect(bHashBefore).toBe(1);
    db1.close();

    // Delete b.ts
    unlinkSync(join(projectDir, 'b.ts'));

    // Incremental
    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    // Verify b.ts is cleaned up
    const db2 = getDb();
    const bNodesAfter = (db2.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    const bHashAfter = (db2.prepare("SELECT COUNT(*) AS c FROM file_hashes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    expect(bNodesAfter).toBe(0);
    expect(bHashAfter).toBe(0);

    // a.ts should still be there
    const aNodes = (db2.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'a.ts') as { c: number }).c;
    expect(aNodes).toBeGreaterThan(0);

    // No orphan edges
    const orphanEdges = (db2.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanEdges).toBe(0);

    // R107: crossFileCallsStale should be false — with persistent call_sites
    // and the initialized flag, the deletion-only fast path either:
    //   (a) rebuilds cross-file CALLS (if call_sites exist) → stale=false, or
    //   (b) has nothing to rebuild (no call_sites) → stale=false (graph still complete)
    // Before R106, this was true because deletion made the graph stale.
    expect(result.crossFileCallsStale).toBe(false);

    db2.close();
  });

  it('deleted file + modified file: both handled correctly', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function funcB() { return 2; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function funcC() { return 3; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete b.ts, modify a.ts
    unlinkSync(join(projectDir, 'b.ts'));
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA_modified() { return 10; }\n');

    // Incremental
    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    // b.ts cleaned up
    const bNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    expect(bNodes).toBe(0);

    // a.ts re-indexed (has new function name)
    const aNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'a.ts') as { c: number }).c;
    expect(aNodes).toBeGreaterThan(0);

    // c.ts preserved
    const cNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'c.ts') as { c: number }).c;
    expect(cNodes).toBeGreaterThan(0);

    // No orphan edges
    const orphanEdges = (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanEdges).toBe(0);

    db.close();
  });

  it('no-op after deletion cleanup: deleted file stays gone', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function funcB() { return 2; }\n');

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Delete b.ts
    unlinkSync(join(projectDir, 'b.ts'));

    // First incremental: cleanup
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    // Second incremental: no-op (should not re-create b.ts)
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.skipped).toBe(1); // only a.ts

    const db = getDb();
    const bNodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'b.ts') as { c: number }).c;
    expect(bNodes).toBe(0);
    db.close();
  });
});
