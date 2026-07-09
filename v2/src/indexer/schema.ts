// v2/src/indexer/schema.ts
// R68: SQLite schema for the native TypeScript/JavaScript indexer.
// Compatible with V1's schema — V2's sqlite-ro.ts can read the same DB
// whether it was created by V1 (C, 158 languages) or V2 (TS/JS only).
//
// This is NOT a replacement for V1. V1 supports 158 languages via tree-sitter.
// This module gives V2 partial autonomy for TS/JS projects when the `cbm`
// binary is unavailable.

import type Database from 'better-sqlite3';

/**
 * Tables created by the native indexer. Matches V1's schema so that
 * CodeGraphReader (sqlite-ro.ts) can read the DB transparently.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    properties_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    properties_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS file_hashes (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    mtime_ns TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    UNIQUE(project, file_path)
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    node_count INTEGER DEFAULT 0,
    edge_count INTEGER DEFAULT 0,
    cross_file_calls_stale INTEGER DEFAULT 0,
    -- R107: explicit flag indicating that a full R106+ reindex has populated
    -- the call_sites table (even if it found 0 call-sites). This distinguishes
    -- a valid R106 DB with 0 call-sites from a legacy pre-R106 DB that never
    -- had call_sites. Without this flag, hasCallSites()===false is ambiguous.
    call_sites_initialized INTEGER DEFAULT 0
  );

  -- R106: Call-sites persistent table.
  -- Stores unresolved call-sites from every file so that cross-file CALLS
  -- edges can be rebuilt in incremental mode (without re-parsing unchanged files).
  -- Schema:
  --   - project + file_path: which file the call-site lives in
  --   - source_qn: qualified name of the enclosing function/method (CALLS source)
  --   - callee: raw callee expression text (e.g. obj.method or foo)
  --   - last_segment: last segment of callee (e.g. method) - used for symbol lookup
  --   - call_kind: identifier_call | member_call | computed_call
  --   - line: 1-indexed source line (for diagnostics)
  -- In incremental mode, only call_sites for changed/deleted files are removed;
  -- call_sites for unchanged files remain and participate in resolution.
  CREATE TABLE IF NOT EXISTS call_sites (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source_qn TEXT NOT NULL,
    callee TEXT NOT NULL,
    last_segment TEXT NOT NULL,
    call_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  );

  -- R110: Imports persistent table.
  -- Stores import bindings per file so that cross-file CALLS resolution can
  -- prioritize imported symbols over name-based fallback.
  -- Schema:
  --   - project + file_path: which file the import lives in
  --   - local_name: the name used in the file (after alias, if any)
  --   - source_module: the module path as written (e.g. './b', './utils/helpers')
  --   - imported_name: the original name in the source module (before alias)
  --   - import_kind: named | alias | default | namespace
  --   - line: 1-indexed source line
  -- When resolving a call-site, the resolver checks if the callee name matches
  -- a local_name in the file's imports. If so, it resolves to the source module's
  -- symbol with high confidence (cross_file_import_exact or cross_file_import_alias).
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    local_name TEXT NOT NULL,
    source_module TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    import_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  );

  -- Indexes matching V1's layout for query compatibility.
  CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
  CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(project, qualified_name);
  CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(project, label);
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
  CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(project, file_path);
  -- R106: indexes for call_sites — (project, file_path) for per-file delete/replace,
  -- (project, last_segment) is intentionally NOT created because resolution loads
  -- all call_sites for a project at once and uses an in-memory Map (faster than
  -- per-row index lookup for the typical 1k-100k call-site range).
  CREATE INDEX IF NOT EXISTS idx_call_sites_project_file ON call_sites(project, file_path);
  -- R110: index for imports — (project, file_path) for per-file delete/replace.
  CREATE INDEX IF NOT EXISTS idx_imports_project_file ON imports(project, file_path);
`;

/**
 * Initialize the SQLite schema for the native indexer.
 * Idempotent — uses CREATE IF NOT EXISTS.
 * R81: also migrates pre-R80 file_hashes tables from UNIQUE(file_path) to
 * UNIQUE(project, file_path) so old DBs don't break with the new ON CONFLICT.
 */
export function initIndexerSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.exec(SCHEMA_SQL);
  // R81: Bug 15 — migrate old file_hashes schema if needed
  migrateFileHashesSchema(db);
  // R83: add size column if missing (for mtime+size fast skip)
  migrateFileHashesSizeColumn(db);
  // R85: add mtime_ns column if missing (for nanosecond precision fast skip)
  migrateFileHashesMtimeNsColumn(db);
  // R101: add cross_file_calls_stale column to projects if missing
  migrateProjectsCrossFileStale(db);
  // R107: add call_sites_initialized column to projects if missing
  migrateProjectsCallSitesInitialized(db);
  // R106: call_sites table is created by SCHEMA_SQL (CREATE IF NOT EXISTS),
  // but the index idx_call_sites_project_file must exist for legacy DBs that
  // already had the table created without it. CREATE INDEX IF NOT EXISTS in
  // SCHEMA_SQL handles this idempotently.
}

/**
 * R81: Bug 15 — Migrate file_hashes from pre-R80 schema (UNIQUE(file_path))
 * to R80+ schema (UNIQUE(project, file_path)). CREATE TABLE IF NOT EXISTS
 * doesn't migrate existing tables, so old DBs keep the old constraint and
 * ON CONFLICT(project, file_path) fails with "does not match any constraint".
 *
 * R82: Bug 23 fix — use PRAGMA index_list/index_info instead of string matching
 * on sqlite_master.sql. More robust against whitespace/case/named-constraint
 * variations. Also cleans up any leftover file_hashes_new from interrupted migration.
 */
function migrateFileHashesSchema(db: Database.Database): void {
  // Clean up any leftover temp table from an interrupted migration
  db.exec('DROP TABLE IF EXISTS file_hashes_new');

  // R82: use PRAGMA to check if a UNIQUE index exists on (project, file_path)
  if (hasUniqueIndexOn(db, 'file_hashes', ['project', 'file_path'])) {
    return; // already has the correct unique constraint
  }

  // Check if table exists at all
  const tableExists = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='file_hashes'"
  ).get() as { c: number };
  if (tableExists.c === 0) return; // CREATE IF NOT EXISTS will make it with correct schema

  // Migrate: create new table, copy data deduped by (project, file_path),
  // drop old, rename, recreate index.
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE file_hashes_new (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(project, file_path)
      );
    `);
    // Copy with dedup: keep the row with the latest indexed_at per (project, file_path)
    db.exec(`
      INSERT INTO file_hashes_new (project, file_path, content_hash, mtime, indexed_at)
      SELECT project, file_path, content_hash, mtime, indexed_at
      FROM file_hashes
      WHERE id IN (
        SELECT id FROM file_hashes fh1
        WHERE NOT EXISTS (
          SELECT 1 FROM file_hashes fh2
          WHERE fh2.project = fh1.project
            AND fh2.file_path = fh1.file_path
            AND (fh2.indexed_at > fh1.indexed_at OR (fh2.indexed_at = fh1.indexed_at AND fh2.id > fh1.id))
        )
      );
    `);
    db.exec('DROP TABLE file_hashes');
    db.exec('ALTER TABLE file_hashes_new RENAME TO file_hashes');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(project, file_path)');
  });
  tx();
}

/**
 * R82: Check if a table has a UNIQUE index on exactly the given columns.
 * Uses PRAGMA index_list + index_info for robust detection.
 */
function hasUniqueIndexOn(db: Database.Database, table: string, columns: string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    if (colNames.length === columns.length && colNames.every((c, i) => c === columns[i])) {
      return true;
    }
  }
  return false;
}

/**
 * R83: Add `size` column to file_hashes if missing. Enables mtime+size fast
 * skip — if mtime AND size match, skip SHA-256 hashing entirely.
 */
function migrateFileHashesSizeColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
  const hasSize = cols.some(c => c.name === 'size');
  if (!hasSize) {
    db.exec('ALTER TABLE file_hashes ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * R85: Add `mtime_ns` column to file_hashes if missing. Enables nanosecond
 * precision fast skip — Math.floor(mtimeMs) can cause false skips when two
 * versions of the same size are written in the same millisecond. mtimeNs
 * (from statSync bigint) gives nanosecond precision, eliminating this risk.
 */
function migrateFileHashesMtimeNsColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
  const hasMtimeNs = cols.some(c => c.name === 'mtime_ns');
  if (!hasMtimeNs) {
    db.exec('ALTER TABLE file_hashes ADD COLUMN mtime_ns TEXT');
  }
}

/**
 * R101: Add cross_file_calls_stale column to projects if missing.
 */
function migrateProjectsCrossFileStale(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'cross_file_calls_stale');
  if (!hasCol) {
    db.exec('ALTER TABLE projects ADD COLUMN cross_file_calls_stale INTEGER DEFAULT 0');
  }
}

/**
 * R107: Add call_sites_initialized column to projects if missing.
 *
 * This flag is set to 1 after any successful full R106+ reindex. It
 * distinguishes:
 *   - A valid R106 DB that found 0 call-sites at full index time (initialized=1)
 *   - A legacy pre-R106 DB that never had call_sites populated (initialized=0)
 *
 * Without this flag, hasCallSites()===false is ambiguous: it returns false
 * for both cases, causing the incremental resolver to skip resolution
 * incorrectly for valid R106 DBs with 0 call-sites (R108 P2 bug).
 */
function migrateProjectsCallSitesInitialized(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'call_sites_initialized');
  if (!hasCol) {
    db.exec('ALTER TABLE projects ADD COLUMN call_sites_initialized INTEGER DEFAULT 0');
  }
}

/**
 * Clear all data for a project (nodes, edges, file_hashes, call_sites, imports) before re-indexing.
 * Does NOT clear the projects table — that's updated separately.
 * R106: also clears call_sites (persistent cross-file resolution table).
 * R110: also clears imports (persistent import bindings table).
 */
export function clearProjectData(db: Database.Database, project: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(project);
    db.prepare('DELETE FROM call_sites WHERE project = ?').run(project);
    db.prepare('DELETE FROM imports WHERE project = ?').run(project);
  });
  tx();
}

/**
 * Update the projects table with final counts after indexing.
 * R101: also persists cross_file_calls_stale flag.
 * R107: also persists call_sites_initialized flag (set to true after full reindex).
 */
export function updateProjectStats(
  db: Database.Database,
  project: string,
  rootPath: string,
  nodeCount: number,
  edgeCount: number,
  crossFileCallsStale: boolean = false,
  callSitesInitialized: boolean = false,
): void {
  db.prepare(`
    INSERT INTO projects (name, root_path, indexed_at, node_count, edge_count, cross_file_calls_stale, call_sites_initialized)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      root_path = excluded.root_path,
      indexed_at = excluded.indexed_at,
      node_count = excluded.node_count,
      edge_count = excluded.edge_count,
      cross_file_calls_stale = excluded.cross_file_calls_stale,
      call_sites_initialized = excluded.call_sites_initialized
  `).run(project, rootPath, new Date().toISOString(), nodeCount, edgeCount, crossFileCallsStale ? 1 : 0, callSitesInitialized ? 1 : 0);
}
