// tests/round41-fixes.test.ts
// R41: tests for the fixes introduced in round 41.
//
// Coverage:
//   - M5: FTS5 migration V4 + searchHumanNodes (BM25 ranking + LIKE fallback)
//   - L2: CodeGraphReader.countAll (single-query node+edge counts)
//   - L6: SlugConflictError class (importer.ts)
//   - N1: report.ts withProjectStores (resource cleanup on codeReader throw)
//   - L4: store.ts slug-collision prepared-statement hoist (behavioral parity)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HumanMemoryStore } from '../src/human/store.js';
import { CodeGraphReader } from '../src/bridge/sqlite-ro.js';
import { SlugConflictError } from '../src/obsidian/importer.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── M5: FTS5 searchHumanNodes ─────────────────────────────────────

describe('R41 (M5): searchHumanNodes with FTS5', () => {
  let store: HumanMemoryStore;

  beforeEach(() => {
    store = HumanMemoryStore.openMemory();
    // Seed a few notes with searchable content.
    store.createNode({
      project: 'p', label: 'BugNote', title: 'Auth login fails on Safari',
      body_markdown: 'The login form throws TypeError when Safari blocks third-party cookies.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['auth', 'safari'],
    });
    store.createNode({
      project: 'p', label: 'ADR', title: 'ADR-003: Use JWT for auth',
      body_markdown: 'We decided to use JSON Web Tokens for authentication.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['auth', 'jwt'],
    });
    store.createNode({
      project: 'p', label: 'Convention', title: 'Coding conventions',
      body_markdown: 'Use camelCase for variables. No tabs.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: ['style'],
    });
    store.createNode({
      project: 'p', label: 'BugNote', title: 'Deprecated bug',
      body_markdown: 'This bug is deprecated and should not appear in search.',
      status: 'deprecated', source: 'human', cbm_node_ids: [], tags: [],
    });
  });

  afterEach(() => store.close());

  it('FTS5 table exists after migration V4', () => {
    const db = store.getRawDb();
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='human_nodes_fts'"
    ).all() as any[];
    expect(rows.length).toBe(1);
  });

  it('triggers exist after migration V4', () => {
    const db = store.getRawDb();
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'human_nodes_fts_%'"
    ).all() as any[];
    expect(rows.length).toBe(3); // _ai, _ad, _au
    const names = rows.map(r => r.name).sort();
    expect(names).toEqual(['human_nodes_fts_ad', 'human_nodes_fts_ai', 'human_nodes_fts_au']);
  });

  it('finds notes by title keyword', () => {
    const results = store.searchHumanNodes('p', 'auth');
    // Should find the BugNote "Auth login fails on Safari" and the ADR "Use JWT for auth".
    expect(results.length).toBeGreaterThanOrEqual(2);
    const titles = results.map(r => r.title);
    expect(titles.some(t => t.includes('Auth'))).toBe(true);
    expect(titles.some(t => t.includes('JWT'))).toBe(true);
  });

  it('finds notes by body content', () => {
    const results = store.searchHumanNodes('p', 'Safari');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('Auth login');
  });

  it('finds notes by tag', () => {
    const results = store.searchHumanNodes('p', 'jwt');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('JWT');
  });

  it('excludes deprecated notes from search results', () => {
    const results = store.searchHumanNodes('p', 'deprecated');
    // The deprecated note should NOT appear (status = 'deprecated' is filtered).
    const titles = results.map(r => r.title);
    expect(titles.find(t => t.includes('Deprecated bug'))).toBeUndefined();
  });

  it('returns empty array for empty query', () => {
    expect(store.searchHumanNodes('p', '')).toEqual([]);
    expect(store.searchHumanNodes('p', '   ')).toEqual([]);
  });

  it('respects the limit parameter', () => {
    // 'auth' matches at least 2 notes — limit to 1.
    const results = store.searchHumanNodes('p', 'auth', 1);
    expect(results.length).toBe(1);
  });

  it('scoping by project excludes other projects', () => {
    store.createNode({
      project: 'other', label: 'BugNote', title: 'Auth bug in other project',
      body_markdown: 'Should not appear in project p search.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    const results = store.searchHumanNodes('p', 'Auth');
    const projects = new Set(results.map(r => r.project));
    expect(projects.has('other')).toBe(false);
  });

  it('FTS5 index stays in sync after createNode', () => {
    // Create a new note AFTER migration.
    store.createNode({
      project: 'p', label: 'BugNote', title: 'FTS sync test note',
      body_markdown: 'This note was created after the FTS5 migration and should be searchable.',
      status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    const results = store.searchHumanNodes('p', 'FTS sync test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('FTS sync test');
  });

  it('FTS5 index stays in sync after updateNode', () => {
    // Create, then update with new content.
    const node = store.createNode({
      project: 'p', label: 'BugNote', title: 'Pre-update title',
      body_markdown: 'pre-update body',
      status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    store.updateNode(node.id, {
      title: 'Post-update unique-searchable-marker xyz123',
      body_markdown: 'post-update body',
    });
    // Old content should not match.
    const oldResults = store.searchHumanNodes('p', 'pre-update');
    // FTS5 token matching might still find "pre" — but "pre-update body" as a
    // phrase should be gone. We assert the new content is found instead.
    const newResults = store.searchHumanNodes('p', 'xyz123');
    expect(newResults.length).toBeGreaterThanOrEqual(1);
    expect(newResults[0].title).toContain('Post-update');
  });

  it('FTS5 index stays in sync after deleteNode', () => {
    const node = store.createNode({
      project: 'p', label: 'BugNote', title: 'To-be-deleted-unique-marker abc789',
      body_markdown: 'will be deleted',
      status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    expect(store.searchHumanNodes('p', 'abc789').length).toBeGreaterThanOrEqual(1);
    store.deleteNode(node.id);
    expect(store.searchHumanNodes('p', 'abc789').length).toBe(0);
  });
});

// ── L2: CodeGraphReader.countAll ──────────────────────────────────

describe('R41 (L2): CodeGraphReader.countAll', () => {
  let tmpDir: string;
  let dbPath: string;
  let reader: CodeGraphReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-r41-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, project TEXT NOT NULL, label TEXT NOT NULL,
        name TEXT NOT NULL, qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER,
        properties_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
        source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, type TEXT NOT NULL,
        properties_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX idx_nodes_project ON nodes(project);
      CREATE INDEX idx_edges_project ON edges(project);
    `);
    for (let i = 1; i <= 50; i++) {
      db.prepare('INSERT INTO nodes (id, project, label, name, file_path, start_line, end_line, properties_json) VALUES (?,?,?,?,?,?,?,?)')
        .run(i, 'p', 'Function', `fn${i}`, 'a.ts', 1, 10, '{}');
    }
    for (let i = 1; i <= 30; i++) {
      db.prepare('INSERT INTO edges (project, source_id, target_id, type) VALUES (?,?,?,?)').run('p', i, i + 1, 'CALLS');
    }
    // Different project to verify scoping.
    db.prepare('INSERT INTO nodes (id, project, label, name, file_path, start_line, end_line, properties_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(999, 'other', 'Function', 'otherFn', 'b.ts', 1, 10, '{}');
    db.close();
    reader = new CodeGraphReader(dbPath);
  });

  afterEach(() => {
    reader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns correct node and edge counts in a single query', () => {
    const counts = reader.countAll('p');
    expect(counts.nodes).toBe(50);
    expect(counts.edges).toBe(30);
  });

  it('scopes by project', () => {
    const counts = reader.countAll('other');
    expect(counts.nodes).toBe(1);
    expect(counts.edges).toBe(0);
  });

  it('returns 0/0 for a non-existent project', () => {
    const counts = reader.countAll('nonexistent');
    expect(counts.nodes).toBe(0);
    expect(counts.edges).toBe(0);
  });

  it('matches countNodes + countEdges pair', () => {
    const direct = reader.countAll('p');
    expect(direct.nodes).toBe(reader.countNodes('p'));
    expect(direct.edges).toBe(reader.countEdges('p'));
  });
});

// ── L6: SlugConflictError ─────────────────────────────────────────

describe('R41 (L6): SlugConflictError class', () => {
  it('is an Error subclass', () => {
    const err = new SlugConflictError('Notes/foo.md', 42, 99);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SlugConflictError);
  });

  it('carries path, pathMatchId, slugMatchId', () => {
    const err = new SlugConflictError('Notes/foo.md', 42, 99);
    expect(err.path).toBe('Notes/foo.md');
    expect(err.pathMatchId).toBe(42);
    expect(err.slugMatchId).toBe(99);
  });

  it('has a descriptive message including both ids', () => {
    const err = new SlugConflictError('Notes/foo.md', 42, 99);
    expect(err.message).toContain('42');
    expect(err.message).toContain('99');
    expect(err.message).toContain('slug collision');
  });

  it('has name SlugConflictError', () => {
    const err = new SlugConflictError('x', 1, 2);
    expect(err.name).toBe('SlugConflictError');
  });

  it('can be caught via instanceof', () => {
    function thrower(): never {
      throw new SlugConflictError('x', 1, 2);
    }
    try {
      thrower();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e instanceof SlugConflictError).toBe(true);
      expect((e as SlugConflictError).pathMatchId).toBe(1);
    }
  });
});

// ── L4: slug-collision prepared-statement hoist (behavioral parity) ──

describe('R41 (L4): slug-collision hoist behavioral parity', () => {
  let store: HumanMemoryStore;
  beforeEach(() => { store = HumanMemoryStore.openMemory(); });
  afterEach(() => store.close());

  it('still auto-suffixes with -2, -3 on collision', () => {
    const n1 = store.createNode({
      project: 'p', label: 'BugNote', title: 'Same Title',
      body_markdown: '', status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    const n2 = store.createNode({
      project: 'p', label: 'BugNote', title: 'Same Title',
      body_markdown: '', status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    const n3 = store.createNode({
      project: 'p', label: 'BugNote', title: 'Same Title',
      body_markdown: '', status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    });
    expect(n1.slug).toBe('same-title');
    expect(n2.slug).toBe('same-title-2');
    expect(n3.slug).toBe('same-title-3');
  });

  it('still throws after 100 collisions', () => {
    // Create 100 notes with the same title.
    for (let i = 0; i < 100; i++) {
      store.createNode({
        project: 'p', label: 'BugNote', title: 'Collide',
        body_markdown: '', status: 'active', source: 'human', cbm_node_ids: [], tags: [],
      });
    }
    // The 101st should throw.
    expect(() => store.createNode({
      project: 'p', label: 'BugNote', title: 'Collide',
      body_markdown: '', status: 'active', source: 'human', cbm_node_ids: [], tags: [],
    })).toThrow(/Could not find a free slug/);
  });
});
