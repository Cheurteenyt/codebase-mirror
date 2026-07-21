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
    endLine?: number;
  }): void;
  addCallSite(callSite: {
    path: string;
    sourceQualifiedName: string;
    callee: string;
    line: number;
  }): void;
  initializeGit(): void;
  setCallSiteStatus(status: { stale: number | null; initialized: number | null }): void;
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
        node.endLine ?? node.startLine ?? 1,
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
    setCallSiteStatus(status) {
      db.prepare(`
        UPDATE projects
        SET cross_file_calls_stale = ?, call_sites_initialized = ?
        WHERE name = 'test'
      `).run(status.stale, status.initialized);
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

  it('traces identity-aware transitive callers without changing the direct-caller default', async () => {
    const harness = createHarness({
      'src/target.ts': 'export function target() {}\n',
      'src/callers.ts': [
        "import { target } from './target.js';",
        'export function direct() { target(); }',
        'export function middle() { direct(); }',
        'export function top() { middle(); }',
        'export const namedArrow = () => target();',
        'export function fromArrow() { namedArrow(); }',
        '',
      ].join('\n'),
      'src/unrelated.ts': [
        'export function target() {}',
        'export function unrelated() { target(); }',
        '',
      ].join('\n'),
      'src/mcp/test/production.ts': [
        "import { target } from '../../target.js';",
        'export function productionCaller() { target(); }',
        '',
      ].join('\n'),
      'tests/target.test.ts': [
        "import { target } from '../src/target.js';",
        'export function excludedTestCaller() { target(); }',
        '',
      ].join('\n'),
    });
    harness.addCodeNode({
      label: 'Function',
      name: 'target',
      qualifiedName: 'test::src/target.ts::target',
      path: 'src/target.ts',
      startLine: 1,
    });

    try {
      const directResponse = await harness.tool.handle({
        operation: 'direct_callers',
        symbol: 'target',
      });
      expect(JSON.parse(directResponse.content[0].text)).not.toHaveProperty('transitive_callers');

      const response = await harness.tool.handle({
        operation: 'direct_callers',
        symbol: 'target',
        max_depth: 3,
      });
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.max_depth).toBe(3);
      expect(payload.transitive_callers).toEqual([
        { depth: 1, name: 'direct', path: 'src/callers.ts', definition_line: 2 },
        { depth: 1, name: 'namedArrow', path: 'src/callers.ts', definition_line: 5 },
        { depth: 1, name: 'productionCaller', path: 'src/mcp/test/production.ts', definition_line: 2 },
        { depth: 2, name: 'middle', path: 'src/callers.ts', definition_line: 3 },
        { depth: 2, name: 'fromArrow', path: 'src/callers.ts', definition_line: 6 },
        { depth: 3, name: 'top', path: 'src/callers.ts', definition_line: 4 },
      ]);
      expect(payload.formatted_callers).toEqual([
        '1|direct@src/callers.ts:2',
        '1|namedArrow@src/callers.ts:5',
        '1|productionCaller@src/mcp/test/production.ts:2',
        '2|middle@src/callers.ts:3',
        '2|fromArrow@src/callers.ts:6',
        '3|top@src/callers.ts:4',
      ]);
      expect(payload.transitive_callers_truncated).toBe(false);
      expect(payload.complete).toBe(true);
      expect(payload.incomplete_reasons).toEqual([]);
      expect(payload.formatted_callers).not.toContain('1|unrelated@src/unrelated.ts:2');
      expect(payload.formatted_callers).not.toContain('1|excludedTestCaller@tests/target.test.ts:2');

      const boundedResponse = await harness.tool.handle({
        operation: 'direct_callers',
        symbol: 'target',
        max_depth: 3,
        max_callers: 2,
      });
      const boundedPayload = JSON.parse(boundedResponse.content[0].text);
      expect(boundedPayload.formatted_callers).toEqual([
        '1|direct@src/callers.ts:2',
        '1|namedArrow@src/callers.ts:5',
      ]);
      expect(boundedPayload.transitive_callers_truncated).toBe(true);
      expect(boundedPayload.complete).toBe(false);
      expect(boundedPayload.incomplete_reasons).toContain('transitive_callers_truncated');
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

  it('traces an HTTP entry through exact source fallback and persistent call sites', async () => {
    const harness = createHarness({
      'src/server.ts': "routes.set('GET /work', () => start());\n",
      'src/flow.ts': [
        'export function start() {',
        '  middle(',
        '  );',
        '}',
        'export function middle() {',
        '  finish();',
        '}',
        'export function finish() {}',
        '',
      ].join('\n'),
    });
    for (const node of [
      { name: 'start', startLine: 1, endLine: 4 },
      { name: 'middle', startLine: 5, endLine: 7 },
      { name: 'finish', startLine: 8, endLine: 8 },
    ]) {
      harness.addCodeNode({
        label: 'Function',
        name: node.name,
        qualifiedName: `test::src/flow.ts::${node.name}`,
        path: 'src/flow.ts',
        startLine: node.startLine,
        endLine: node.endLine,
      });
    }
    // The multiline start -> middle call intentionally has no persistent row;
    // call_chain must recover it from the bounded definition text.
    harness.addCallSite({
      path: 'src/flow.ts',
      sourceQualifiedName: 'test::src/flow.ts::middle',
      callee: 'finish',
      line: 6,
    });

    try {
      const response = await harness.tool.handle({
        operation: 'call_chain',
        entry: 'GET /work',
        target_symbol: 'finish',
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        project: 'test',
        operation: 'call_chain',
        entry: {
          label: 'GET /work',
          path: 'src/server.ts',
          line: 1,
        },
        chain: [
          { name: 'start', path: 'src/flow.ts', definition_line: 1 },
          { name: 'middle', path: 'src/flow.ts', definition_line: 5 },
          { name: 'finish', path: 'src/flow.ts', definition_line: 8 },
        ],
        formatted_chain: 'GET /work@src/server.ts:1 -> start@src/flow.ts:1 -> middle@src/flow.ts:5 -> finish@src/flow.ts:8',
        shortest_chains_found: 1,
        alternative_chains_truncated: false,
        complete: true,
        incomplete_reasons: [],
      });
    } finally {
      harness.close();
    }
  });

  it('labels a CLI registration and omits its enclosing registration helper', async () => {
    const harness = createHarness({
      'src/program.ts': [
        'function addCommand() {',
        "  const command = program.command('test [filter...]');",
        '  command.action(() => runTests());',
        '}',
        'function runTests() {',
        '  return finish();',
        '}',
        'function finish() {}',
        '',
      ].join('\n'),
    });
    for (const node of [
      { name: 'addCommand', startLine: 1, endLine: 4 },
      { name: 'runTests', startLine: 5, endLine: 7 },
      { name: 'finish', startLine: 8, endLine: 8 },
    ]) {
      harness.addCodeNode({
        label: 'Function',
        name: node.name,
        qualifiedName: `test::src/program.ts::${node.name}`,
        path: 'src/program.ts',
        startLine: node.startLine,
        endLine: node.endLine,
      });
    }
    harness.addCallSite({
      path: 'src/program.ts',
      sourceQualifiedName: 'test::src/program.ts::addCommand::anonymous#1',
      callee: 'runTests',
      line: 3,
    });
    harness.addCallSite({
      path: 'src/program.ts',
      sourceQualifiedName: 'test::src/program.ts::runTests',
      callee: 'finish',
      line: 6,
    });

    try {
      const response = await harness.tool.handle({
        operation: 'call_chain',
        entry: 'test',
        target_symbol: 'finish',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.entry).toMatchObject({ label: 'test command', line: 2 });
      expect(payload.chain).toEqual([
        { name: 'runTests', path: 'src/program.ts', definition_line: 5 },
        { name: 'finish', path: 'src/program.ts', definition_line: 8 },
      ]);
      expect(payload.formatted_chain).toBe(
        'test command@src/program.ts:2 -> runTests@src/program.ts:5 -> finish@src/program.ts:8',
      );
      expect(payload.complete).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('resolves a unique reachable terminal from a semantic target hint', async () => {
    const harness = createHarness({
      'src/flow.ts': [
        "routes.set('GET /tasks', () => start());",
        'function start() { runTasks(); createRunTestsTasks(); }',
        'function runTasks() {}',
        'function createRunTestsTasks() {}',
        '',
      ].join('\n'),
    });
    for (const node of [
      { name: 'start', line: 2 },
      { name: 'runTasks', line: 3 },
      { name: 'createRunTestsTasks', line: 4 },
    ]) {
      harness.addCodeNode({
        label: 'Function',
        name: node.name,
        qualifiedName: `test::src/flow.ts::${node.name}`,
        path: 'src/flow.ts',
        startLine: node.line,
        endLine: node.line,
      });
    }
    for (const callee of ['runTasks', 'createRunTestsTasks']) {
      harness.addCallSite({
        path: 'src/flow.ts',
        sourceQualifiedName: 'test::src/flow.ts::start',
        callee,
        line: 2,
      });
    }

    try {
      const response = await harness.tool.handle({
        operation: 'call_chain',
        entry: 'GET /tasks',
        target_hint: 'shared task executor',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.target_symbol).toBe('runTasks');
      expect(payload.target_resolution).toMatchObject({
        mode: 'semantic_hint',
        hint: 'shared task executor',
        selected_symbol: 'runTasks',
      });
      expect(payload.formatted_chain).toBe(
        'GET /tasks@src/flow.ts:1 -> start@src/flow.ts:2 -> runTasks@src/flow.ts:3',
      );
      expect(payload.complete).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('fails chain completeness closed for stale metadata, hop bounds, and duplicate targets', async () => {
    const harness = createHarness({
      'src/server.ts': "routes.set('GET /work', () => start());\n",
      'src/flow.ts': [
        'function start() { middle(); }',
        'function middle() { finish(); }',
        'function finish() {}',
        '',
      ].join('\n'),
      'src/other.ts': 'function finish() {}\n',
    });
    for (const node of [
      { name: 'start', path: 'src/flow.ts', line: 1 },
      { name: 'middle', path: 'src/flow.ts', line: 2 },
      { name: 'finish', path: 'src/flow.ts', line: 3 },
      { name: 'finish', path: 'src/other.ts', line: 1 },
    ]) {
      harness.addCodeNode({
        label: 'Function',
        name: node.name,
        qualifiedName: `test::${node.path}::${node.name}`,
        path: node.path,
        startLine: node.line,
        endLine: node.line,
      });
    }
    harness.setCallSiteStatus({ stale: 1, initialized: 1 });

    try {
      const response = await harness.tool.handle({
        operation: 'call_chain',
        entry: 'GET /work',
        target_symbol: 'finish',
        max_hops: 1,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.chain).toEqual([]);
      expect(payload.complete).toBe(false);
      expect(payload.incomplete_reasons).toEqual(expect.arrayContaining([
        'chain_not_found',
        'cross_file_call_status_unknown_or_stale',
        'target_ambiguous',
      ]));
    } finally {
      harness.close();
    }
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
      expect((await harness.tool.handle({ operation: 'call_chain', entry: 'start' })).isError).toBe(true);
      expect((await harness.tool.handle({ operation: 'unknown' })).isError).toBe(true);
    } finally {
      harness.close();
    }
  });
});
