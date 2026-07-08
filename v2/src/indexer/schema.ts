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
 */
export function initIndexerSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.exec(SCHEMA_SQL);
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
