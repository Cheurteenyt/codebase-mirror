import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import type { HumanMemoryStore } from '../../src/human/store.js';
import { PrepareEditContextTool } from '../../src/mcp/tools/prepare_edit_context.js';

describe('prepare_edit_context relationship precision', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  it('uses IMPORTS for File blast radius and degree', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cbm-prepare-context-'));
    const dbPath = join(tempDir, 'code.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
        qualified_name TEXT, file_path TEXT, start_line INTEGER,
        end_line INTEGER, properties_json TEXT
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER,
        target_id INTEGER, type TEXT, properties_json TEXT
      );
      CREATE TABLE projects (name TEXT, root_path TEXT);
      INSERT INTO projects VALUES ('test', '');
      INSERT INTO nodes VALUES
        (1, 'test', 'File', 'a.ts', 'test::a.ts', 'a.ts', 1, 1, '{}'),
        (2, 'test', 'File', 'b.ts', 'test::b.ts', 'b.ts', 1, 1, '{}');
      INSERT INTO edges VALUES (1, 'test', 1, 2, 'IMPORTS', '{}');
    `);
    db.close();

    const codeReader = new CodeGraphReader(dbPath);
    const humanStore = {
      getBulkNotesByCbmNodeIds: () => new Map<number, never[]>(),
      getBulkNoteCountsByCbmNodeIds: () => new Map<number, number>(),
      getBulkActiveNoteLabelCountsByCbmNodeIds: () => new Map<number, Record<string, number>>(),
    } as unknown as HumanMemoryStore;
    cleanup.push(() => {
      codeReader.close();
      rmSync(tempDir, { recursive: true, force: true });
    });
    const tool = new PrepareEditContextTool({ project: 'test', humanStore, codeReader });

    const response = await tool.handle({ file_path: 'b.ts' });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.nodes[0].dependencies).toMatchObject({
      relationship_type: 'IMPORTS',
      callers_count: 1,
      callees_count: 0,
      actual_degree: 1,
    });
    expect(payload.nodes[0].dependencies.called_by[0]).toMatchObject({
      type: 'IMPORTS',
      source_id: 1,
    });
    expect(payload.blast_radius.total_dependent_nodes).toBe(1);
  });

  it('keeps blast-radius totals exact when displayed neighbors are capped', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cbm-prepare-blast-'));
    const dbPath = join(tempDir, 'code.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
        qualified_name TEXT, file_path TEXT, start_line INTEGER,
        end_line INTEGER, properties_json TEXT
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER,
        target_id INTEGER, type TEXT, properties_json TEXT
      );
      CREATE TABLE projects (name TEXT, root_path TEXT);
      INSERT INTO projects VALUES ('test', '');
      INSERT INTO nodes VALUES (1, 'test', 'File', 'target.ts', 'target.ts', 'target.ts', 1, 1, '{}');
    `);
    const insertNode = db.prepare(
      `INSERT INTO nodes VALUES (?, 'test', 'File', ?, ?, ?, 1, 1, '{}')`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges VALUES (?, 'test', ?, 1, 'IMPORTS', '{}')`,
    );
    for (let index = 0; index < 60; index += 1) {
      const id = index + 2;
      insertNode.run(id, `caller-${index}.ts`, `caller-${index}.ts`, `caller-${index}.ts`);
      insertEdge.run(index + 1, id);
    }
    db.close();

    const codeReader = new CodeGraphReader(dbPath);
    const humanStore = {
      getBulkNotesByCbmNodeIds: () => new Map<number, never[]>(),
      getBulkNoteCountsByCbmNodeIds: () => new Map<number, number>(),
      getBulkActiveNoteLabelCountsByCbmNodeIds: () => new Map<number, Record<string, number>>(),
    } as unknown as HumanMemoryStore;
    cleanup.push(() => {
      codeReader.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    const payload = JSON.parse((await new PrepareEditContextTool({
      project: 'test', humanStore, codeReader,
    }).handle({ file_path: 'target.ts' })).content[0].text);
    expect(payload.nodes[0].dependencies.callers_count).toBe(60);
    expect(payload.nodes[0].dependencies.called_by).toHaveLength(20);
    expect(payload.nodes[0].dependencies).toMatchObject({
      callers_returned: 20,
      callers_truncated: true,
    });
    expect(payload.blast_radius.total_dependent_nodes).toBe(60);
  });

  it('marks linked-note body lists as truncated while risk uses exact aggregate counts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cbm-prepare-notes-'));
    const dbPath = join(tempDir, 'code.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
        qualified_name TEXT, file_path TEXT, start_line INTEGER,
        end_line INTEGER, properties_json TEXT
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER,
        target_id INTEGER, type TEXT, properties_json TEXT
      );
      CREATE TABLE projects (name TEXT, root_path TEXT);
      INSERT INTO projects VALUES ('test', '');
      INSERT INTO nodes VALUES (1, 'test', 'Function', 'target', 'target', 'target.ts', 1, 1, '{}');
    `);
    db.close();
    const notes = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      label: 'BugNote',
      title: `Bug ${index + 1}`,
      status: 'active',
      body_markdown: 'body',
    }));
    const humanStore = {
      getBulkNotesByCbmNodeIds: () => new Map([[1, notes]]),
      getBulkNoteCountsByCbmNodeIds: () => new Map([[1, 250]]),
      getBulkActiveNoteLabelCountsByCbmNodeIds: () => new Map([[1, { BugNote: 250 }]]),
    } as unknown as HumanMemoryStore;
    const codeReader = new CodeGraphReader(dbPath);
    cleanup.push(() => {
      codeReader.close();
      rmSync(tempDir, { recursive: true, force: true });
    });

    const payload = JSON.parse((await new PrepareEditContextTool({
      project: 'test', humanStore, codeReader,
    }).handle({ file_path: 'target.ts' })).content[0].text);
    expect(payload.nodes[0].human_notes).toMatchObject({
      total_notes: 250,
      notes_returned: 200,
      truncated: true,
    });
    expect(payload.human_memory_summary.returned_counts_are_lower_bounds).toBe(true);
    expect(payload.recommendation).toContain('response cap');
  });
});
