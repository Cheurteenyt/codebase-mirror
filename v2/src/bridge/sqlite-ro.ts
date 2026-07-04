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
      throw new Error(`Code graph DB not found: ${dbPath}. Run 'cbm index_repository' first.`);
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('journal_mode = WAL');
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
    const sql = `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} LIMIT ? OFFSET ?`;
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
    if (direction === 'out' || direction === 'both') {
      const rows = this.db
        .prepare(
          `SELECT e.*, n.* FROM edges e
           JOIN nodes n ON n.id = e.target_id
           WHERE e.source_id = ?
           LIMIT ?`
        )
        .all(nodeId, limit) as any[];
      for (const row of rows) {
        results.push({
          edge: {
            id: row.id,
            project: row.project,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.type,
            properties_json: row.properties_json,
          },
          node: deserializeCodeNode({
            id: row.id,
            project: row.project,
            label: row.label,
            name: row.name,
            qualified_name: row.qualified_name,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            properties_json: row.properties_json,
          }),
        });
      }
    }
    if (direction === 'in' || direction === 'both') {
      const rows = this.db
        .prepare(
          `SELECT e.*, n.* FROM edges e
           JOIN nodes n ON n.id = e.source_id
           WHERE e.target_id = ?
           LIMIT ?`
        )
        .all(nodeId, limit) as any[];
      for (const row of rows) {
        results.push({
          edge: {
            id: row.id,
            project: row.project,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.type,
            properties_json: row.properties_json,
          },
          node: deserializeCodeNode({
            id: row.id,
            project: row.project,
            label: row.label,
            name: row.name,
            qualified_name: row.qualified_name,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            properties_json: row.properties_json,
          }),
        });
      }
    }
    return results;
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
   * BM25 search on the code graph (uses V1's FTS5 table).
   */
  searchCode(project: string, query: string, limit = 50): CodeNode[] {
    // V1 uses FTS5 with table name 'nodes_fts' (or similar — exact name TBD per V1 schema).
    // We try the most common name; if it fails, fall back to LIKE.
    try {
      const rows = this.db
        .prepare(
          `SELECT n.* FROM nodes n
           JOIN nodes_fts f ON f.rowid = n.id
           WHERE n.project = ? AND nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(project, query, limit) as any[];
      if (rows.length > 0) {
        return rows.map(deserializeCodeNode);
      }
    } catch {
      // Fall through to LIKE fallback
    }
    // LIKE fallback
    const likePattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
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
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes WHERE project = ? AND label = 'Route' LIMIT 500`
      )
      .all(project) as any[];
    for (const row of rows) {
      const props = JSON.parse(row.properties_json || '{}');
      if (
        (props.route_method === method || props.route_method === method.toUpperCase()) &&
        props.route_path === path
      ) {
        return deserializeCodeNode(row);
      }
    }
    return null;
  }

  /**
   * List projects that have a code graph.
   */
  listProjects(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT name FROM projects')
      .all() as any[];
    return rows.map((r) => r.name as string);
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
