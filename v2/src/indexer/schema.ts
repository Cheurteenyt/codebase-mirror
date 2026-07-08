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
    size INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    UNIQUE(project, file_path)
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    node_count INTEGER DEFAULT 0,
    edge_count INTEGER DEFAULT 0
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
 * Clear all data for a project (nodes, edges, file_hashes) before re-indexing.
 * Does NOT clear the projects table — that's updated separately.
 */
export function clearProjectData(db: Database.Database, project: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(project);
  });
  tx();
}

/**
 * Update the projects table with final counts after indexing.
 */
export function updateProjectStats(
  db: Database.Database,
  project: string,
  rootPath: string,
  nodeCount: number,
  edgeCount: number,
): void {
  db.prepare(`
    INSERT INTO projects (name, root_path, indexed_at, node_count, edge_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      root_path = excluded.root_path,
      indexed_at = excluded.indexed_at,
      node_count = excluded.node_count,
      edge_count = excluded.edge_count
  `).run(project, rootPath, new Date().toISOString(), nodeCount, edgeCount);
}
