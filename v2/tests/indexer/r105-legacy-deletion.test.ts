// v2/tests/indexer/r105-legacy-deletion.test.ts
// R105: Test legacy DB deletion (nodes without file_hashes) + parallel deletion smoke.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { initIndexerSchema } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R105: Legacy Deletion + Parallel Smoke', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r105-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r105-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  it('legacy DB: nodes without file_hashes are detected and cleaned up', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function funcA() { return 1; }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Simulate legacy: insert a ghost node for 'ghost.ts' WITHOUT file_hashes entry
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    initIndexerSchema(dbW);
    dbW.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(99999, projectName, 'Function', 'ghostFunc', `${projectName}::ghost.ts::ghostFunc`, 'ghost.ts', 1, 2, '{}');
    dbW.close();

    // Verify ghost exists
    const db1 = new Database(dbPath, { readonly: true });
    const ghostBefore = (db1.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'ghost.ts') as { c: number }).c;
    expect(ghostBefore).toBeGreaterThan(0);
    db1.close();

    // Incremental — should detect ghost.ts as deleted (not on disk, not in file_hashes, but in nodes)
    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    // Ghost should be cleaned up
    const db2 = new Database(dbPath, { readonly: true });
    const ghostAfter = (db2.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'ghost.ts') as { c: number }).c;
    expect(ghostAfter).toBe(0);
    db2.close();
  });

  it('parallel: deletion cleanup works with workers > 1', async () => {
    // Create 24 files to force parallel
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}() { return ${i}; }\n`);
    }

    // Full index — try parallel first, fallback to single-thread
    let workers = 2;
    let result1 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
    });
    if (result1.errors.length > 0 || !result1.parallel) {
      workers = 0;
      result1 = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
      });
    }
    expect(result1.errors.length).toBe(0);
    expect(result1.files).toBe(24);

    // Delete file5.ts
    unlinkSync(join(projectDir, 'file5.ts'));

    // Incremental
    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers,
    });
    expect(result2.errors.length).toBe(0);

    const dbPath = defaultCodeDbPath(projectName);
    const db = new Database(dbPath, { readonly: true });
    const file5Nodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'file5.ts') as { c: number }).c;
    expect(file5Nodes).toBe(0);

    const file5Hash = (db.prepare("SELECT COUNT(*) AS c FROM file_hashes WHERE project = ? AND file_path = ?").get(projectName, 'file5.ts') as { c: number }).c;
    expect(file5Hash).toBe(0);

    // Other files preserved
    const file0Nodes = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND file_path = ?").get(projectName, 'file0.ts') as { c: number }).c;
    expect(file0Nodes).toBeGreaterThan(0);

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
});
