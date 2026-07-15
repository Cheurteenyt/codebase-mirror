// v2/tests/bridge/sqlite-ro.test.ts
// Regression test for the CRITICAL getNeighbors column-collision bug.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CodeGraphReader — getNeighbors column collision regression', () => {
  let tmpDir: string;
  let dbPath: string;
  let reader: CodeGraphReader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-neighbors-'));
    dbPath = join(tmpDir, 'test-code.db');
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
    `);
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
      .run('test', 'C:\\Work\\Project');

    const insertNode = db.prepare(
      'INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertNode.run(10, 'test', 'Function', 'login', 'test.login', 'src/auth.ts', 1, 50, '{"complexity": 5}');
    insertNode.run(20, 'test', 'Function', 'validateToken', 'test.validateToken', 'src/auth.ts', 51, 80, '{"complexity": 3}');
    insertNode.run(30, 'test', 'Function', 'handleRequest', 'test.handleRequest', 'src/server.ts', 1, 100, '{"complexity": 8}');
    insertNode.run(40, 'test', 'File', 'auth.ts', 'test::src/auth/auth.ts', 'src/auth/auth.ts', 1, 100, '{}');
    insertNode.run(50, 'test', 'File', 'invoice.ts', 'test::src\\billing\\invoice.ts', 'src\\billing\\invoice.ts', 1, 100, '{}');

    const insertEdge = db.prepare(
      'INSERT INTO edges (id, project, source_id, target_id, type, properties_json) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertEdge.run(1, 'test', 10, 20, 'CALLS', '{"arg_count": 2}');
    insertEdge.run(2, 'test', 30, 10, 'CALLS', '{"arg_count": 0}');

    db.close();
    reader = new CodeGraphReader(dbPath);
  });

  afterEach(() => {
    reader.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns correct edge.id (not corrupted to node.id)', () => {
    const neighbors = reader.getNeighbors(10, 'both', 100);
    expect(neighbors.length).toBe(2);

    const outNeighbor = neighbors.find((n) => n.edge.source_id === 10);
    expect(outNeighbor).toBeDefined();
    expect(outNeighbor!.edge.id).toBe(1);
    expect(outNeighbor!.node.id).toBe(20);
    expect(outNeighbor!.edge.type).toBe('CALLS');
    expect(outNeighbor!.edge.properties_json).toBe('{"arg_count": 2}');

    const inNeighbor = neighbors.find((n) => n.edge.target_id === 10);
    expect(inNeighbor).toBeDefined();
    expect(inNeighbor!.edge.id).toBe(2);
    expect(inNeighbor!.node.id).toBe(30);
    expect(inNeighbor!.edge.type).toBe('CALLS');
    expect(inNeighbor!.edge.properties_json).toBe('{"arg_count": 0}');
  });

  it('returns empty array for a node with no neighbors', () => {
    const neighbors = reader.getNeighbors(999, 'both', 100);
    expect(neighbors).toEqual([]);
  });

  it('respects the limit parameter (per direction)', () => {
    // getNeighbors applies limit separately to out and in directions.
    // With limit=1 and direction='both', we get at most 1 out + 1 in = 2.
    const neighbors = reader.getNeighbors(10, 'both', 1);
    expect(neighbors.length).toBe(2); // 1 out + 1 in

    // With direction='out', only out-edges are fetched.
    const outOnly = reader.getNeighbors(10, 'out', 1);
    expect(outOnly.length).toBe(1);
  });

  it('returns correct getNodeDegree', () => {
    expect(reader.getNodeDegree(10)).toBe(2);
    expect(reader.getNodeDegree(20)).toBe(1);
    expect(reader.getNodeDegree(30)).toBe(1);
    expect(reader.getNodeDegree(999)).toBe(0);
  });

  it('returns the indexed project root for project-aware freshness checks', () => {
    expect(reader.getProjectRoot('test')).toBe('C:\\Work\\Project');
    expect(reader.getProjectRoot('missing')).toBeUndefined();
  });

  it('bulk-fetches every internal edge without a redundant target-side scan', () => {
    expect(reader.getBulkEdges([10, 20, 30], 20)).toEqual([
      { source: 10, target: 20, type: 'CALLS' },
      { source: 30, target: 10, type: 'CALLS' },
    ]);
    expect(reader.getBulkEdges([10, 20], 20)).toEqual([
      { source: 10, target: 20, type: 'CALLS' },
    ]);
  });

  it('can count callers/callees without structural edges inflating them', () => {
    reader.close();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
       VALUES (3, 'test', 40, 10, 'CONTAINS', '{}')`,
    ).run();
    db.close();
    reader = new CodeGraphReader(dbPath);

    expect(reader.getBulkNodeDegreesSplit([10]).get(10)).toEqual({ in: 2, out: 1 });
    expect(reader.getBulkNodeDegreesSplit([10], 'CALLS').get(10)).toEqual({ in: 1, out: 1 });
    expect(reader.getBulkNeighbors([10], 'both', 50, 'CALLS').get(10)).toHaveLength(2);
  });

  it('deprioritizes test files rooted directly at test directories before LIMIT', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
       VALUES (?, 'test', 'Function', ?, ?, ?, 1, 2, '{}')`,
    );
    for (let index = 0; index < 6; index += 1) {
      insertNode.run(100 + index, `root-test-${index}`, `test.root-${index}`, `tests/root-${index}.ts`);
    }
    insertNode.run(200, 'production-dead', 'test.production-dead', 'src/production-dead.ts');
    db.close();
    reader = new CodeGraphReader(dbPath);

    expect(reader.listNodesWithoutIncoming('test', ['Function'], 2).map((node) => node.name))
      .toEqual(['handleRequest', 'production-dead']);
  });

  it('finds POSIX-stored paths with Windows separators and vice versa', () => {
    expect(reader.findNodesByFilePath('test', 'src\\auth\\auth.ts').map(node => node.id)).toEqual([40]);
    expect(reader.findNodesByFilePath('test', 'src/billing/invoice.ts').map(node => node.id)).toEqual([50]);
  });

  it('resolves an absolute Windows query against a project-relative stored path', () => {
    const matches = reader.findNodesByFilePath('test', 'c:\\work\\project\\src\\auth\\auth.ts');
    expect(matches.map(node => node.id)).toEqual([40]);
  });

  it('supports portable path matching when filtering context-root labels', () => {
    const matches = reader.findNodesByNameOrPath('test', 'src/billing/invoice.ts', ['File']);
    expect(matches.map(node => node.id)).toEqual([50]);
  });
});
