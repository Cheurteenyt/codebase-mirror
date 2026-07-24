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

  it('paginates an exact project-scoped neighborhood without duplicating self-loops', () => {
    reader.close();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
       VALUES (3, 'test', 10, 10, 'RECURSIVE', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
       VALUES (100, 'other', 'Function', 'foreign', 'other.foreign', 'src/foreign.ts', 1, 2, '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
       VALUES (4, 'other', 100, 10, 'CALLS', '{}')`,
    ).run();
    db.close();
    reader = new CodeGraphReader(dbPath);

    const first = reader.getExactNeighborhoodPage('test', 10, 0, 2);
    expect(first).toMatchObject({
      total_inbound: 2,
      total_outbound: 2,
      total_unique_edges: 3,
      next_after_edge_id: 2,
    });
    expect(first?.neighbors.map(({ edge }) => edge.id)).toEqual([1, 2]);

    const second = reader.getExactNeighborhoodPage('test', 10, first!.next_after_edge_id!, 2);
    expect(second?.neighbors.map(({ edge, node }) => ({ edge: edge.id, node: node.id })))
      .toEqual([{ edge: 3, node: 10 }]);
    expect(second?.next_after_edge_id).toBeNull();
    expect(reader.getExactNeighborhoodPage('other', 10, 0, 10)).toBeNull();
  });

  it('finds a deterministic shortest coupling path without relying on edge direction', () => {
    const path = reader.findExactPath('test', 20, 30, {
      maxHops: 4,
      maxVisitedNodes: 20,
      maxVisitedEdges: 20,
    });

    expect(path).toMatchObject({
      status: 'found',
      hops: 2,
      visited_nodes: 3,
    });
    expect(path?.nodes.map((node) => node.id)).toEqual([20, 10, 30]);
    expect(path?.edges.map((edge) => ({
      id: edge.id,
      source: edge.source_id,
      target: edge.target_id,
    }))).toEqual([
      { id: 1, source: 10, target: 20 },
      { id: 2, source: 30, target: 10 },
    ]);

    expect(reader.findExactPath('test', 20, 30, {
      maxHops: 1,
      maxVisitedNodes: 20,
      maxVisitedEdges: 20,
    })?.status).toBe('max_hops');
    expect(reader.findExactPath('test', 20, 30, {
      maxHops: 4,
      maxVisitedNodes: 20,
      maxVisitedEdges: 1,
    })?.status).toBe('limit_reached');
    expect(reader.findExactPath('test', 40, 50, {
      maxHops: 4,
      maxVisitedNodes: 20,
      maxVisitedEdges: 20,
    })?.status).toBe('not_found');
    expect(reader.findExactPath('test', 20, 100, {
      maxHops: 4,
      maxVisitedNodes: 20,
      maxVisitedEdges: 20,
    })).toBeNull();
  });

  it('reconstructs an exact architecture scope incrementally without dangling or duplicate edges', () => {
    reader.close();
    const setup = new Database(dbPath);
    setup.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (80, 'test', 'File', 'index.ts', 'test::packages/zod/index.ts',
        'packages/zod/index.ts', 1, 100, '{}')`,
    ).run();
    setup.prepare(
      `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
       VALUES (5, 'test', 40, 80, 'IMPORTS', '{"resolution":"cross_file_module_exact"}')`,
    ).run();
    setup.prepare(
      `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
       VALUES (6, 'test', 80, 40, 'CALLS', '{"resolution":"cross_file_import_exact"}')`,
    ).run();
    setup.close();
    reader = new CodeGraphReader(dbPath);

    let cursor = { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 };
    const collectedNodes: number[] = [];
    const collectedEdges: number[] = [];

    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = reader.getExactScopePage('test', 'community', 'src', cursor, 1, 1);
      expect(page.total_nodes).toBe(3);
      expect(page.total_internal_edges).toBe(2);
      collectedNodes.push(...page.nodes.map((node) => node.id));
      collectedEdges.push(...page.edges.map((edge) => edge.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }

    expect(collectedNodes).toEqual([10, 20, 30]);
    expect(collectedEdges).toEqual([1, 2]);
    expect(new Set(collectedEdges).size).toBe(collectedEdges.length);
    expect(reader.getExactScopePage(
      'test',
      'community',
      'src/auth',
      { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 },
      10,
      10,
    )).toMatchObject({ total_nodes: 1, total_internal_edges: 0 });
    expect(reader.getExactScopePage(
      'test',
      'domain',
      'src',
      { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 },
      10,
      10,
    ).nodes.map((node) => node.id)).toEqual([10, 20, 30, 40, 50]);

    // A directory is not the homonymous three-segment community. It contains
    // every descendant path, including portable Windows separators.
    const directory = reader.getExactScopePage(
      'test',
      'directory',
      'src',
      { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 },
      10,
      10,
    );
    expect(directory.nodes.map((node) => node.id)).toEqual([10, 20, 30, 40, 50]);
    expect(directory.total_nodes).toBe(5);
    expect(directory.total_internal_edges).toBe(2);

    const authDirectory = reader.getExactScopePage(
      'test',
      'directory',
      'src/auth',
      { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 },
      10,
      10,
    );
    expect(authDirectory.boundary).toEqual({
      exact: true,
      total_relations: 2,
      incoming_relations: 1,
      outgoing_relations: 1,
      returned_groups: 2,
      truncated: false,
      dependencies: [
        {
          direction: 'incoming',
          external_key: 'packages/zod',
          type: 'CALLS',
          count: 1,
        },
        {
          direction: 'outgoing',
          external_key: 'packages/zod',
          type: 'IMPORTS',
          count: 1,
        },
      ],
    });
  });

  it('does not confuse a same-named file with the selected directory', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, 'test', ?, ?, ?, 'src', 1, 2, '{}')`,
    );
    insertNode.run(60, 'File', 'src', 'test::src');
    insertNode.run(70, 'Directory', 'src', 'test::directory:src');
    db.close();
    reader = new CodeGraphReader(dbPath);

    const directory = reader.getExactScopePage(
      'test',
      'directory',
      'src',
      { after_node_id: 0, batch_end_node_id: 0, after_edge_id: 0 },
      20,
      20,
    );

    expect(directory.nodes.map((node) => node.id)).toEqual([10, 20, 30, 40, 50, 70]);
    expect(directory.nodes.map((node) => node.id)).not.toContain(60);
  });

  it('keeps a stable graph revision and reads multi-statement pages from one snapshot', () => {
    reader.close();
    const setup = new Database(dbPath);
    setup.pragma('journal_mode = WAL');
    setup.close();
    reader = new CodeGraphReader(dbPath);

    const initialRevision = reader.getGraphRevision();
    expect(initialRevision).toMatch(/^graph-reader-v1:[A-Za-z0-9_-]{22}$/u);
    expect(reader.getGraphRevision()).toBe(initialRevision);

    const snapshot = reader.withGraphSnapshot(null, () => {
      const before = reader.countNodes('test');
      const writer = new Database(dbPath);
      writer.prepare(
        `INSERT INTO nodes (
          id, project, label, name, qualified_name, file_path,
          start_line, end_line, properties_json
        ) VALUES (90, 'test', 'Function', 'late', 'test.late', 'src/late.ts', 1, 2, '{}')`,
      ).run();
      writer.close();
      const after = reader.countNodes('test');
      return { before, after };
    });

    expect(snapshot).toMatchObject({
      ok: true,
      graph_revision: initialRevision,
      value: { before: 5, after: 5 },
    });
    const changedRevision = reader.getGraphRevision();
    expect(changedRevision).not.toBe(initialRevision);
    expect(reader.withGraphSnapshot(initialRevision, () => 'must-not-run')).toEqual({
      ok: false,
      graph_revision: changedRevision,
      expected_graph_revision: initialRevision,
    });
    reader.close();
    reader = new CodeGraphReader(dbPath);
    expect(reader.getGraphRevision()).not.toBe(changedRevision);
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

  it('enforces both directional edge caps and reports truncation honestly', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, 'test', 'Function', ?, ?, ?, 1, 2, '{}')`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges (
        id, project, source_id, target_id, type, properties_json
      ) VALUES (?, 'test', ?, ?, 'CALLS', '{}')`,
    );
    db.transaction(() => {
      for (let id = 60; id < 66; id += 1) {
        insertNode.run(id, `dense-${id}`, `test.dense-${id}`, `src/dense-${id}.ts`);
      }
      let edgeId = 100;
      for (let source = 60; source < 66; source += 1) {
        for (let target = 60; target < 66; target += 1) {
          if (source !== target) insertEdge.run(edgeId++, source, target);
        }
      }
    })();
    db.close();
    reader = new CodeGraphReader(dbPath);

    const result = reader.getBulkEdgesWithStats([60, 61, 62, 63, 64, 65], 2);
    const outCount = new Map<number, number>();
    const inCount = new Map<number, number>();
    for (const edge of result.edges) {
      outCount.set(edge.source, (outCount.get(edge.source) ?? 0) + 1);
      inCount.set(edge.target, (inCount.get(edge.target) ?? 0) + 1);
    }

    expect(Math.max(...outCount.values())).toBeLessThanOrEqual(2);
    expect(Math.max(...inCount.values())).toBeLessThanOrEqual(2);
    expect(result).toMatchObject({
      strategy: 'connectivity-first-dual-cap-v1',
      total_induced_edges: 30,
      returned_edges: result.edges.length,
      edges_truncated: true,
      limit_per_direction: 2,
      available_by_type: { CALLS: 30 },
      returned_by_type: { CALLS: result.edges.length },
    });
    expect(result.returned_edges).toBeLessThan(result.total_induced_edges);
    expect(reader.getBulkEdges([60, 61, 62, 63, 64, 65], 2)).toEqual(result.edges);
  });

  it('preserves a connectivity bridge before spending a cap slot on a cycle', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, 'test', 'Function', ?, ?, ?, 1, 2, '{}')`,
    );
    for (let id = 70; id < 74; id += 1) {
      insertNode.run(id, `bridge-${id}`, `test.bridge-${id}`, `src/bridge-${id}.ts`);
    }
    const insertEdge = db.prepare(
      `INSERT INTO edges (
        id, project, source_id, target_id, type, properties_json
      ) VALUES (?, 'test', ?, ?, 'CALLS', '{}')`,
    );
    insertEdge.run(200, 70, 71);
    insertEdge.run(201, 71, 70); // cycle: should not consume node 71's only out slot
    insertEdge.run(202, 71, 72); // bridge between the two halves
    insertEdge.run(203, 72, 73);
    db.close();
    reader = new CodeGraphReader(dbPath);

    const result = reader.getBulkEdgesWithStats([70, 71, 72, 73], 1);
    expect(result.edges).toEqual([
      { source: 70, target: 71, type: 'CALLS' },
      { source: 71, target: 72, type: 'CALLS' },
      { source: 72, target: 73, type: 'CALLS' },
    ]);
    expect(result).toMatchObject({
      total_induced_edges: 4,
      returned_edges: 3,
      edges_truncated: true,
    });
  });

  it('keeps only induced rows when a visible hub has many external targets', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, 'test', 'Function', ?, ?, ?, 1, 2, '{}')`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges (
        id, project, source_id, target_id, type, properties_json
      ) VALUES (?, 'test', ?, ?, ?, '{}')`,
    );
    db.transaction(() => {
      insertNode.run(80, 'visible-hub', 'test.visible-hub', 'src/hub.ts');
      insertNode.run(81, 'visible-peer', 'test.visible-peer', 'src/peer.ts');
      for (let index = 0; index < 2_000; index += 1) {
        const externalId = 1_000 + index;
        insertNode.run(
          externalId,
          `external-${index}`,
          `test.external-${index}`,
          `vendor/external-${index}.ts`,
        );
        insertEdge.run(10_000 + index, 80, externalId, 'CALLS');
      }
      insertEdge.run(20_000, 80, 81, 'IMPORTS');
    })();
    db.close();
    reader = new CodeGraphReader(dbPath);

    expect(reader.getBulkEdgesWithStats([80, 81], 20)).toMatchObject({
      edges: [{ source: 80, target: 81, type: 'IMPORTS' }],
      total_induced_edges: 1,
      returned_edges: 1,
      edges_truncated: false,
      available_by_type: { IMPORTS: 1 },
      returned_by_type: { IMPORTS: 1 },
    });
  });

  it('returns exact domain summaries even when a domain appears after 10k files', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 2, '{}')`,
    );
    db.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) {
        const id = 1_000 + index;
        insertNode.run(
          id,
          'test',
          'File',
          `bulk-${index}.ts`,
          `test::bulk/bulk-${index}.ts`,
          `bulk/bulk-${index}.ts`,
        );
      }
      insertNode.run(
        20_000,
        'test',
        'File',
        'late.ts',
        'test::late-domain/late.ts',
        'late-domain/late.ts',
      );
      insertNode.run(20_001, 'test', 'Directory', 'scripts', 'test::scripts', 'scripts');
      insertNode.run(
        20_002,
        'other',
        'File',
        'foreign.ts',
        'other::foreign-domain/foreign.ts',
        'foreign-domain/foreign.ts',
      );
    })();
    db.close();
    reader = new CodeGraphReader(dbPath);

    const summaries = reader.listArchitectureDomains('test');
    expect(summaries.find(({ key }) => key === 'bulk')).toMatchObject({
      node_count: 10_001,
      file_count: 10_001,
      representative: { id: 1_000 },
    });
    expect(summaries.find(({ key }) => key === 'late-domain')).toMatchObject({
      node_count: 1,
      file_count: 1,
      representative: { id: 20_000 },
    });
    expect(summaries.find(({ key }) => key === 'scripts')).toMatchObject({
      node_count: 1,
      file_count: 0,
      representative: { id: 20_001 },
    });
    expect(summaries.some(({ key }) => key === 'foreign-domain')).toBe(false);
  });

  it('searches the complete project literally with stable ranked pagination', () => {
    reader.close();
    const db = new Database(dbPath);
    const insertNode = db.prepare(
      `INSERT INTO nodes (
        id, project, label, name, qualified_name, file_path,
        start_line, end_line, properties_json
      ) VALUES (?, ?, 'Function', ?, ?, ?, 1, 2, '{}')`,
    );
    insertNode.run(80, 'test', 'auth', 'test.auth', 'src/exact.ts');
    insertNode.run(81, 'test', 'authClient', 'test.authClient', 'src/client.ts');
    insertNode.run(82, 'test', 'helper', 'auth', 'src/helper.ts');
    insertNode.run(83, 'test', 'router', 'test.router', 'src\\auth');
    insertNode.run(84, 'test', 'percent%literal', 'test.percent', 'src/percent.ts');
    insertNode.run(85, 'other', 'auth', 'other.auth', 'src/auth.ts');
    insertNode.run(86, 'test', 'under_score', 'test.under_score', 'src/under.ts');
    db.close();
    reader = new CodeGraphReader(dbPath);

    const first = reader.searchNodesExactPage('test', 'auth', -1, 0, 2);
    expect(first.nodes.map((node) => node.id)).toEqual([80, 82]);
    expect(first.total_matches).toBe(7);
    expect(first).toMatchObject({ next_after_rank: 1, next_after_node_id: 82 });

    const second = reader.searchNodesExactPage(
      'test',
      'auth',
      first.next_after_rank!,
      first.next_after_node_id!,
      2,
    );
    expect(second.nodes.map((node) => node.id)).toEqual([40, 81]);
    expect(second.total_matches).toBe(7);

    expect(reader.searchNodesExactPage('test', '%', -1, 0, 10).nodes.map((node) => node.id))
      .toEqual([84]);
    expect(reader.searchNodesExactPage('test', '_', -1, 0, 10).nodes.map((node) => node.id))
      .toEqual([86]);
    expect(reader.searchNodesExactPage('test', 'src\\auth', -1, 0, 10).nodes[0]?.id)
      .toBe(83);
    expect(reader.searchNodesExactPage('test', 'auth', -1, 0, 250).nodes)
      .not.toContainEqual(expect.objectContaining({ id: 85 }));
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

describe('CodeGraphReader — legacy V1 properties compatibility', () => {
  let tmpDir: string;
  let dbPath: string;
  let reader: CodeGraphReader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-legacy-properties-'));
    dbPath = join(tmpDir, 'legacy-code.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        project TEXT, label TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, start_line INTEGER, end_line INTEGER, properties TEXT
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY,
        project TEXT, source_id INTEGER, target_id INTEGER,
        type TEXT, properties TEXT
      );
      CREATE TABLE projects (name TEXT, root_path TEXT);
    `);
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
      .run('legacy', 'C:\\Work\\Legacy');

    const insertNode = db.prepare(
      'INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertNode.run(1, 'legacy', 'Function', 'target', 'legacy.target', 'src/target.ts', 1, 10, '{"complexity":4}');
    insertNode.run(2, 'legacy', 'Function', 'caller', 'legacy.caller', 'src/caller.ts', 1, 10, '{"is_exported":false}');
    insertNode.run(3, 'legacy', 'Route', '/health', 'legacy.route.health', 'src/server.ts', 20, 25, '{"route_method":"GET","route_path":"/health"}');

    db.prepare(
      'INSERT INTO edges (id, project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(10, 'legacy', 2, 1, 'CALLS', '{"arg_count":1}');
    db.close();

    reader = new CodeGraphReader(dbPath);
  });

  afterEach(() => {
    reader.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizes legacy node and edge payloads to properties_json', () => {
    expect(reader.getNodeById(1)?.properties_json).toBe('{"complexity":4}');

    const neighbor = reader.getNeighbors(1, 'in', 10)[0];
    expect(neighbor.edge.properties_json).toBe('{"arg_count":1}');
    expect(neighbor.node.properties_json).toBe('{"is_exported":false}');

    const bulkNeighbor = reader.getBulkNeighbors([1], 'in', 10).get(1)?.[0];
    expect(bulkNeighbor?.edge.properties_json).toBe('{"arg_count":1}');
    expect(bulkNeighbor?.node.properties_json).toBe('{"is_exported":false}');
  });

  it('falls back to legacy values in partially migrated mixed schemas', () => {
    reader.close();
    const db = new Database(dbPath);
    db.exec(`
      ALTER TABLE nodes ADD COLUMN properties_json TEXT;
      ALTER TABLE edges ADD COLUMN properties_json TEXT;
      UPDATE nodes SET properties_json = '';
      UPDATE edges SET properties_json = '';
    `);
    db.close();
    reader = new CodeGraphReader(dbPath);

    expect(reader.getNodeById(1)?.properties_json).toBe('{"complexity":4}');
    const neighbor = reader.getNeighbors(1, 'in', 10)[0];
    expect(neighbor.edge.properties_json).toBe('{"arg_count":1}');
    expect(neighbor.node.properties_json).toBe('{"is_exported":false}');
  });

  it('supports Graph UI dead-code sampling and route lookup on legacy stores', () => {
    expect(reader.listNodesWithoutIncoming('legacy', ['Function'], 10).map((node) => node.name))
      .toEqual(['caller']);
    expect(reader.findRoute('legacy', 'get', '/health')?.id).toBe(3);
  });
});
