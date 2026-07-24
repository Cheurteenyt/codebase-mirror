// v2/src/bridge/sqlite-ro.ts
// Read-only access to the V1 code graph SQLite DB.

import Database from 'better-sqlite3';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { BULK_CHUNK_SIZE } from '../constants.js';
import { resolveProjectStoragePath } from '../storage/project-path.js';
import {
  graphCommunityKey,
  graphDomainKey,
  graphNodeBelongsToDirectory,
  normalizeGraphPath,
} from '../graph-scope.js';
import {
  buildExactScopeLayout,
  type ExactScopeLayoutPlan,
} from '../exact-scope-layout.js';

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

export interface BulkEdgesResult {
  edges: Array<{ source: number; target: number; type: string }>;
  strategy: 'connectivity-first-dual-cap-v1';
  total_induced_edges: number;
  returned_edges: number;
  edges_truncated: boolean;
  limit_per_direction: number;
  available_by_type: Record<string, number>;
  returned_by_type: Record<string, number>;
}

export interface ExactNeighborhoodPage {
  anchor: CodeNode;
  neighbors: Array<{ edge: CodeEdge; node: CodeNode }>;
  total_inbound: number;
  total_outbound: number;
  total_unique_edges: number;
  next_after_edge_id: number | null;
}

export type ExactPathStatus = 'found' | 'not_found' | 'max_hops' | 'limit_reached';

export interface ExactPathSearchOptions {
  maxHops: number;
  maxVisitedNodes: number;
  maxVisitedEdges: number;
}

export interface ExactPathResult {
  status: ExactPathStatus;
  nodes: CodeNode[];
  edges: CodeEdge[];
  hops: number | null;
  visited_nodes: number;
  visited_edges: number;
}

export interface ExactNodeSearchPage {
  nodes: CodeNode[];
  total_matches: number;
  next_after_rank: number | null;
  next_after_node_id: number | null;
}

export type ExactScopeKind = 'domain' | 'community' | 'directory';

export interface ExactScopeCursorState {
  after_node_id: number;
  batch_end_node_id: number;
  after_edge_id: number;
}

export interface ExactScopePage {
  nodes: CodeNode[];
  edges: CodeEdge[];
  total_nodes: number;
  total_internal_edges: number;
  boundary: ExactScopeBoundarySummary;
  structure_layout: ExactScopeLayoutPlan;
  next_cursor: ExactScopeCursorState | null;
}

export interface ExactScopeBoundaryDependency {
  direction: 'incoming' | 'outgoing';
  external_key: string;
  type: string;
  count: number;
}

export interface ExactScopeBoundarySummary {
  exact: true;
  total_relations: number;
  incoming_relations: number;
  outgoing_relations: number;
  returned_groups: number;
  truncated: boolean;
  dependencies: ExactScopeBoundaryDependency[];
}

export interface ArchitectureDomainSummary {
  key: string;
  node_count: number;
  file_count: number;
  representative: CodeNode;
}

export interface ArchitectureDomainDependencySummary {
  /** Selected atlas key, or null for the aggregate of omitted domains. */
  source_key: string | null;
  /** Selected atlas key, or null for the aggregate of omitted domains. */
  target_key: string | null;
  type: string;
  count: number;
}

export interface DirectCallerSummary {
  name: string;
  qualified_name: string;
  path: string;
  definition_line: number;
  call_sites: number;
}

export interface DirectCallerAggregation {
  symbol: string;
  target_candidates: Array<{
    qualified_name: string;
    path: string;
    definition_line: number;
  }>;
  callers: DirectCallerSummary[];
  callers_by_name: Record<string, number>;
  total_call_sites: number;
  callers_truncated: boolean;
  complete: boolean;
  incomplete_reasons: string[];
}

export interface ProjectCallSiteStatus {
  complete: boolean;
  incomplete_reasons: string[];
}

export interface StaticCallLinkSummary {
  owner_qualified_name: string;
  symbol: string;
  line: number;
}

export type GraphSnapshotResult<T> =
  | { ok: true; graph_revision: string; value: T }
  | {
      ok: false;
      graph_revision: string;
      expected_graph_revision: string;
    };

// ── Row types (what SQLite actually returns) ──────────────────────────────
// R59: same pattern as store.ts R58 — replace `as any` casts with proper row
// types so the compiler catches column-name typos and schema drift at build time.

/** Raw row from `SELECT * FROM nodes` across current and legacy V1 schemas. */
interface CodeNodeRow {
  id: number;
  project: string;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties_json?: string | null;
  properties?: string | null;
}

type PropertiesColumn = 'properties_json' | 'properties' | 'both' | null;

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

interface CodeEdgeRow {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties_json?: string | null;
  properties?: string | null;
}

interface ExactScopeIndexRow {
  id: number;
  file_path: string | null;
  label: string;
}

interface ExactScopeMembership {
  nodeIds: number[];
  nodeIdsJson: string;
  totalInternalEdges: number | null;
  boundary: ExactScopeBoundarySummary | null;
  structureLayout: ExactScopeLayoutPlan | null;
}

interface ProjectExactScopeIndex {
  graphRevision: string;
  domains: Map<string, ExactScopeMembership>;
  communities: Map<string, ExactScopeMembership>;
  directories: Map<string, ExactScopeMembership>;
  structuredReady: boolean;
}

const MAX_EXACT_DIRECTORY_MEMBERSHIPS = 24;
const MAX_EXACT_SCOPE_BOUNDARY_GROUPS = 24;

interface ExactScopeBoundaryRow {
  direction: 'incoming' | 'outgoing';
  type: string;
  file_path: string | null;
  label: string;
  count: number;
}

function exactScopeBoundaryKey(
  kind: ExactScopeKind,
  key: string,
  filePath: string | null,
  label: string,
): string {
  if (kind === 'domain') return graphDomainKey(filePath, label);
  if (kind === 'community') return graphCommunityKey(filePath, label);
  const normalizedPath = normalizeGraphPath(filePath ?? '');
  if (!normalizedPath || !normalizedPath.includes('/')) return '(root)';
  const scopeDepth = Math.max(1, normalizeGraphPath(key).split('/').filter(Boolean).length);
  return normalizedPath.split('/').filter(Boolean).slice(0, scopeDepth).join('/');
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

interface PathEdgeRow {
  id: number;
  project: string;
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

interface ProjectRootRow {
  root_path: string | null;
}

interface DirectCallerRow {
  source_qn: string;
  file_path: string;
  call_sites: number;
  first_call_line: number;
}

interface ProjectCallSiteStatusRow {
  cross_file_calls_stale: number | null;
  call_sites_initialized: number | null;
}

/** Normalize either Windows or POSIX separators for portable DB searches. */
function normalizePathForSearch(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

/** Escape a literal value for a LIKE expression using backslash as ESCAPE. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
}

function callerOwnerQualifiedName(qualifiedName: string): string {
  const parts = qualifiedName.split('::');
  while (parts.length > 1 && /^(?:anonymous#\d+|<anonymous>)$/u.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join('::');
}

function isTestSourcePath(filePath: string): boolean {
  const normalized = normalizePathForSearch(filePath).toLowerCase();
  return normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('__tests__/')
    || normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || /\.(?:test|spec)\.[^/]+$/u.test(normalized);
}

interface NeighborhoodCountRow {
  inbound: number;
  outbound: number;
  self_loops: number;
}

function detectPropertiesColumn(
  db: Database.Database,
  table: 'nodes' | 'edges',
): PropertiesColumn {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const hasJson = columns.some((column) => column.name === 'properties_json');
  const hasLegacy = columns.some((column) => column.name === 'properties');
  if (hasJson && hasLegacy) return 'both';
  if (hasJson) return 'properties_json';
  if (hasLegacy) return 'properties';
  return null;
}

function rowPropertiesJson(row: CodeNodeRow): string {
  return row.properties_json || row.properties || '{}';
}

const READER_PROCESS_EPOCH = randomUUID();
let nextReaderEpoch = 0;

function databaseIdentity(dbPath: string): string {
  let canonicalPath = dbPath;
  try {
    canonicalPath = realpathSync.native(dbPath);
  } catch {
    // The constructor already proved that the path exists. Keep the original
    // absolute path if identity metadata becomes unavailable concurrently.
  }
  try {
    const stat = statSync(dbPath, { bigint: true });
    return `${canonicalPath}\0${stat.dev}:${stat.ino}`;
  } catch {
    return canonicalPath;
  }
}

export function defaultCodeDbPath(project: string): string {
  return resolveProjectStoragePath(project, '.db');
}

export class CodeGraphReader {
  private db: Database.Database;
  private readonly nodePropertiesColumn!: PropertiesColumn;
  private readonly edgePropertiesColumn!: PropertiesColumn;
  private readonly revisionIdentity: string;
  private cachedDataVersion = -1;
  private cachedGraphRevision = '';
  private readonly exactScopeIndexes = new Map<string, ProjectExactScopeIndex>();

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
        `  1. Run 'cbm-v2 index --project <name> --root <path>' to build the code graph\n` +
        `  2. Pass --project <name> to specify the project (DB is at $XDG_CACHE_HOME/codebase-memory-mcp/<project>.db)\n` +
        `  3. Verify the project name matches what was indexed (case-sensitive)\n` +
        `  4. Set XDG_CACHE_HOME to point to a non-default cache directory if configured`
      );
    }
    const readerEpoch = ++nextReaderEpoch;
    this.revisionIdentity = `${databaseIdentity(dbPath)}\0${READER_PROCESS_EPOCH}:${readerEpoch}`;
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Set busy_timeout to handle concurrent writes from V1 engine gracefully.
      this.db.pragma('busy_timeout = 5000');
      // R20: performance PRAGMAs for the read-only code graph connection.
      // temp_store=MEMORY avoids disk I/O for sorting/grouping in bulk queries.
      // cache_size=-65536 gives 64MB page cache (default 2MB is too small for
      // getBulkEdges/getBulkNodeDegrees on large graphs).
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('cache_size = -65536');
      // Current V2 stores expose `properties_json`; original V1 stores used
      // `properties`. Detect the physical columns once so every reader method
      // presents the stable CodeNode/CodeEdge `properties_json` contract.
      this.nodePropertiesColumn = detectPropertiesColumn(this.db, 'nodes');
      this.edgePropertiesColumn = detectPropertiesColumn(this.db, 'edges');
      // NOTE: do NOT set `journal_mode = WAL` on a readonly connection — it's a no-op or error.
      // V1 sets WAL when it opens the DB for writing; the readonly reader inherits it.
      // R59: prepare hot-path statements once. These two single-row lookups are
      // called on every MCP tool invocation — preparing them here means each call
      // is just .get(params) with no SQL compilation or cache lookup.
      this.stmtGetNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
      this.stmtFindNodeByQName = this.db.prepare('SELECT * FROM nodes WHERE project = ? AND qualified_name = ?');
    } catch (error: unknown) {
      // Constructor failures must not leak the native SQLite handle. On
      // Windows, even an invalid open DB would otherwise block cleanup.
      try { this.db.close(); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Opaque revision of the graph currently visible to this reader.
   *
   * PRAGMA data_version changes when another SQLite connection commits. The
   * physical identity and reader epoch make replacement/reopen fail closed,
   * because data_version values are only comparable on the same connection.
   */
  getGraphRevision(): string {
    const dataVersion = Number(this.db.pragma('data_version', { simple: true }));
    if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) {
      throw new Error('SQLite returned an invalid PRAGMA data_version');
    }
    if (dataVersion === this.cachedDataVersion && this.cachedGraphRevision) {
      return this.cachedGraphRevision;
    }
    const digest = createHash('sha256')
      .update(this.revisionIdentity)
      .update('\0')
      .update(String(dataVersion))
      .digest('base64url')
      .slice(0, 22);
    this.cachedDataVersion = dataVersion;
    this.cachedGraphRevision = `graph-reader-v1:${digest}`;
    return this.cachedGraphRevision;
  }

  /**
   * Run a set of synchronous graph reads against one SQLite snapshot. Cursor
   * validation happens after the read transaction begins, closing the race in
   * which a writer could commit between revision validation and the first
   * page/count query.
   */
  withGraphSnapshot<T>(
    expectedGraphRevision: string | null,
    read: (graphRevision: string) => T,
  ): GraphSnapshotResult<T> {
    type SnapshotAttempt = GraphSnapshotResult<T> | { retry: true };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Observe once before BEGIN and once after establishing the read
      // snapshot. If a commit lands in that window, discard the attempt so a
      // revision can never describe a different snapshot.
      const revisionBeforeSnapshot = this.getGraphRevision();
      const transaction = this.db.transaction((): SnapshotAttempt => {
        this.db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
        const graphRevision = this.getGraphRevision();
        if (graphRevision !== revisionBeforeSnapshot) return { retry: true };
        if (expectedGraphRevision !== null && expectedGraphRevision !== graphRevision) {
          return {
            ok: false,
            graph_revision: graphRevision,
            expected_graph_revision: expectedGraphRevision,
          };
        }
        return { ok: true, graph_revision: graphRevision, value: read(graphRevision) };
      });
      const result = transaction.deferred();
      if ('retry' in result) continue;
      return result;
    }
    throw new Error('Graph changed repeatedly while opening a stable read snapshot');
  }

  private propertiesExpression(alias: string, column: PropertiesColumn): string {
    if (column === 'both') {
      return `COALESCE(NULLIF(${alias}.properties_json, ''), NULLIF(${alias}.properties, ''), '{}')`;
    }
    return column ? `${alias}.${column}` : "'{}'";
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

  /**
   * Return exact top-level path-domain counts plus one stable representative.
   * A File is preferred when the domain has one, preserving overview coverage;
   * domains containing only other node labels still remain visible. This stays
   * exhaustive without transferring every node row to JavaScript, so a domain
   * indexed after the first 10k files cannot disappear.
   */
  listArchitectureDomains(project: string): ArchitectureDomainSummary[] {
    const rows = this.db
      .prepare(
        `WITH normalized_nodes AS (
           SELECT n.id, n.label,
             TRIM(
               CASE
                 WHEN SUBSTR(REPLACE(n.file_path, CHAR(92), '/'), 2, 2) = ':/'
                   THEN SUBSTR(REPLACE(n.file_path, CHAR(92), '/'), 4)
                 ELSE REPLACE(n.file_path, CHAR(92), '/')
               END,
               '/'
             ) AS normalized_path
           FROM nodes n
           WHERE n.project = ?
         ), node_domains AS (
           SELECT id, label,
             CASE
               WHEN normalized_path = '' THEN '(virtual)'
               WHEN INSTR(normalized_path, '/') = 0 THEN
                 CASE
                   WHEN label IN ('Directory', 'Folder') THEN normalized_path
                   ELSE '(root)'
                 END
               ELSE SUBSTR(normalized_path, 1, INSTR(normalized_path, '/') - 1)
             END AS architecture_domain
           FROM normalized_nodes
         ), domain_summaries AS (
           SELECT
             architecture_domain,
             COUNT(*) AS node_count,
             SUM(CASE WHEN label = 'File' THEN 1 ELSE 0 END) AS file_count,
             COALESCE(MIN(CASE WHEN label = 'File' THEN id END), MIN(id)) AS representative_id
           FROM node_domains
           GROUP BY architecture_domain
         )
         SELECT n.*, d.architecture_domain, d.node_count, d.file_count
         FROM domain_summaries d
         JOIN nodes n ON n.id = d.representative_id AND n.project = ?
         ORDER BY d.architecture_domain ASC, n.id ASC`,
      )
      .all(project, project) as Array<CodeNodeRow & {
        architecture_domain: string;
        node_count: number;
        file_count: number;
      }>;
    return rows.map((row) => ({
      key: row.architecture_domain,
      node_count: row.node_count,
      file_count: row.file_count,
      representative: deserializeCodeNode(row),
    }));
  }

  /**
   * Aggregate every relationship touching one of the selected architecture
   * domains inside SQLite. Omitted domains are folded into one explicit
   * null endpoint, so the atlas can stay bounded without understating the
   * selected domains' total inbound or outbound traffic. Null cannot collide
   * with a real top-level directory name.
   */
  listArchitectureDomainDependencies(
    project: string,
    selectedDomainKeys: readonly string[],
  ): ArchitectureDomainDependencySummary[] {
    const domainKeys = [...new Set(selectedDomainKeys)].sort();
    if (domainKeys.length === 0) return [];
    const selectedDomainsJson = JSON.stringify(domainKeys);
    const rows = this.db
      .prepare(
        `WITH normalized_nodes AS (
           SELECT n.id,
             n.label,
             TRIM(
               CASE
                 WHEN SUBSTR(REPLACE(n.file_path, CHAR(92), '/'), 2, 2) = ':/'
                   THEN SUBSTR(REPLACE(n.file_path, CHAR(92), '/'), 4)
                 ELSE REPLACE(n.file_path, CHAR(92), '/')
               END,
               '/'
             ) AS normalized_path
           FROM nodes n
           WHERE n.project = ?
         ), node_domains AS (
           SELECT id,
             CASE
               WHEN normalized_path = '' THEN '(virtual)'
               WHEN INSTR(normalized_path, '/') = 0 THEN
                 CASE
                   WHEN label IN ('Directory', 'Folder') THEN normalized_path
                   ELSE '(root)'
                 END
               ELSE SUBSTR(normalized_path, 1, INSTR(normalized_path, '/') - 1)
             END AS architecture_domain
           FROM normalized_nodes
         ), selected_domains AS (
           SELECT CAST(value AS TEXT) AS key FROM json_each(?)
         ), classified_edges AS (
           SELECT
             CASE WHEN source_domain.architecture_domain IN (SELECT key FROM selected_domains)
               THEN source_domain.architecture_domain ELSE NULL END AS source_key,
             CASE WHEN target_domain.architecture_domain IN (SELECT key FROM selected_domains)
               THEN target_domain.architecture_domain ELSE NULL END AS target_key,
             e.type
           FROM edges e
           JOIN node_domains source_domain ON source_domain.id = e.source_id
           JOIN node_domains target_domain ON target_domain.id = e.target_id
           WHERE e.project = ?
             AND (
               source_domain.architecture_domain IN (SELECT key FROM selected_domains)
               OR target_domain.architecture_domain IN (SELECT key FROM selected_domains)
             )
         )
         SELECT source_key, target_key, type, COUNT(*) AS count
         FROM classified_edges
         GROUP BY source_key, target_key, type
         ORDER BY count DESC, source_key ASC, target_key ASC, type ASC`,
      )
      .all(project, selectedDomainsJson, project) as Array<{
        source_key: string | null;
        target_key: string | null;
        type: string;
        count: number;
      }>;
    return rows.map((row) => ({
      source_key: row.source_key,
      target_key: row.target_key,
      type: row.type,
      count: row.count,
    }));
  }

  getNeighbors(nodeId: number, direction: 'in' | 'out' | 'both' = 'both', limit = 100): { edge: CodeEdge; node: CodeNode }[] {
    const results: { edge: CodeEdge; node: CodeNode }[] = [];
    // CRITICAL: use column aliases — both edges and nodes tables have `id`,
    // `project`, and a properties column. Without aliases, better-sqlite3
    // returns the last duplicate value and corrupts the edge payload.
    const edgeProperties = this.propertiesExpression('e', this.edgePropertiesColumn);
    const nodeProperties = this.propertiesExpression('n', this.nodePropertiesColumn);
    const EDGE_COLS = `e.id AS edge_id, e.project AS edge_project, e.source_id, e.target_id,
                       e.type AS edge_type, ${edgeProperties} AS edge_properties`;
    const NODE_COLS = `n.id AS node_id, n.project AS node_project, n.label, n.name,
                       n.qualified_name, n.file_path, n.start_line, n.end_line,
                       ${nodeProperties} AS node_properties`;

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
   * Strict, project-scoped, id-ordered page for Graph UI drill-down.
   * Unlike the legacy MCP helper, this never swallows SQL errors and applies
   * one combined page limit across inbound and outbound relationships.
   */
  getExactNeighborhoodPage(
    project: string,
    nodeId: number,
    afterEdgeId = 0,
    limit = 100,
  ): ExactNeighborhoodPage | null {
    const anchorRow = this.db
      .prepare('SELECT * FROM nodes WHERE project = ? AND id = ?')
      .get(project, nodeId) as CodeNodeRow | undefined;
    if (!anchorRow) return null;

    const countRow = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM edges WHERE project = ? AND target_id = ?) AS inbound,
           (SELECT COUNT(*) FROM edges WHERE project = ? AND source_id = ?) AS outbound,
           (SELECT COUNT(*) FROM edges
              WHERE project = ? AND source_id = ? AND target_id = ?) AS self_loops`,
      )
      .get(project, nodeId, project, nodeId, project, nodeId, nodeId) as NeighborhoodCountRow;

    const safeAfterEdgeId = Math.max(0, Math.floor(afterEdgeId));
    const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)));
    const edgeProperties = this.propertiesExpression('e', this.edgePropertiesColumn);
    const nodeProperties = this.propertiesExpression('n', this.nodePropertiesColumn);
    const rows = this.db
      .prepare(
        `WITH incident_edges AS (
           SELECT * FROM edges
           WHERE project = ? AND source_id = ? AND id > ?
           UNION ALL
           SELECT * FROM edges
           WHERE project = ? AND target_id = ? AND source_id <> ? AND id > ?
         )
         SELECT
           e.id AS edge_id, e.project AS edge_project,
           e.source_id, e.target_id, e.type AS edge_type,
           ${edgeProperties} AS edge_properties,
           n.id AS node_id, n.project AS node_project,
           n.label, n.name, n.qualified_name, n.file_path,
           n.start_line, n.end_line, ${nodeProperties} AS node_properties
         FROM incident_edges e
         JOIN nodes n
           ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
          AND n.project = e.project
         ORDER BY e.id ASC
         LIMIT ?`,
      )
      // Split the two directions so SQLite can use idx_edges_source and
      // idx_edges_target. The equivalent OR predicate is planned as a scan of
      // every project edge once ORDER BY id is present. Exclude self-loops from
      // the inbound branch so they remain one unique relationship in the page.
      .all(
        project,
        nodeId,
        safeAfterEdgeId,
        project,
        nodeId,
        nodeId,
        safeAfterEdgeId,
        nodeId,
        safeLimit + 1,
      ) as NeighborRow[];
    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const neighbors = pageRows.map((row) => ({
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
    }));

    return {
      anchor: deserializeCodeNode(anchorRow),
      neighbors,
      total_inbound: countRow?.inbound ?? 0,
      total_outbound: countRow?.outbound ?? 0,
      total_unique_edges: (countRow?.inbound ?? 0)
        + (countRow?.outbound ?? 0)
        - (countRow?.self_loops ?? 0),
      next_after_edge_id: hasMore && neighbors.length > 0
        ? neighbors[neighbors.length - 1].edge.id
        : null,
    };
  }

  /**
   * Find a shortest coupling path in the complete project graph.
   *
   * Relationships are traversed in either direction because this answers
   * "how are these symbols coupled?" rather than pretending every stored
   * relationship is an executable call direction. Breadth-first levels and
   * edge-id ordering make the chosen shortest path deterministic. The query
   * stops with an explicit non-authoritative status when a safety bound is
   * reached; it never reports that a sampled or interrupted search found no
   * path.
   */
  findExactPath(
    project: string,
    sourceId: number,
    targetId: number,
    options: ExactPathSearchOptions,
  ): ExactPathResult | null {
    const endpointRows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE project = ? AND id IN (?, ?)
         ORDER BY id ASC`,
      )
      .all(project, sourceId, targetId) as CodeNodeRow[];
    const endpoints = new Map(endpointRows.map((row) => [row.id, deserializeCodeNode(row)]));
    const source = endpoints.get(sourceId);
    const target = endpoints.get(targetId);
    if (!source || !target) return null;

    const maxHops = Math.max(1, Math.floor(options.maxHops));
    const maxVisitedNodes = Math.max(2, Math.floor(options.maxVisitedNodes));
    const maxVisitedEdges = Math.max(1, Math.floor(options.maxVisitedEdges));
    if (sourceId === targetId) {
      return {
        status: 'found',
        nodes: [source],
        edges: [],
        hops: 0,
        visited_nodes: 1,
        visited_edges: 0,
      };
    }

    const incidentEdges = this.db.prepare(
      `WITH frontier(id) AS MATERIALIZED (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       ), incident AS (
         SELECT e.id, e.project, e.source_id, e.target_id, e.type
         FROM edges e
         WHERE e.project = ?
           AND e.source_id IN (SELECT id FROM frontier)
         UNION ALL
         SELECT e.id, e.project, e.source_id, e.target_id, e.type
         FROM edges e
         WHERE e.project = ?
           AND e.target_id IN (SELECT id FROM frontier)
           AND e.source_id NOT IN (SELECT id FROM frontier)
       )
       SELECT e.*
       FROM incident e
       JOIN nodes source
         ON source.project = e.project AND source.id = e.source_id
       JOIN nodes target
         ON target.project = e.project AND target.id = e.target_id
       ORDER BY e.id ASC
       LIMIT ?`,
    );
    const visited = new Set<number>([sourceId]);
    const parents = new Map<number, { nodeId: number; edge: PathEdgeRow }>();
    let frontier = [sourceId];
    let visitedEdges = 0;

    const stopped = (status: Exclude<ExactPathStatus, 'found'>): ExactPathResult => ({
      status,
      nodes: [],
      edges: [],
      hops: null,
      visited_nodes: visited.size,
      visited_edges: visitedEdges,
    });
    const found = (): ExactPathResult => {
      const nodeIds = [targetId];
      const edges: CodeEdge[] = [];
      let cursor = targetId;
      while (cursor !== sourceId) {
        const parent = parents.get(cursor);
        if (!parent) throw new Error('Exact path parent chain is incomplete');
        nodeIds.push(parent.nodeId);
        edges.push({ ...parent.edge, properties_json: '{}' });
        cursor = parent.nodeId;
      }
      nodeIds.reverse();
      edges.reverse();
      const rows = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
        )
        .all(project, JSON.stringify(nodeIds)) as CodeNodeRow[];
      const byId = new Map(rows.map((row) => [row.id, deserializeCodeNode(row)]));
      const nodes = nodeIds.map((id) => byId.get(id));
      if (nodes.some((node) => node == null)) {
        throw new Error('Exact path referenced a node outside its stable snapshot');
      }
      return {
        status: 'found',
        nodes: nodes as CodeNode[],
        edges,
        hops: edges.length,
        visited_nodes: visited.size,
        visited_edges: visitedEdges,
      };
    };

    for (let hop = 1; hop <= maxHops; hop += 1) {
      const remainingEdges = maxVisitedEdges - visitedEdges;
      if (remainingEdges <= 0) return stopped('limit_reached');
      const rows = incidentEdges.all(
        JSON.stringify(frontier),
        project,
        project,
        remainingEdges + 1,
      ) as PathEdgeRow[];
      const edgeLimitReached = rows.length > remainingEdges;
      const pageRows = edgeLimitReached ? rows.slice(0, remainingEdges) : rows;
      visitedEdges += pageRows.length;
      const frontierSet = new Set(frontier);
      const next: number[] = [];
      for (const edge of pageRows) {
        const neighborId = frontierSet.has(edge.source_id) ? edge.target_id : edge.source_id;
        if (visited.has(neighborId)) continue;
        if (visited.size >= maxVisitedNodes) return stopped('limit_reached');
        visited.add(neighborId);
        parents.set(neighborId, {
          nodeId: frontierSet.has(edge.source_id) ? edge.source_id : edge.target_id,
          edge,
        });
        next.push(neighborId);
        if (neighborId === targetId) return found();
      }
      if (edgeLimitReached) return stopped('limit_reached');
      if (next.length === 0) return stopped('not_found');
      frontier = next;
    }
    return stopped('max_hops');
  }

  /**
   * Build all exact architecture memberships in one project-node pass.
   *
   * Domain/community membership is built in one project-node pass. Directory
   * membership is queried only after an explicit tree drill-down and cached in
   * a small revision-bound LRU, avoiding both a full descendant map and repeated
   * scans of the same subtree.
   */
  private getExactScopeMembership(
    project: string,
    kind: ExactScopeKind,
    key: string,
  ): ExactScopeMembership {
    const graphRevision = this.getGraphRevision();
    const cacheKey = `${project}\0${graphRevision}`;
    let index = this.exactScopeIndexes.get(cacheKey);
    if (!index) {
      index = {
        graphRevision,
        domains: new Map(),
        communities: new Map(),
        directories: new Map(),
        structuredReady: false,
      };
      // A reader normally serves one project. Keep a small bound for legacy
      // multi-project databases and discard stale revision entries first.
      for (const [existingKey, existing] of this.exactScopeIndexes) {
        if (existing.graphRevision !== graphRevision || existingKey.startsWith(`${project}\0`)) {
          this.exactScopeIndexes.delete(existingKey);
        }
      }
      while (this.exactScopeIndexes.size >= 4) {
        const oldest = this.exactScopeIndexes.keys().next().value as string | undefined;
        if (oldest == null) break;
        this.exactScopeIndexes.delete(oldest);
      }
      this.exactScopeIndexes.set(cacheKey, index);
    }

    const finalizeMembership = (
      nodeIds: number[],
      layoutRows?: readonly ExactScopeIndexRow[],
    ): ExactScopeMembership => ({
      nodeIds,
      nodeIdsJson: JSON.stringify(nodeIds),
      totalInternalEdges: null,
      boundary: null,
      structureLayout: layoutRows ? buildExactScopeLayout(layoutRows, key) : null,
    });

    if (kind === 'directory') {
      const normalizedKey = normalizeGraphPath(key);
      const cached = index.directories.get(normalizedKey);
      if (cached) {
        // Refresh insertion order so the bounded map behaves as an LRU.
        index.directories.delete(normalizedKey);
        index.directories.set(normalizedKey, cached);
        return cached;
      }

      const rows = normalizedKey === '(root)'
        ? this.db.prepare(
            `SELECT id, file_path, label FROM nodes WHERE project = ? ORDER BY id ASC`,
          ).all(project) as ExactScopeIndexRow[]
        : this.db.prepare(
            `SELECT id, file_path, label
             FROM nodes
             WHERE project = ?
               AND (
                 file_path = ? OR file_path LIKE ? ESCAPE '\\'
                 OR file_path = ? OR file_path LIKE ? ESCAPE '\\'
               )
             ORDER BY id ASC`,
          ).all(
            project,
            normalizedKey,
            `${escapeLike(normalizedKey)}/%`,
            normalizedKey.replace(/\//gu, '\\'),
            `${escapeLike(normalizedKey.replace(/\//gu, '\\'))}\\\\%`,
          ) as ExactScopeIndexRow[];
      const matchingRows = rows
        .filter((row) => graphNodeBelongsToDirectory(row.file_path, row.label, normalizedKey));
      const membership = finalizeMembership(
        matchingRows.map((row) => row.id),
        matchingRows,
      );
      while (index.directories.size >= MAX_EXACT_DIRECTORY_MEMBERSHIPS) {
        const oldest = index.directories.keys().next().value as string | undefined;
        if (oldest == null) break;
        index.directories.delete(oldest);
      }
      index.directories.set(normalizedKey, membership);
      return membership;
    }

    if (!index.structuredReady) {
      const domainIds = new Map<string, number[]>();
      const communityIds = new Map<string, number[]>();
      const rows = this.db.prepare(
        `SELECT id, file_path, label
         FROM nodes
         WHERE project = ?
         ORDER BY id ASC`,
      ).all(project) as ExactScopeIndexRow[];
      for (const row of rows) {
        const community = graphCommunityKey(row.file_path, row.label);
        const domain = graphDomainKey(row.file_path, row.label);
        const communityBucket = communityIds.get(community) ?? [];
        communityBucket.push(row.id);
        communityIds.set(community, communityBucket);
        const domainBucket = domainIds.get(domain) ?? [];
        domainBucket.push(row.id);
        domainIds.set(domain, domainBucket);
      }
      index.domains = new Map([...domainIds]
        .map(([scopeKey, nodeIds]) => [scopeKey, finalizeMembership(nodeIds)]));
      index.communities = new Map([...communityIds]
        .map(([scopeKey, nodeIds]) => [scopeKey, finalizeMembership(nodeIds)]));
      index.structuredReady = true;
    }
    const memberships = kind === 'domain' ? index.domains : index.communities;
    return memberships.get(key) ?? {
      nodeIds: [],
      nodeIdsJson: '[]',
      totalInternalEdges: 0,
      boundary: {
        exact: true,
        total_relations: 0,
        incoming_relations: 0,
        outgoing_relations: 0,
        returned_groups: 0,
        truncated: false,
        dependencies: [],
      },
      structureLayout: buildExactScopeLayout([], key),
    };
  }

  /**
   * Exact architecture scope, reconstructed as bounded node/edge batches.
   *
   * Nodes are keyset-paged by id. An internal edge belongs to the batch that
   * introduces max(source_id, target_id), so its endpoints are always already
   * loaded and the client can merge pages without duplicates or dangling
   * links. Dense batches use edge-only continuation pages before advancing the
   * node frontier, keeping every response bounded.
   */
  getExactScopePage(
    project: string,
    kind: ExactScopeKind,
    key: string,
    cursor: ExactScopeCursorState,
    nodeLimit = 100,
    edgeLimit = 250,
  ): ExactScopePage {
    const safeNodeLimit = Number.isSafeInteger(nodeLimit)
      ? Math.max(1, Math.min(250, nodeLimit))
      : 100;
    const safeEdgeLimit = Number.isSafeInteger(edgeLimit)
      ? Math.max(1, Math.min(250, edgeLimit))
      : 250;
    const afterNodeId = Number.isSafeInteger(cursor.after_node_id)
      ? Math.max(0, cursor.after_node_id)
      : 0;
    const requestedBatchEnd = Number.isSafeInteger(cursor.batch_end_node_id)
      ? Math.max(0, cursor.batch_end_node_id)
      : 0;
    const afterEdgeId = Number.isSafeInteger(cursor.after_edge_id)
      ? Math.max(0, cursor.after_edge_id)
      : 0;
    const membership = this.getExactScopeMembership(project, kind, key);
    const totalNodes = membership.nodeIds.length;
    if (membership.structureLayout == null) {
      const layoutRows = this.db.prepare(
        `SELECT id, file_path, label
         FROM nodes
         WHERE project = ?
           AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
         ORDER BY id ASC`,
      ).all(project, membership.nodeIdsJson) as ExactScopeIndexRow[];
      membership.structureLayout = buildExactScopeLayout(layoutRows, key);
    }
    const structureLayout = membership.structureLayout;
    if (membership.totalInternalEdges == null) {
      membership.totalInternalEdges = (this.db.prepare(
        `WITH scope_nodes AS MATERIALIZED (
         SELECT CAST(value AS INTEGER) AS id FROM json_each(?)
       )
       SELECT COUNT(*) AS c
       FROM edges e
       JOIN scope_nodes source_node ON source_node.id = e.source_id
       JOIN scope_nodes target_node ON target_node.id = e.target_id
       WHERE e.project = ?`,
      ).get(membership.nodeIdsJson, project) as CountRow | undefined)?.c ?? 0;
    }
    const totalInternalEdges = membership.totalInternalEdges;
    if (membership.boundary == null) {
      const boundaryRows = membership.nodeIds.length === 0 ? [] : this.db.prepare(
        `WITH scope_nodes AS MATERIALIZED (
           SELECT CAST(value AS INTEGER) AS id FROM json_each(?)
         )
         SELECT
           CASE
             WHEN source_scope.id IS NOT NULL THEN 'outgoing'
             ELSE 'incoming'
           END AS direction,
           e.type,
           external_node.file_path,
           external_node.label,
           COUNT(*) AS count
         FROM edges e
         LEFT JOIN scope_nodes source_scope ON source_scope.id = e.source_id
         LEFT JOIN scope_nodes target_scope ON target_scope.id = e.target_id
         JOIN nodes external_node
           ON external_node.project = e.project
          AND external_node.id = CASE
            WHEN source_scope.id IS NOT NULL THEN e.target_id
            ELSE e.source_id
          END
         WHERE e.project = ?
           AND (
             (source_scope.id IS NOT NULL AND target_scope.id IS NULL)
             OR (source_scope.id IS NULL AND target_scope.id IS NOT NULL)
           )
         GROUP BY direction, e.type, external_node.file_path, external_node.label`,
      ).all(membership.nodeIdsJson, project) as ExactScopeBoundaryRow[];
      const grouped = new Map<string, ExactScopeBoundaryDependency>();
      let totalRelations = 0;
      let incomingRelations = 0;
      let outgoingRelations = 0;
      for (const row of boundaryRows) {
        const externalKey = exactScopeBoundaryKey(kind, key, row.file_path, row.label);
        const groupKey = `${row.direction}\0${externalKey}\0${row.type}`;
        const count = Number(row.count) || 0;
        totalRelations += count;
        if (row.direction === 'incoming') incomingRelations += count;
        else outgoingRelations += count;
        const existing = grouped.get(groupKey);
        if (existing) existing.count += count;
        else grouped.set(groupKey, {
          direction: row.direction,
          external_key: externalKey,
          type: row.type,
          count,
        });
      }
      const allDependencies = [...grouped.values()].sort((left, right) => (
        right.count - left.count
        || left.direction.localeCompare(right.direction)
        || left.external_key.localeCompare(right.external_key)
        || left.type.localeCompare(right.type)
      ));
      const dependencies = allDependencies.slice(0, MAX_EXACT_SCOPE_BOUNDARY_GROUPS);
      membership.boundary = {
        exact: true,
        total_relations: totalRelations,
        incoming_relations: incomingRelations,
        outgoing_relations: outgoingRelations,
        returned_groups: dependencies.length,
        truncated: dependencies.length < allDependencies.length,
        dependencies,
      };
    }
    const boundary = membership.boundary;

    let nodes: CodeNode[] = [];
    let batchEndNodeId = requestedBatchEnd;
    let hasMoreNodes = false;
    if (batchEndNodeId === 0) {
      // Membership IDs are sorted, so keyset pagination is a binary search plus
      // a bounded SQLite row fetch rather than another project-wide scan.
      let low = 0;
      let high = membership.nodeIds.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (membership.nodeIds[middle] <= afterNodeId) low = middle + 1;
        else high = middle;
      }
      const pageIds = membership.nodeIds.slice(low, low + safeNodeLimit);
      hasMoreNodes = low + pageIds.length < membership.nodeIds.length;
      const nodeRows = pageIds.length === 0 ? [] : this.db.prepare(
        `SELECT *
         FROM nodes n
         WHERE n.project = ?
           AND n.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
         ORDER BY n.id ASC
         LIMIT ?`,
      ).all(project, JSON.stringify(pageIds), safeNodeLimit) as CodeNodeRow[];
      nodes = nodeRows.map(deserializeCodeNode);
      batchEndNodeId = pageIds.at(-1) ?? 0;
    } else {
      hasMoreNodes = (membership.nodeIds.at(-1) ?? 0) > batchEndNodeId;
    }

    if (batchEndNodeId === 0) {
      return {
        nodes,
        edges: [],
        total_nodes: totalNodes,
        total_internal_edges: totalInternalEdges,
        boundary,
        structure_layout: structureLayout,
        next_cursor: null,
      };
    }

    const edgeProperties = this.propertiesExpression('e', this.edgePropertiesColumn);
    const edgeRows = this.db.prepare(
      `WITH scope_nodes AS MATERIALIZED (
         SELECT CAST(value AS INTEGER) AS id FROM json_each(?)
       )
       SELECT e.id, e.project, e.source_id, e.target_id, e.type,
               ${edgeProperties} AS properties_json
       FROM edges e
       JOIN scope_nodes source_node ON source_node.id = e.source_id
       JOIN scope_nodes target_node ON target_node.id = e.target_id
       WHERE e.project = ?
         AND MAX(e.source_id, e.target_id) > ?
         AND MAX(e.source_id, e.target_id) <= ?
         AND e.id > ?
       ORDER BY e.id ASC
       LIMIT ?`,
    ).all(
      membership.nodeIdsJson,
      project,
      afterNodeId,
      batchEndNodeId,
      afterEdgeId,
      safeEdgeLimit + 1,
    ) as CodeEdgeRow[];
    const hasMoreEdges = edgeRows.length > safeEdgeLimit;
    const pageEdgeRows = hasMoreEdges ? edgeRows.slice(0, safeEdgeLimit) : edgeRows;
    const edges = pageEdgeRows.map((row) => ({
      id: row.id,
      project: row.project,
      source_id: row.source_id,
      target_id: row.target_id,
      type: row.type,
      properties_json: row.properties_json || row.properties || '{}',
    }));

    let nextCursor: ExactScopeCursorState | null = null;
    if (hasMoreEdges && edges.length > 0) {
      nextCursor = {
        after_node_id: afterNodeId,
        batch_end_node_id: batchEndNodeId,
        after_edge_id: edges.at(-1)!.id,
      };
    } else if (hasMoreNodes) {
      nextCursor = {
        after_node_id: batchEndNodeId,
        batch_end_node_id: 0,
        after_edge_id: 0,
      };
    }

    return {
      nodes,
      edges,
      total_nodes: totalNodes,
      total_internal_edges: totalInternalEdges,
      boundary,
      structure_layout: structureLayout,
      next_cursor: nextCursor,
    };
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
   * Returns Map<nodeId, {in: number, out: number}>. An optional edge type lets
   * callers distinguish semantic CALLS from structural graph relationships
   * without the per-direction cap imposed by getNeighbors.
   */
  getBulkNodeDegreesSplit(
    nodeIds: number[],
    edgeType?: string,
  ): Map<number, { in: number; out: number }> {
    const result = new Map<number, { in: number; out: number }>();
    if (nodeIds.length === 0) return result;
    for (const id of nodeIds) result.set(id, { in: 0, out: 0 });
    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const typeFilter = edgeType ? ' AND type = ?' : '';
      const params: Array<number | string> = edgeType ? [...chunk, edgeType] : chunk;
      try {
        const outRows = this.db
          .prepare(`SELECT source_id AS id, COUNT(*) AS c FROM edges WHERE source_id IN (${placeholders})${typeFilter} GROUP BY source_id`)
          .all(...params) as DegreeCountRow[];
        for (const r of outRows) {
          const entry = result.get(r.id);
          if (entry) entry.out = r.c;
        }
        const inRows = this.db
          .prepare(`SELECT target_id AS id, COUNT(*) AS c FROM edges WHERE target_id IN (${placeholders})${typeFilter} GROUP BY target_id`)
          .all(...params) as DegreeCountRow[];
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

  /** Return the indexed repository root when the V1/V2 projects table exposes it. */
  getProjectRoot(project: string): string | undefined {
    try {
      const row = this.db
        .prepare('SELECT root_path FROM projects WHERE name = ? LIMIT 1')
        .get(project) as ProjectRootRow | undefined;
      const root = row?.root_path?.trim();
      return root || undefined;
    } catch {
      // Legacy/minimal code databases may not contain the projects table.
      return undefined;
    }
  }

  findNodesByNames(project: string, names: readonly string[], limit = 1000): CodeNode[] {
    const uniqueNames = [...new Set(names.filter(Boolean))].slice(0, 512);
    if (uniqueNames.length === 0) return [];
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const rows = this.db.prepare(
      `SELECT n.*
       FROM nodes n
       JOIN json_each(?) requested ON n.name = CAST(requested.value AS TEXT)
       WHERE n.project = ?
       ORDER BY n.name COLLATE BINARY ASC, n.file_path COLLATE BINARY ASC,
                n.start_line ASC, n.id ASC
       LIMIT ?`,
    ).all(JSON.stringify(uniqueNames), project, safeLimit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  findNodesContainingLine(
    project: string,
    filePath: string,
    line: number,
    limit = 20,
  ): CodeNode[] {
    const safeLine = Math.max(1, Math.floor(line));
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const normalizedPath = normalizePathForSearch(filePath);
    const rows = this.db.prepare(
      `SELECT *
       FROM nodes
       WHERE project = ?
         AND REPLACE(file_path, CHAR(92), '/') = ?
         AND start_line <= ? AND end_line >= ?
       ORDER BY (end_line - start_line) ASC, start_line DESC, id ASC
       LIMIT ?`,
    ).all(project, normalizedPath, safeLine, safeLine, safeLimit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  getProjectCallSiteStatus(project: string): ProjectCallSiteStatus {
    const reasons: string[] = [];
    try {
      const status = this.db.prepare(
        `SELECT cross_file_calls_stale, call_sites_initialized
         FROM projects WHERE name = ? LIMIT 1`,
      ).get(project) as ProjectCallSiteStatusRow | undefined;
      if (!status) reasons.push('project_status_unavailable');
      else {
        if (status.call_sites_initialized !== 1) reasons.push('call_sites_not_initialized');
        if (status.cross_file_calls_stale !== 0) reasons.push('cross_file_call_status_unknown_or_stale');
      }
    } catch {
      reasons.push('project_status_unavailable');
    }
    return { complete: reasons.length === 0, incomplete_reasons: reasons };
  }

  listProjectCallSites(
    project: string,
    options: { includeTests?: boolean; limit?: number } = {},
  ): { call_sites: StaticCallLinkSummary[]; truncated: boolean; available: boolean } {
    const safeLimit = Math.max(1, Math.min(250_000, Math.floor(options.limit ?? 200_000)));
    const normalizedPath = `LOWER(REPLACE(file_path, CHAR(92), '/'))`;
    const productionFilter = options.includeTests === true
      ? ''
      : `AND NOT (
          ${normalizedPath} LIKE '%/test/%'
          OR ${normalizedPath} LIKE '%/tests/%'
          OR ${normalizedPath} LIKE '%/__tests__/%'
          OR ${normalizedPath} LIKE 'test/%'
          OR ${normalizedPath} LIKE 'tests/%'
          OR ${normalizedPath} LIKE '__tests__/%'
          OR ${normalizedPath} LIKE '%.test.%'
          OR ${normalizedPath} LIKE '%.spec.%'
        )`;
    let rows: Array<{ source_qn: string; last_segment: string; line: number }>;
    try {
      rows = this.db.prepare(
        `SELECT source_qn, last_segment, line
         FROM call_sites
         WHERE project = ?
         ${productionFilter}
         LIMIT ?`,
      ).all(project, safeLimit + 1) as typeof rows;
    } catch {
      return { call_sites: [], truncated: false, available: false };
    }
    const truncated = rows.length > safeLimit;
    return {
      call_sites: rows.slice(0, safeLimit).map((row) => ({
        owner_qualified_name: callerOwnerQualifiedName(row.source_qn),
        symbol: row.last_segment,
        line: row.line,
      })),
      truncated,
      available: true,
    };
  }

  /**
   * Aggregate direct static call-sites for one exact symbol in SQLite.
   *
   * `call_sites` preserves every syntactic occurrence, unlike the deduplicated
   * CALLS edge table. Nested anonymous callbacks are rolled up to their nearest
   * named owner so one caller receives its real static call count. Ambiguous
   * target names and stale/legacy call-site metadata are returned explicitly
   * instead of presenting a partial result as exhaustive.
   */
  listDirectCallers(
    project: string,
    symbol: string,
    options: { includeTests?: boolean; limit?: number } = {},
  ): DirectCallerAggregation {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));
    const includeTests = options.includeTests === true;
    const incompleteReasons: string[] = [];

    const targetProbe = this.findNodesByName(project, symbol, undefined, 1001);
    if (targetProbe.length > 1000) incompleteReasons.push('target_search_truncated');
    const targetCandidates = targetProbe.slice(0, 1000)
      .filter((node) => includeTests || !isTestSourcePath(node.file_path))
      .map((node) => ({
        qualified_name: node.qualified_name,
        path: normalizePathForSearch(node.file_path),
        definition_line: node.start_line,
      }));
    if (targetCandidates.length === 0) incompleteReasons.push('target_not_found');
    if (targetCandidates.length > 1) incompleteReasons.push('target_ambiguous');
    if (targetCandidates.length > 20) {
      targetCandidates.length = 20;
      incompleteReasons.push('target_candidates_truncated');
    }

    try {
      const status = this.db
        .prepare(
          `SELECT cross_file_calls_stale, call_sites_initialized
           FROM projects WHERE name = ? LIMIT 1`,
        )
        .get(project) as ProjectCallSiteStatusRow | undefined;
      if (!status) incompleteReasons.push('project_status_unavailable');
      else {
        if (status.call_sites_initialized !== 1) incompleteReasons.push('call_sites_not_initialized');
        if (status.cross_file_calls_stale === 1) incompleteReasons.push('cross_file_calls_stale');
        else if (status.cross_file_calls_stale !== 0) incompleteReasons.push('cross_file_call_status_unknown');
      }
    } catch {
      incompleteReasons.push('project_status_unavailable');
    }

    const normalizedPath = `LOWER(REPLACE(file_path, CHAR(92), '/'))`;
    const productionFilter = includeTests
      ? ''
      : `AND NOT (
          ${normalizedPath} LIKE '%/test/%'
          OR ${normalizedPath} LIKE '%/tests/%'
          OR ${normalizedPath} LIKE '%/__tests__/%'
          OR ${normalizedPath} LIKE 'test/%'
          OR ${normalizedPath} LIKE 'tests/%'
          OR ${normalizedPath} LIKE '__tests__/%'
          OR ${normalizedPath} LIKE '%.test.%'
          OR ${normalizedPath} LIKE '%.spec.%'
        )`;

    let rows: DirectCallerRow[];
    let totalCallSites = 0;
    try {
      rows = this.db.prepare(
        `SELECT source_qn, file_path, COUNT(*) AS call_sites, MIN(line) AS first_call_line
         FROM call_sites
         WHERE project = ? AND last_segment = ?
         ${productionFilter}
         GROUP BY source_qn, file_path
         ORDER BY source_qn COLLATE BINARY ASC, file_path COLLATE BINARY ASC
         LIMIT ?`,
      ).all(project, symbol, safeLimit + 1) as DirectCallerRow[];
      const count = this.db.prepare(
        `SELECT COUNT(*) AS c
         FROM call_sites
         WHERE project = ? AND last_segment = ?
         ${productionFilter}`,
      ).get(project, symbol) as CountRow;
      totalCallSites = count.c;
    } catch {
      return {
        symbol,
        target_candidates: targetCandidates,
        callers: [],
        callers_by_name: {},
        total_call_sites: 0,
        callers_truncated: false,
        complete: false,
        incomplete_reasons: [...new Set([...incompleteReasons, 'call_sites_unavailable'])].sort(),
      };
    }

    const callersTruncated = rows.length > safeLimit;
    if (callersTruncated) {
      rows = rows.slice(0, safeLimit);
      incompleteReasons.push('callers_truncated');
    }

    const grouped = new Map<string, {
      qualifiedName: string;
      filePath: string;
      callSites: number;
      firstCallLine: number;
    }>();
    for (const row of rows) {
      const qualifiedName = callerOwnerQualifiedName(row.source_qn);
      const key = `${qualifiedName}\0${normalizePathForSearch(row.file_path)}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.callSites += row.call_sites;
        existing.firstCallLine = Math.min(existing.firstCallLine, row.first_call_line);
      } else {
        grouped.set(key, {
          qualifiedName,
          filePath: normalizePathForSearch(row.file_path),
          callSites: row.call_sites,
          firstCallLine: row.first_call_line,
        });
      }
    }

    const ownerQualifiedNames = [...new Set([...grouped.values()].map((row) => row.qualifiedName))];
    const ownerNodes = new Map<string, CodeNode>();
    if (ownerQualifiedNames.length > 0) {
      const ownerRows = this.db.prepare(
        `SELECT n.* FROM nodes n
         JOIN json_each(?) q ON n.qualified_name = CAST(q.value AS TEXT)
         WHERE n.project = ?
         ORDER BY n.id ASC`,
      ).all(JSON.stringify(ownerQualifiedNames), project) as CodeNodeRow[];
      for (const row of ownerRows) {
        const node = deserializeCodeNode(row);
        if (!ownerNodes.has(node.qualified_name)) ownerNodes.set(node.qualified_name, node);
      }
    }

    const callers = [...grouped.values()].map((row): DirectCallerSummary => {
      const owner = ownerNodes.get(row.qualifiedName);
      const name = owner?.name ?? row.qualifiedName.split('::').at(-1) ?? row.qualifiedName;
      return {
        name,
        qualified_name: row.qualifiedName,
        path: normalizePathForSearch(owner?.file_path ?? row.filePath),
        definition_line: owner?.start_line ?? row.firstCallLine,
        call_sites: row.callSites,
      };
    }).sort((left, right) => (
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      || left.definition_line - right.definition_line
      || (left.qualified_name < right.qualified_name ? -1 : left.qualified_name > right.qualified_name ? 1 : 0)
    ));

    const callersByName: Record<string, number> = {};
    const callerNameOwners = new Map<string, number>();
    for (const caller of callers) {
      callersByName[caller.name] = (callersByName[caller.name] ?? 0) + caller.call_sites;
      callerNameOwners.set(caller.name, (callerNameOwners.get(caller.name) ?? 0) + 1);
    }
    if ([...callerNameOwners.values()].some((count) => count > 1)) {
      incompleteReasons.push('caller_names_ambiguous');
    }

    const reasons = [...new Set(incompleteReasons)].sort();
    return {
      symbol,
      target_candidates: targetCandidates,
      callers,
      callers_by_name: callersByName,
      total_call_sites: totalCallSites,
      callers_truncated: callersTruncated,
      complete: reasons.length === 0,
      incomplete_reasons: reasons,
    };
  }

  /**
   * Return distinct indexed source paths in deterministic order.
   *
   * Source-text lookup deliberately starts from graph-owned paths instead of
   * walking the repository. This keeps the MCP read surface confined to the
   * published project and avoids exposing ignored or unrelated files.
   */
  listProjectFilePaths(project: string, limit = 20_001): string[] {
    const safeLimit = Math.max(0, Math.min(100_000, Math.floor(limit)));
    if (safeLimit === 0) return [];
    const rows = this.db.prepare(`
      SELECT DISTINCT file_path
      FROM nodes
      WHERE project = ? AND file_path IS NOT NULL AND file_path != ''
      ORDER BY file_path COLLATE BINARY ASC
      LIMIT ?
    `).all(project, safeLimit) as Array<{ file_path: string }>;
    return rows.map((row) => row.file_path);
  }

  /**
   * Count incoming edges of one semantic type for a set of nodes.
   *
   * A node's generic in-degree includes structural CONTAINS/IMPORTS edges and
   * therefore cannot be used to decide whether a callable has callers. Keeping
   * this query separate also preserves the all-edge semantics of
   * getBulkNodeDegreesSplit(), which is used by MCP context preparation.
   */
  getBulkIncomingEdgeCounts(nodeIds: number[], edgeType: string): Map<number, number> {
    const result = new Map<number, number>();
    if (nodeIds.length === 0) return result;
    for (const id of nodeIds) result.set(id, 0);
    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = this.db
          .prepare(
            `SELECT target_id AS id, COUNT(*) AS c
             FROM edges
             WHERE type = ? AND target_id IN (${placeholders})
             GROUP BY target_id`,
          )
          .all(edgeType, ...chunk) as DegreeCountRow[];
        for (const row of rows) result.set(row.id, row.c);
      } catch {
        // Preserve the bulk-reader convention: unavailable counts remain zero.
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
   * Bulk-fetch all internal edges for a set of node IDs with source-side
   * chunked queries. Directional caps reuse the returned rows in memory.
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
    return this.getBulkEdgesWithStats(nodeIds, limitPerNode).edges;
  }

  /**
   * Fetch internal edges with honest directional caps and coverage metadata.
   * Every admitted edge consumes one source-out and one target-in slot. The old
   * two-pass deduplication only charged whichever side saw the edge first,
   * allowing both advertised caps to be exceeded substantially.
   */
  getBulkEdgesWithStats(nodeIds: number[], limitPerNode = 0): BulkEdgesResult {
    const empty: BulkEdgesResult = {
      edges: [],
      strategy: 'connectivity-first-dual-cap-v1',
      total_induced_edges: 0,
      returned_edges: 0,
      edges_truncated: false,
      limit_per_direction: Math.max(0, limitPerNode),
      available_by_type: {},
      returned_by_type: {},
    };
    if (nodeIds.length === 0) return empty;
    const nodeIdSet = new Set(nodeIds);
    const visibleNodeIdsJson = JSON.stringify([...nodeIdSet]);
    const seenEdgeKeys = new Set<string>();
    const visibleRows: EdgeTripleRow[] = [];

    for (let i = 0; i < nodeIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = nodeIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      // Fail the whole overview on SQL errors. Returning a partial result here
      // would make total_induced_edges and edges_truncated look authoritative.
      const outRows = this.db
        .prepare(
          `SELECT source_id, target_id, type
           FROM edges
           WHERE source_id IN (${placeholders})
             AND target_id IN (
               SELECT CAST(value AS INTEGER) FROM json_each(?)
             )
           ORDER BY id ASC`,
        )
        // Keep source-side chunking for the existing deterministic ordering,
        // but make SQLite return only induced edges. Previously a visible hub
        // materialized every external out-edge before JavaScript discarded it.
        .all(...chunk, visibleNodeIdsJson) as EdgeTripleRow[];
      for (const row of outRows) {
        const key = `${row.source_id}-${row.target_id}-${row.type}`;
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);
        visibleRows.push(row);
      }
    }
    const availableByType: Record<string, number> = {};
    for (const row of visibleRows) {
      availableByType[row.type] = (availableByType[row.type] ?? 0) + 1;
    }

    if (limitPerNode <= 0) {
      return {
        edges: visibleRows.map((row) => ({
          source: row.source_id,
          target: row.target_id,
          type: row.type,
        })),
        strategy: 'connectivity-first-dual-cap-v1',
        total_induced_edges: visibleRows.length,
        returned_edges: visibleRows.length,
        edges_truncated: false,
        limit_per_direction: 0,
        available_by_type: availableByType,
        returned_by_type: { ...availableByType },
      };
    }

    const edgePriority = (type: string): number => {
      switch (type.toUpperCase()) {
        case 'CONTAINS':
        case 'DECLARES':
        case 'DEFINES':
        case 'HAS_METHOD':
          return 0;
        case 'EXTENDS':
        case 'IMPLEMENTS':
        case 'IMPORTS':
          return 1;
        case 'CALLS':
          return 2;
        default:
          return 3;
      }
    };
    const orderedRows = visibleRows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => edgePriority(a.row.type) - edgePriority(b.row.type) || a.index - b.index)
      .map(({ row }) => row);

    const perNodeOutCount = new Map<number, number>();
    const perNodeInCount = new Map<number, number>();
    const edges: Array<{ source: number; target: number; type: string }> = [];
    const returnedByType: Record<string, number> = {};
    const selectedKeys = new Set<string>();
    const parent = new Map<number, number>(nodeIds.map((id) => [id, id]));
    const findRoot = (id: number): number => {
      let root = parent.get(id) ?? id;
      while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
      let current = id;
      while ((parent.get(current) ?? current) !== root) {
        const next = parent.get(current) ?? current;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (source: number, target: number) => {
      const sourceRoot = findRoot(source);
      const targetRoot = findRoot(target);
      if (sourceRoot !== targetRoot) parent.set(targetRoot, sourceRoot);
    };
    const canAdmit = (row: EdgeTripleRow): boolean => (
      (perNodeOutCount.get(row.source_id) ?? 0) < limitPerNode
      && (perNodeInCount.get(row.target_id) ?? 0) < limitPerNode
    );
    const admit = (row: EdgeTripleRow) => {
      const sourceOut = perNodeOutCount.get(row.source_id) ?? 0;
      const targetIn = perNodeInCount.get(row.target_id) ?? 0;
      perNodeOutCount.set(row.source_id, sourceOut + 1);
      perNodeInCount.set(row.target_id, targetIn + 1);
      edges.push({ source: row.source_id, target: row.target_id, type: row.type });
      returnedByType[row.type] = (returnedByType[row.type] ?? 0) + 1;
      selectedKeys.add(`${row.source_id}-${row.target_id}-${row.type}`);
    };

    // First reserve scarce directional slots for a spanning forest. Cycles
    // cannot improve overview connectivity and are filled only afterwards.
    for (const row of orderedRows) {
      if (row.source_id === row.target_id || findRoot(row.source_id) === findRoot(row.target_id)) continue;
      if (!canAdmit(row)) continue;
      admit(row);
      union(row.source_id, row.target_id);
    }
    for (const row of orderedRows) {
      const key = `${row.source_id}-${row.target_id}-${row.type}`;
      if (selectedKeys.has(key) || !canAdmit(row)) continue;
      admit(row);
    }

    return {
      edges,
      strategy: 'connectivity-first-dual-cap-v1',
      total_induced_edges: visibleRows.length,
      returned_edges: edges.length,
      edges_truncated: edges.length < visibleRows.length,
      limit_per_direction: Math.max(0, limitPerNode),
      available_by_type: availableByType,
      returned_by_type: returnedByType,
    };
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
   * @param edgeType     optional exact semantic edge type (for example CALLS)
   */
  getBulkNeighbors(
    nodeIds: number[],
    direction: 'in' | 'out' | 'both' = 'both',
    limitPerNode = 50,
    edgeType?: string,
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
    const edgeProperties = this.propertiesExpression('e', this.edgePropertiesColumn);
    const EDGE_COLS = `e.id AS edge_id, e.project AS edge_project, e.source_id, e.target_id,
                       e.type AS edge_type, ${edgeProperties} AS edge_properties`;

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
      const typeFilter = edgeType ? ' AND e.type = ?' : '';
      const params: Array<number | string> = edgeType ? [...chunk, edgeType] : chunk;
      try {
        if (direction === 'out' || direction === 'both') {
          // Out-edges: chunk nodes are sources; neighbor is target.
          const outRows = this.db
            .prepare(
              `SELECT ${EDGE_COLS} FROM edges e
               WHERE e.source_id IN (${placeholders})${typeFilter}
               ORDER BY e.id ASC`,
            )
            .all(...params) as BulkEdgeRow[];
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
               WHERE e.target_id IN (${placeholders})${typeFilter}
               ORDER BY e.id ASC`,
            )
            .all(...params) as BulkEdgeRow[];
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

  /** Return exact distinct incoming-neighbor labels without loading full nodes. */
  getBulkIncomingNeighborLabels(nodeIds: number[], edgeType: string): Map<number, string> {
    const result = new Map<number, string>();
    const uniqueIds = [...new Set(nodeIds.filter(Number.isSafeInteger))];
    for (let i = 0; i < uniqueIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + BULK_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const rows = this.db.prepare(
          `SELECT DISTINCT n.id, n.label
           FROM edges e
           JOIN nodes n ON n.id = e.source_id
           WHERE e.target_id IN (${placeholders}) AND e.type = ?`,
        ).all(...chunk, edgeType) as Array<{ id: number; label: string }>;
        for (const row of rows) result.set(row.id, row.label);
      } catch {
        // Legacy/minimal graph: preserve partial-result reader semantics.
      }
    }
    return result;
  }

  /**
   * Find nodes by file path substring (used by prepare_edit_context).
   *
   * Both the query and stored paths are compared with `/` separators. This is
   * intentionally independent of the host OS: a graph indexed on Windows can
   * be queried with `src/auth.ts`, and a POSIX graph with `src\\auth.ts`.
   * Absolute queries are made project-relative when the projects table has a
   * root_path, which lets MCP callers pass the absolute paths they receive from
   * editor or workspace integrations.
   */
  findNodesByFilePath(project: string, filePathSubstr: string, limit = 50): CodeNode[] {
    const safeLimit = Math.max(0, Math.min(10000, Math.floor(limit)));
    if (safeLimit === 0) return [];

    const normalizedQuery = normalizePathForSearch(filePathSubstr);
    if (normalizedQuery.length === 0) return [];

    const searchTerms = [normalizedQuery];
    try {
      const root = this.getProjectRoot(project);
      if (root) {
        const normalizedRoot = normalizePathForSearch(root).replace(/\/+$/, '');
        const rootPrefix = `${normalizedRoot}/`;
        if (normalizedQuery.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
          const relativeQuery = normalizedQuery.slice(rootPrefix.length);
          if (relativeQuery.length > 0) searchTerms.unshift(relativeQuery);
        }
      }
    } catch {
      // Legacy/minimal V1 databases may not expose projects.root_path. The
      // normalized full query remains valid and preserves prior behavior.
    }

    const uniqueTerms = [...new Set(searchTerms)];
    const pathExpression = `REPLACE(file_path, CHAR(92), '/')`;
    const conditions = uniqueTerms.map(() => `${pathExpression} LIKE ? ESCAPE '\\'`).join(' OR ');
    const likePatterns = uniqueTerms.map(term => `%${escapeLike(term)}%`);
    return (
      this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND (${conditions})
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(project, ...likePatterns, safeLimit) as CodeNodeRow[]
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
   * Exhaustive literal substring search for the Graph UI. Results are scoped
   * to one project, ordered by stable node id, and paged without OFFSET so a
   * caller never has to download the overview sample before searching.
   */
  searchNodesExactPage(
    project: string,
    query: string,
    afterRank = -1,
    afterNodeId = 0,
    limit = 50,
  ): ExactNodeSearchPage {
    const safeQuery = query.trim();
    const safeAfterRank = Number.isSafeInteger(afterRank)
      ? Math.max(-1, Math.min(5, afterRank))
      : -1;
    const safeAfterNodeId = Number.isSafeInteger(afterNodeId)
      ? Math.max(0, afterNodeId)
      : 0;
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(250, limit))
      : 50;
    if (safeQuery.length === 0) {
      return {
        nodes: [],
        total_matches: 0,
        next_after_rank: null,
        next_after_node_id: null,
      };
    }

    const portableQuery = normalizePathForSearch(safeQuery);
    const prefixPattern = `${escapeLike(safeQuery)}%`;
    const rawPattern = `%${escapeLike(safeQuery)}%`;
    const portablePattern = `%${escapeLike(portableQuery)}%`;
    const matchSql = `(
      name LIKE ? ESCAPE '\\'
      OR REPLACE(qualified_name, CHAR(92), '/') LIKE ? ESCAPE '\\'
      OR REPLACE(file_path, CHAR(92), '/') LIKE ? ESCAPE '\\'
    )`;
    const totalMatches = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND ${matchSql}`)
        .get(project, rawPattern, portablePattern, portablePattern) as CountRow
    ).c;
    const rankSql = `CASE
      WHEN name = ? COLLATE NOCASE THEN 0
      WHEN REPLACE(qualified_name, CHAR(92), '/') = ? COLLATE NOCASE
        OR REPLACE(file_path, CHAR(92), '/') = ? COLLATE NOCASE THEN 1
      WHEN name LIKE ? ESCAPE '\\' THEN 2
      WHEN name LIKE ? ESCAPE '\\' THEN 3
      WHEN REPLACE(qualified_name, CHAR(92), '/') LIKE ? ESCAPE '\\' THEN 4
      ELSE 5
    END`;
    const rows = this.db
      .prepare(
        `WITH ranked_matches AS (
           SELECT nodes.*, ${rankSql} AS match_rank
           FROM nodes
           WHERE project = ? AND ${matchSql}
         )
         SELECT * FROM ranked_matches
         WHERE match_rank > ? OR (match_rank = ? AND id > ?)
         ORDER BY match_rank ASC, id ASC
         LIMIT ?`,
      )
      .all(
        safeQuery,
        portableQuery,
        portableQuery,
        prefixPattern,
        rawPattern,
        portablePattern,
        project,
        rawPattern,
        portablePattern,
        portablePattern,
        safeAfterRank,
        safeAfterRank,
        safeAfterNodeId,
        safeLimit + 1,
      ) as Array<CodeNodeRow & { match_rank: number }>;
    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    return {
      nodes: pageRows.map(deserializeCodeNode),
      total_matches: totalMatches,
      next_after_rank: hasMore && lastRow ? lastRow.match_rank : null,
      next_after_node_id: hasMore && lastRow ? lastRow.id : null,
    };
  }

  /**
   * Return the most connected nodes for one label.
   *
   * The Graph UI uses this as a building block for a balanced overview. The
   * old overview selected the first N node ids, which made large projects
   * appear to contain only whichever directory happened to be indexed first.
   * Ranking within every label keeps the sample deterministic while retaining
   * the nodes that carry the most structural information.
   */
  listNodesByLabelRanked(project: string, label: string, limit: number): CodeNode[] {
    const safeLimit = Math.max(0, Math.min(10000, Math.floor(limit)));
    if (safeLimit === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT n.*
         FROM nodes n
         WHERE n.project = ? AND n.label = ?
         ORDER BY (
           (SELECT COUNT(*) FROM edges outgoing WHERE outgoing.source_id = n.id) +
           (SELECT COUNT(*) FROM edges incoming WHERE incoming.target_id = n.id)
         ) DESC, n.id ASC
         LIMIT ?`
      )
      .all(project, label, safeLimit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  /** Return callable candidates with no incoming edge for dead-code sampling. */
  listNodesWithoutIncoming(project: string, labels: string[], limit: number): CodeNode[] {
    const safeLimit = Math.max(0, Math.min(10000, Math.floor(limit)));
    if (safeLimit === 0 || labels.length === 0) return [];
    const placeholders = labels.map(() => '?').join(',');
    const nodeProperties = this.propertiesExpression('n', this.nodePropertiesColumn);
    const rows = this.db
      .prepare(
        `SELECT n.*
         FROM nodes n
         WHERE n.project = ?
           AND n.label IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM edges incoming
             WHERE incoming.target_id = n.id AND incoming.type = 'CALLS'
           )
         ORDER BY
           CASE
             WHEN LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '%/test/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '%/tests/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '%/__tests__/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE 'test/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE 'tests/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '__tests__/%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '%.test.%'
               OR LOWER(REPLACE(n.file_path, CHAR(92), '/')) LIKE '%.spec.%'
             THEN 1 ELSE 0
           END ASC,
           CASE
             WHEN json_valid(${nodeProperties}) THEN
               CASE
                 WHEN COALESCE(json_extract(${nodeProperties}, '$.is_exported'), 0) IN (1, 'true')
                   OR COALESCE(json_extract(${nodeProperties}, '$.exported'), 0) IN (1, 'true')
                 THEN 1 ELSE 0
               END
             ELSE 0
           END ASC,
           n.id ASC
         LIMIT ?`
      )
      .all(project, ...labels, safeLimit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  /**
   * Find code nodes by a name, qualified name, or portable file-path
   * substring. Labels are parameters rather than SQL fragments, so callers
   * can implement explicit fallback orders without loading the graph in JS.
   */
  findNodesByNameOrPath(
    project: string,
    namePattern: string,
    labels: readonly string[],
    limit = 50,
  ): CodeNode[] {
    const safeLimit = Math.max(0, Math.min(10000, Math.floor(limit)));
    if (safeLimit === 0 || labels.length === 0 || namePattern.length === 0) return [];

    const placeholders = labels.map(() => '?').join(',');
    const rawPattern = `%${escapeLike(namePattern)}%`;
    const portablePattern = `%${escapeLike(normalizePathForSearch(namePattern))}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE project = ?
           AND label IN (${placeholders})
           AND (
             name LIKE ? ESCAPE '\\'
             OR REPLACE(qualified_name, CHAR(92), '/') LIKE ? ESCAPE '\\'
             OR REPLACE(file_path, CHAR(92), '/') LIKE ? ESCAPE '\\'
           )
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(project, ...labels, rawPattern, portablePattern, portablePattern, safeLimit) as CodeNodeRow[];
    return rows.map(deserializeCodeNode);
  }

  /** Find modules by name, qualified name, or portable file path. */
  findModulesByName(project: string, namePattern: string, limit = 50): CodeNode[] {
    return this.findNodesByNameOrPath(project, namePattern, ['Module'], limit);
  }

  /**
   * Find routes by HTTP method + path.
   */
  findRoute(project: string, method: string, path: string): CodeNode | null {
    // Use json_extract (SQLite 3.38+) for an indexed-style exact lookup.
    // Fall back to JS-side filtering if json_extract is unavailable.
    try {
      const nodeProperties = this.propertiesExpression('nodes', this.nodePropertiesColumn);
      const row = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE project = ? AND label = 'Route'
             AND LOWER(json_extract(${nodeProperties}, '$.route_method')) = LOWER(?)
             AND json_extract(${nodeProperties}, '$.route_path') = ?
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
          props = JSON.parse(rowPropertiesJson(row));
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
    properties_json: rowPropertiesJson(row),
  };
}
