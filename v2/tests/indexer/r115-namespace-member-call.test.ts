// v2/tests/indexer/r115-namespace-member-call.test.ts
// R115: Import-aware Phase 2 — Namespace + Member-call Tracking
//
// Tests that namespace imports (`import * as ns from './api'; ns.foo()`)
// resolve to the correct target file, not ambiguous edges to all files
// that export a function named `foo`.
//
// Also tests that member calls on namespace imports work in incremental mode.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R115: Import-aware Phase 2 — Namespace + Member-call', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r115-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r115-${Date.now()}`;
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

  // ── Test 1: namespace import resolves to correct file ─────────────────
  it('namespace import: import * as api from "./api"; api.foo() → api.ts::foo only', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'api.foo');
    // R115: should create exactly 1 edge (to api.ts::foo), not 2 (ambiguous)
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('api.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_namespace_exact');
    expect(props.confidence).toBe(1.0);
    expect(props.import_kind).toBe('namespace');
    db.close();
  });

  // ── Test 2: same name foo in two files → namespace disambiguates ──────
  it('namespace disambiguates: two files export foo, namespace import picks correct one', async () => {
    writeFileSync(join(projectDir, 'api1.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'api2.ts'), 'export function foo() { return 2; }\n');
    // a.ts imports api1 as namespace, calls api1.foo()
    writeFileSync(join(projectDir, 'a.ts'), `import * as api1 from './api1';\nimport * as api2 from './api2';\nexport function caller() { return api1.foo() + api2.foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    // api1.foo should resolve to api1.ts::foo
    const edges1 = getCallEdgesForCallee(db, 'api1.foo');
    expect(edges1.length).toBe(1);
    expect(edges1[0].target_qn).toContain('api1.ts');
    expect(edges1[0].target_qn).not.toContain('api2.ts');

    // api2.foo should resolve to api2.ts::foo
    const edges2 = getCallEdgesForCallee(db, 'api2.foo');
    expect(edges2.length).toBe(1);
    expect(edges2[0].target_qn).toContain('api2.ts');
    expect(edges2[0].target_qn).not.toContain('api1.ts');

    // Both should be namespace_exact
    const props1 = JSON.parse(edges1[0].properties_json);
    const props2 = JSON.parse(edges2[0].properties_json);
    expect(props1.resolution).toBe('cross_file_namespace_exact');
    expect(props2.resolution).toBe('cross_file_namespace_exact');
    db.close();
  });

  // ── Test 3: namespace import with multiple methods ────────────────────
  it('namespace import: multiple methods (api.foo, api.bar) all resolve', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\nexport function baz() { return 3; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.foo() + api.bar() + api.baz(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    for (const method of ['api.foo', 'api.bar', 'api.baz']) {
      const edges = getCallEdgesForCallee(db, method);
      expect(edges.length).toBe(1);
      expect(edges[0].target_qn).toContain('api.ts');
      const props = JSON.parse(edges[0].properties_json);
      expect(props.resolution).toBe('cross_file_namespace_exact');
    }
    db.close();
  });

  // ── Test 4: member call NOT on namespace import → name-based fallback ─
  it('member call on non-import object → name-based fallback (not namespace_exact)', async () => {
    writeFileSync(join(projectDir, 'store.ts'), 'export function listNodes() { return []; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function listNodes() { return 99; }\n');
    // s is a local variable, not a namespace import → should fall back to name-based
    writeFileSync(join(projectDir, 'a.ts'), `const s = { listNodes: () => [] };\nexport function caller() { return s.listNodes(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 's.listNodes');
    // Should NOT be namespace_exact (s is not a namespace import)
    for (const e of edges) {
      const props = JSON.parse(e.properties_json);
      expect(props.resolution).not.toBe('cross_file_namespace_exact');
    }
    db.close();
  });

  // ── Test 5: namespace import works in incremental mode ───────────────
  it('incremental: modify caller with namespace import → edge still resolves', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.foo(); }\n`);

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify a.ts — add another namespace call
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.foo() + api.bar(); }\n`);

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });
    expect(result2.errors.length).toBe(0);
    expect(result2.crossFileCallsStale).toBe(false);

    const db = getDb();
    // Both calls should resolve via namespace_exact
    const fooEdges = getCallEdgesForCallee(db, 'api.foo');
    const barEdges = getCallEdgesForCallee(db, 'api.bar');
    expect(fooEdges.length).toBe(1);
    expect(barEdges.length).toBe(1);
    expect(fooEdges[0].target_qn).toContain('api.ts');
    expect(barEdges[0].target_qn).toContain('api.ts');
    expect(fooEdges[0].target_qn).not.toContain('c.ts');
    db.close();
  });

  // ── Test 6: orphan edges = 0 after namespace resolution ───────────────
  it('orphan edges = 0 after namespace import resolution', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import * as api from './api';\nexport function caller() { return api.foo(); }\n`);

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

  // ── Test 7: namespace import with alias (import * as ns) ─────────────
  it('namespace import with different alias name resolves correctly', async () => {
    writeFileSync(join(projectDir, 'api.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    // Use a different alias name 'myApi'
    writeFileSync(join(projectDir, 'a.ts'), `import * as myApi from './api';\nexport function caller() { return myApi.foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'myApi.foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('api.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_namespace_exact');
    db.close();
  });
});
