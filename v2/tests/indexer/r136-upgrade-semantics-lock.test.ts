// v2/tests/indexer/r136-upgrade-semantics-lock.test.ts
// R136: Upgrade Semantics Emergency Lock + engines fix
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R136: Upgrade Semantics Emergency Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r136-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r136-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getVersion(db: Database.Database): number {
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v?: number } | undefined;
    return row?.v ?? 0;
  }
  function getCrossFileEdges(db: Database.Database): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS'
         AND properties_json LIKE '%"resolution":"cross_file%'`
    ).get(projectName) as { c: number };
    return row.c;
  }

  // ── MIG-R136-01: DB v5 → R136 incremental must detect stale ─────────────

  it('migration: DB version=5 → no-op incremental → stale=true, version stays 5', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // Full index (sets version=6)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db0 = getDb();
    expect(getVersion(db0)).toBe(6);
    const edgesBefore = getCrossFileEdges(db0);
    db0.close();
    // Simulate R134/R135 DB: set version back to 5
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();
    // No-op incremental (no files changed)
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R136: version mismatch detected → stale=true
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    expect(getVersion(db)).toBe(5); // version preserved (not upgraded by incremental)
    // Cross-file edges should be cleaned up
    expect(getCrossFileEdges(db)).toBe(0);
    db.close();
  });

  // ── MIG-R136-01: full reindex after stale → version=6 ───────────────────

  it('migration: full reindex after stale → version=6, edges restored', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // Full index
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    // Simulate v5
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();
    // Full reindex
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    expect(r.crossFileCallsStale).toBe(false);
    const db = getDb();
    expect(getVersion(db)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getVersion(db)).toBe(6);
    expect(getCrossFileEdges(db)).toBeGreaterThan(0);
    db.close();
  });

  // ── Full reindex sets version=6 ─────────────────────────────────────────

  it('full reindex sets extractor_semantics_version=6', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    expect(getVersion(db)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getVersion(db)).toBe(6);
    db.close();
  });
});
