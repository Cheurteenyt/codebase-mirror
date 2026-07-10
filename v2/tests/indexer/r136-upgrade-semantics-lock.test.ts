// v2/tests/indexer/r136-upgrade-semantics-lock.test.ts
// R136/R137: Upgrade Semantics Emergency Lock + Migration Proof Lock
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R136/R137: Upgrade Semantics + Migration Proof', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r137-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r137-${Date.now()}`;
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
  function getStale(db: Database.Database): boolean {
    const row = db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s?: number } | undefined;
    return row?.s === 1;
  }
  function getCrossFileEdges(db: Database.Database): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS'
         AND properties_json LIKE '%"resolution":"cross_file%'`
    ).get(projectName) as { c: number };
    return row.c;
  }
  function simulateV5(): void {
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();
  }

  // ── TEST-R137-01: edgesBefore must be asserted > 0 ──────────────────────

  it('migration: DB v5 → no-op incremental → stale=true, edges cleaned (TEST-R137-01)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // Full index (sets version=6)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db0 = getDb();
    expect(getVersion(db0)).toBe(6);
    const edgesBefore = getCrossFileEdges(db0);
    // R137: TEST-R137-01 — assert edges exist before migration
    expect(edgesBefore).toBeGreaterThan(0);
    db0.close();
    // Simulate R134/R135 DB: set version back to 5
    simulateV5();
    // No-op incremental (no files changed)
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    // R136: version mismatch detected → stale=true
    expect(r.crossFileCallsStale).toBe(true);
    const db = getDb();
    expect(getVersion(db)).toBe(5); // version preserved (not upgraded by incremental)
    expect(getStale(db)).toBe(true); // stale flag persisted in DB
    // Cross-file edges should be cleaned up
    expect(getCrossFileEdges(db)).toBe(0);
    db.close();
  });

  // ── TEST-R137-02: full after stale must go through stale cycle ──────────

  it('migration: stale → full recovery cycle (TEST-R137-02)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // 1. Full index
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db1 = getDb();
    expect(getVersion(db1)).toBe(6);
    expect(getStale(db1)).toBe(false);
    expect(getCrossFileEdges(db1)).toBeGreaterThan(0);
    db1.close();
    // 2. Simulate v5
    simulateV5();
    // 3. Incremental no-op → stale=true
    const rStale = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(rStale.crossFileCallsStale).toBe(true);
    const db2 = getDb();
    expect(getVersion(db2)).toBe(5);
    expect(getStale(db2)).toBe(true);
    expect(getCrossFileEdges(db2)).toBe(0);
    db2.close();
    // 4. Full reindex → stale=false, version=6, edges restored
    const rFull = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(rFull.errors.length).toBe(0);
    expect(rFull.crossFileCallsStale).toBe(false);
    const db3 = getDb();
    expect(getVersion(db3)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getVersion(db3)).toBe(6);
    expect(getStale(db3)).toBe(false);
    expect(getCrossFileEdges(db3)).toBeGreaterThan(0);
    db3.close();
  });

  // ── TEST-R137-03: causal migration with R134 payload ────────────────────

  it('migration: causal R134 payload → stale → full → correct data (TEST-R137-03)', async () => {
    // Fixture: type-only default clause + node:fake star
    writeFileSync(join(projectDir, 'type-index.ts'),
      `type Foo = { x: number };\n` +
      `export type { Foo as default };\n` +
      `export default function make() { return 1; }\n`
    );
    writeFileSync(join(projectDir, 'builtin-index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:fs';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'),
      `import { local } from './builtin-index';\n` +
      `export function caller() { return local(); }\n`
    );
    // 1. Full index (v6 — produces type_only_default rows + validates builtins)
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db1 = getDb();
    // Verify v6 data exists
    const typeOnlyRows = db1.prepare(
      "SELECT COUNT(*) AS c FROM exports WHERE project = ? AND export_kind = 'type_only_default'"
    ).get(projectName) as { c: number };
    expect(typeOnlyRows.c).toBeGreaterThan(0);
    expect(getCrossFileEdges(db1)).toBeGreaterThan(0);
    db1.close();
    // 2. Simulate R134: remove type_only_default rows + set version=5
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare("DELETE FROM exports WHERE project = ? AND export_kind = 'type_only_default'").run(projectName);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();
    // 3. No-op incremental → stale=true, edges cleaned
    const rStale = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(rStale.crossFileCallsStale).toBe(true);
    const db2 = getDb();
    expect(getCrossFileEdges(db2)).toBe(0);
    db2.close();
    // 4. Full reindex → v6 data restored
    const rFull = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(rFull.errors.length).toBe(0);
    expect(rFull.crossFileCallsStale).toBe(false);
    const db3 = getDb();
    expect(getVersion(db3)).toBe(6);
    const typeOnlyRestored = db3.prepare(
      "SELECT COUNT(*) AS c FROM exports WHERE project = ? AND export_kind = 'type_only_default'"
    ).get(projectName) as { c: number };
    expect(typeOnlyRestored.c).toBeGreaterThan(0);
    expect(getCrossFileEdges(db3)).toBeGreaterThan(0);
    db3.close();
  });

  // ── Full reindex sets version=6 ─────────────────────────────────────────

  it('full reindex sets extractor_semantics_version=CURRENT', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    expect(getVersion(db)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
