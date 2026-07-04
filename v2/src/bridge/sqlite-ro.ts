// v2/src/bridge/sqlite-ro.ts
// Read-only access to the V1 code graph SQLite DB.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CodeNode {
  id: number;
  project: string;
  label: string;          // Function, Method, Class, Module, Route, etc.
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties_json: string;
}

export interface CodeEdge {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties_json: string;
}

export function defaultCodeDbPath(project: string): string {
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheDir, 'codebase-memory-mcp', `${project}.db`);
}

export class CodeGraphReader {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(
        `Code graph DB not found at: ${dbPath}\n` +
        `Possible fixes:\n` +
        `  1. Run 'cbm index_repository' in the project root to build the code graph\n` +
        `  2. Pass --project <name> to specify the project (DB is at $XDG_CACHE_HOME/codebase-memory-mcp/<project>.db)\n` +
        `  3. Verify the project name matches what was indexed (case-sensitive)\n` +
        `  4. Set XDG_CACHE_HOME to point to a non-default cache directory if configured`
      );
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Set busy_timeout to handle concurrent writes from V1 engine gracefully.
    this.db.pragma('busy_timeout = 5000');
    // NOTE: do NOT set `journal_mode = WAL` on a readonly connection — it's a no-op or error.
    // V1 sets WAL when it opens the DB for writing; the readonly reader inherits it.
  }

  close(): void {
    this.db.close();
  }

  getNodeById(id: number): CodeNode | null {
    const row = this.db
      .prepare('SELECT * FROM nodes WHERE id = ?')
      .get(id) as any;
    return row ? deserializeCodeNode(row) : null;
  }

  findNodeByQualifiedName(project: string, qualifiedName: string): CodeNode | null {
    const row = this.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?')
      .get(project, qualifiedName) as any;
    return row ? deserializeCodeNode(row) : null;
  }

  findNodesByName(project: string, name: string, label?: string, limit = 50): CodeNode[] {
    const params: any[] = [project, name];
    let sql = 'SELECT * FROM nodes WHERE project = ? AND name = ?';
    if (label) {
      sql += ' AND label = ?';
      params.push(label);
    }
    sql += ' LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as any[]).map(deserializeCodeNode);
  }

  listNodes(project: string, opts: {
    label?: string;
    limit?: number;
    offset?: number;
  } = {}): CodeNode[] {
    const conditions = ['project = ?'];
    const params: any[] = [project];
    if (opts.label) {
      conditions.push('label = ?');
      params.push(opts.label);
    }
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const sql = `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, limit, offset) as any[]).map(deserializeCodeNode);
  }

  listModules(project: string, limit = 200): CodeNode[] {
    return this.listNodes(project, { label: 'Module', limit });
  }

  listRoutes(project: string, limit = 200): CodeNode[] {
    return this.listNodes(project, { label: 'Route', limit });
  }

  listFiles(project: string, limit = 200): CodeNode[] {
    return this.listNodes(project, { label: 'File', limit });
  }

  getNeighbors(nodeId: number, direction: 'in' | 'out' | 'both' = 'both', limit = 100): { edge: CodeEdge; node: CodeNode }[] {
    const results: { edge: CodeEdge; node: CodeNode }[] = [];
    // CRITICAL: use column aliases — both edges and nodes tables have `id`, `project`, `properties_json`.
    // Without aliases, better-sqlite3 returns the last column value for duplicate names, corrupting edge.id and edge.properties_json.
    const EDGE_COLS = `e.id AS edge_id, e.project AS edge_project, e.source_id, e.target_id,
                       e.type AS edge_type, e.properties_json AS edge_properties`;
    const NODE_COLS = `n.id AS node_id, n.project AS node_project, n.label, n.name,
                       n.qualified_name, n.file_path, n.start_line, n.end_line,
                       n.properties_json AS node_properties`;

    if (direction === 'out' || direction === 'both') {
      const rows = this.db
        .prepare(
          `SELECT ${EDGE_COLS}, ${NODE_COLS} FROM edges e
           JOIN nodes n ON n.id = e.target_id
           WHERE e.source_id = ?
           ORDER BY e.id ASC
           LIMIT ?`
        )
        .all(nodeId, limit) as any[];
      for (const row of rows) {
        results.push({
          edge: {
            id: row.edge_id,
            project: row.edge_project,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.edge_type,
            properties_json: row.edge_properties ?? '{}',
          },
          node: deserializeCodeNode({
            id: row.node_id,
            project: row.node_project,
            label: row.label,
            name: row.name,
            qualified_name: row.qualified_name,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            properties_json: row.node_properties,
          }),
        });
      }
    }
    if (direction === 'in' || direction === 'both') {
      const rows = this.db
        .prepare(
          `SELECT ${EDGE_COLS}, ${NODE_COLS} FROM edges e
           JOIN nodes n ON n.id = e.source_id
           WHERE e.target_id = ?
           ORDER BY e.id ASC
           LIMIT ?`
        )
        .all(nodeId, limit) as any[];
      for (const row of rows) {
        results.push({
          edge: {
            id: row.edge_id,
            project: row.edge_project,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.edge_type,
            properties_json: row.edge_properties ?? '{}',
          },
          node: deserializeCodeNode({
            id: row.node_id,
            project: row.node_project,
            label: row.label,
            name: row.name,
            qualified_name: row.qualified_name,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            properties_json: row.node_properties,
          }),
        });
      }
    }
    return results;
  }

  /**
   * Bulk-fetch node degrees (in + out) for many node IDs in two queries.
   * Returns Map<nodeId, degree>. Much faster than calling getNodeDegree per node.
   */
  getBulkNodeDegrees(nodeIds: number[]): Map<number, number> {
    const result = new Map<number, number>();
    if (nodeIds.length === 0) return result;
    for (const id of nodeIds) result.set(id, 0);
    const placeholders = nodeIds.map(() => '?').join(',');
    try {
      const outRows = this.db
        .prepare(`SELECT source_id AS id, COUNT(*) AS c FROM edges WHERE source_id IN (${placeholders}) GROUP BY source_id`)
        .all(...nodeIds) as any[];
      for (const r of outRows) result.set(r.id, (result.get(r.id) ?? 0) + r.c);
      const inRows = this.db
        .prepare(`SELECT target_id AS id, COUNT(*) AS c FROM edges WHERE target_id IN (${placeholders}) GROUP BY target_id`)
        .all(...nodeIds) as any[];
      for (const r of inRows) result.set(r.id, (result.get(r.id) ?? 0) + r.c);
    } catch {
      // ignore — return zeros
    }
    return result;
  }

  /**
   * Fetch many nodes by ID in one query. Returns Map<id, CodeNode>.
   */
  getNodesByIds(ids: number[]): Map<number, CodeNode> {
    const result = new Map<number, CodeNode>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    try {
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...ids) as any[];
      for (const row of rows) {
        const node = deserializeCodeNode(row);
        result.set(node.id, node);
      }
    } catch {
      // ignore
    }
    return result;
  }

  countNodes(project: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?')
        .get(project) as any
    ).c;
  }

  countEdges(project: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM edges WHERE project = ?')
        .get(project) as any
    ).c;
  }

  countNodesByLabel(project: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT label, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY label ORDER BY c DESC`
      )
      .all(project) as any[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.label] = row.c;
    }
    return result;
  }

  countEdgesByType(project: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS c FROM edges WHERE project = ? GROUP BY type ORDER BY c DESC`
      )
      .all(project) as any[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.c;
    }
    return result;
  }

  /**
   * Compute node degree (in + out).
   */
  getNodeDegree(nodeId: number): number {
    const outDeg = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM edges WHERE source_id = ?')
        .get(nodeId) as any
    ).c;
    const inDeg = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM edges WHERE target_id = ?')
        .get(nodeId) as any
    ).c;
    return outDeg + inDeg;
  }

  /**
   * BM25 search on the code graph (uses V1's FTS5 table if available).
   * Falls back to LIKE on `name` and `qualified_name` if FTS5 is missing or throws.
   */
  searchCode(project: string, query: string, limit = 50): CodeNode[] {
    if (!query || typeof query !== 'string' || query.length === 0) return [];
    // Try FTS5 first.
    try {
      // Wrap the query in double quotes for a phrase query (safer than raw input).
      // FTS5 phrase queries don't interpret AND/OR/NEAR.
      const phraseQuery = '"' + query.replace(/"/g, '""') + '"';
      const rows = this.db
        .prepare(
          `SELECT n.* FROM nodes n
           JOIN nodes_fts f ON f.rowid = n.id
           WHERE n.project = ? AND nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(project, phraseQuery, limit) as any[];
      // Trust FTS5 — return whatever it found (including empty).
      return rows.map(deserializeCodeNode);
    } catch {
      // Fall through to LIKE fallback.
    }
    // LIKE fallback — escape backslash, %, _ correctly.
    const escaped = query.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE project = ? AND (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')
         LIMIT ?`
      )
      .all(project, likePattern, likePattern, limit) as any[];
    return rows.map(deserializeCodeNode);
  }

  /**
   * Find modules by name (case-insensitive substring).
   */
  findModulesByName(project: string, namePattern: string, limit = 50): CodeNode[] {
    const likePattern = `%${namePattern.replace(/[%_]/g, '\\$&')}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND label = 'Module' AND name LIKE ? ESCAPE '\\'
           LIMIT ?`
        )
        .all(project, likePattern, limit) as any[]
    ).map(deserializeCodeNode);
  }

  /**
   * Find routes by HTTP method + path.
   */
  findRoute(project: string, method: string, path: string): CodeNode | null {
    // Use json_extract (SQLite 3.38+) for an indexed-style exact lookup.
    // Fall back to JS-side filtering if json_extract is unavailable.
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND label = 'Route'
             AND json_extract(properties_json, '$.route_method') = ?
             AND json_extract(properties_json, '$.route_path') = ?
           LIMIT 1`
        )
        .get(project, method.toUpperCase(), path) as any;
      return row ? deserializeCodeNode(row) : null;
    } catch {
      // Fallback: scan up to 10000 routes (was 500, which missed routes beyond 500).
      const rows = this.db
        .prepare(
          `SELECT * FROM nodes WHERE project = ? AND label = 'Route' LIMIT 10000`
        )
        .all(project) as any[];
      const methodUpper = method.toUpperCase();
      for (const row of rows) {
        let props: Record<string, unknown>;
        try {
          props = JSON.parse(row.properties_json || '{}');
        } catch {
          continue; // Skip corrupted row
        }
        if (
          (props.route_method === methodUpper ||
            (typeof props.route_method === 'string' && props.route_method.toUpperCase() === methodUpper)) &&
          props.route_path === path
        ) {
          return deserializeCodeNode(row);
        }
      }
      return null;
    }
  }

  /**
   * List projects that have a code graph.
   */
  listProjects(): string[] {
    // Try the `projects` table first; fall back to DISTINCT project from nodes.
    try {
      const rows = this.db
        .prepare('SELECT DISTINCT name FROM projects')
        .all() as any[];
      if (rows.length > 0) return rows.map((r) => r.name as string);
    } catch {
      // Table may not exist in some V1 schema versions.
    }
    try {
      const rows = this.db
        .prepare('SELECT DISTINCT project FROM nodes')
        .all() as any[];
      return rows.map((r) => r.project as string);
    } catch {
      return [];
    }
  }
}

function deserializeCodeNode(row: any): CodeNode {
  return {
    id: row.id,
    project: row.project,
    label: row.label,
    name: row.name,
    qualified_name: row.qualified_name,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    properties_json: row.properties_json || '{}',
  };
}
