import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import type { HumanMemoryStore } from '../../src/human/store.js';
import {
  LookupSourceTextTool,
  topLevelDirectoriesFromTrackedPaths,
} from '../../src/mcp/tools/lookup_source_text.js';

const tempDirs: string[] = [];

interface Harness {
  root: string;
  tool: LookupSourceTextTool;
  addIndexedPath(path: string): void;
  addCodeNode(node: {
    label: string;
    name: string;
    qualifiedName: string;
    path: string;
    startLine?: number;
  }): void;
  addCallSite(callSite: {
    path: string;
    sourceQualifiedName: string;
    callee: string;
    line: number;
  }): void;
  initializeGit(): void;
  close(): void;
}

function createHarness(files: Record<string, string>): Harness {
  const tempDir = mkdtempSync(join(tmpdir(), 'cbm-exact-source-'));
  tempDirs.push(tempDir);
  const root = join(tempDir, 'repo');
  const dbPath = join(tempDir, 'code.db');
  mkdirSync(root, { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      project TEXT,
      label TEXT,
      name TEXT,
      qualified_name TEXT,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      properties_json TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      project TEXT,
      source_id INTEGER,
      target_id INTEGER,
      type TEXT,
      properties_json TEXT
    );
    CREATE TABLE projects (
      name TEXT,
      root_path TEXT,
      cross_file_calls_stale INTEGER DEFAULT 0,
      call_sites_initialized INTEGER DEFAULT 1
    );
    CREATE TABLE call_sites (
      id INTEGER PRIMARY KEY,
      project TEXT,
      file_path TEXT,
      source_qn TEXT,
      callee TEXT,
      last_segment TEXT,
      call_kind TEXT,
      line INTEGER
    );
  `);
  db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('test', root);
  const insertNode = db.prepare(`
    INSERT INTO nodes
      (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
    VALUES ('test', 'File', ?, ?, ?, 1, 1, '{}')
  `);

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = join(root, ...filePath.split('/'));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
    insertNode.run(filePath, `test::${filePath}`, filePath);
  }

  const codeReader = new CodeGraphReader(dbPath);
  const tool = new LookupSourceTextTool({
    project: 'test',
    humanStore: null as unknown as HumanMemoryStore,
    codeReader,
  });

  return {
    root,
    tool,
    addIndexedPath(filePath: string) {
      insertNode.run(filePath, `test::${filePath}`, filePath);
    },
    addCodeNode(node) {
      db.prepare(`
        INSERT INTO nodes
          (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
        VALUES ('test', ?, ?, ?, ?, ?, ?, '{}')
      `).run(
        node.label,
        node.name,
        node.qualifiedName,
        node.path,
        node.startLine ?? 1,
        node.startLine ?? 1,
      );
    },
    addCallSite(callSite) {
      db.prepare(`
        INSERT INTO call_sites
          (project, file_path, source_qn, callee, last_segment, call_kind, line)
        VALUES ('test', ?, ?, ?, ?, 'identifier_call', ?)
      `).run(
        callSite.path,
        callSite.sourceQualifiedName,
        callSite.callee,
        callSite.callee.split('.').at(-1),
        callSite.line,
      );
    },
    initializeGit() {
      execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
      execFileSync('git', ['add', '--all'], { cwd: root, windowsHide: true });
    },
    close() {
      codeReader.close();
      db.close();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('lookup_source_text', () => {
  it('finds batched exact literals with deterministic 1-based locations and source text', async () => {
    const harness = createHarness({
      'src/b.ts': 'export const second = "exact cross-domain relations";\n',
      'src/a.ts': [
        'const DEPENDENCY_ATLAS_MAX_DOMAINS = 12;',
        'const label = "Dependency atlas:";',
        '// Dependency atlas:',
      ].join('\r\n'),
    });
    try {
      const response = await harness.tool.handle({
        queries: [
          'DEPENDENCY_ATLAS_MAX_DOMAINS',
          'Dependency atlas:',
          'exact cross-domain relations',
        ],
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        project: 'test',
        results: [
          {
            query: 'DEPENDENCY_ATLAS_MAX_DOMAINS',
            matches: [{
              path: 'src/a.ts',
              line: 1,
              column: 7,
              text: 'const DEPENDENCY_ATLAS_MAX_DOMAINS = 12;',
            }],
            matches_truncated: false,
          },
          {
            query: 'Dependency atlas:',
            matches: [
              { path: 'src/a.ts', line: 2, column: 16, text: 'const label = "Dependency atlas:";' },
              { path: 'src/a.ts', line: 3, column: 4, text: '// Dependency atlas:' },
            ],
            matches_truncated: false,
          },
          {
            query: 'exact cross-domain relations',
            matches: [{
              path: 'src/b.ts',
              line: 1,
              column: 24,
              text: 'export const second = "exact cross-domain relations";',
            }],
            matches_truncated: false,
          },
        ],
        files_scanned: 2,
        bytes_scanned: 152,
        scan_complete: true,
      });
    } finally {
      harness.close();
    }
  });

  it('caps each query independently and reports truncation', async () => {
    const harness = createHarness({
      'src/repeated.ts': 'needle first\nneedle second\nother value\n',
    });
    try {
      const response = await harness.tool.handle({
        queries: ['needle', 'other'],
        max_results_per_query: 1,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.results[0]).toEqual({
        query: 'needle',
        matches: [{ path: 'src/repeated.ts', line: 1, column: 1, text: 'needle first' }],
        matches_truncated: true,
      });
      expect(payload.results[1]).toEqual({
        query: 'other',
        matches: [{ path: 'src/repeated.ts', line: 3, column: 1, text: 'other value' }],
        matches_truncated: false,
      });
    } finally {
      harness.close();
    }
  });

  it('never reads indexed traversal or symlink escapes', async () => {
    const harness = createHarness({ 'src/safe.ts': 'export const safe = true;\n' });
    const outsideDir = join(dirname(harness.root), 'outside');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'secret.ts'), 'DO_NOT_EXPOSE\n', 'utf8');
    symlinkSync(outsideDir, join(harness.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    harness.addIndexedPath('../outside/secret.ts');
    harness.addIndexedPath('escape/secret.ts');

    try {
      const response = await harness.tool.handle({ queries: ['DO_NOT_EXPOSE'] });
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.results[0].matches).toEqual([]);
      expect(payload.scan_complete).toBe(false);
      expect(payload.scan_incomplete_reasons).toEqual({ unsafe_paths: 2 });
      expect(response.content[0].text).not.toContain('DO_NOT_EXPOSE\\n');
    } finally {
      harness.close();
    }
  });

  it('aggregates deterministic direct caller counts and rolls anonymous callbacks into their owner', async () => {
    const harness = createHarness({});
    harness.addCodeNode({
      label: 'Function',
      name: 'target',
      qualifiedName: 'test::src/target.ts::target',
      path: 'src/target.ts',
      startLine: 4,
    });
    harness.addCodeNode({
      label: 'Function',
      name: 'outer',
      qualifiedName: 'test::src/a.ts::outer',
      path: 'src/a.ts',
      startLine: 10,
    });
    harness.addCodeNode({
      label: 'Function',
      name: 'anonymous#1',
      qualifiedName: 'test::src/a.ts::outer::anonymous#1',
      path: 'src/a.ts',
      startLine: 12,
    });
    harness.addCodeNode({
      label: 'Function',
      name: 'second',
      qualifiedName: 'test::src/b.ts::second',
      path: 'src/b.ts',
      startLine: 20,
    });
    harness.addCodeNode({
      label: 'Function',
      name: 'testCaller',
      qualifiedName: 'test::tests/caller.test.ts::testCaller',
      path: 'tests/caller.test.ts',
      startLine: 1,
    });
    for (const callSite of [
      { path: 'src/a.ts', sourceQualifiedName: 'test::src/a.ts::outer', callee: 'target', line: 11 },
      { path: 'src/a.ts', sourceQualifiedName: 'test::src/a.ts::outer::anonymous#1', callee: 'target', line: 13 },
      { path: 'src/b.ts', sourceQualifiedName: 'test::src/b.ts::second', callee: 'target', line: 22 },
      { path: 'tests/caller.test.ts', sourceQualifiedName: 'test::tests/caller.test.ts::testCaller', callee: 'target', line: 2 },
    ]) harness.addCallSite(callSite);

    try {
      const response = await harness.tool.handle({ operation: 'direct_callers', symbol: 'target' });
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        project: 'test',
        operation: 'direct_callers',
        symbol: 'target',
        target_candidates: [{
          qualified_name: 'test::src/target.ts::target',
          path: 'src/target.ts',
          definition_line: 4,
        }],
        callers: [
          {
            name: 'outer',
            qualified_name: 'test::src/a.ts::outer',
            path: 'src/a.ts',
            definition_line: 10,
            call_sites: 2,
          },
          {
            name: 'second',
            qualified_name: 'test::src/b.ts::second',
            path: 'src/b.ts',
            definition_line: 20,
            call_sites: 1,
          },
        ],
        callers_by_name: { outer: 2, second: 1 },
        total_call_sites: 3,
        callers_truncated: false,
        complete: true,
        incomplete_reasons: [],
      });
    } finally {
      harness.close();
    }
  });

  it('bounds caller output and reports ambiguous duplicate target symbols', async () => {
    const harness = createHarness({});
    for (const path of ['src/a.ts', 'src/b.ts']) {
      harness.addCodeNode({
        label: 'Function',
        name: 'duplicate',
        qualifiedName: `test::${path}::duplicate`,
        path,
      });
      harness.addCodeNode({
        label: 'Function',
        name: `caller_${path[4]}`,
        qualifiedName: `test::${path}::caller_${path[4]}`,
        path,
      });
      harness.addCallSite({
        path,
        sourceQualifiedName: `test::${path}::caller_${path[4]}`,
        callee: 'duplicate',
        line: 3,
      });
    }
    try {
      const response = await harness.tool.handle({
        operation: 'direct_callers',
        symbol: 'duplicate',
        max_callers: 1,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.total_call_sites).toBe(2);
      expect(payload.callers).toHaveLength(1);
      expect(payload.callers_truncated).toBe(true);
      expect(payload.complete).toBe(false);
      expect(payload.incomplete_reasons).toEqual(['callers_truncated', 'target_ambiguous']);
    } finally {
      harness.close();
    }
  });

  it('returns exact Git-tracked top-level directories while excluding root files and untracked paths', async () => {
    const harness = createHarness({
      '.github/workflows/ci.yml': 'name: ci\n',
      '.claude/instructions.md': 'rules\n',
      'src/a.ts': 'export const a = 1;\n',
      'README.md': '# test\n',
    });
    harness.initializeGit();
    mkdirSync(join(harness.root, 'untracked'));
    writeFileSync(join(harness.root, 'untracked', 'ignored.ts'), 'ignored\n', 'utf8');
    try {
      const response = await harness.tool.handle({
        operation: 'top_level_directories',
        inventory_scope: 'tracked',
      });
      expect(JSON.parse(response.content[0].text)).toEqual({
        project: 'test',
        operation: 'top_level_directories',
        inventory_scope: 'tracked',
        directories: ['.claude', '.github', 'src'],
        tracked_files: 4,
        complete: true,
      });
    } finally {
      harness.close();
    }
  });

  it('normalizes Windows and POSIX tracked paths deterministically', () => {
    expect(topLevelDirectoriesFromTrackedPaths([
      'src\\windows.ts',
      './.github/workflows/ci.yml',
      'README.md',
      'src/posix.ts',
      '.git/config',
    ])).toEqual(['.github', 'src']);
  });

  it('rejects empty, multiline, duplicate, or oversized query batches', async () => {
    const harness = createHarness({ 'src/a.ts': 'value\n' });
    try {
      for (const queries of [
        [],
        ['   '],
        ['first\nsecond'],
        ['same', 'same'],
        Array.from({ length: 11 }, (_, index) => `q${index}`),
      ]) {
        const response = await harness.tool.handle({ queries });
        expect(response.isError).toBe(true);
      }
      expect((await harness.tool.handle({ operation: 'direct_callers' })).isError).toBe(true);
      expect((await harness.tool.handle({ operation: 'unknown' })).isError).toBe(true);
    } finally {
      harness.close();
    }
  });
});
