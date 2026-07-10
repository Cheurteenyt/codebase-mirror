// v2/tests/indexer/r142-discovery-completeness-lock.test.ts
// R142: Discovery Completeness Lock + Canonical Root Propagation + File Identity Contract
//
// Covers the 7 confirmed findings of the R141 audit:
//   - DATA-R142-01 (P1): root mode 000 — assertDiscoveryRoot must readdir
//   - DATA-R142-02 (P1): subtree EACCES — errors collected, not swallowed
//   - PATH-R142-01 (P1): canonicalRoot propagated — no `..` in file_path
//   - IDX-R142-01 (P1/P2): hardlink non-code first — detect language before visited
//   - SEC-R142-01 (P1/P2): symlink to FIFO/socket/device — isFile() gate
//   - ID-R142-01 (P2): dev:ino = 0n — fallback to path:realpath
//   - STATE-R142-01 (P1/P2): root failure persists stale=true in DB
//
// Also closes CI-R142-01: pretest build script ensures dist/ exists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, existsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';
import { assertPathInsideRoot, assertDiscoveryRoot, DiscoveryRootError, isPathInside } from '../../src/utils/safe-path.js';
import { discoverSourceFilesWasm, discoverSourceFilesStructured } from '../../src/indexer/wasm-extractor.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R142: Discovery Completeness Lock', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r142-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r142-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  // ── DATA-R142-01: root mode 000 — readdir must be verified ────────────

  it('DATA-R142-01a: assertDiscoveryRoot rejects root with mode 000 (readdir fails)', () => {
    // R142: assertDiscoveryRoot now does readdirSync, not just stat+realpath.
    // A directory with mode 000 passes stat+realpath but fails readdir.
    const root = join(tmpDir, 'mode000');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    chmodSync(root, 0o000); // no read, no write, no execute
    try {
      expect(() => assertDiscoveryRoot(root)).toThrow(DiscoveryRootError);
      try {
        assertDiscoveryRoot(root);
      } catch (e) {
        const err = e as DiscoveryRootError;
        expect(err.reason).toBe('not_readable');
      }
    } finally {
      // Restore permissions so afterEach cleanup can delete it.
      chmodSync(root, 0o755);
    }
  });

  it('DATA-R142-01b: root mode 000 → IndexResult.errors, no DB wipe', async () => {
    // 1. Build a valid graph.
    writeFileSync(join(projectDir, 'a.ts'), 'export function foo() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesBefore).toBeGreaterThan(0);
    db.close();

    // 2. Create a mode-000 root and index against it.
    const root000 = join(tmpDir, 'root000');
    mkdirSync(root000, { recursive: true });
    chmodSync(root000, 0o000);
    try {
      const r = await indexProjectWasm({ project: projectName, rootPath: root000, incremental: false, useWasm: true, workers: 0 });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.crossFileCallsStale).toBe(true);
    } finally {
      chmodSync(root000, 0o755);
    }

    // 3. Graph preserved.
    db = new Database(dbPath, { readonly: true });
    const nodesAfter = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore);
    db.close();
  });

  // ── DATA-R142-02: subtree EACCES — errors collected, not swallowed ────

  it('DATA-R142-02a: discoverSourceFilesStructured collects subtree readdir errors', () => {
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'subdir', 'b.ts'), 'export function b() { return 2; }\n');
    // Make subdir unreadable.
    chmodSync(join(projectDir, 'subdir'), 0o000);
    try {
      const result = discoverSourceFilesStructured(projectDir);
      expect(result.files.length).toBeGreaterThanOrEqual(1); // a.ts still found
      expect(result.files.some(f => f.endsWith('a.ts'))).toBe(true);
      // R142: errors are collected, not swallowed.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.complete).toBe(false);
      const errorPaths = result.errors.map(e => e.path);
      expect(errorPaths.some(p => p.includes('subdir'))).toBe(true);
    } finally {
      chmodSync(join(projectDir, 'subdir'), 0o755);
    }
  });

  it('DATA-R142-02b: full mode + partial discovery → no clearProjectData, graph preserved', async () => {
    // 1. Build a valid graph with a.ts and subdir/b.ts.
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'subdir', 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesBefore).toBeGreaterThan(0);
    db.close();

    // 2. Make subdir unreadable, then full reindex.
    chmodSync(join(projectDir, 'subdir'), 0o000);
    try {
      const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
      // R142: partial discovery → error returned, graph NOT cleared.
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.crossFileCallsStale).toBe(true);
    } finally {
      chmodSync(join(projectDir, 'subdir'), 0o755);
    }

    // 3. Graph preserved (both a.ts and b.ts nodes still present).
    db = new Database(dbPath, { readonly: true });
    const nodesAfter = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore);
    db.close();
  });

  // ── PATH-R142-01: canonicalRoot propagated — no `..` in file_path ─────

  it('PATH-R142-01a: symlinked root → file_path has no `..` (canonical root used)', async () => {
    // /tmp/real-root/src/a.ts
    // /tmp/link-root -> /tmp/real-root
    const realRoot = join(tmpDir, 'real-root');
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    const linkRoot = join(tmpDir, 'link-root');
    symlinkSync(realRoot, linkRoot);

    // Index via the symlink root.
    const r = await indexProjectWasm({ project: projectName, rootPath: linkRoot, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBe(0);

    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    const fileNodes = db.prepare("SELECT file_path FROM nodes WHERE project = ? AND label = 'File'").all(projectName) as Array<{ file_path: string }>;
    expect(fileNodes.length).toBe(1);
    // R142 (PATH-R142-01): file_path must NOT contain `..`.
    expect(fileNodes[0].file_path).not.toContain('..');
    // R142: file_path should be relative to the canonical root (src/a.ts).
    expect(fileNodes[0].file_path).toBe('src/a.ts');
    db.close();
  });

  it('PATH-R142-01b: assertDiscoveryRoot returns canonical realpath for symlinked root', () => {
    const realRoot = join(tmpDir, 'real-target');
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, 'marker.ts'), 'export const x = 1;\n');
    const linkRoot = join(tmpDir, 'link-root');
    symlinkSync(realRoot, linkRoot);
    const canonical = assertDiscoveryRoot(linkRoot);
    expect(canonical).toBe(realRoot);
    expect(canonical).not.toBe(linkRoot);
  });

  // ── IDX-R142-01: hardlink non-code first — detect language before visited ──

  it('IDX-R142-01a: hardlink a.txt + z.ts (a.txt first) → z.ts indexed, not suppressed', () => {
    // Create two hardlinks to the same inode: a.txt (non-code) and z.ts (code).
    // readdir order on Linux is typically alphabetical, so a.txt comes first.
    // R141 bug: a.txt marks the inode visited, z.ts is skipped → source lost.
    // R142 fix: detectLanguage is called BEFORE visitedFiles.add, so a.txt
    // (non-code) does NOT poison the visited set.
    writeFileSync(join(projectDir, 'z.ts'), 'export function z() { return 1; }\n');
    // Create a.txt as a hardlink to z.ts (same inode).
    linkSync(join(projectDir, 'z.ts'), join(projectDir, 'a.txt'));

    const files = discoverSourceFilesWasm(projectDir);
    // R142: z.ts must be in the results. The non-code hardlink a.txt must NOT
    // suppress it.
    // Note: exactly one of {a.ts, z.ts} is in the results (same inode → dedup).
    // Since both have the same content, either is acceptable, but at least one
    // code path must be present.
    const tsFiles = files.filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBe(1);
  });

  it('IDX-R142-01b: hardlink code + code (two .ts files same inode) → exactly one result', () => {
    writeFileSync(join(projectDir, 'original.ts'), 'export function orig() { return 1; }\n');
    linkSync(join(projectDir, 'original.ts'), join(projectDir, 'alias.ts'));

    const files = discoverSourceFilesWasm(projectDir);
    const tsFiles = files.filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBe(1);
  });

  // ── SEC-R142-01: symlink to FIFO/socket/device — isFile() gate ────────

  it('SEC-R142-01a: regular FIFO is NOT treated as a source file', () => {
    // Create a FIFO with a .ts extension. R141 bug: the else branch of
    // isDirectory() treated it as a file candidate → readFileSync would block.
    // R142 fix: only isFile() entries are candidates.
    // Note: mkfifo is not available in Node's fs module; we use a different
    // approach — create a FIFO via spawnSync('mkfifo'). If mkfifo is not
    // available (Windows), skip this test.
    const { spawnSync } = require('node:child_process');
    const fifoPath = join(projectDir, 'pipe.ts');
    try {
      spawnSync('mkfifo', [fifoPath]);
    } catch {
      // mkfifo not available — skip.
      return;
    }
    if (!existsSync(fifoPath)) return;

    const files = discoverSourceFilesWasm(projectDir);
    // R142: FIFO must NOT be in the results.
    expect(files.some(f => f.endsWith('pipe.ts'))).toBe(false);
  });

  it('SEC-R142-01b: symlink to FIFO with .ts extension is NOT indexed', () => {
    const { spawnSync } = require('node:child_process');
    const fifoPath = join(tmpDir, 'pipe.ts');
    try {
      spawnSync('mkfifo', [fifoPath]);
    } catch {
      return;
    }
    if (!existsSync(fifoPath)) return;
    // Create a symlink to the FIFO inside the project.
    symlinkSync(fifoPath, join(projectDir, 'alias.ts'));
    writeFileSync(join(projectDir, 'real.ts'), 'export function r() { return 1; }\n');

    const files = discoverSourceFilesWasm(projectDir);
    // R142: The symlink to the FIFO must NOT be indexed.
    expect(files.some(f => f.endsWith('alias.ts'))).toBe(false);
    // The real .ts file should still be indexed.
    expect(files.some(f => f.endsWith('real.ts'))).toBe(true);
  });

  // ── ID-R142-01: dev:ino = 0n fallback (logic test) ────────────────────
  // Note: we can't easily simulate dev:ino=0 in a unit test without mocking
  // statSync. The logic is tested indirectly: the fileIdentityKey function
  // checks `st.dev === 0n && st.ino === 0n` and falls back to path:realpath.
  // We verify the function exists and the discovery still works on normal
  // filesystems (where dev/ino are non-zero).

  it('ID-R142-01a: normal filesystem — dev:ino dedup works (inode-based)', () => {
    // Two file symlinks to the same file → one result (dev:ino dedup).
    writeFileSync(join(projectDir, 'real.ts'), 'export function r() { return 1; }\n');
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias1.ts'));
    symlinkSync(join(projectDir, 'real.ts'), join(projectDir, 'alias2.ts'));

    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith('real.ts')).toBe(true);
  });

  // ── STATE-R142-01: root failure persists stale=true in DB ─────────────

  it('STATE-R142-01a: root failure persists cross_file_calls_stale=1 in DB', async () => {
    // 1. Build a valid graph (stale=false after full).
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const staleBefore = (db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s: number }).s;
    expect(staleBefore).toBe(0); // fresh after successful full
    db.close();

    // 2. Trigger root failure.
    const bogusRoot = join(tmpDir, 'nonexistent');
    const r = await indexProjectWasm({ project: projectName, rootPath: bogusRoot, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.crossFileCallsStale).toBe(true);

    // 3. R142 (STATE-R142-01): DB must now have stale=1.
    db = new Database(dbPath, { readonly: true });
    const staleAfter = (db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s: number }).s;
    expect(staleAfter).toBe(1);
    db.close();
  });

  it('STATE-R142-01b: partial discovery persists cross_file_calls_stale=1 in DB', async () => {
    // 1. Build a valid graph.
    mkdirSync(join(projectDir, 'subdir'), { recursive: true });
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    writeFileSync(join(projectDir, 'subdir', 'b.ts'), 'export function b() { return 2; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const staleBefore = (db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s: number }).s;
    expect(staleBefore).toBe(0);
    db.close();

    // 2. Make subdir unreadable, then incremental index.
    chmodSync(join(projectDir, 'subdir'), 0o000);
    try {
      const r = await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0 });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.crossFileCallsStale).toBe(true);
    } finally {
      chmodSync(join(projectDir, 'subdir'), 0o755);
    }

    // 3. DB must have stale=1.
    db = new Database(dbPath, { readonly: true });
    const staleAfter = (db.prepare('SELECT cross_file_calls_stale AS s FROM projects WHERE name = ?').get(projectName) as { s: number }).s;
    expect(staleAfter).toBe(1);
    db.close();
  });

  // ── PERF-R142-01: canonicalRoot avoids redundant stat/realpath ────────

  it('PERF-R142-01a: discoverSourceFilesStructured with canonicalRoot skips redundant validation', () => {
    // When canonicalRoot is provided, the walker reuses it instead of
    // re-running stat+realpath+readdir on the root. This is a perf
    // optimization (PERF-R142-01) and also ensures the canonical root
    // is used for all relative-path computation (PATH-R142-01).
    const canonical = assertDiscoveryRoot(projectDir);
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');

    // Pass canonicalRoot — the walker should NOT re-stat the root.
    const result = discoverSourceFilesStructured(projectDir, canonical);
    expect(result.realRoot).toBe(canonical);
    expect(result.files.length).toBe(1);
    expect(result.complete).toBe(true);
  });

  // ── Regression: R141 findings stay fixed ──────────────────────────────

  it('regression: nonexistent root → error, graph preserved (R141 DATA-R141-01)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    await indexProjectWasm({ project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0 });
    const dbPath = defaultCodeDbPath(projectName);
    let db = new Database(dbPath, { readonly: true });
    const nodesBefore = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesBefore).toBeGreaterThan(0);
    db.close();

    const bogusRoot = join(tmpDir, 'no-such-dir');
    const r = await indexProjectWasm({ project: projectName, rootPath: bogusRoot, incremental: false, useWasm: true, workers: 0 });
    expect(r.errors.length).toBeGreaterThan(0);

    db = new Database(dbPath, { readonly: true });
    const nodesAfter = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(projectName) as { c: number }).c;
    expect(nodesAfter).toBe(nodesBefore);
    db.close();
  });

  it('regression: file symlinks deduplicated (R141 IDX-R141-01)', () => {
    writeFileSync(join(projectDir, 'original.ts'), 'export function orig() { return 1; }\n');
    symlinkSync(join(projectDir, 'original.ts'), join(projectDir, 'alias.ts'));
    const files = discoverSourceFilesWasm(projectDir);
    expect(files.length).toBe(1);
    expect(files.some(f => f.endsWith('original.ts'))).toBe(true);
  });

  it('regression: deep SKIP_DIRS bypass closed (R141 PERF-R141-01)', () => {
    mkdirSync(join(projectDir, 'node_modules', 'pkg', 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'node_modules', 'pkg', 'src', 'dep.ts'), 'export function dep() { return 0; }\n');
    symlinkSync(join(projectDir, 'node_modules', 'pkg', 'src'), join(projectDir, 'source-alias'));
    writeFileSync(join(projectDir, 'real.ts'), 'export function r() { return 1; }\n');
    const files = discoverSourceFilesWasm(projectDir);
    const paths = files.map(f => f.replace(projectDir + '/', ''));
    expect(paths.some(p => p === 'real.ts')).toBe(true);
    expect(paths.some(p => p.includes('dep.ts'))).toBe(false);
    expect(paths.some(p => p.includes('source-alias'))).toBe(false);
  });

  it('regression: assertPathInsideRoot rejects 101+ descendant escape (R140 P0)', () => {
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

  it('regression: CURRENT_EXTRACTOR_SEMANTICS_VERSION is 8 (R144 MIG-R144-01)', () => {
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(8);
  });
});
