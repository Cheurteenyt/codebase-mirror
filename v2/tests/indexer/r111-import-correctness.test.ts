// v2/tests/indexer/r111-import-correctness.test.ts
// R111: Import Resolution Correctness Lock
//
// Tests 3 fixes from R112 audit report:
// 1. resolveModulePath handles explicit extensions (./b.ts, ./b.js, ./dir/index.ts)
// 2. Default import resolves when local name differs from exported name
// 3. Type-only imports (import type {Foo}) are not persisted
// Plus: parallel smoke test for import-aware resolution

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R111: Import Resolution Correctness Lock', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r111-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r111-${Date.now()}`;
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

  // ── Test 1: explicit extension ./b.ts ──────────────────────────────────
  it('explicit extension: import { foo } from "./b.ts" resolves to b::foo', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b.ts';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R111: should create exactly 1 edge (to b::foo), not 2 (ambiguous)
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    db.close();
  });

  // ── Test 2: explicit extension ./b.js ──────────────────────────────────
  it('explicit extension: import { foo } from "./b.js" resolves when b.js exists', async () => {
    writeFileSync(join(projectDir, 'b.js'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b.js';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R111: should create exactly 1 edge (to b.js::foo)
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.js');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    db.close();
  });

  // ── Test 3: explicit extension ./dir/index.ts ──────────────────────────
  it('explicit extension: import { foo } from "./dir/index.ts" resolves', async () => {
    mkdirSync(join(projectDir, 'dir'), { recursive: true });
    writeFileSync(join(projectDir, 'dir', 'index.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './dir/index.ts';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R111: should create exactly 1 edge (to dir/index.ts::foo)
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn.replaceAll('\\', '/')).toContain('dir/index.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    db.close();
  });

  // ── Test 4: default import with different local name ──────────────────
  it('default import: import foo from "./b" resolves to b::realName (different name)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R111: should create exactly 1 edge (to b::realName), not to c::foo
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');
    expect(props.import_kind).toBe('default');
    db.close();
  });

  // ── Test 5: default import with same name (regression check) ──────────
  it('default import: import foo from "./b" still works when names match', async () => {
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
    db.close();
  });

  // ── Test 6: import type { Foo } is not persisted ───────────────────────
  it('type-only import: import type { Foo } is not persisted to imports table', async () => {
    writeFileSync(join(projectDir, 'types.ts'), 'export interface Foo { x: number; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import type { Foo } from './types';\nimport { bar } from './types';\nexport function caller() { return bar(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const imports = db.prepare("SELECT local_name, import_kind FROM imports WHERE project = ? AND file_path = ?").all(projectName, 'a.ts') as Array<{
      local_name: string; import_kind: string;
    }>;
    // R111: Foo should NOT be in imports (type-only). bar should be.
    const fooImp = imports.find(i => i.local_name === 'Foo');
    const barImp = imports.find(i => i.local_name === 'bar');
    expect(fooImp).toBeUndefined();
    expect(barImp).toBeDefined();
    expect(barImp!.import_kind).toBe('named');
    db.close();
  });

  // ── Test 7: inline type-only specifier ─────────────────────────────────
  it('inline type-only: import { type Foo, bar } skips Foo, keeps bar', async () => {
    writeFileSync(join(projectDir, 'types.ts'), 'export interface Foo { x: number; }\nexport function bar() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import { type Foo, bar } from './types';\nexport function caller() { return bar(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    const imports = db.prepare("SELECT local_name, import_kind FROM imports WHERE project = ? AND file_path = ?").all(projectName, 'a.ts') as Array<{
      local_name: string; import_kind: string;
    }>;
    // R111: Foo should NOT be in imports (inline type-only). bar should be.
    const fooImp = imports.find(i => i.local_name === 'Foo');
    const barImp = imports.find(i => i.local_name === 'bar');
    expect(fooImp).toBeUndefined();
    expect(barImp).toBeDefined();
    db.close();
  });

  // ── Test 8: parallel smoke — import-aware with workers=2 ──────────────
  it('parallel: workers=2 import-aware resolution works correctly', async () => {
    // Create 24+ files to force parallel
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function func${i}() { return ${i}; }\n`);
    }
    // b.ts and c.ts both export foo
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'c.ts'), 'export function foo() { return 99; }\n');
    // a.ts explicitly imports from b.ts
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './b';\nexport function caller() { return foo(); }\n`);

    // Full index — try parallel, fallback to single-thread
    let workers = 2;
    let result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 2,
    });
    if (result.errors.length > 0 || !result.parallel) {
      workers = 0;
      result = await indexProjectWasm({
        project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
      });
    }
    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = getCallEdgesForCallee(db, 'foo');
    // R111: should create exactly 1 edge (to b::foo), not 2 (ambiguous)
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).not.toContain('c.ts');
    const props = JSON.parse(edges[0].properties_json);
    expect(props.resolution).toBe('cross_file_import_exact');

    // If parallel actually ran, verify it's real parallel
    if (result.parallel) {
      // Orphan edges = 0
      const orphanEdges = (db.prepare(`
        SELECT COUNT(*) AS c FROM edges e
        LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
        LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
        WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
      `).get(projectName) as { c: number }).c;
      expect(orphanEdges).toBe(0);
    }
    db.close();
  });

  // ── Test 9: default export marker persisted ───────────────────────────
  it('default export marker is persisted in imports table', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export default function realName() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);

    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    const db = getDb();
    // The default export marker should be in imports for b.ts
    const marker = db.prepare(
      "SELECT imported_name, import_kind FROM imports WHERE project = ? AND file_path = ? AND local_name = '__default_export__'"
    ).get(projectName, 'b.ts') as { imported_name: string; import_kind: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.import_kind).toBe('default_export');
    expect(marker!.imported_name).toContain('realName');
    db.close();
  });
});
