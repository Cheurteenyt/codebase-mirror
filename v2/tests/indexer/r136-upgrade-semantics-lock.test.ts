// v2/tests/indexer/r136-upgrade-semantics-lock.test.ts
// R136/R137/R138: Upgrade Semantics + Migration Proof + Causal Closure
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R136/R138: Upgrade Semantics + Causal Migration', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r138-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r138-${Date.now()}`;
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
  function getEdgesForCallee(db: Database.Database, callee: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS'
         AND properties_json LIKE '%"callee":"' || ? || '"%'
         AND properties_json LIKE '%cross_file%'`
    ).get(projectName, callee) as { c: number };
    return row.c;
  }
  function getTypeOnlyDefaultRows(db: Database.Database): number {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM exports WHERE project = ? AND export_kind = 'type_only_default'"
    ).get(projectName) as { c: number };
    return row.c;
  }

  // ── TEST-R138-01/02/03/04: Causal migration with real R134 payload ──────

  it('causal migration: node:fake edge + type-only default → stale → full → correct', async () => {
    // R138-01: Use node:fake (invalid builtin) to test the real R134 bug.
    // R138-02: Add a default consumer for type-index to test resolver effect.
    writeFileSync(join(projectDir, 'type-index.ts'),
      `type Foo = { x: number };\n` +
      `export type { Foo as default };\n` +
      `export default function make() { return 1; }\n`
    );
    writeFileSync(join(projectDir, 'builtin-index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:fake';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'),
      `import { local } from './builtin-index';\n` +
      `import value from './type-index';\n` +
      `export function caller() { return local() + value(); }\n`
    );

    // 1. Full index under v6
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db1 = getDb();
    expect(getVersion(db1)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    // R138-03: exact counts, not >0
    expect(getTypeOnlyDefaultRows(db1)).toBe(1);
    // R138-02: default consumer — type-index is invalid (type default + runtime default collision)
    // so 0 edges for 'value'
    expect(getEdgesForCallee(db1, 'value')).toBe(0);
    // builtin-index is invalid (node:fake) so 0 edges for 'local'
    expect(getEdgesForCallee(db1, 'local')).toBe(0);
    db1.close();

    // 2. Simulate R134 DB: remove type_only_default rows + set version=5
    // R138-04: assert the DELETE actually removed rows
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    const deleteInfo = dbW.prepare(
      "DELETE FROM exports WHERE project = ? AND export_kind = 'type_only_default'"
    ).run(projectName);
    expect(deleteInfo.changes).toBe(1); // R138-04: assert exactly 1 row deleted
    // Verify rows are gone
    const afterDelete = dbW.prepare(
      "SELECT COUNT(*) AS c FROM exports WHERE project = ? AND export_kind = 'type_only_default'"
    ).get(projectName) as { c: number };
    expect(afterDelete.c).toBe(0);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();

    // 3. No-op incremental → stale=true, edges cleaned
    const rStale = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(rStale.crossFileCallsStale).toBe(true);
    const db2 = getDb();
    expect(getVersion(db2)).toBe(5);
    expect(getStale(db2)).toBe(true);
    expect(getCrossFileEdges(db2)).toBe(0); // all cross-file edges cleaned
    db2.close();

    // 4. Full reindex → v6 data restored
    const rFull = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(rFull.errors.length).toBe(0);
    expect(rFull.crossFileCallsStale).toBe(false);
    const db3 = getDb();
    expect(getVersion(db3)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getStale(db3)).toBe(false);
    // R138-03: exact counts after restoration
    expect(getTypeOnlyDefaultRows(db3)).toBe(1);
    expect(getEdgesForCallee(db3, 'value')).toBe(0); // type-index still invalid
    expect(getEdgesForCallee(db3, 'local')).toBe(0); // builtin-index still invalid
    db3.close();
  });

  // ── TEST-R138-01: Stale → full recovery cycle ──────────────────────────

  it('stale → full recovery cycle (TEST-R138-01)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);
    // 1. Full index
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db1 = getDb();
    expect(getVersion(db1)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getStale(db1)).toBe(false);
    expect(getCrossFileEdges(db1)).toBe(1); // exact: one edge caller→foo
    db1.close();
    // 2. Simulate v5
    const dbPath = defaultCodeDbPath(projectName);
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 5 WHERE name = ?').run(projectName);
    dbW.close();
    // 3. Incremental no-op → stale
    const rStale = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(rStale.crossFileCallsStale).toBe(true);
    const db2 = getDb();
    expect(getVersion(db2)).toBe(5);
    expect(getStale(db2)).toBe(true);
    expect(getCrossFileEdges(db2)).toBe(0);
    db2.close();
    // 4. Full → recovered
    const rFull = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(rFull.crossFileCallsStale).toBe(false);
    const db3 = getDb();
    expect(getVersion(db3)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(getStale(db3)).toBe(false);
    expect(getCrossFileEdges(db3)).toBe(1); // exact: one edge restored
    db3.close();
  });

  // ── Full reindex sets version=CURRENT ───────────────────────────────────

  it('full reindex sets extractor_semantics_version=CURRENT', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    expect(getVersion(db)).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
