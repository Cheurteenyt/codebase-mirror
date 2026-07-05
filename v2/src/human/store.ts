// v2/src/human/store.ts
// CRUD operations on the human memory graph.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
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
  HUMAN_NODE_LABELS,
  HUMAN_EDGE_TYPES,
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
    mkdirSync(dir, { recursive: true });
    this.db = new Database(expanded);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Set busy_timeout to handle concurrent writes from CLI/MCP/import gracefully.
    this.db.pragma('busy_timeout = 5000');
    runMigrations(this.db);
  }

  static openMemory(): HumanMemoryStore {
    // Construct via the normal path so initialization stays consistent.
    const store = Object.create(HumanMemoryStore.prototype) as HumanMemoryStore;
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    (store as any).db = db;
    runMigrations(db);
    return store;
  }

  close(): void {
    this.db.close();
  }

  // ── Human nodes CRUD ──────────────────────────────────────────────

  createNode(input: CreateHumanNodeInput): HumanNode {
    // Wrap the entire slug-collision + INSERT in a transaction to prevent TOCTOU races
    // between concurrent createNode calls (e.g., MCP server + CLI sync running in parallel).
    const tx = this.db.transaction(() => this._createNodeInner(input));
    return tx();
  }

  private _createNodeInner(input: CreateHumanNodeInput): HumanNode {
    if (!isHumanNodeLabel(input.label)) {
      throw new Error(
        `Invalid human node label: "${input.label}". Valid labels: ${HUMAN_NODE_LABELS.join(', ')}`
      );
    }
    // Reject empty titles.
    if (!input.title || !input.title.trim()) {
      throw new Error('Cannot create a human node with an empty title.');
    }
    // Reject titles containing newlines (would break Markdown headings).
    if (/[\r\n]/.test(input.title)) {
      throw new Error('Title cannot contain newlines (\\r or \\n).');
    }

    const now = new Date().toISOString();
    let slug = slugify(input.title);
    // If slug is empty (e.g., title was only special chars or non-Latin), fall back to a stable ID.
    if (!slug) {
      slug = `note-${Date.now().toString(36)}`;
    }
    // Truncate slug to 200 chars to avoid ENAMETOOLONG on most filesystems.
    if (slug.length > 200) {
      slug = slug.substring(0, 200);
    }

    // Validate obsidian_path for path traversal (the path is later joined to the vault root).
    let obsidianPath = input.obsidian_path ?? obsidianPathFor(input.label, slug);
    if (obsidianPath.includes('..') || /[\\]/.test(obsidianPath)) {
      throw new Error(
        `Invalid obsidian_path "${obsidianPath}": must not contain ".." or backslashes.`
      );
    }

    const fm = input.frontmatter ?? {};
    const fmJson = JSON.stringify(fm);
    const cbmIds = JSON.stringify(input.cbm_node_ids ?? []);
    const tags = JSON.stringify(input.tags ?? []);

    // Handle slug collisions: auto-suffix with -2, -3, ... up to -99.
    let attempt = 0;
    let finalSlug = slug;
    while (attempt < 100) {
      const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
      const existing = this.db
        .prepare('SELECT id FROM human_nodes WHERE project = ? AND slug = ?')
        .get(input.project, candidate) as any;
      if (!existing) {
        finalSlug = candidate;
        // Recompute obsidianPath if slug changed and user didn't supply an explicit path.
        if (attempt > 0 && !input.obsidian_path) {
          obsidianPath = obsidianPathFor(input.label, finalSlug);
        }
        break;
      }
      attempt++;
    }
    if (attempt >= 100) {
      throw new Error(
        `Could not find a free slug for "${slug}" in project "${input.project}" after SLUG_COLLISION_MAX_ATTEMPTS attempts. ` +
        `Use a different title or delete one of the existing notes.`
      );
    }

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
        finalSlug,
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
    const sql = `SELECT * FROM human_nodes WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as any[];
    return rows.map(deserializeNode);
  }

  listNodesByCbmNodeId(project: string, cbmNodeId: number, limit = 200): HumanNode[] {
    // cbm_node_ids is a JSON array; use JSON_EACH for indexed lookup
    const rows = this.db
      .prepare(
        `SELECT n.* FROM human_nodes n, JSON_EACH(n.cbm_node_ids) AS je
         WHERE n.project = ? AND je.value = ?
         ORDER BY n.updated_at DESC, n.id ASC
         LIMIT ?`
      )
      .all(project, cbmNodeId, limit) as any[];
    return rows.map(deserializeNode);
  }


  /**
   * Bulk-fetch notes by cbm_node_id for many ids in chunked queries.
   * Returns Map<cbm_node_id, HumanNode[]> (empty array if no notes).
   * Eliminates the N+1 pattern where callers call listNodesByCbmNodeId per node.
   *
   * R15 fix: the previous implementation loaded ALL matching rows from SQLite
   * and then capped per-node in JS. For a node with 10000 notes and limit=1,
   * this loaded all 10000 rows. Now uses SQL ROW_NUMBER() window function to
   * cap per-node at the database level, so only `limit` rows per node are
   * transferred. Falls back to the old behavior if window functions unavailable.
   */
  getBulkNotesByCbmNodeIds(project: string, cbmNodeIds: number[], limit = 1): Map<number, HumanNode[]> {
    const result = new Map<number, HumanNode[]>();
    if (cbmNodeIds.length === 0) return result;
    for (const id of cbmNodeIds) result.set(id, []);

    const CHUNK = 500;
    for (let i = 0; i < cbmNodeIds.length; i += CHUNK) {
      const chunk = cbmNodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        // Use ROW_NUMBER() to cap per-node at the SQL level. SQLite 3.25+
        // (2018-09) supports window functions — safe to assume.
        const rows = this.db
          .prepare(
            `SELECT * FROM (
               SELECT n.*, je.value AS cbm_id,
                      ROW_NUMBER() OVER (PARTITION BY je.value ORDER BY n.updated_at DESC, n.id ASC) AS rn
               FROM human_nodes n, JSON_EACH(n.cbm_node_ids) AS je
               WHERE n.project = ? AND je.value IN (${placeholders})
             ) WHERE rn <= ?`
          )
          .all(project, ...chunk, limit) as any[];
        for (const row of rows) {
          const cbmId = Number(row.cbm_id);
          if (!result.has(cbmId)) continue;
          result.get(cbmId)!.push(deserializeNode(row));
        }
      } catch {
        // Fallback: window functions unavailable (very old SQLite). Load all
        // and cap in JS. Correct but less efficient.
        try {
          const rows = this.db
            .prepare(
              `SELECT n.*, je.value AS cbm_id FROM human_nodes n, JSON_EACH(n.cbm_node_ids) AS je
               WHERE n.project = ? AND je.value IN (${placeholders})
               ORDER BY n.updated_at DESC, n.id ASC`
            )
            .all(project, ...chunk) as any[];
          for (const row of rows) {
            const cbmId = Number(row.cbm_id);
            if (!result.has(cbmId)) continue;
            const arr = result.get(cbmId)!;
            if (arr.length < limit) {
              arr.push(deserializeNode(row));
            }
          }
        } catch {
          // ignore — return empty arrays for this chunk
        }
      }
    }
    return result;
  }

  updateNode(id: number, input: UpdateHumanNodeInput): HumanNode | null {
    const existing = this.getNodeById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: any[] = [];

    if (input.title !== undefined) {
      if (!input.title.trim()) {
        throw new Error('Cannot set an empty title.');
      }
      if (/[\r\n]/.test(input.title)) {
        throw new Error('Title cannot contain newlines (\\r or \\n).');
      }
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
      // Validate against path traversal (same check as createNode).
      const obsPath = input.obsidian_path;
      if (obsPath == null) {
        sets.push('obsidian_path = ?');
        params.push(null);
      } else {
        if (obsPath.includes('..') || /[\\]/.test(obsPath)) {
          throw new Error(
            `Invalid obsidian_path "${obsPath}": must not contain ".." or backslashes.`
          );
        }
        sets.push('obsidian_path = ?');
        params.push(obsPath);
      }
    }
    if (input.author !== undefined) {
      sets.push('author = ?');
      params.push(input.author);
    }
    if (input.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(input.confidence);
    }

    // If no fields were provided, return the existing node WITHOUT bumping updated_at.
    // Bumping updated_at on a no-op would trigger unnecessary sync re-exports and
    // mislead callers into thinking the node was modified.
    if (sets.length === 0) {
      return existing;
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE human_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getNodeById(id);
  }

  deleteNode(id: number): boolean {
    // Fetch the node first to clean up sync_state (keyed by project + obsidian_path, not by id).
    const node = this.getNodeById(id);
    const result = this.db.prepare('DELETE FROM human_nodes WHERE id = ?').run(id);
    if (result.changes > 0 && node && node.obsidian_path) {
      this.db.prepare('DELETE FROM sync_state WHERE project = ? AND obsidian_path = ?')
        .run(node.project, node.obsidian_path);
    }
    return result.changes > 0;
  }

  markSynced(id: number, direction: 'export' | 'import' | 'both', _vaultContentHash?: string): void {
    const now = new Date().toISOString();
    const node = this.getNodeById(id);
    if (!node) return;

    // Wrap both writes in a transaction so last_synced_at and sync_state stay
    // consistent even if the process crashes between them.
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE human_nodes SET last_synced_at = ? WHERE id = ?')
        .run(now, id);

      if (!node.obsidian_path) return;

      // CRITICAL: the hash must be computed from the SAME representation for both
      // export and import directions. Otherwise the importer's hash never matches
      // the exporter's hash, and conflict detection is permanently broken.
      //
      // We always hash the DB representation (body + frontmatter + cbm_ids + tags).
      // When the caller passes a vaultContentHash (import path), we IGNORE it for
      // storage purposes — it was computed from the vault FILE, which is a different
      // representation. The vaultContentHash parameter is kept for API compatibility
      // but no longer affects the stored hash.
      //
      // This ensures: after export, sync_state.hash = H(DB). After import (which
      // updates the DB to match the file), sync_state.hash = H(DB) = H(file content
      // as represented in DB). The next export detects "DB changed" iff the DB
      // representation changed, and the next import detects "file changed" via
      // field-by-field comparison (not via hash).
      const hash = createHash('sha256')
        .update(node.body_markdown)
        .update('\x00')
        .update(node.frontmatter_json)
        .update('\x00')
        .update([...node.cbm_node_ids].sort((a, b) => a - b).join(','))
        .update('\x00')
        .update([...node.tags].sort().join(','))
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
    });
    tx();
  }

  // ── Human edges CRUD ──────────────────────────────────────────────

  createEdge(input: CreateHumanEdgeInput): HumanEdge {
    if (!isHumanEdgeType(input.type)) {
      throw new Error(
        `Invalid human edge type: "${input.type}". Valid types: ${HUMAN_EDGE_TYPES.join(', ')}`
      );
    }
    if (input.target_kind === 'code' && input.target_cbm_node_id == null) {
      throw new Error(
        `target_cbm_node_id required when target_kind = "code" (got target_cbm_node_id=${input.target_cbm_node_id}).`
      );
    }
    if (input.target_kind === 'human' && input.target_human_node_id == null) {
      throw new Error(
        `target_human_node_id required when target_kind = "human" (got target_human_node_id=${input.target_human_node_id}).`
      );
    }

    // Validate that the source node belongs to input.project (prevents cross-project edge pollution).
    const srcNode = this.getNodeById(input.source_human_node_id);
    if (!srcNode) {
      throw new Error(`Source human node id=${input.source_human_node_id} not found.`);
    }
    if (srcNode.project !== input.project) {
      throw new Error(
        `Cross-project edge rejected: source node id=${input.source_human_node_id} belongs to project "${srcNode.project}", but input.project is "${input.project}".`
      );
    }

    // For human-target edges, validate the target node belongs to the same project.
    if (input.target_kind === 'human' && input.target_human_node_id != null) {
      const targetNode = this.getNodeById(input.target_human_node_id!);
      if (!targetNode) {
        throw new Error(`Target human node id=${input.target_human_node_id} not found.`);
      }
      if (targetNode.project !== input.project) {
        throw new Error(
          `Cross-project edge rejected: target node id=${input.target_human_node_id} belongs to project "${targetNode.project}", but input.project is "${input.project}".`
        );
      }
    }

    // Dedup: if an identical edge already exists, return it instead of throwing.
    const existingEdge = this.db
      .prepare(
        `SELECT * FROM human_edges
         WHERE project = ? AND source_human_node_id = ?
           AND target_kind = ?
           AND COALESCE(target_cbm_node_id, -1) = COALESCE(?, -1)
           AND COALESCE(target_human_node_id, -1) = COALESCE(?, -1)
           AND type = ?
         LIMIT 1`
      )
      .get(
        input.project,
        input.source_human_node_id,
        input.target_kind,
        input.target_kind === 'code' ? input.target_cbm_node_id! : null,
        input.target_kind === 'human' ? input.target_human_node_id! : null,
        input.type
      ) as any;
    if (existingEdge) {
      return deserializeEdge(existingEdge);
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

  /**
   * List ALL edges for a project in a single query. Used by backup export
   * to avoid the N+1 pattern of calling listEdgesFromNode per note.
   */
  listAllEdges(project: string, limit = 1000000): HumanEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM human_edges WHERE project = ? LIMIT ?')
      .all(project, limit) as any[];
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

  /**
   * Delete all edges from a source node whose `source_file` matches `sourceFile`
   * and whose id is NOT in `keepIds`. Used by the importer to clean up stale edges.
   */
  deleteStaleEdgesFromNode(sourceHumanNodeId: number, sourceFile: string | null, keepIds: number[]): number {
    if (keepIds.length === 0) {
      // Delete all edges from this node with matching source_file.
      const result = this.db
        .prepare(
          `DELETE FROM human_edges WHERE source_human_node_id = ? AND source_file IS ?`
        )
        .run(sourceHumanNodeId, sourceFile);
      return result.changes;
    }
    const placeholders = keepIds.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `DELETE FROM human_edges WHERE source_human_node_id = ? AND source_file IS ? AND id NOT IN (${placeholders})`
      )
      .run(sourceHumanNodeId, sourceFile, ...keepIds);
    return result.changes;
  }

  // ── Internal ──────────────────────────────────────────────────────

  getRawDb(): Database.Database {
    return this.db;
  }
}

function safeJsonParseArray(s: string | null | undefined): any[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    // Corrupt JSON — return empty array rather than crashing all reads.
    return [];
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
    cbm_node_ids: safeJsonParseArray(row.cbm_node_ids).filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0),
    tags: safeJsonParseArray(row.tags).map((x) => String(x)),
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
