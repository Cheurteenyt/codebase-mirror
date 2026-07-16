import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { defaultHumanDbPath, HumanMemoryStore } from '../../src/human/store.js';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

describe('Graph UI balanced overview contract', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-ui-layout-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('represents every label, retains hubs, and reports truncation honestly', async () => {
    const project = 'layout-balanced';
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          label TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE INDEX idx_edges_source ON edges(source_id);
        CREATE INDEX idx_edges_target ON edges(target_id);
      `);
      const insertNode = db.prepare(`
        INSERT INTO nodes (
          id, project, label, name, qualified_name, file_path,
          start_line, end_line, properties_json
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 2, ?)
      `);
      const labels = ['Function', 'Class', 'File', 'Method'];
      let id = 1;
      for (const label of labels) {
        for (let index = 0; index < 6; index += 1) {
          const properties = label === 'Function' && index === 1 ? '{"is_exported":true}' : '{}';
          insertNode.run(
            id,
            project,
            label,
            `${label}-${index}`,
            `${project}.${label}-${index}`,
            label === 'File' && index === 0
              ? 'tests/file-0.test.ts'
              : `src/${label.toLowerCase()}-${index}.ts`,
            properties,
          );
          id += 1;
        }
      }
      insertNode.run(
        100,
        'other',
        'Function',
        'Function-foreign',
        'other.Function-foreign',
        'foreign/Function-foreign.ts',
        '{}',
      );
      const insertEdge = db.prepare(
        `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
         VALUES (?, ?, ?, ?, ?, '{}')`,
      );
      // Function-5 (id 6) is the hub. An id-ordered sample of two Functions
      // would miss it; the ranked sampler must retain it.
      for (let edgeId = 1; edgeId <= 5; edgeId += 1) {
        insertEdge.run(edgeId, project, 6 + edgeId, 6, 'CALLS');
      }
      // Structural containment must not make an otherwise uncalled function
      // look live in the dead-code classification.
      insertEdge.run(6, project, 13, 1, 'CONTAINS');
    } finally {
      db.close();
    }

    fixture = await startUiTestFixture({ project });
    const response = await fixture.getJson('/api/layout?max_nodes=8');

    expect(response.status).toBe(200);
    expect(response.body.contract_version).toBe(1);
    expect(response.body.graph_revision).toMatch(/^graph-reader-v1:[A-Za-z0-9_-]{22}$/u);
    expect(response.body.total_nodes).toBe(24);
    expect(response.body.returned_nodes).toBe(8);
    expect(response.body.topology_revision).toMatch(/^architecture-domain-v1:[A-Za-z0-9_-]+$/u);
    expect(response.body.truncated).toBe(true);
    expect(response.body.sampling.strategy).toBe('architecture-coverage-v1');
    expect(response.body.sampling.returned_by_label).toEqual({
      Function: 2,
      Class: 2,
      File: 2,
      Method: 2,
    });
    expect(response.body.edge_sampling).toMatchObject({
      strategy: 'connectivity-first-dual-cap-v1',
      returned_edges: response.body.edges.length,
      edges_truncated: false,
      limit_per_direction: 20,
    });
    expect(response.body.edge_sampling.total_induced_edges)
      .toBe(response.body.edge_sampling.returned_edges);
    expect(response.body.layout.domain_catalog).toEqual({
      exact: true,
      counts_scope: 'all_nodes',
      total_domains: 2,
      domains: [
        { key: 'src', node_count: 23, file_count: 5, representative_node_id: 14 },
        { key: 'tests', node_count: 1, file_count: 1, representative_node_id: 13 },
      ],
    });
    expect(response.body.nodes.map((node: { id: number }) => node.id)).toContain(6);
    expect(response.body.nodes.every((node: { status?: string }) => typeof node.status === 'string')).toBe(true);
    const hub = response.body.nodes.find((node: { id: number }) => node.id === 6);
    expect(hub.in_calls).toBe(5);
    expect(hub.in_degree).toBe(5);
    expect(hub.out_degree).toBe(0);
    const uncalled = response.body.nodes.find((node: { id: number }) => node.id === 1);
    expect(uncalled).toMatchObject({ status: 'dead', in_calls: 0 });

    const neighborhood = await fixture.getJson('/api/neighborhood?node_id=6&limit=2');
    expect(neighborhood.status).toBe(200);
    expect(neighborhood.body).toMatchObject({
      contract_version: 1,
      exact: true,
      graph_revision: expect.stringMatching(/^graph-reader-v1:[A-Za-z0-9_-]{22}$/u),
      anchor: {
        kind: 'node',
        id: 6,
        total_inbound: 5,
        total_outbound: 0,
        total_unique_edges: 5,
      },
      page: { limit: 2, returned: 2 },
    });
    expect(neighborhood.body.edges.map((edge: { id: number }) => edge.id)).toEqual([1, 2]);
    expect(neighborhood.body.page.next_cursor).toEqual(expect.any(String));

    const nextNeighborhood = await fixture.getJson(
      `/api/neighborhood?node_id=6&limit=2&cursor=${encodeURIComponent(neighborhood.body.page.next_cursor)}`,
    );
    expect(nextNeighborhood.body.edges.map((edge: { id: number }) => edge.id)).toEqual([3, 4]);
    const wrongAnchorCursor = await fixture.getJson(
      `/api/neighborhood?node_id=5&limit=2&cursor=${encodeURIComponent(neighborhood.body.page.next_cursor)}`,
    );
    expect(wrongAnchorCursor.status).toBe(400);

    const search = await fixture.getJson('/api/node-search?q=Function&limit=2');
    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({
      contract_version: 1,
      exact: true,
      graph_revision: neighborhood.body.graph_revision,
      scope: 'complete_project',
      query: 'Function',
      match_strategy: 'literal-relevance-v1',
      total_matches: 6,
      returned_nodes: 2,
      truncated: true,
      page: { limit: 2, returned: 2 },
    });
    expect(search.body.nodes.map((node: { id: number }) => node.id)).toEqual([1, 2]);
    expect(search.body.nodes[0]).toMatchObject({
      x: 0,
      y: 0,
      status: expect.any(String),
      in_degree: expect.any(Number),
      out_degree: expect.any(Number),
    });
    expect(search.body.page.next_cursor).toEqual(expect.any(String));

    const nextSearch = await fixture.getJson(
      `/api/node-search?q=Function&limit=2&cursor=${encodeURIComponent(search.body.page.next_cursor)}`,
    );
    expect(nextSearch.body.nodes.map((node: { id: number }) => node.id)).toEqual([3, 4]);
    expect(nextSearch.body.total_matches).toBe(6);

    const wrongQuerySearch = await fixture.getJson(
      `/api/node-search?q=Class&limit=2&cursor=${encodeURIComponent(search.body.page.next_cursor)}`,
    );
    expect(wrongQuerySearch.status).toBe(400);
    const decodedCursor = JSON.parse(
      Buffer.from(search.body.page.next_cursor, 'base64url').toString('utf8'),
    );
    decodedCursor.project = 'other';
    const wrongProjectCursor = Buffer.from(JSON.stringify(decodedCursor), 'utf8').toString('base64url');
    expect((await fixture.getJson(
      `/api/node-search?q=Function&limit=2&cursor=${encodeURIComponent(wrongProjectCursor)}`,
    )).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=%25')).body.total_matches).toBe(0);
    expect((await fixture.getJson('/api/node-search')).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=%20%20')).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=Function%0A')).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=Function&limit=1.5')).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=Function&limit=251')).status).toBe(400);
    expect((await fixture.getJson('/api/node-search?q=Function&cursor=not-base64')).status).toBe(400);

    const complete = await fixture.getJson('/api/layout?max_nodes=24');
    expect(complete.body.truncated).toBe(false);
    expect(complete.body.nodes.find((node: { id: number }) => node.id === 2)
      .status).toBe('exported');
    expect(complete.body.nodes.find((node: { id: number }) => node.id === 13)
      .status).toBe('test');

    const compressed = await fixture.getJson(
      '/api/layout?max_nodes=24',
      { 'Accept-Encoding': 'br' },
    );
    expect(compressed.status).toBe(200);
    expect(compressed.body.topology_revision).toBe(complete.body.topology_revision);
    expect(compressed.headers.get('content-encoding')).toBe('br');
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding');
    const etag = compressed.headers.get('etag');
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/u);

    const notModified = await fetch(
      `${fixture.baseUrl}/api/layout?max_nodes=24`,
      {
        headers: {
          'Accept-Encoding': 'br',
          'If-None-Match': etag!,
        },
      },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('vary')).toContain('Accept-Encoding');
    expect(await notModified.text()).toBe('');

    const gzipFallback = await fixture.getJson(
      '/api/layout?max_nodes=24',
      { 'Accept-Encoding': 'br;q=0, gzip;q=0.5' },
    );
    expect(gzipFallback.headers.get('content-encoding')).toBe('gzip');
    expect(gzipFallback.body.topology_revision).toBe(complete.body.topology_revision);

    const invalidBrotliQuality = await fixture.getJson(
      '/api/layout?max_nodes=24',
      { 'Accept-Encoding': 'br;q=invalid, gzip;q=0.5' },
    );
    expect(invalidBrotliQuality.headers.get('content-encoding')).toBe('gzip');

    const identity = await fixture.getJson(
      '/api/layout?max_nodes=24',
      { 'Accept-Encoding': 'br;q=0, gzip;q=0' },
    );
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(identity.body.topology_revision).toBe(complete.body.topology_revision);
  });

  it('keeps a top-level domain whose first file appears after the old 10k cutoff', { timeout: 10_000 }, async () => {
    const project = 'layout-late-domain';
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          label TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE INDEX idx_edges_source ON edges(source_id);
        CREATE INDEX idx_edges_target ON edges(target_id);
      `);
      const insertNode = db.prepare(
        `INSERT INTO nodes (
          id, project, label, name, qualified_name, file_path,
          start_line, end_line, properties_json
        ) VALUES (?, ?, 'File', ?, ?, ?, 1, 2, '{}')`,
      );
      db.transaction(() => {
        for (let index = 0; index < 10_001; index += 1) {
          const id = index + 1;
          insertNode.run(
            id,
            project,
            `main-${index}.ts`,
            `${project}::main/main-${index}.ts`,
            `main/main-${index}.ts`,
          );
        }
        insertNode.run(
          10_002,
          project,
          'late.ts',
          `${project}::late-domain/late.ts`,
          'late-domain/late.ts',
        );
      })();
    } finally {
      db.close();
    }

    fixture = await startUiTestFixture({ project });
    const response = await fixture.getJson('/api/layout?max_nodes=2');

    expect(response.status).toBe(200);
    expect(response.body.nodes.map((node: { id: number }) => node.id)).toContain(10_002);
    expect(response.body.layout.domains.map((domain: { key: string }) => domain.key))
      .toEqual(['late-domain', 'main']);
    expect(response.body.layout.domain_catalog).toEqual({
      exact: true,
      counts_scope: 'all_nodes',
      total_domains: 2,
      domains: [
        { key: 'late-domain', node_count: 1, file_count: 1, representative_node_id: 10_002 },
        { key: 'main', node_count: 10_001, file_count: 10_001, representative_node_id: 1 },
      ],
    });
  });

  it('rejects search and neighborhood cursors after the graph revision changes', async () => {
    const project = 'layout-revision-lock';
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          label TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY,
          project TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          properties_json TEXT NOT NULL
        );
        CREATE INDEX idx_edges_source ON edges(source_id);
        CREATE INDEX idx_edges_target ON edges(target_id);
      `);
      const insertNode = db.prepare(
        `INSERT INTO nodes (
          id, project, label, name, qualified_name, file_path,
          start_line, end_line, properties_json
        ) VALUES (?, ?, 'Function', ?, ?, ?, 1, 2, '{}')`,
      );
      insertNode.run(1, project, 'alpha-anchor', `${project}.alpha-anchor`, 'src/anchor.ts');
      insertNode.run(2, project, 'alpha-caller-a', `${project}.alpha-caller-a`, 'src/a.ts');
      insertNode.run(3, project, 'alpha-caller-b', `${project}.alpha-caller-b`, 'src/b.ts');
      const insertEdge = db.prepare(
        `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
         VALUES (?, ?, ?, 1, 'CALLS', '{}')`,
      );
      insertEdge.run(1, project, 2);
      insertEdge.run(2, project, 3);
    } finally {
      db.close();
    }

    fixture = await startUiTestFixture({ project });
    const layoutBeforeMutation = await fixture.getJson('/api/layout?max_nodes=2');
    const search = await fixture.getJson('/api/node-search?q=alpha&limit=1');
    const neighborhood = await fixture.getJson('/api/neighborhood?node_id=1&limit=1');
    const scope = await fixture.getJson('/api/scope?kind=community&key=src&limit=1');
    expect(layoutBeforeMutation.status).toBe(200);
    expect(search.status).toBe(200);
    expect(neighborhood.status).toBe(200);
    expect(scope.status).toBe(200);
    expect(layoutBeforeMutation.body.graph_revision).toBe(search.body.graph_revision);
    expect(search.body.graph_revision).toBe(neighborhood.body.graph_revision);
    expect(scope.body).toMatchObject({
      contract_version: 1,
      exact: true,
      graph_revision: search.body.graph_revision,
      scope: {
        kind: 'community',
        key: 'src',
        total_nodes: 3,
        total_internal_edges: 2,
      },
      page: { node_limit: 1, edge_limit: 1, returned_nodes: 1, returned_edges: 0 },
    });
    expect(scope.body.nodes.map((node: { id: number }) => node.id)).toEqual([1]);
    expect(scope.body.edges).toEqual([]);
    expect(search.body.page.next_cursor).toEqual(expect.any(String));
    expect(neighborhood.body.page.next_cursor).toEqual(expect.any(String));
    expect(scope.body.page.next_cursor).toEqual(expect.any(String));

    const nextScope = await fixture.getJson(
      `/api/scope?kind=community&key=src&limit=1&cursor=${encodeURIComponent(scope.body.page.next_cursor)}`,
    );
    expect(nextScope.body.nodes.map((node: { id: number }) => node.id)).toEqual([2]);
    expect(nextScope.body.edges.map((edge: { id: number }) => edge.id)).toEqual([1]);
    expect((await fixture.getJson(
      `/api/scope?kind=domain&key=src&limit=1&cursor=${encodeURIComponent(scope.body.page.next_cursor)}`,
    )).status).toBe(400);

    const writer = new Database(dbPath);
    try {
      writer.prepare(
        `INSERT INTO nodes (
          id, project, label, name, qualified_name, file_path,
          start_line, end_line, properties_json
        ) VALUES (4, ?, 'Function', 'alpha-caller-c', ?, 'src/c.ts', 1, 2, '{}')`,
      ).run(project, `${project}.alpha-caller-c`);
      writer.prepare(
        `INSERT INTO edges (id, project, source_id, target_id, type, properties_json)
         VALUES (3, ?, 4, 1, 'CALLS', '{}')`,
      ).run(project);
    } finally {
      writer.close();
    }

    const layoutAfterMutation = await fixture.getJson('/api/layout?max_nodes=2');
    expect(layoutAfterMutation.status).toBe(200);
    expect(layoutAfterMutation.body.graph_revision).not.toBe(
      layoutBeforeMutation.body.graph_revision,
    );
    expect(layoutAfterMutation.body.total_nodes).toBe(4);

    const staleSearch = await fixture.getJson(
      `/api/node-search?q=alpha&limit=1&cursor=${encodeURIComponent(search.body.page.next_cursor)}`,
    );
    const staleNeighborhood = await fixture.getJson(
      `/api/neighborhood?node_id=1&limit=1&cursor=${encodeURIComponent(neighborhood.body.page.next_cursor)}`,
    );
    const staleScope = await fixture.getJson(
      `/api/scope?kind=community&key=src&limit=1&cursor=${encodeURIComponent(nextScope.body.page.next_cursor)}`,
    );
    for (const responseWithStaleCursor of [staleSearch, staleNeighborhood, staleScope]) {
      expect(responseWithStaleCursor.status).toBe(409);
      expect(responseWithStaleCursor.body).toMatchObject({
        contract_version: 1,
        error: 'graph_revision_mismatch',
        code: 'GRAPH_REVISION_MISMATCH',
        expected_graph_revision: search.body.graph_revision,
        graph_revision: expect.stringMatching(/^graph-reader-v1:[A-Za-z0-9_-]{22}$/u),
        restart_from_first_page: true,
      });
      expect(responseWithStaleCursor.body.graph_revision).not.toBe(search.body.graph_revision);
    }

    const restarted = await fixture.getJson('/api/node-search?q=alpha&limit=1');
    expect(restarted.status).toBe(200);
    expect(restarted.body.graph_revision).toBe(staleSearch.body.graph_revision);
    expect(restarted.body.total_matches).toBe(4);
  });

  it('reports the full linked-note count instead of a presence bit', async () => {
    const project = 'layout-note-count';
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, label TEXT NOT NULL,
          name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, properties_json TEXT NOT NULL
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, source_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL, type TEXT NOT NULL, properties_json TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO nodes VALUES (1, ?, 'Function', 'target', 'target', 'src/target.ts', 1, 2, '{}')`,
      ).run(project);
    } finally {
      db.close();
    }

    fixture = await startUiTestFixture({ project });
    const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
    try {
      humanStore.createNode({
        project, label: 'ADR', title: 'First note', cbm_node_ids: [1],
      });
      humanStore.createNode({
        project, label: 'BugNote', title: 'Second note', cbm_node_ids: [1],
      });
    } finally {
      humanStore.close();
    }

    const response = await fixture.getJson('/api/layout?max_nodes=1');
    expect(response.status).toBe(200);
    expect(response.body.nodes[0].notes_count).toBe(2);
  });

  it('separates active work from history and exposes partial dashboard coverage', async () => {
    const project = 'dashboard-count-honesty';
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, label TEXT NOT NULL,
          name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, properties_json TEXT NOT NULL
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, source_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL, type TEXT NOT NULL, properties_json TEXT NOT NULL
        );
        CREATE INDEX idx_edges_source ON edges(source_id);
        CREATE INDEX idx_edges_target ON edges(target_id);
      `);
      const insertNode = db.prepare(
        `INSERT INTO nodes VALUES (?, ?, 'Module', ?, ?, ?, 1, 2, '{}')`,
      );
      db.transaction(() => {
        for (let id = 1; id <= 5001; id += 1) {
          insertNode.run(
            id,
            project,
            `module-${id}`,
            `${project}.module-${id}`,
            `src/module-${id}.ts`,
          );
        }
      })();
      const insertEdge = db.prepare(
        `INSERT INTO edges VALUES (?, ?, 1, 1, 'CALLS', '{}')`,
      );
      db.transaction(() => {
        for (let id = 1; id <= 20; id += 1) insertEdge.run(id, project);
      })();
    } finally {
      db.close();
    }

    const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
    try {
      humanStore.createNode({ project, label: 'BugNote', title: 'Open bug' });
      humanStore.createNode({
        project, label: 'BugNote', title: 'Historical bug', status: 'deprecated',
      });
      humanStore.createNode({
        project, label: 'RefactorPlan', title: 'Historical plan', status: 'reviewed',
      });
    } finally {
      humanStore.close();
    }

    fixture = await startUiTestFixture({ project });
    const response = await fixture.getJson('/api/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.human_memory).toMatchObject({
      bugs: 2,
      active_bugs: 1,
      refactors: 1,
      active_refactors: 0,
    });
    expect(response.body.recommendations).toContainEqual(expect.stringContaining('1 open bug'));
    expect(response.body.recommendations).not.toContainEqual(expect.stringContaining('2 open bug'));
    expect(response.body.recommendations).not.toContainEqual(expect.stringContaining('pending refactor'));
    expect(response.body.documentation_coverage).toMatchObject({
      critical_modules_total: 1,
      critical_modules_documented: 0,
      scanned_modules: 5000,
      module_scan_limit: 5000,
      scan_truncated: true,
      critical_counts_are_lower_bounds: true,
      coverage_is_partial: true,
    });
    expect(response.body.recommendations).toContainEqual(expect.stringContaining('coverage is partial'));
    expect(response.body.recommendations).toContainEqual(expect.stringContaining('at least 1 critical'));
  });
});
