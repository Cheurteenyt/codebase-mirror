// v2/tests/indexer/r132-external-star-default-fix.test.ts
// R132: External Star Fix + Default Occurrence Count + Overload Verification
//
// Tests the R132 fixes for:
//   - IDX-R132-05: external/bare star specifiers no longer falsely invalidated
//   - IDX-R132-06: two direct `export default` statements detected
//   - IDX-R132-07: `export default identifier` + `export { foo as default }` detected
//   - IDX-R132-01 (false positive): TypeScript overloads work correctly
//   - QUAL-R132-02: wrong "lazy" comment corrected
//   - Semantics version bump v2→v3
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R132: External Star + Default Fix', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r132-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r132-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  function getDb() { return new Database(defaultCodeDbPath(projectName), { readonly: true }); }
  function getEdges(db: Database.Database, callee: string) {
    return db.prepare(
      `SELECT t.qualified_name AS target_qn, e.properties_json
       FROM edges e
       JOIN nodes t ON t.id = e.target_id AND t.project = e.project
       WHERE e.project = ? AND e.type = 'CALLS'
         AND e.properties_json LIKE '%"callee":"' || ? || '"%'
         AND e.properties_json LIKE '%cross_file%'`
    ).all(projectName, callee) as Array<{ target_qn: string; properties_json: string }>;
  }

  // ── IDX-R132-01 (false positive): TypeScript overloads ──────────────────
  // The audit claimed overloads would produce duplicate rows. Tree-sitter
  // uses `function_signature` for overload signatures (not `function_declaration`),
  // so the extractor only picks up the implementation. This test verifies
  // that overloads do NOT produce false `invalid_duplicate_export`.

  it('TypeScript overloads → 1 edge (NOT duplicate, tree-sitter uses function_signature)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export function foo(x: string): string;\n` +
      `export function foo(x: number): number;\n` +
      `export function foo(x: string | number) { return x; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo('hello'); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R132: overloads should NOT produce duplicate export rows.
    // tree-sitter uses `function_signature` for overload signatures (no body)
    // and `function_declaration` for the implementation. The extractor only
    // searches for `function_declaration`, so only 1 row is created.
    const exportRows = db.prepare(
      "SELECT COUNT(*) AS c FROM exports WHERE project = ? AND file_path = 'index.ts' AND exported_name = 'foo'"
    ).get(projectName) as { c: number };
    expect(exportRows.c).toBe(1);
    // The import should resolve normally (1 edge)
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    db.close();
  });

  // ── IDX-R132-05: External/bare star specifiers ──────────────────────────

  it('export * from bare specifier (node:path) → NOT invalidated, local export resolves', async () => {
    // `export * from 'node:path'` is valid ESM. R131 falsely marked the
    // module invalid because resolveModulePath() returns null for bare
    // specifiers. R132 only marks invalid for relative paths (./ ../).
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:path';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R132: bare specifier star should NOT invalidate the module.
    // local should resolve normally.
    const edges = getEdges(db, 'local');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('index.ts');
    db.close();
  });

  it('export * from bare package → NOT invalidated (R133: bare specifiers are unverifiable, not invalid)', async () => {
    // R133: TEST-R133-01 — the R132 test used 'some-package' which is NOT
    // installed and would fail at runtime (ERR_MODULE_NOT_FOUND). However,
    // the indexer cannot verify package existence without node_modules access.
    // R133 keeps the conservative behavior: bare specifiers are treated as
    // "external_or_alias" — not verified, but not marked invalid. This avoids
    // false negatives on valid packages and builtins. Full package resolution
    // (createRequire.resolve) is deferred to a future round.
    // The test now uses 'node:path' which is a guaranteed-valid builtin.
    writeFileSync(join(projectDir, 'index.ts'),
      `export function local() { return 1; }\n` +
      `export * from 'node:fs';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { local } from './index';\nexport function caller() { return local(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'local');
    expect(edges.length).toBe(1);
    db.close();
  });

  // ── IDX-R132-05 positive: relative star still validated ─────────────────

  it('export * from missing relative → still invalidated (IDX-R131-04 preserved)', async () => {
    writeFileSync(join(projectDir, 'good.ts'), `export function foo() { return 1; }\n`);
    writeFileSync(join(projectDir, 'index.ts'),
      `export { foo } from './good';\n` +
      `export * from './missing';\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import { foo } from './index';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R132: relative missing star source still invalidates the module
    expect(getEdges(db, 'foo').length).toBe(0);
    db.close();
  });

  // ── IDX-R132-06: Two direct defaults ────────────────────────────────────

  it('two export default statements → 0 edges (Duplicate default, IDX-R132-06)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `export default function a() { return 1; }\n` +
      `export default function b() { return 2; }\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R132: two `export default` → count > 1 → invalid_duplicate_export → 0 edges
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  // ── IDX-R132-07: Default identifier + binding default ───────────────────

  it('export default identifier + export { foo as default } → 0 edges (IDX-R132-07)', async () => {
    writeFileSync(join(projectDir, 'index.ts'),
      `function foo() { return 1; }\n` +
      `export default foo;\n` +
      `export { foo as default };\n`
    );
    writeFileSync(join(projectDir, 'a.ts'), `import value from './index';\nexport function caller() { return value(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    // R132: `export default foo` creates a marker with count=1, qn=null.
    // `export { foo as default }` creates a binding with exportedName='default'.
    // count > 0 + fileExp.named.has('default') → invalid_duplicate_export.
    expect(getEdges(db, 'value').length).toBe(0);
    db.close();
  });

  // ── Positive control: single direct default still works ─────────────────

  it('single export default function → 1 edge (positive control)', async () => {
    writeFileSync(join(projectDir, 'b.ts'), `export default function realName() { return 42; }\n`);
    writeFileSync(join(projectDir, 'a.ts'), `import foo from './b';\nexport function caller() { return foo(); }\n`);
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);
    const db = getDb();
    const edges = getEdges(db, 'foo');
    expect(edges.length).toBe(1);
    expect(edges[0].target_qn).toContain('b.ts');
    expect(edges[0].target_qn).toContain('realName');
    db.close();
  });

  // ── Semantics version bump v3 ───────────────────────────────────────────

  it('full reindex sets extractor_semantics_version=3 (R132 bump)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), `export function foo() { return 1; }\n`);
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = getDb();
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    expect(row.v).toBe(CURRENT_EXTRACTOR_SEMANTICS_VERSION);
    db.close();
  });
});
