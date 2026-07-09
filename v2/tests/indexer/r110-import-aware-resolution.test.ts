// v2/tests/indexer/r110-import-aware-resolution.test.ts
// R110: Import-aware Resolution Phase 1
//
// Tests that the cross-file CALLS resolver prioritizes imported symbols over
// name-based fallback. Before R110, the resolver was purely name-based: if two
// files exported `foo`, a call to `foo()` would create edges to BOTH. After
// R110, an explicit import `import { foo } from './b'` resolves only to b::foo.
//
// Covers: named imports, alias imports, default imports, namespace imports,
// no-import fallback, and builtins filtering preserved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R110: Import-aware Resolution Phase 1', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r110-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r110-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function getCallEdgesForCallee(db: Database.Database, calleeName: string): Array<{
    target_qn: string;
    properties_json: string;
  }> {
    return db.prepare(
      `SELECT t.qualified_name AS target_qn, e.properties_json
       FROM edges e
       JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"' || ? || '"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName, calleeName) as Array<{ target_qn: string; properties_json: string }>;
  }

  // ── Test 1: named import resolves to the correct file ─────────────────
  it('named import: import { foo } from "./b" resolves to b::foo, not c::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R110: should create exactly 1 edge (to b::foo), not 2 (to both b::foo and c::foo)
    expect(edges.length).toBe(1);
    // The target should be in b.ts, not c.ts
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    // Resolution should be import_exact
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    expect(props.confidence).toBe(1.0);
    expect(props.import_kind).toBe('named');
    db.close();
  });

  // ── Test 2: alias import resolves to the original name ────────────────
  it('alias import: import { foo as bar } resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function bar() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo as bar } from './b';\nexport function caller() { return bar(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    // The callee is 'bar' (the local alias)
    const edges = getCallEdgesForCallee(db, 'bar');
    expect(edges.length).toBe(1);
    // Should resolve to b::foo (the original name in the source module)
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('foo');
    // Should NOT resolve to c::bar (name-based fallback would match this)
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_alias');
    expect(props.import_kind).toBe('alias');
    db.close();
  });

  // ── Test 3: default import resolves to the exported function ──────────
  it('default import: import foo from "./b" resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    expect(props.import_kind).toBe('default');
    db.close();
  });

  // ── Test 4: no import → name-based fallback ───────────────────────────
  it('no import: name-based fallback creates edges to all candidates', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    // No import — just a bare call to foo()
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R110: without an import, fall back to name-based resolution → 2 edges (ambiguous)
    expect(edges.length).toBe(2);
    // Both should have resolution 'cross_file_ambiguous'
    for (const e of edges) {
      const props = JSON.parse(e.properties_json);
      expect(props.resolution).toBe('cross_file_ambiguous');
    }
    db.close();
  });

  // ── Test 5: builtins filtering preserved with imports ─────────────────
  it('builtins filter preserved: imported log still works, console.log filtered', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function log() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { log } from './b';\nexport function caller() { console.log("x"); return log(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    // console.log should NOT create a cross-file edge (member call builtin)
    const consoleLogEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%console.log%'").get(projectName) as { c: number }).c;
    expect(consoleLogEdges).toBe(0);
    // But log() as identifier_call SHOULD create an edge (imported from b.ts)
    const logEdges = getCallEdgesForCallee(db, 'log');
    expect(logEdges.length).toBe(1);
    expect(logEdges[0].target_qn).toContain('b.ts');
    const props = JSON.parse(logEdges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    db.close();
  });

  // ── Test 6: import-aware resolution works in incremental mode ─────────
  it('incremental: modify caller with import → edge still resolves correctly', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify a.ts — still imports from b, adds another call
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo() + foo(); }\n`);

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.crossFileCallsStale).toBe(false);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // Should still resolve only to b::foo (import-aware)
    for (const e of edges) {
      expect(e.target_qn).toContain('b.ts');
      expect(e.target_qn).not.toContain('c.ts');
    }
    db.close();
  });

  // ── Test 7: imports table is populated ────────────────────────────────
  it('imports table is populated with correct bindings', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo, bar as baz } from './b';\nexport function caller() { return foo() + baz(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const imports = db.prepare("SELECT local_name, source_module, imported_name, import_kind FROM imports WHERE project = ? AND file_path = ?").all(projectName, 'a.ts') as Array<{
      local_name: string; source_module: string; imported_name: string; import_kind: string;
    }>;
    expect(imports.length).toBe(2);
    // Find by local_name (don't rely on ORDER)
    const fooImp = imports.find(i => i.local_name === 'foo');
    const bazImp = imports.find(i => i.local_name === 'baz');
    expect(fooImp).toBeDefined();
    expect(bazImp).toBeDefined();
    // foo: named import
    expect(fooImp!.imported_name).toBe('foo');
    expect(fooImp!.import_kind).toBe('named');
    expect(fooImp!.source_module).toBe('./b');
    // baz: alias import (original name is bar)
    expect(bazImp!.imported_name).toBe('bar');
    expect(bazImp!.import_kind).toBe('alias');
    db.close();
  });

  // ── Test 8: orphan edges = 0 after import-aware resolution ────────────
  it('orphan edges = 0 after import-aware resolution', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const orphanCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanCount).toBe(0);
    db.close();
  });
});
