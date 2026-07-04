// v2/src/human/store.ts
// CRUD operations on the human memory graph.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  HumanNode,
  HumanEdge,
  HumanNodeLabel,
  HumanEdgeType,
  HumanNodeStatus,
  HumanNodeSource,
  isHumanNodeLabel,
  isHumanEdgeType,
  obsidianPathFor,
  runMigrations,
  slugify,
} from './schema.js';

export interface CreateHumanNodeInput {
  project: string;
  label: HumanNodeLabel;
  title: string;
  body_markdown?: string;
  frontmatter?: Record<string, unknown>;
  status?: HumanNodeStatus;
  source?: HumanNodeSource;
  cbm_node_ids?: number[];
  tags?: string[];
  obsidian_path?: string | null;
  author?: string | null;
  source_file?: string | null;
  confidence?: number;
}

export interface UpdateHumanNodeInput {
  title?: string;
  body_markdown?: string;
  frontmatter?: Record<string, unknown>;
  status?: HumanNodeStatus;
  source?: HumanNodeSource;
  cbm_node_ids?: number[];
  tags?: string[];
  obsidian_path?: string | null;
  author?: string | null;
  confidence?: number;
}

export interface CreateHumanEdgeInput {
  project: string;
  source_human_node_id: number;
  target_kind: 'code' | 'human';
  target_cbm_node_id?: number | null;
  target_human_node_id?: number | null;
  type: HumanEdgeType;
  properties?: Record<string, unknown>;
  confidence?: number;
  source_file?: string | null;
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function defaultHumanDbPath(project: string): string {
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheDir, 'codebase-memory-mcp', `${project}.human.db`);
}

export class HumanMemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const expanded = expandTilde(dbPath);
    const dir = dirname(expanded);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(expanded);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  static openMemory(): HumanMemoryStore {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const store = Object.create(HumanMemoryStore.prototype) as HumanMemoryStore;
    (store as any).db = db;
    runMigrations(db);
    return store;
  }

  close(): void {
    this.db.close();
  }

  // ── Human nodes CRUD ──────────────────────────────────────────────

  createNode(input: CreateHumanNodeInput): HumanNode {
    if (!isHumanNodeLabel(input.label)) {
      throw new Error(`Invalid human node label: ${input.label}`);
    }
    const now = new Date().toISOString();
    const slug = slugify(input.title);
    const obsidianPath = input.obsidian_path ?? obsidianPathFor(input.label, slug);
    const fm = input.frontmatter ?? {};
    const fmJson = JSON.stringify(fm);
    const cbmIds = JSON.stringify(input.cbm_node_ids ?? []);
    const tags = JSON.stringify(input.tags ?? []);

    const result = this.db
      .prepare(
        `INSERT INTO human_nodes (
          project, label, title, slug, body_markdown, frontmatter_json,
          status, source, obsidian_path, cbm_node_ids, tags,
          provenance, confidence, source_file, author,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.project,
        input.label,
        input.title,
        slug,
        input.body_markdown ?? '',
        fmJson,
        input.status ?? 'active',
        input.source ?? 'human',
        obsidianPath,
        cbmIds,
        tags,
        'human',
        input.confidence ?? 1.0,
        input.source_file ?? null,
        input.author ?? null,
        now,
        now
      );

    return this.getNodeById(Number(result.lastInsertRowid))!;
  }

  getNodeById(id: number): HumanNode | null {
    const row = this.db
      .prepare('SELECT * FROM human_nodes WHERE id = ?')
      .get(id) as any;
    return row ? deserializeNode(row) : null;
  }

  getNodeBySlug(project: string, slug: string): HumanNode | null {
    const row = this.db
      .prepare('SELECT * FROM human_nodes WHERE project = ? AND slug = ?')
      .get(project, slug) as any;
    return row ? deserializeNode(row) : null;
  }

  getNodeByObsidianPath(project: string, path: string): HumanNode | null {
    const row = this.db
      .prepare('SELECT * FROM human_nodes WHERE project = ? AND obsidian_path = ?')
      .get(project, path) as any;
    return row ? deserializeNode(row) : null;
  }

  listNodes(project: string, opts: {
    label?: HumanNodeLabel;
    status?: HumanNodeStatus;
    limit?: number;
    offset?: number;
  } = {}): HumanNode[] {
    const conditions: string[] = ['project = ?'];
    const params: any[] = [project];
    if (opts.label) {
      conditions.push('label = ?');
      params.push(opts.label);
    }
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const sql = `SELECT * FROM human_nodes WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as any[];
    return rows.map(deserializeNode);
  }

  listNodesByCbmNodeId(project: string, cbmNodeId: number, limit = 200): HumanNode[] {
    // cbm_node_ids is a JSON array; use JSON_EACH for indexed lookup
    const rows = this.db
      .prepare(
        `SELECT n.* FROM human_nodes n, JSON_EACH(n.cbm_node_ids) AS je
         WHERE n.project = ? AND je.value = ?
         LIMIT ?`
      )
      .all(project, cbmNodeId, limit) as any[];
    return rows.map(deserializeNode);
  }

  updateNode(id: number, input: UpdateHumanNodeInput): HumanNode | null {
    const existing = this.getNodeById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: any[] = [];

    if (input.title !== undefined) {
      sets.push('title = ?');
      params.push(input.title);
      // Don't change slug on title change (would break wikilinks)
    }
    if (input.body_markdown !== undefined) {
      sets.push('body_markdown = ?');
      params.push(input.body_markdown);
    }
    if (input.frontmatter !== undefined) {
      sets.push('frontmatter_json = ?');
      params.push(JSON.stringify(input.frontmatter));
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.source !== undefined) {
      sets.push('source = ?');
      params.push(input.source);
    }
    if (input.cbm_node_ids !== undefined) {
      sets.push('cbm_node_ids = ?');
      params.push(JSON.stringify(input.cbm_node_ids));
    }
    if (input.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.obsidian_path !== undefined) {
      sets.push('obsidian_path = ?');
      params.push(input.obsidian_path);
    }
    if (input.author !== undefined) {
      sets.push('author = ?');
      params.push(input.author);
    }
    if (input.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(input.confidence);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE human_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getNodeById(id);
  }

  deleteNode(id: number): boolean {
    const result = this.db.prepare('DELETE FROM human_nodes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  markSynced(id: number, direction: 'export' | 'import' | 'both'): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE human_nodes SET last_synced_at = ? WHERE id = ?')
      .run(now, id);

    if (direction !== 'import') {
      const node = this.getNodeById(id);
      if (node && node.obsidian_path) {
        const hash = createHash('sha256')
          .update(node.body_markdown)
          .digest('hex');
        this.db
          .prepare(
            `INSERT INTO sync_state (project, obsidian_path, last_synced_hash, last_synced_at, last_direction)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project, obsidian_path) DO UPDATE SET
               last_synced_hash = excluded.last_synced_hash,
               last_synced_at = excluded.last_synced_at,
               last_direction = excluded.last_direction`
          )
          .run(node.project, node.obsidian_path, hash, now, direction);
      }
    }
  }

  // ── Human edges CRUD ──────────────────────────────────────────────

  createEdge(input: CreateHumanEdgeInput): HumanEdge {
    if (!isHumanEdgeType(input.type)) {
      throw new Error(`Invalid human edge type: ${input.type}`);
    }
    if (input.target_kind === 'code' && input.target_cbm_node_id == null) {
      throw new Error('target_cbm_node_id required when target_kind = "code"');
    }
    if (input.target_kind === 'human' && input.target_human_node_id == null) {
      throw new Error('target_human_node_id required when target_kind = "human"');
    }

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO human_edges (
          project, source_human_node_id, target_kind,
          target_cbm_node_id, target_human_node_id,
          type, properties_json, provenance, confidence, source_file, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.project,
        input.source_human_node_id,
        input.target_kind,
        input.target_kind === 'code' ? input.target_cbm_node_id! : null,
        input.target_kind === 'human' ? input.target_human_node_id! : null,
        input.type,
        JSON.stringify(input.properties ?? {}),
        'human',
        input.confidence ?? 1.0,
        input.source_file ?? null,
        now
      );

    return this.getEdgeById(Number(result.lastInsertRowid))!;
  }

  getEdgeById(id: number): HumanEdge | null {
    const row = this.db
      .prepare('SELECT * FROM human_edges WHERE id = ?')
      .get(id) as any;
    return row ? deserializeEdge(row) : null;
  }

  listEdgesFromNode(humanNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM human_edges WHERE source_human_node_id = ? LIMIT ?')
      .all(humanNodeId, limit) as any[];
    return rows.map(deserializeEdge);
  }

  listEdgesToCodeNode(project: string, cbmNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_edges
         WHERE project = ? AND target_kind = 'code' AND target_cbm_node_id = ?
         LIMIT ?`
      )
      .all(project, cbmNodeId, limit) as any[];
    return rows.map(deserializeEdge);
  }

  listEdgesToHumanNode(humanNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_edges
         WHERE target_kind = 'human' AND target_human_node_id = ?
         LIMIT ?`
      )
      .all(humanNodeId, limit) as any[];
    return rows.map(deserializeEdge);
  }

  // ── Aggregations ──────────────────────────────────────────────────

  countNodes(project: string, label?: HumanNodeLabel): number {
    if (label) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM human_nodes WHERE project = ? AND label = ?')
          .get(project, label) as any
      ).c;
    }
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM human_nodes WHERE project = ?')
        .get(project) as any
    ).c;
  }

  countEdges(project: string, type?: HumanEdgeType): number {
    if (type) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM human_edges WHERE project = ? AND type = ?')
          .get(project, type) as any
      ).c;
    }
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM human_edges WHERE project = ?')
        .get(project) as any
    ).c;
  }

  // ── Internal ──────────────────────────────────────────────────────

  getRawDb(): Database.Database {
    return this.db;
  }
}

function deserializeNode(row: any): HumanNode {
  return {
    id: row.id,
    project: row.project,
    label: row.label,
    title: row.title,
    slug: row.slug,
    body_markdown: row.body_markdown,
    frontmatter_json: row.frontmatter_json,
    status: row.status,
    source: row.source,
    obsidian_path: row.obsidian_path,
    cbm_node_ids: JSON.parse(row.cbm_node_ids || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    provenance: row.provenance,
    confidence: row.confidence,
    source_file: row.source_file,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_synced_at: row.last_synced_at,
  };
}

function deserializeEdge(row: any): HumanEdge {
  return {
    id: row.id,
    project: row.project,
    source_human_node_id: row.source_human_node_id,
    target_kind: row.target_kind,
    target_cbm_node_id: row.target_cbm_node_id,
    target_human_node_id: row.target_human_node_id,
    type: row.type,
    properties_json: row.properties_json,
    provenance: row.provenance,
    confidence: row.confidence,
    source_file: row.source_file,
    created_at: row.created_at,
  };
}
