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
}

/**
 * R81: Bug 15 — Migrate file_hashes from pre-R80 schema (UNIQUE(file_path))
 * to R80+ schema (UNIQUE(project, file_path)). CREATE TABLE IF NOT EXISTS
 * doesn't migrate existing tables, so old DBs keep the old constraint and
 * ON CONFLICT(project, file_path) fails with "does not match any constraint".
 *
 * Detection: check sqlite_master.sql for the old UNIQUE(file_path) without
 * the new UNIQUE(project, file_path). If found, rebuild the table.
 */
function migrateFileHashesSchema(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='file_hashes'").get() as { sql: string } | undefined;
  if (!row || !row.sql) return; // table doesn't exist yet (CREATE IF NOT EXISTS will make it)

  const oldSchema = row.sql;
  const hasOldUnique = /file_path\s+TEXT\s+NOT\s+UNIQUE/i.test(oldSchema) ||
                       (oldSchema.includes('UNIQUE') && oldSchema.includes('file_path') && !oldSchema.includes('UNIQUE(project, file_path)'));
  const hasNewUnique = oldSchema.includes('UNIQUE(project, file_path)');

  if (!hasOldUnique || hasNewUnique) return; // already correct or unknown shape

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
