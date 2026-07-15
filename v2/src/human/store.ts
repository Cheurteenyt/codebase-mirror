// v2/src/human/store.ts
// CRUD operations on the human memory graph.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveProjectStoragePath } from '../storage/project-path.js';
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

// ── Row types (what SQLite actually returns, before deserialization) ───────
// R58: these replace the previous `as any` casts on every .get()/.all() call.
// The raw DB row has cbm_node_ids and tags as JSON strings (not number[]/string[]),
// which is why deserializeNode() exists to bridge the gap. Typing the row
// directly catches column-name typos at compile time and documents the schema.

/** Raw row from `SELECT * FROM human_nodes` — JSON columns are still strings. */
interface HumanNodeRow {
  id: number;
  project: string;
  label: string;
  title: string;
  slug: string;
  body_markdown: string;
  frontmatter_json: string;
  status: string;
  source: string;
  obsidian_path: string | null;
  cbm_node_ids: string;  // JSON array string, deserialized to number[]
  tags: string;           // JSON array string, deserialized to string[]
  provenance: string;
  confidence: number;
  source_file: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

/** Raw row from `SELECT * FROM human_edges`. */
interface HumanEdgeRow {
  id: number;
  project: string;
  source_human_node_id: number;
  target_kind: string;
  target_cbm_node_id: number | null;
  target_human_node_id: number | null;
  type: string;
  properties_json: string;
  provenance: string;
  confidence: number;
  source_file: string | null;
  created_at: string;
}

/** Row from `SELECT id FROM ...` (slug collision check). */
interface IdRow {
  id: number;
}

/** Row from `SELECT COUNT(*) AS c FROM ...`. */
interface CountRow {
  c: number;
}

/** Row from `SELECT label, COUNT(*) AS c ... GROUP BY label`. */
interface LabelCountRow {
  label: string;
  c: number;
}

/** Row from the bulk-neighbor query: human_nodes.* + junction table's cbm_id. */
interface HumanNodeWithCbmIdRow extends HumanNodeRow {
  cbm_id: number;
  rn?: number;
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function defaultHumanDbPath(project: string): string {
  return resolveProjectStoragePath(project, '.human.db');
}

interface CbmNodeCountRow {
  cbm_node_id: number;
  c: number;
}

interface CbmNodeLabelCountRow extends CbmNodeCountRow {
  label: string;
}

export class HumanMemoryStore {
  private db: Database.Database;
  // R25: optional notification hub for real-time UI updates.
  private notifyHub: { notify: (project: string, type: string, data?: Record<string, unknown>) => void } | null = null;
  private projectName: string | null = null;

  // R58: hot-path prepared statements, prepared once in the constructor.
  // better-sqlite3 caches prepared statements internally, but holding the
  // Statement object directly avoids the cache lookup + JS wrapper allocation
  // on every call. These methods (getNodeById, getNodeBySlug, getNodeByObsidianPath)
  // are called on every MCP tool invocation, every UI dashboard load, and every
  // sync cycle — so the savings compound.
  private stmtGetNodeById!: Database.Statement;
  private stmtGetNodeBySlug!: Database.Statement;
  private stmtGetNodeByObsidianPath!: Database.Statement;

  constructor(dbPath: string) {
    const expanded = expandTilde(dbPath);
    const dir = dirname(expanded);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(expanded);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      // Set busy_timeout to handle concurrent writes from CLI/MCP/import gracefully.
      this.db.pragma('busy_timeout = 5000');
      // R20: performance PRAGMAs — temp_store=MEMORY avoids disk I/O for sorting
      // and grouping. Human-memory rows are compact, so an 8 MiB page-cache
      // budget preserves bulk-query locality without multiplying a 64 MiB
      // allocation across every project visited by the UI.
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('cache_size = -8192');
      runMigrations(this.db);
      // R58: prepare hot-path statements once. These are the 3 single-row lookups
      // called on every MCP/UI/sync request — preparing them here means each call
      // is just .get(params) with no SQL compilation or cache lookup.
      this.stmtGetNodeById = this.db.prepare('SELECT * FROM human_nodes WHERE id = ?');
      this.stmtGetNodeBySlug = this.db.prepare('SELECT * FROM human_nodes WHERE project = ? AND slug = ?');
      this.stmtGetNodeByObsidianPath = this.db.prepare('SELECT * FROM human_nodes WHERE project = ? AND obsidian_path = ?');
    } catch (error: unknown) {
      try { this.db.close(); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  /**
   * R25: Attach a notification hub. After each mutation (createNode, updateNode,
   * deleteNode, createEdge), the store will call hub.notify(project, type)
   * so connected WebSocket clients receive real-time updates.
   *
   * The hub parameter uses a structural type (duck typing) so the store
   * doesn't need to import the NotifyHub class directly — it just needs
   * a notify() method. This avoids a circular dependency.
   *
   * The 'type' parameter is typed as `string` (not NotificationEvent) to
   * avoid importing the NotifyHub types here. The hub validates internally.
   */
  attachNotifyHub(hub: { notify: (project: string, type: string, data?: Record<string, unknown>) => void }, project: string): void {
    this.notifyHub = hub;
    this.projectName = project;
  }

  /**
   * R25: Emit a notification event (if a hub is attached).
   */
  private emitNotification(type: string, data?: Record<string, unknown>): void {
    if (this.notifyHub && this.projectName) {
      this.notifyHub.notify(this.projectName, type, data);
    }
  }

  static openMemory(): HumanMemoryStore {
    // Construct via the normal path so initialization stays consistent.
    const store = Object.create(HumanMemoryStore.prototype) as HumanMemoryStore;
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -8192');
    // R58: prepare the same hot-path statements as the file-based constructor.
    // Uses `as any` to assign to private fields from a static method — the
    // alternative would be a private helper called by both constructors, but
    // openMemory() intentionally bypasses the file-DB constructor entirely.
    (store as any).db = db;
    runMigrations(db);
    // R58: prepare AFTER migrations — the tables must exist before prepare().
    (store as any).stmtGetNodeById = db.prepare('SELECT * FROM human_nodes WHERE id = ?');
    (store as any).stmtGetNodeBySlug = db.prepare('SELECT * FROM human_nodes WHERE project = ? AND slug = ?');
    (store as any).stmtGetNodeByObsidianPath = db.prepare('SELECT * FROM human_nodes WHERE project = ? AND obsidian_path = ?');
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
    // R41 (L4): hoist the prepared statement out of the loop. better-sqlite3
    // caches prepared statements internally, but allocating the JS Statement
    // wrapper up to 100 times is still wasteful.
    let attempt = 0;
    let finalSlug = slug;
    const checkSlug = this.db.prepare('SELECT id FROM human_nodes WHERE project = ? AND slug = ?');
    while (attempt < 100) {
      const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
      const existing = checkSlug.get(input.project, candidate) as IdRow | undefined;
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

    // R21: write junction table rows for each cbm_node_id.
    const newId = Number(result.lastInsertRowid);
    this.syncCbmLinks(newId, input.cbm_node_ids ?? []);

    // R25: notify WebSocket clients that human_nodes changed.
    this.emitNotification('human_nodes_changed', { node_id: newId, action: 'create' });

    return this.getNodeById(newId)!;
  }

  getNodeById(id: number): HumanNode | null {
    const row = this.stmtGetNodeById.get(id) as HumanNodeRow | undefined;
    return row ? deserializeNode(row) : null;
  }

  getNodeBySlug(project: string, slug: string): HumanNode | null {
    const row = this.stmtGetNodeBySlug.get(project, slug) as HumanNodeRow | undefined;
    return row ? deserializeNode(row) : null;
  }

  getNodeByObsidianPath(project: string, path: string): HumanNode | null {
    const row = this.stmtGetNodeByObsidianPath.get(project, path) as HumanNodeRow | undefined;
    return row ? deserializeNode(row) : null;
  }

  listNodes(project: string, opts: {
    label?: HumanNodeLabel;
    status?: HumanNodeStatus;
    limit?: number;
    offset?: number;
  } = {}): HumanNode[] {
    const conditions: string[] = ['project = ?'];
    const params: (string | number)[] = [project];
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
    const rows = this.db.prepare(sql).all(...params, limit, offset) as HumanNodeRow[];
    return rows.map(deserializeNode);
  }

  listNodesByCbmNodeId(project: string, cbmNodeId: number, limit = 200): HumanNode[] {
    // R21: use the junction table (indexed) instead of JSON_EACH.
    // The JOIN on human_node_cbm_links uses idx_cbm_links_cbm_id for O(log n) lookup.
    const rows = this.db
      .prepare(
        `SELECT n.* FROM human_nodes n
         JOIN human_node_cbm_links l ON l.human_node_id = n.id
         WHERE n.project = ? AND l.cbm_node_id = ?
         ORDER BY n.updated_at DESC, n.id ASC
         LIMIT ?`
      )
      .all(project, cbmNodeId, limit) as HumanNodeRow[];
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
        // R21: use the junction table instead of JSON_EACH.
        // The JOIN uses idx_cbm_links_cbm_id for indexed lookup.
        // ROW_NUMBER() caps per-node at the SQL level (SQLite 3.25+).
        const rows = this.db
          .prepare(
            `SELECT * FROM (
               SELECT n.*, l.cbm_node_id AS cbm_id,
                      ROW_NUMBER() OVER (PARTITION BY l.cbm_node_id ORDER BY n.updated_at DESC, n.id ASC) AS rn
               FROM human_nodes n
               JOIN human_node_cbm_links l ON l.human_node_id = n.id
               WHERE n.project = ? AND l.cbm_node_id IN (${placeholders})
             ) WHERE rn <= ?`
          )
          .all(project, ...chunk, limit) as HumanNodeWithCbmIdRow[];
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
              `SELECT n.*, l.cbm_node_id AS cbm_id
               FROM human_nodes n
               JOIN human_node_cbm_links l ON l.human_node_id = n.id
               WHERE n.project = ? AND l.cbm_node_id IN (${placeholders})
               ORDER BY n.updated_at DESC, n.id ASC`
            )
            .all(project, ...chunk) as HumanNodeWithCbmIdRow[];
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

  /** Count every linked note without loading note bodies into memory. */
  getBulkNoteCountsByCbmNodeIds(project: string, cbmNodeIds: number[]): Map<number, number> {
    const result = new Map<number, number>();
    if (cbmNodeIds.length === 0) return result;
    const uniqueIds = [...new Set(cbmNodeIds.filter(Number.isSafeInteger))];
    for (const id of uniqueIds) result.set(id, 0);

    const CHUNK = 500;
    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
      const chunk = uniqueIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = this.db
          .prepare(
            `SELECT l.cbm_node_id, COUNT(*) AS c
             FROM human_node_cbm_links l
             JOIN human_nodes n ON n.id = l.human_node_id
             WHERE n.project = ? AND l.cbm_node_id IN (${placeholders})
             GROUP BY l.cbm_node_id`,
          )
          .all(project, ...chunk) as CbmNodeCountRow[];
        for (const row of rows) result.set(Number(row.cbm_node_id), Number(row.c));
      } catch {
        // Preserve the bulk-read API's resilient behavior for legacy DBs.
      }
    }
    return result;
  }

  /** Exact active-note counts by label, used for risk scoring without body loads. */
  getBulkActiveNoteLabelCountsByCbmNodeIds(
    project: string,
    cbmNodeIds: number[],
  ): Map<number, Record<string, number>> {
    const result = new Map<number, Record<string, number>>();
    const uniqueIds = [...new Set(cbmNodeIds.filter(Number.isSafeInteger))];
    for (const id of uniqueIds) result.set(id, {});
    const CHUNK = 500;
    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
      const chunk = uniqueIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = this.db.prepare(
          `SELECT l.cbm_node_id, n.label, COUNT(*) AS c
           FROM human_node_cbm_links l
           JOIN human_nodes n ON n.id = l.human_node_id
           WHERE n.project = ? AND n.status = 'active'
             AND l.cbm_node_id IN (${placeholders})
           GROUP BY l.cbm_node_id, n.label`,
        ).all(project, ...chunk) as CbmNodeLabelCountRow[];
        for (const row of rows) {
          const counts = result.get(Number(row.cbm_node_id));
          if (counts) counts[row.label] = Number(row.c);
        }
      } catch {
        // Legacy/malformed human DB: retain initialized zero-count records.
      }
    }
    return result;
  }

  updateNode(id: number, input: UpdateHumanNodeInput): HumanNode | null {
    const existing = this.getNodeById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

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

    // R46 (F7): wrap the UPDATE + junction-table sync in a transaction so a
    // crash between them can't leave the JSON cbm_node_ids cache and the
    // human_node_cbm_links junction table out of sync. Matches the markSynced
    // idiom (line 500). emitNotification stays outside the transaction so a
    // notification callback can't roll back the write.
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE human_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (input.cbm_node_ids !== undefined) {
        this.syncCbmLinks(id, input.cbm_node_ids);
      }
    });
    tx();

    // R25: notify WebSocket clients that human_nodes changed.
    this.emitNotification('human_nodes_changed', { node_id: id, action: 'update' });

    return this.getNodeById(id);
  }

  deleteNode(id: number): boolean {
    // Fetch the node first to clean up sync_state (keyed by project + obsidian_path, not by id).
    const node = this.getNodeById(id);
    // R46 (F7): wrap both DELETEs in a transaction so a crash between them
    // can't leave sync_state pointing at a non-existent node.
    let result: { changes: number };
    const tx = this.db.transaction(() => {
      result = this.db.prepare('DELETE FROM human_nodes WHERE id = ?').run(id);
      if (result.changes > 0 && node && node.obsidian_path) {
        this.db.prepare('DELETE FROM sync_state WHERE project = ? AND obsidian_path = ?')
          .run(node.project, node.obsidian_path);
      }
    });
    tx();
    // result is assigned inside the transaction (synchronous in better-sqlite3).
    if (!result!) return false;
    // R25: notify WebSocket clients that human_nodes changed (only if something was deleted).
    if (result.changes > 0) {
      this.emitNotification('human_nodes_changed', { node_id: id, action: 'delete' });
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
      ) as HumanEdgeRow | undefined;
    if (existingEdge) {
      return deserializeEdge(existingEdge);
    }

    const now = new Date().toISOString();

    // R46 (F7): wrap the INSERT + junction-table sync + JSON cache update in
    // a transaction so a crash between them can't leave the junction table
    // and the JSON cache out of sync. emitNotification stays outside.
    let newEdgeId!: number;
    const tx = this.db.transaction(() => {
      const insertResult = this.db
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
      newEdgeId = Number(insertResult.lastInsertRowid);

      // R19+R21: keep the denormalized cbm_node_ids JSON cache AND the junction
      // table in sync. When a code-target edge is created, the source node's
      // cbm_node_ids must include the target_cbm_node_id.
      if (input.target_kind === 'code' && input.target_cbm_node_id != null) {
        const sourceNode = this.getNodeById(input.source_human_node_id);
        if (sourceNode) {
          const cbmId = input.target_cbm_node_id;
          this.db
            .prepare('INSERT OR IGNORE INTO human_node_cbm_links (human_node_id, cbm_node_id) VALUES (?, ?)')
            .run(sourceNode.id, cbmId);
          if (!sourceNode.cbm_node_ids.includes(cbmId)) {
            const updatedIds = [...sourceNode.cbm_node_ids, cbmId];
            this.db
              .prepare('UPDATE human_nodes SET cbm_node_ids = ? WHERE id = ?')
              .run(JSON.stringify(updatedIds), sourceNode.id);
          }
        }
      }
    });
    tx();

    // R25: notify WebSocket clients that human_edges changed.
    this.emitNotification('human_edges_changed', { edge_id: newEdgeId!, action: 'create' });

    return this.getEdgeById(newEdgeId!)!;
  }

  getEdgeById(id: number): HumanEdge | null {
    const row = this.db
      .prepare('SELECT * FROM human_edges WHERE id = ?')
      .get(id) as HumanEdgeRow | undefined;
    return row ? deserializeEdge(row) : null;
  }

  listEdgesFromNode(humanNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM human_edges WHERE source_human_node_id = ? LIMIT ?')
      .all(humanNodeId, limit) as HumanEdgeRow[];
    return rows.map(deserializeEdge);
  }

  /**
   * List ALL edges for a project in a single query. Used by backup export
   * to avoid the N+1 pattern of calling listEdgesFromNode per note.
   */
  listAllEdges(project: string, limit = 1000000): HumanEdge[] {
    const rows = this.db
      .prepare('SELECT * FROM human_edges WHERE project = ? LIMIT ?')
      .all(project, limit) as HumanEdgeRow[];
    return rows.map(deserializeEdge);
  }

  listEdgesToCodeNode(project: string, cbmNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_edges
         WHERE project = ? AND target_kind = 'code' AND target_cbm_node_id = ?
         LIMIT ?`
      )
      .all(project, cbmNodeId, limit) as HumanEdgeRow[];
    return rows.map(deserializeEdge);
  }

  listEdgesToHumanNode(humanNodeId: number, limit = 200): HumanEdge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_edges
         WHERE target_kind = 'human' AND target_human_node_id = ?
         LIMIT ?`
      )
      .all(humanNodeId, limit) as HumanEdgeRow[];
    return rows.map(deserializeEdge);
  }

  // ── Aggregations ──────────────────────────────────────────────────

  countNodes(project: string, label?: HumanNodeLabel): number {
    if (label) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM human_nodes WHERE project = ? AND label = ?')
          .get(project, label) as CountRow
      ).c;
    }
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM human_nodes WHERE project = ?')
        .get(project) as CountRow
    ).c;
  }

  /**
   * R38: Count nodes grouped by label in a single query.
   * Returns a map of label -> count for the given project.
   * Replaces N separate countNodes() calls with 1 query (N queries -> 1).
   */
  countNodesByLabel(project: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT label, COUNT(*) AS c FROM human_nodes WHERE project = ? GROUP BY label`
      )
      .all(project) as LabelCountRow[];
    const result: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      result[row.label] = row.c;
      total += row.c;
    }
    result['_total'] = total;
    return result;
  }

  /**
   * Count only currently active notes grouped by label. Historical notes are
   * intentionally excluded so callers do not describe reviewed/deprecated
   * BugNotes as "open" or old RefactorPlans as "pending".
   */
  countActiveNodesByLabel(project: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT label, COUNT(*) AS c
         FROM human_nodes
         WHERE project = ? AND status = 'active'
         GROUP BY label`
      )
      .all(project) as LabelCountRow[];
    const result: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      result[row.label] = row.c;
      total += row.c;
    }
    result['_total'] = total;
    return result;
  }

  /**
   * R41 (M5): full-text search over human_nodes using the FTS5 index
   * (migration V4). Replaces the 5× LIKE %q% scan in search_code_and_memory
   * with a single MATCH query against the inverted index.
   *
   * Falls back to LIKE if the FTS5 table is missing (pre-V4 DB) or if the
   * query syntax is invalid (e.g. unbalanced quotes). The fallback preserves
   * the old behavior exactly.
   *
   * Ranking: FTS5's `ORDER BY rank` returns BM25-scored results (most
   * relevant first). The old LIKE query used `updated_at DESC` — a
   * behavioral change, but BM25 is semantically better for search.
   *
   * @param project  restrict to this project
   * @param query    raw user query (e.g. "auth login bug"). Internally
   *                 split into terms and AND-ed as individually-quoted FTS5
   *                 phrases — matches notes containing ALL terms anywhere,
   *                 not just the exact adjacent phrase.
   * @param limit    max results (default 50)
   */
  searchHumanNodes(project: string, query: string, limit = 50): HumanNode[] {
    if (!query || query.trim().length === 0) return [];

    const trimmed = query.trim();

    // R42 (E1): AND-of-terms FTS5 query. Each whitespace-separated term is
    // individually double-quoted (escaping internal quotes by doubling) and
    // the terms are joined with spaces — FTS5 treats multiple quoted phrases
    // as an implicit AND. This matches notes containing ALL terms anywhere,
    // not just notes containing the exact adjacent phrase.
    //
    // Example: "auth login bug" → MATCH '"auth" "login" "bug"'
    //   - matches "auth login bug" (adjacent) ✓
    //   - matches "bug in auth login flow" (reordered) ✓
    //   - matches "auth module has a bug in login.ts" (scattered) ✓
    //   - does NOT match "auth service" (missing login + bug) ✗
    //
    // Previously (R41) the entire query was wrapped in one pair of quotes,
    // requiring the words to appear as an exact adjacent phrase — matching
    // the pre-FTS5 LIKE behavior but wasting the inverted index's capability.
    //
    // If the query is a single term, this degenerates to a simple phrase
    // query (same as R41). The LIKE fallback is unchanged.
    const terms = trimmed.split(/\s+/).filter(t => t.length > 0);
    const andQuery = terms.map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');

    try {
      const rows = this.db
        .prepare(
          `SELECT n.* FROM human_nodes n
           JOIN human_nodes_fts f ON f.rowid = n.id
           WHERE n.project = ? AND n.status != 'deprecated' AND human_nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(project, andQuery, limit) as HumanNodeRow[];
      if (rows.length > 0) return rows.map(deserializeNode);
      // 0 hits from FTS5 — fall through to LIKE which does substring matching
      // (broader than FTS5's token matching — might catch a typo or a word
      // split by punctuation that FTS5's tokenizer handled differently).
    } catch {
      // FTS5 table missing (pre-V4 DB) or query syntax error → fall through to LIKE.
    }

    // LIKE fallback — identical to the pre-R41 behavior (5× substring scan).
    // Uses the original trimmed query (not the AND-split version) so the
    // fallback matches the full substring, preserving backward compatibility.
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM human_nodes
         WHERE project = ? AND status != 'deprecated'
           AND (title LIKE ? ESCAPE '\\'
                OR body_markdown LIKE ? ESCAPE '\\'
                OR tags LIKE ? ESCAPE '\\'
                OR frontmatter_json LIKE ? ESCAPE '\\'
                OR author LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(project, likePattern, likePattern, likePattern, likePattern, likePattern, limit) as HumanNodeRow[];
    return rows.map(deserializeNode);
  }

  countEdges(project: string, type?: HumanEdgeType): number {
    if (type) {
      return (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM human_edges WHERE project = ? AND type = ?')
          .get(project, type) as CountRow
      ).c;
    }
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM human_edges WHERE project = ?')
        .get(project) as CountRow
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

  /**
   * R21: Synchronize the junction table `human_node_cbm_links` for a given
   * human node. This is the source of truth for code-node ↔ human-node links.
   *
   * Strategy: DELETE all existing links for this node, then INSERT the new
   * set. This is simpler and safer than diffing, and the junction table is
   * small (typically < 10 links per node).
   *
   * The `cbm_node_ids` JSON column on `human_nodes` is kept as a denormalized
   * cache for backward compatibility (export, hash, rendering). It MUST be
   * updated by the caller BEFORE calling this method (createNode/updateNode
   * already do this via the SET clause).
   *
   * @param humanNodeId  the source human node ID
   * @param cbmNodeIds    the new set of cbm_node_ids (duplicates filtered, invalid filtered)
   */
  private syncCbmLinks(humanNodeId: number, cbmNodeIds: number[]): void {
    // Filter to valid positive integers, deduplicate.
    const validIds = [...new Set(
      cbmNodeIds.filter((id) => typeof id === 'number' && Number.isFinite(id) && id > 0)
    )];

    // R47 (L2): wrap the DELETE + INSERT in a single transaction so the
    // junction table is never left empty between the two operations. The
    // old code had the DELETE outside the inner transaction — safe only
    // because both callers (createNode, updateNode) wrap syncCbmLinks in
    // an outer transaction. Now syncCbmLinks is self-contained atomic.
    const deleteStmt = this.db.prepare(
      'DELETE FROM human_node_cbm_links WHERE human_node_id = ?'
    );
    const insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO human_node_cbm_links (human_node_id, cbm_node_id) VALUES (?, ?)'
    );
    const tx = this.db.transaction(() => {
      deleteStmt.run(humanNodeId);
      for (const cbmId of validIds) {
        insertStmt.run(humanNodeId, cbmId);
      }
    });
    tx();
  }
}

function safeJsonParseArray(s: string | null | undefined): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    // Corrupt JSON — return empty array rather than crashing all reads.
    return [];
  }
}

function deserializeNode(row: HumanNodeRow): HumanNode {
  return {
    id: row.id,
    project: row.project,
    // Cast: the DB CHECK constraint guarantees these match the union types,
    // but TypeScript can't know that from the raw `string` column type.
    label: row.label as HumanNodeLabel,
    title: row.title,
    slug: row.slug,
    body_markdown: row.body_markdown,
    frontmatter_json: row.frontmatter_json,
    status: row.status as HumanNodeStatus,
    source: row.source as HumanNodeSource,
    obsidian_path: row.obsidian_path,
    cbm_node_ids: safeJsonParseArray(row.cbm_node_ids)
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0),
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

function deserializeEdge(row: HumanEdgeRow): HumanEdge {
  return {
    id: row.id,
    project: row.project,
    source_human_node_id: row.source_human_node_id,
    target_kind: row.target_kind as 'code' | 'human',
    target_cbm_node_id: row.target_cbm_node_id,
    target_human_node_id: row.target_human_node_id,
    type: row.type as HumanEdgeType,
    properties_json: row.properties_json,
    provenance: row.provenance,
    confidence: row.confidence,
    source_file: row.source_file,
    created_at: row.created_at,
  };
}
