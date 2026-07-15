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
    expect(response.body.total_nodes).toBe(24);
    expect(response.body.returned_nodes).toBe(8);
    expect(response.body.truncated).toBe(true);
    expect(response.body.sampling.strategy).toBe('balanced-degree-v1');
    expect(response.body.sampling.returned_by_label).toEqual({
      Function: 2,
      Class: 2,
      File: 2,
      Method: 2,
    });
    expect(response.body.nodes.map((node: { id: number }) => node.id)).toContain(6);
    expect(response.body.nodes.every((node: { status?: string }) => typeof node.status === 'string')).toBe(true);
    const hub = response.body.nodes.find((node: { id: number }) => node.id === 6);
    expect(hub.in_calls).toBe(5);
    const uncalled = response.body.nodes.find((node: { id: number }) => node.id === 1);
    expect(uncalled).toMatchObject({ status: 'dead', in_calls: 0 });

    const complete = await fixture.getJson('/api/layout?max_nodes=24');
    expect(complete.body.truncated).toBe(false);
    expect(complete.body.nodes.find((node: { id: number }) => node.id === 2)
      .status).toBe('exported');
    expect(complete.body.nodes.find((node: { id: number }) => node.id === 13)
      .status).toBe('test');
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
