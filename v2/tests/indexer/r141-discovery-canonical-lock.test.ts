// v2/tests/indexer/r141-discovery-canonical-lock.test.ts
// R141: Discovery Canonical Lock — root failure lock + file symlink dedup +
//      canonical paths + deep SKIP_DIRS + fail-closed realpath + helper unify.
//
// Covers the 7 confirmed findings of the R140 audit:
//   - DATA-R141-01 (P1): root inaccessible must not wipe the graph
//   - IDX-R141-01 (P1/P2): file symlinks must be deduplicated
//   - IDX-R141-02 (P1/P2): canonical path (not alias) must be persisted
//   - PERF-R141-01 (P1/P2): deep SKIP_DIRS bypass must be closed
//   - SEC-R141-02 (P2): regular realpath failure must be fail-closed
//   - QUAL-R141-01 (P2/P3): isPathInside unified
//   - MIG-R141-01 (P2 security): semantics version bumped to 7
//
// Also adds the test gaps called out by the audit:
//   - TEST-R141-01: actual writeNote sink test (not just assertPathInsideRoot)
//   - TEST-R141-02: file symlinks
//   - TEST-R141-03: root inaccessible
//   - TEST-R141-04: alias to nested excluded dir
//   - TEST-R141-06: canonical path exact assertion (not just count)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { assertPathInsideRoot, assertDiscoveryRoot, DiscoveryRootError, isPathInside } from '../../src/utils/safe-path.js';
import { discoverSourceFilesWasm } from '../../src/indexer/wasm-extractor.js';
import { writeNote } from '../../src/obsidian/vault.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R141: Discovery Canonical Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r141-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r141-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── DATA-R141-01: Root Discovery Failure Lock ──────────────────────────

  it('DATA-R141-01a: nonexistent root → IndexResult.errors, no DB wipe', async () => {
    // 1. Build a valid project + index it (full mode) so a graph exists.
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    const r1 = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r1.errors.length).toBe(0);
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesBefore).toBeGreaterThan(0);
    db.close();

    // 2. Now point the indexer at a NONEXISTENT root. R141: must NOT wipe
    //    the existing graph. The previous behavior was: clearProjectData →
    //    discoverSourceFilesWasm returns [] → empty graph certified fresh.
    const bogusRoot = join(tmpDir, 'does-not-exist');
    const r2 = await indexProjectWasm({ project: projectName, rootPath: bogusRoot, incremental: false, useWasm: true, workers: 0 });
    expect(r2.errors.length).toBeGreaterThan(0);
    expect(r2.crossFileCallsStale).toBe(true);
    expect(r2.errors[0].error).toMatch(/Discovery root/);

    // 3. The existing graph MUST still be present (clearProjectData was skipped).
    db = new Database(dbPath, { readonly: true });
    const nodesAfter = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore); // unchanged — no wipe
    db.close();
  });

  it('DATA-R141-01b: root pointing at a file (not directory) → error, no DB wipe', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);

    // Point at a file, not a directory.
    const fileAsRoot = join(projectDir, 'a.ts');
    const r = await indexProjectWasm({ project: projectName, rootPath: fileAsRoot, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodes).toBeGreaterThan(0); // graph preserved
    db.close();
  });

  it('DATA-R141-01c: incremental root failure does NOT delete all files', async () => {
    // 1. Build a graph.
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function bar() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesBefore).toBeGreaterThan(0);
    db.close();

    // 2. Run incremental against a nonexistent root. R141: must NOT interpret
    //    all files as deleted (which would wipe the graph via deletedRelPaths).
    const bogusRoot = join(tmpDir, 'no-such-dir');
    const r = await indexProjectWasm({ project: projectName, rootPath: bogusRoot, incremental: true, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);

    // 3. The graph must be intact — no silent deletion of all nodes.
    db = new Database(dbPath, { readonly: true });
    const nodesAfter = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore);
    db.close();
  });

  it('DATA-R141-01d: assertDiscoveryRoot throws DiscoveryRootError on missing root', () => {
    const bogus = join(tmpDir, 'definitely-missing');
    expect(() => assertDiscoveryRoot(bogus)).toThrow(DiscoveryRootError);
    try {
      assertDiscoveryRoot(bogus);
    } catch (e) {
      const err = e as DiscoveryRootError;
      expect(err.code).toBe('DISCOVERY_ROOT');
      expect(err.reason).toBe('not_found');
      expect(err.rootPath).toBe(bogus);
    }
  });

  it('DATA-R141-01e: assertDiscoveryRoot rejects a file (not directory)', () => {
    const filePath = join(projectDir, 'a.txt');
    writeFileSync(filePath, 'hello');
    expect(() => assertDiscoveryRoot(filePath)).toThrow(DiscoveryRootError);
    try {
      assertDiscoveryRoot(filePath);
    } catch (e) {
      const err = e as DiscoveryRootError;
      expect(err.reason).toBe('not_directory');
    }
  });

  it('DATA-R141-01f: assertDiscoveryRoot returns realpath for valid root', () => {
    // A symlinked root should resolve to its target.
    const realTarget = join(tmpDir, 'real-target');
    mkdirSync(realTarget, { recursive: true });
    const symlinkRoot = join(tmpDir, 'symlink-root');
    symlinkSync(realTarget, symlinkRoot);
    const resolved = assertDiscoveryRoot(symlinkRoot);
    expect(resolved).toBe(realTarget);
  });

  // ── IDX-R141-01: File symlinks must be deduplicated ───────────────────

  it('IDX-R141-01a: file symlink → original dedup (dev:ino)', () => {
    // project/
    //   original.ts
    //   alias.ts -> original.ts
    writeFileSync(join(projectDir, 'original.ts'), 'export function orig() { return 1; }\n');
    symlinkSync(join(projectDir, 'original.ts'), join(projectDir, 'alias.ts'));

    const files = discoverSourceFilesWasm(projectDir);
    // R141: Exactly one path — the canonical original.ts (not the alias).
    expect(files.length).toBe(1);
    // R141 (IDX-R141-02): The path MUST be the canonical one, not the alias.
    expect(files.some(f => f.endsWith('original.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('alias.ts'))).toBe(false);
  });

  it('IDX-R141-01b: two aliases to the same file → exactly one result', () => {
    writeFileSync(join(projectDir, 'real.ts'), 'export function r() { return 0; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias1.ts'));
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias2.ts'));

    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith('real.ts')).toBe(true);
  });

  it('IDX-R141-01c: file symlink indexing produces exactly one File node', async () => {
    writeFileSync(join(projectDir, 'original.ts'), 'export function orig() { return 1; }\n');
    symlinkSync(join(projectDir, 'original.ts'), join(projectDir, 'alias.ts'));

    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);

    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const fileNodes = db.prepare("SELECT file_path FROM nodes WHERE project = ? AND label = 'File'").all(projectName) as Array<{ file_path: string }>;
    expect(fileNodes.length).toBe(1);
    expect(fileNodes[0].file_path.endsWith('original.ts')).toBe(true);
    expect(fileNodes[0].file_path.endsWith('alias.ts')).toBe(false);
    db.close();
  });

  // ── IDX-R141-02: Canonical path must be deterministic ─────────────────

  it('IDX-R141-02a: directory alias → canonical path (subdir, not link)', () => {
    // project/
    //   subdir/inner.ts
    //   link -> subdir
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'subdir', 'inner.ts'), 'export function inner() { return 1; }\n');
    symlinkSync(join(projectDir, 'subdir'), join(projectDir, 'link'));

    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(1);
    // R141: The CANONICAL path (subdir/inner.ts) wins — not the alias (link/inner.ts).
    expect(files.some(f => f.endsWith('subdir/inner.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('link/inner.ts'))).toBe(false);
  });

  it('IDX-R141-02b: directory alias indexing → file_path is canonical', async () => {
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'subdir', 'inner.ts'), 'export function inner() { return 1; }\n');
    symlinkSync(join(projectDir, 'subdir'), join(projectDir, 'link'));

    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);

    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const fileNodes = db.prepare("SELECT file_path FROM nodes WHERE project = ? AND label = 'File'").all(projectName) as Array<{ file_path: string }>;
    expect(fileNodes.length).toBe(1);
    // R141 (TEST-R141-06): assert EXACT canonical path, not just count.
    expect(fileNodes[0].file_path.endsWith('subdir/inner.ts')).toBe(true);
    db.close();
  });

  // ── PERF-R141-01: Deep SKIP_DIRS bypass must be closed ────────────────

  it('PERF-R141-01a: alias to node_modules/pkg/src is skipped (deep component check)', () => {
    // project/
    //   node_modules/pkg/src/dep.ts
    //   source-alias -> node_modules/pkg/src
    mkdirSync(join(projectDir, 'node_modules', 'pkg', 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'pkg', 'src', 'dep.ts'), 'export function dep() { return 0; }\n');
    symlinkSync(join(projectDir, 'node_modules', 'pkg', 'src'), join(projectDir, 'source-alias'));
    writeFileSync(join(projectDir, 'real.ts'), 'export function r() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    // R141: real.ts is indexed; dep.ts is NOT (its canonical path contains
    // `node_modules`, which is in SKIP_DIRS — even though the alias basename
    // is `source-alias` and the target basename is `src`).
    const paths = files.map(f => f.replace(projectDir + '/', ''));
    expect(paths.some(p => p === 'real.ts')).toBe(true);
    expect(paths.some(p => p.includes('dep.ts'))).toBe(false);
    expect(paths.some(p => p.includes('source-alias'))).toBe(false);
  });

  it('PERF-R141-01b: alias to vendor/lib/src is skipped', () => {
    mkdirSync(join(projectDir, 'vendor', 'lib', 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'vendor', 'lib', 'src', 'vendored.ts'), 'export function v() { return 0; }\n');
    symlinkSync(join(projectDir, 'vendor', 'lib', 'src'), join(projectDir, 'vendored-alias'));
    writeFileSync(join(projectDir, 'main.ts'), 'export function m() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    const paths = files.map(f => f.replace(projectDir + '/', ''));
    expect(paths.some(p => p === 'main.ts')).toBe(true);
    expect(paths.some(p => p.includes('vendored.ts'))).toBe(false);
  });

  it('PERF-R141-01c: hidden directory alias is skipped', () => {
    mkdirSync(join(projectDir, '.cache', 'gen'), { recursive: true });
    writeFileSync(join(projectDir, '.cache', 'gen', 'cached.ts'), 'export function c() { return 0; }\n');
    symlinkSync(join(projectDir, '.cache', 'gen'), join(projectDir, 'cache-alias'));
    writeFileSync(join(projectDir, 'app.ts'), 'export function a() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    const paths = files.map(f => f.replace(projectDir + '/', ''));
    expect(paths.some(p => p === 'app.ts')).toBe(true);
    expect(paths.some(p => p.includes('cached.ts'))).toBe(false);
    expect(paths.some(p => p.includes('cache-alias'))).toBe(false);
  });

  // ── QUAL-R141-01: Unified isPathInside ────────────────────────────────

  it('QUAL-R141-01a: isPathInside is exported from safe-path and consistent', () => {
    // The same predicate used by vault writes is now used by discovery.
    const root = projectDir;
    const inside = join(root, 'inside.ts');
    const outside = join(tmpDir, 'outside.ts');
    writeFileSync(inside, '');
    writeFileSync(outside, '');
    expect(isPathInside(root, inside)).toBe(true);
    expect(isPathInside(root, outside)).toBe(false);
    // Edge cases
    expect(isPathInside(root, root)).toBe(true); // root itself
    expect(isPathInside(root, join(root, '..'))).toBe(false); // parent
  });

  it('QUAL-R141-01b: discovery uses the same isPathInside as vault writes', () => {
    // External symlink must be rejected by BOTH paths.
    const externalDir = join(tmpDir, 'external');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'secret.ts'), 'export const s = "leaked";\n');
    symlinkSync(externalDir, join(projectDir, 'escape'));

    // discovery rejects
    const files = discoverSourceFilesWasm(projectDir);
    expect(files.some(f => f.includes('secret'))).toBe(false);

    // vault write also rejects (uses the same isPathInside)
    expect(() => assertPathInsideRoot(projectDir, 'escape/secret.ts')).toThrow(/Path traversal rejected/);
  });

  // ── TEST-R141-01: Real writeNote sink test ────────────────────────────

  it('TEST-R141-01a: writeNote rejects escape via 101+ symlink descendants', () => {
    // R140 test only checked assertPathInsideRoot. R141 adds the SINK test:
    // call writeNote directly and verify the external file is NOT created.
    const vault = join(tmpDir, 'vault');
    const external = join(tmpDir, 'external-sink');
    mkdirSync(vault, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(vault, 'escape'));

    const segments = ['escape'];
    for (let i = 0; i < 101; i++) segments.push(`d${i}`);
    segments.push('note.md');
    const relPath = segments.join('/');

    expect(() => {
      writeNote(vault, relPath, 'should not be written');
    }).toThrow();

    // SINK assertion: no file was created in the external directory.
    const externalFiles: string[] = [];
    function walk(d: string) {
      const entries = readdirSync(d);
      for (const e of entries) {
        const p = join(d, e);
        const s = lstatSync(p);
        if (s.isDirectory()) walk(p);
        else externalFiles.push(p);
      }
    }
    walk(external);
    expect(externalFiles.length).toBe(0);
  });

  it('TEST-R141-01b: writeNote allows legitimate internal path', () => {
    const vault = join(tmpDir, 'vault-ok');
    mkdirSync(vault, { recursive: true });
    const { written } = writeNote(vault, 'notes/test.md', '# Test\nHello.');
    expect(written).toBe(true);
    expect(existsSync(join(vault, 'notes', 'test.md'))).toBe(true);
  });

  // ── SEC-R141-02: Fail-closed regular directory realpath ───────────────
  // Note: we can't easily simulate EACCES on a regular dir in vitest without
  // root privileges, but we CAN verify the algorithm pushes canonical paths
  // by checking that the stack always contains realpath'd entries.

  it('SEC-R141-02a: regular directory traversal persists canonical paths', () => {
    // project/real/inner.ts
    // project/real is a regular dir (no symlink) — the traversal must use
    // its canonical realpath, which on most systems equals projectDir/real.
    mkdirSync(join(projectDir, 'real'), { recursive: true });
    writeFileSync(join(projectDir, 'real', 'inner.ts'), 'export function i() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    // The canonical path (no alias component) is used.
    expect(files.some(f => f.endsWith('real/inner.ts'))).toBe(true);
  });

  // ── MIG-R141-01: Semantics version bumped to 7 ─────────────────────────
  // R144: bumped to 8 (hardlink language contract)

  it('MIG-R141-01a: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 9 (R184 graph contract)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);
  });

  it('MIG-R141-01b: full reindex sets version=8 in DB', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(9);
    db.close();
  });

  it('MIG-R141-01c: DB with version=6 is treated as stale on incremental', async () => {
    // 1. Full index (sets version=7).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);

    // 2. Manually downgrade to version=6 (simulates a pre-R141 DB).
    const dbW = new Database(dbPath);
    dbW.prepare('UPDATE projects SET extractor_semantics_version = 6 WHERE name = ?').run(projectName);
    dbW.close();

    // 3. Incremental no-op → must detect stale semantics.
    const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
    expect(r.crossFileCallsStale).toBe(true);

    // 4. Version is preserved (NOT upgraded by incremental).
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(projectName) as { v: number };
    expect(row.v).toBe(6);
    db.close();
  });

  // ── Regression: R140 P0 depth bypass stays closed ─────────────────────

  it('regression: assertPathInsideRoot still rejects 101+ descendant escape (R140 P0)', () => {
    const root = join(tmpDir, 'vault-r140');
    const external = join(tmpDir, 'external-r140');
    mkdirSync(root, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(root, 'escape'));
    const segments = ['escape'];
    for (let i = 0; i < 101; i++) segments.push(`d${i}`);
    segments.push('note.md');
    expect(() => assertPathInsideRoot(root, segments.join('/'))).toThrow();
  });

  it('regression: external symlink is NOT traversed (R139 P1)', () => {
    const externalDir = join(tmpDir, 'ext');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'secret.ts'), 'export const s = "leaked";\n');
    symlinkSync(externalDir, join(projectDir, 'external-link'));
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    expect(files.some(f => f.includes('secret'))).toBe(false);
    expect(files.some(f => f.includes('external-link'))).toBe(false);
    expect(files.some(f => f.endsWith('a.ts'))).toBe(true);
  });

  it('regression: symlink cycle does NOT cause infinite loop (R139 P1)', () => {
    mkdirSync(join(projectDir, 'a'), { recursive: true });
    symlinkSync(join(projectDir, 'a'), join(projectDir, 'a', 'loop'));
    writeFileSync(join(projectDir, 'a', 'real.ts'), 'export function real() { return 1; }\n');
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    const realFiles = files.filter(f => f.endsWith('real.ts'));
    expect(realFiles.length).toBe(1);
  });
});
