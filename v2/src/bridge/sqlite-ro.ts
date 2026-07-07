// v2/src/bridge/sqlite-ro.ts
// Read-only access to the V1 code graph SQLite DB.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BULK_CHUNK_SIZE } from '../constants.js';

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

// ── Row types (what SQLite actually returns) ──────────────────────────────
// R59: same pattern as store.ts R58 — replace `as any` casts with proper row
// types so the compiler catches column-name typos and schema drift at build time.

/** Raw row from `SELECT * FROM nodes`. */
interface CodeNodeRow {
  id: number;
  project: string;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties_json: string;
}

// CodeEdgeRow is not defined here because edges are always queried with column
// aliases (e.id AS edge_id, etc.) to avoid duplicate-name collisions with nodes
// in JOIN queries. See BulkEdgeRow and NeighborRow for the aliased edge row types.

/**
 * Raw row from the getNeighbors JOIN (edges + nodes with column aliases).
 * The aliases are critical: both tables have `id`, `project`, `properties_json`,
 * and without aliases better-sqlite3 returns the last column value for
 * duplicate names, corrupting the data.
 */
interface NeighborRow {
  edge_id: number;
  edge_project: string;
  source_id: number;
  target_id: number;
  edge_type: string;
  edge_properties: string | null;
  node_id: number;
  node_project: string;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  node_properties: string | null;
}

/** Row from `SELECT source_id|target_id AS id, COUNT(*) AS c ... GROUP BY`. */
interface DegreeCountRow {
  id: number;
  c: number;
}

/** Row from `SELECT COUNT(*) AS c FROM ...`. */
interface CountRow {
  c: number;
}

/** Row from `SELECT (subquery) AS n, (subquery) AS e`. */
interface CountAllRow {
  n: number;
  e: number;
}

/** Row from `SELECT label, COUNT(*) AS c ... GROUP BY label`. */
interface LabelCountRow {
  label: string;
  c: number;
}

/** Row from `SELECT type, COUNT(*) AS c ... GROUP BY type`. */
interface TypeCountRow {
  type: string;
  c: number;
}

/** Row from `SELECT source_id, target_id, type FROM edges`. */
interface EdgeTripleRow {
  source_id: number;
  target_id: number;
  type: string;
}

/**
 * Row from getBulkNeighbors — edge columns only (aliased to avoid duplicate
 * column names). Used by the `makeEdge` helper inside getBulkNeighbors.
 */
interface BulkEdgeRow {
  edge_id: number;
  edge_project: string;
  source_id: number;
  target_id: number;
  edge_type: string;
  edge_properties: string | null;
}

/** Row from `SELECT DISTINCT name FROM projects`. */
interface ProjectNameRow {
  name: string;
}

/** Row from `SELECT DISTINCT project FROM nodes`. */
interface ProjectRow {
  project: string;
}

export function defaultCodeDbPath(project: string): string {
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheDir, 'codebase-memory-mcp', `${project}.db`);
}

export class CodeGraphReader {
  private db: Database.Database;

  // R59: hot-path prepared statements, prepared once in the constructor.
  // getNodeById and findNodeByQualifiedName are called on every MCP tool
  // invocation (prepare_edit_context, get_module_context, search_code_and_memory).
  // countNodes/countEdges are called by /api/projects but countAll replaces
  // them with a single query — kept for backward compat but not hot-path.
  private stmtGetNodeById!: Database.Statement;
  private stmtFindNodeByQName!: Database.Statement;

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
    // R20: performance PRAGMAs for the read-only code graph connection.
    // temp_store=MEMORY avoids disk I/O for sorting/grouping in bulk queries.
    // cache_size=-65536 gives 64MB page cache (default 2MB is too small for
    // getBulkEdges/getBulkNodeDegrees on large graphs).
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -65536');
    // NOTE: do NOT set `journal_mode = WAL` on a readonly connection — it's a no-op or error.
    // V1 sets WAL when it opens the DB for writing; the readonly reader inherits it.
    // R59: prepare hot-path statements once. These two single-row lookups are
    // called on every MCP tool invocation — preparing them here means each call
    // is just .get(params) with no SQL compilation or cache lookup.
    this.stmtGetNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    this.stmtFindNodeByQName = this.db.prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?');
  }

  close(): void {
    this.db.close();
  }

  getNodeById(id: number): CodeNode | null {
    const row = this.stmtGetNodeById.get(id) as CodeNodeRow | undefined;
    return row ? deserializeCodeNode(row) : null;
  }

  findNodeByQualifiedName(project: string, qualifiedName: string): CodeNode | null {
    const row = this.stmtFindNodeByQName.get(project, qualifiedName) as CodeNodeRow | undefined;
    return row ? deserializeCodeNode(row) : null;
  }

  findNodesByName(project: string, name: string, label?: string, limit = 50): CodeNode[] {
    const params: (string | number)[] = [project, name];
    let sql = 'SELECT * FROM nodes WHERE project = ? AND name = ?';
    if (label) {
      sql += ' AND label = ?';
      params.push(label);
    }
    sql += ' LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as CodeNodeRow[]).map(deserializeCodeNode);
  }

  listNodes(project: string, opts: {
    label?: string;
    limit?: number;
    offset?: number;
  } = {}): CodeNode[] {
    const conditions = ['project = ?'];
    const params: (string | number)[] = [project];
    if (opts.label) {
      conditions.push('label = ?');
      params.push(opts.label);
    }
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const sql = `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, limit, offset) as CodeNodeRow[]).map(deserializeCodeNode);
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
        .all(nodeId, limit) as NeighborRow[];
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
            properties_json: row.node_properties ?? '{}',
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
        .all(nodeId, limit) as NeighborRow[];
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
            properties_json: row.node_properties ?? '{}',
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
    // Chunk to respect SQLite's variable limit (999). BULK_CHUNK_SIZE = 500.
    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const outRows = this.db
          .prepare(`SELECT source_id AS id, COUNT(*) AS c FROM edges WHERE source_id IN (${placeholders}) GROUP BY source_id`)
          .all(...chunk) as DegreeCountRow[];
        for (const r of outRows) result.set(r.id, (result.get(r.id) ?? 0) + r.c);
        const inRows = this.db
          .prepare(`SELECT target_id AS id, COUNT(*) AS c FROM edges WHERE target_id IN (${placeholders}) GROUP BY target_id`)
          .all(...chunk) as DegreeCountRow[];
        for (const r of inRows) result.set(r.id, (result.get(r.id) ?? 0) + r.c);
      } catch {
        // ignore — return zeros for this chunk
      }
    }
    return result;
  }

  /**
   * Bulk-fetch in-degree and out-degree SEPARATELY for many node IDs.
   * Returns Map<nodeId, {in: number, out: number}>. Used by prepare_edit_context
   * to report accurate callers_count and callees_count without the per-direction
   * cap imposed by getNeighbors (which limits results to 50 per direction).
   */
  getBulkNodeDegreesSplit(nodeIds: number[]): Map<number, { in: number; out: number }> {
    const result = new Map<number, { in: number; out: number }>();
    if (nodeIds.length === 0) return result;
    for (const id of nodeIds) result.set(id, { in: 0, out: 0 });
    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const outRows = this.db
          .prepare(`SELECT source_id AS id, COUNT(*) AS c FROM edges WHERE source_id IN (${placeholders}) GROUP BY source_id`)
          .all(...chunk) as DegreeCountRow[];
        for (const r of outRows) {
          const entry = result.get(r.id);
          if (entry) entry.out = r.c;
        }
        const inRows = this.db
          .prepare(`SELECT target_id AS id, COUNT(*) AS c FROM edges WHERE target_id IN (${placeholders}) GROUP BY target_id`)
          .all(...chunk) as DegreeCountRow[];
        for (const r of inRows) {
          const entry = result.get(r.id);
          if (entry) entry.in = r.c;
        }
      } catch {
        // ignore — return zeros for this chunk
      }
    }
    return result;
  }

  /**
   * Fetch many nodes by ID in one query. Returns Map<id, CodeNode>.
   */
  getNodesByIds(ids: number[]): Map<number, CodeNode> {
    const result = new Map<number, CodeNode>();
    if (ids.length === 0) return result;
    // Chunk to respect SQLite's variable limit (999).
    for (let i = 0; i < ids.length; i += BULK_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = this.db
          .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
          .all(...chunk) as CodeNodeRow[];
        for (const row of rows) {
          const node = deserializeCodeNode(row);
          result.set(node.id, node);
        }
      } catch {
        // ignore
      }
    }
    return result;
  }

  /**
   * Bulk-fetch ALL edges for a set of node IDs (both directions) in at most
   * 2 chunked queries. Returns deduplicated edges with source/target IDs.
   * Used by /api/layout to eliminate the N+1 pattern of calling getNeighbors
   * per node (2000 nodes × 1 query = 2000 queries → 2 queries).
   *
   * @param nodeIds  the visible node set (edges to nodes outside this set are filtered)
   * @param limitPerNode  cap on edges per node per direction (0 = unlimited)
   */
  getBulkEdges(
    nodeIds: number[],
    limitPerNode = 0,
  ): Array<{ source: number; target: number; type: string }> {
    if (nodeIds.length === 0) return [];
    const nodeIdSet = new Set(nodeIds);
    const seenEdgeKeys = new Set<string>();
    const result: Array<{ source: number; target: number; type: string }> = [];

    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        // Out-edges: chunk nodes are sources.
        const outRows = this.db
          .prepare(
            `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) ORDER BY id ASC`,
          )
          .all(...chunk) as EdgeTripleRow[];
        // In-edges: chunk nodes are targets.
        const inRows = this.db
          .prepare(
            `SELECT source_id, target_id, type FROM edges WHERE target_id IN (${placeholders}) ORDER BY id ASC`,
          )
          .all(...chunk) as EdgeTripleRow[];

        // Merge and dedup. If limitPerNode > 0, cap per (node, direction).
        const perNodeOutCount = new Map<number, number>();
        const perNodeInCount = new Map<number, number>();

        const tryPush = (row: EdgeTripleRow, nodeSide: 'source' | 'target') => {
          const s = row.source_id;
          const t = row.target_id;
          // Only keep edges where BOTH endpoints are in the visible set.
          if (!nodeIdSet.has(s) || !nodeIdSet.has(t)) return;
          const key = `${s}-${t}-${row.type}`;
          if (seenEdgeKeys.has(key)) return;
          if (limitPerNode > 0) {
            const cap = nodeSide === 'source' ? perNodeOutCount : perNodeInCount;
            const node = nodeSide === 'source' ? s : t;
            const cur = cap.get(node) ?? 0;
            if (cur >= limitPerNode) return;
            cap.set(node, cur + 1);
          }
          seenEdgeKeys.add(key);
          result.push({ source: s, target: t, type: row.type });
        };

        for (const row of outRows) tryPush(row, 'source');
        for (const row of inRows) tryPush(row, 'target');
      } catch {
        // ignore — return partial results for this chunk
      }
    }
    return result;
  }

  /**
   * R40 (M3): Bulk-fetch neighbors for a set of node IDs in at most
   * 2 chunked queries + 1 getNodesByIds for the unique neighbor nodes.
   * Returns Map<nodeId, { edge, node }[]> — same shape as getNeighbors,
   * but for N nodes at once. Used by prepare_edit_context to eliminate
   * the N+1 pattern of calling getNeighbors per matching node (20 nodes ×
   * 2 queries = 40 queries → 3 queries).
   *
   * Unlike getBulkEdges (which only returns edges within the visible set),
   * this method returns the FULL neighbor node data for edges in BOTH
   * directions, regardless of whether the neighbor is in the input set.
   *
   * @param nodeIds      the nodes to fetch neighbors for
   * @param direction    'in' (callers), 'out' (callees), or 'both'
   * @param limitPerNode cap on edges per node per direction (default 50)
   */
  getBulkNeighbors(
    nodeIds: number[],
    direction: 'in' | 'out' | 'both' = 'both',
    limitPerNode = 50,
  ): Map<number, { edge: CodeEdge; node: CodeNode }[]> {
    const result = new Map<number, { edge: CodeEdge; node: CodeNode }[]>();
    if (nodeIds.length === 0) return result;
    for (const id of nodeIds) result.set(id, []);

    // Step 1: collect all (anchorId, edge, neighborId, side) tuples in 2
    // chunked queries. limitPerNode is enforced PER DIRECTION (matching
    // getNeighbors's behavior: 50 out + 50 in = 100 total when direction='both').
    interface EdgeRow { anchorId: number; edge: CodeEdge; neighborId: number; side: 'out' | 'in'; }
    const allRows: EdgeRow[] = [];
    // Per-anchor per-direction counters (so we cap 50 out AND 50 in, not 100 total).
    const outCount = new Map<number, number>();
    const inCount = new Map<number, number>();
    const EDGE_COLS = `e.id AS edge_id, e.project AS edge_project, e.source_id, e.target_id,
                       e.type AS edge_type, e.properties_json AS edge_properties`;

    const makeEdge = (row: BulkEdgeRow): CodeEdge => ({
      id: row.edge_id,
      project: row.edge_project,
      source_id: row.source_id,
      target_id: row.target_id,
      type: row.edge_type,
      properties_json: row.edge_properties ?? '{}',
    });

    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        if (direction === 'out' || direction === 'both') {
          // Out-edges: chunk nodes are sources; neighbor is target.
          const outRows = this.db
            .prepare(
              `SELECT ${EDGE_COLS} FROM edges e
               WHERE e.source_id IN (${placeholders})
               ORDER BY e.id ASC`,
            )
            .all(...chunk) as BulkEdgeRow[];
          for (const row of outRows) {
            const anchorId = row.source_id;
            const cnt = outCount.get(anchorId) ?? 0;
            if (cnt >= limitPerNode) continue;
            outCount.set(anchorId, cnt + 1);
            allRows.push({
              anchorId,
              edge: makeEdge(row),
              neighborId: row.target_id,
              side: 'out',
            });
          }
        }
        if (direction === 'in' || direction === 'both') {
          // In-edges: chunk nodes are targets; neighbor is source.
          const inRows = this.db
            .prepare(
              `SELECT ${EDGE_COLS} FROM edges e
               WHERE e.target_id IN (${placeholders})
               ORDER BY e.id ASC`,
            )
            .all(...chunk) as BulkEdgeRow[];
          for (const row of inRows) {
            const anchorId = row.target_id;
            const cnt = inCount.get(anchorId) ?? 0;
            if (cnt >= limitPerNode) continue;
            inCount.set(anchorId, cnt + 1);
            allRows.push({
              anchorId,
              edge: makeEdge(row),
              neighborId: row.source_id,
              side: 'in',
            });
          }
        }
      } catch {
        // ignore — return partial results for this chunk
      }
    }

    // Step 2: bulk-fetch all unique neighbor nodes in 1 chunked query.
    const uniqueNeighborIds = [...new Set(allRows.map(r => r.neighborId))];
    const neighborNodeMap = this.getNodesByIds(uniqueNeighborIds);

    // Step 3: attach neighbor nodes to their anchor entries.
    for (const row of allRows) {
      const neighborNode = neighborNodeMap.get(row.neighborId);
      if (!neighborNode) continue; // neighbor node was deleted — skip
      result.get(row.anchorId)!.push({ edge: row.edge, node: neighborNode });
    }

    return result;
  }

  /**
   * Find nodes by file path substring (used by prepare_edit_context).
   */
  findNodesByFilePath(project: string, filePathSubstr: string, limit = 50): CodeNode[] {
    const escaped = filePathSubstr.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND file_path LIKE ? ESCAPE '\\'
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(project, likePattern, limit) as CodeNodeRow[]
    ).map(deserializeCodeNode);
  }

  countNodes(project: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?')
        .get(project) as CountRow
    ).c;
  }

  countEdges(project: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM edges WHERE project = ?')
        .get(project) as CountRow
    ).c;
  }

  /**
   * R41 (L2): single-query node + edge counts for a project. Replaces the
   * countNodes + countEdges pair used by /api/projects (2 queries → 1,
   * plus 1 statement prepare instead of 2). Both subqueries hit the
   * composite index on (project, ...) — index-only scans.
   *
   * Used by the /api/projects endpoint to avoid opening N SQLite readers
   * and running 2N queries when listing all projects.
   */
  countAll(project: string): { nodes: number; edges: number } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM nodes WHERE project = ?) AS n,
           (SELECT COUNT(*) FROM edges WHERE project = ?) AS e`
      )
      .get(project, project) as CountAllRow;
    return { nodes: row?.n ?? 0, edges: row?.e ?? 0 };
  }

  countNodesByLabel(project: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT label, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY label ORDER BY c DESC`
      )
      .all(project) as LabelCountRow[];
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
      .all(project) as TypeCountRow[];
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
        .get(nodeId) as CountRow
    ).c;
    const inDeg = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM edges WHERE target_id = ?')
        .get(nodeId) as CountRow
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
        .all(project, phraseQuery, limit) as CodeNodeRow[];
      // If FTS5 found results, return them. If zero results, fall through
      // to LIKE (FTS5 tokenization may differ from substring matching).
      if (rows.length > 0) {
        return rows.map(deserializeCodeNode);
      }
      // Fall through to LIKE fallback.
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
      .all(project, likePattern, likePattern, limit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  /**
   * Find modules by name (case-insensitive substring).
   */
  findModulesByName(project: string, namePattern: string, limit = 50): CodeNode[] {
    // Escape backslash first (it's the ESCAPE char), then % and _.
    const escaped = namePattern.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const likePattern = `%${escaped}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND label = 'Module' AND name LIKE ? ESCAPE '\\'
           LIMIT ?`
        )
        .all(project, likePattern, limit) as CodeNodeRow[]
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
             AND LOWER(json_extract(properties_json, '$.route_method')) = LOWER(?)
             AND json_extract(properties_json, '$.route_path') = ?
           LIMIT 1`
        )
        .get(project, method.toUpperCase(), path) as CodeNodeRow | undefined;
      return row ? deserializeCodeNode(row) : null;
    } catch {
      // Fallback: scan up to 10000 routes (was 500, which missed routes beyond 500).
      const rows = this.db
        .prepare(
          `SELECT * FROM nodes WHERE project = ? AND label = 'Route' LIMIT 10000`
        )
        .all(project) as CodeNodeRow[];
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
        .all() as ProjectNameRow[];
      if (rows.length > 0) return rows.map((r) => r.name as string);
    } catch {
      // Table may not exist in some V1 schema versions.
    }
    try {
      const rows = this.db
        .prepare('SELECT DISTINCT project FROM nodes')
        .all() as ProjectRow[];
      return rows.map((r) => r.project as string);
    } catch {
      return [];
    }
  }
}

function deserializeCodeNode(row: CodeNodeRow): CodeNode {
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
