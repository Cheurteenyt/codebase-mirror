import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import type { HumanMemoryStore } from '../../src/human/store.js';
import { GetModuleContextTool } from '../../src/mcp/tools/get_module_context.js';

interface NodeSeed {
  id: number;
  label: string;
  name: string;
  qualifiedName: string;
  filePath: string;
}

interface EdgeSeed {
  source: number;
  target: number;
  type?: string;
}

function createHarness(
  nodes: NodeSeed[],
  edges: EdgeSeed[] = [],
  providedHumanStore?: HumanMemoryStore,
) {
  const tempDir = mkdtempSync(join(tmpdir(), 'cbm-module-context-'));
  const dbPath = join(tempDir, 'code.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      project TEXT, label TEXT, name TEXT, qualified_name TEXT,
      file_path TEXT, start_line INTEGER, end_line INTEGER, properties_json TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      project TEXT, source_id INTEGER, target_id INTEGER,
      type TEXT, properties_json TEXT
    );
    CREATE TABLE projects (name TEXT, root_path TEXT);
    INSERT INTO projects (name, root_path) VALUES ('test', 'C:\\Work\\Project');
  `);
  const insertNode = db.prepare(
    `INSERT INTO nodes
      (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
     VALUES (?, 'test', ?, ?, ?, ?, 1, 10, '{}')`
  );
  for (const node of nodes) {
    insertNode.run(node.id, node.label, node.name, node.qualifiedName, node.filePath);
  }
  const insertEdge = db.prepare(
    `INSERT INTO edges (project, source_id, target_id, type, properties_json)
     VALUES ('test', ?, ?, ?, '{}')`,
  );
  for (const edge of edges) insertEdge.run(edge.source, edge.target, edge.type ?? 'CALLS');
  db.close();

  const codeReader = new CodeGraphReader(dbPath);
  const humanStore = providedHumanStore ?? ({
    getBulkNotesByCbmNodeIds: () => new Map<number, never[]>(),
    getBulkNoteCountsByCbmNodeIds: () => new Map<number, number>(),
  } as unknown as HumanMemoryStore);
  const tool = new GetModuleContextTool({ project: 'test', humanStore, codeReader });

  return {
    tool,
    close: () => {
      codeReader.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function callTool(tool: GetModuleContextTool, moduleName: string) {
  return tool.handle({
    module_name: moduleName,
    include_code: false,
    include_human: false,
    include_adrs: false,
    include_bugs: false,
    include_refactors: false,
  });
}

describe('get_module_context V2 root resolution', () => {
  it('falls back from absent Module nodes to a File using portable path separators', async () => {
    const harness = createHarness([
      { id: 1, label: 'File', name: 'session.ts', qualifiedName: 'test::src/auth/session.ts', filePath: 'src/auth/session.ts' },
    ]);
    try {
      const response = await callTool(harness.tool, 'src\\auth\\session.ts');
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text).module).toMatchObject({
        cbm_node_id: 1,
        label: 'File',
        file_path: 'src/auth/session.ts',
      });
    } finally {
      harness.close();
    }
  });

  it('resolves an exact directory path as one bounded architecture context', async () => {
    const harness = createHarness([
      {
        id: 21,
        label: 'File',
        name: 'benchUtil.ts',
        qualifiedName: 'test::packages/bench/benchUtil.ts',
        filePath: 'packages\\bench\\benchUtil.ts',
      },
      {
        id: 22,
        label: 'Function',
        name: 'makeSchema',
        qualifiedName: 'test::packages/bench/benchUtil.ts::makeSchema',
        filePath: 'packages\\bench\\benchUtil.ts',
      },
      {
        id: 23,
        label: 'File',
        name: 'index.ts',
        qualifiedName: 'test::packages/zod/src/index.ts',
        filePath: 'packages\\zod\\src\\index.ts',
      },
    ], [
      { source: 21, target: 23, type: 'IMPORTS' },
    ]);
    try {
      const response = await callTool(harness.tool, 'packages/bench');
      expect(response.isError).not.toBe(true);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.module).toMatchObject({
        cbm_node_id: null,
        label: 'Directory',
        file_path: 'packages/bench',
      });
      expect(parsed.scope).toMatchObject({
        exact: true,
        kind: 'directory',
        total_nodes: 2,
        total_internal_edges: 0,
        boundary: {
          exact: true,
          total_relations: 1,
          dependencies: [{
            direction: 'outgoing',
            external_key: 'packages/zod',
            type: 'IMPORTS',
            count: 1,
          }],
        },
      });
    } finally {
      harness.close();
    }
  });

  it('falls back to a Class or Interface only when no Module or File matches', async () => {
    const harness = createHarness([
      { id: 2, label: 'Class', name: 'AuthService', qualifiedName: 'test::AuthService', filePath: 'src/auth.ts' },
      { id: 3, label: 'Interface', name: 'PaymentPort', qualifiedName: 'test::PaymentPort', filePath: 'src/payment.ts' },
    ]);
    try {
      const classResponse = await callTool(harness.tool, 'AuthService');
      const interfaceResponse = await callTool(harness.tool, 'PaymentPort');
      expect(JSON.parse(classResponse.content[0].text).module.label).toBe('Class');
      expect(JSON.parse(interfaceResponse.content[0].text).module.label).toBe('Interface');
    } finally {
      harness.close();
    }
  });

  it('preserves Module precedence when lower-priority roots also match', async () => {
    const harness = createHarness([
      { id: 4, label: 'Module', name: 'auth', qualifiedName: 'test.auth', filePath: 'src/auth.ts' },
      { id: 5, label: 'File', name: 'auth.ts', qualifiedName: 'test::src/auth.ts', filePath: 'src/auth.ts' },
    ]);
    try {
      const response = await callTool(harness.tool, 'auth');
      expect(JSON.parse(response.content[0].text).module).toMatchObject({ cbm_node_id: 4, label: 'Module' });
    } finally {
      harness.close();
    }
  });

  it('returns an actionable ambiguity error instead of silently picking a File', async () => {
    const harness = createHarness([
      { id: 6, label: 'File', name: 'auth.ts', qualifiedName: 'test::src/auth.ts', filePath: 'src/auth.ts' },
      { id: 7, label: 'File', name: 'auth.test.ts', qualifiedName: 'test::tests/auth.test.ts', filePath: 'tests/auth.test.ts' },
    ]);
    try {
      const response = await callTool(harness.tool, 'auth');
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Ambiguous File match');
      expect(response.content[0].text).toContain('src/auth.ts');
      expect(response.content[0].text).toContain('tests/auth.test.ts');
      expect(response.content[0].text).toContain('Use a more specific module_name');
    } finally {
      harness.close();
    }
  });

  it('also refuses ambiguous Module matches before considering fallbacks', async () => {
    const harness = createHarness([
      { id: 8, label: 'Module', name: 'auth-api', qualifiedName: 'test.auth-api', filePath: 'src/auth-api.ts' },
      { id: 9, label: 'Module', name: 'auth-core', qualifiedName: 'test.auth-core', filePath: 'src/auth-core.ts' },
      { id: 10, label: 'File', name: 'auth.ts', qualifiedName: 'test::src/auth.ts', filePath: 'src/auth.ts' },
    ]);
    try {
      const response = await callTool(harness.tool, 'auth');
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Ambiguous Module match');
      expect(response.content[0].text).not.toContain('cbm_node_id');
    } finally {
      harness.close();
    }
  });

  it('prefers an exact Module name over substring matches', async () => {
    const harness = createHarness([
      { id: 14, label: 'Module', name: 'auth', qualifiedName: 'test.auth', filePath: 'src/auth.ts' },
      { id: 15, label: 'Module', name: 'auth-core', qualifiedName: 'test.auth-core', filePath: 'src/auth-core.ts' },
    ]);
    try {
      const response = await callTool(harness.tool, 'auth');
      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text).module).toMatchObject({
        cbm_node_id: 14,
        name: 'auth',
      });
    } finally {
      harness.close();
    }
  });

  it('reports an exact uncapped neighbor total and an honest returned count', async () => {
    const harness = createHarness([
      { id: 11, label: 'File', name: 'entry.ts', qualifiedName: 'test::src/entry.ts', filePath: 'src/entry.ts' },
      { id: 12, label: 'Function', name: 'first', qualifiedName: 'test.first', filePath: 'src/first.ts' },
      { id: 13, label: 'Function', name: 'second', qualifiedName: 'test.second', filePath: 'src/second.ts' },
    ], [
      { source: 11, target: 12 },
      { source: 11, target: 13 },
    ]);
    try {
      const response = await harness.tool.handle({
        module_name: 'entry.ts',
        include_human: false,
        include_adrs: false,
        include_bugs: false,
        include_refactors: false,
        max_nodes: 1,
      });
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.code_nodes).toHaveLength(1);
      expect(parsed.code_stats).toEqual({
        neighbors_count: 2,
        neighbors_returned: 1,
        truncated: true,
      });
    } finally {
      harness.close();
    }
  });

  it('reports exact linked-note totals when response bodies are capped', async () => {
    const notes = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      label: 'Convention',
      title: `Note ${index + 1}`,
      status: 'active',
      tags: [],
      updated_at: '2026-07-15T00:00:00.000Z',
      obsidian_path: null,
      body_markdown: 'body',
    }));
    const humanStore = {
      getBulkNotesByCbmNodeIds: () => new Map([[20, notes]]),
      getBulkNoteCountsByCbmNodeIds: () => new Map([[20, 250]]),
    } as unknown as HumanMemoryStore;
    const harness = createHarness([
      { id: 20, label: 'File', name: 'notes.ts', qualifiedName: 'test::notes.ts', filePath: 'notes.ts' },
    ], [], humanStore);
    try {
      const response = await harness.tool.handle({ module_name: 'notes.ts' });
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.human_notes).toHaveLength(200);
      expect(parsed.stats).toMatchObject({
        linked_notes_count: 250,
        linked_notes_returned: 200,
        linked_notes_truncated: true,
      });
    } finally {
      harness.close();
    }
  });
});
