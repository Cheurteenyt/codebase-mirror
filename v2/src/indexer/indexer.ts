// v2/src/indexer/indexer.ts
// R68: Native TypeScript/JavaScript indexer — orchestrateur.
//
// Walks a project directory, extracts code structure using ts-morph,
// and writes to SQLite (compatible with V1's schema).
//
// This gives V2 partial autonomy for TS/JS projects. V1 is still needed
// for 158 other languages (Python, Go, Rust, C, etc.).

import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { initIndexerSchema, clearProjectData, updateProjectStats } from './schema.js';
import { discoverSourceFiles, extractFromFiles, type ExtractionResult } from './extractor.js';

export interface IndexOptions {
  project: string;
  rootPath: string;
  /** If true, skip files whose content hash hasn't changed since last index. */
  incremental?: boolean;
  /** If true, don't write to DB (just report what would be indexed). */
  dryRun?: boolean;
}

export interface IndexResult extends ExtractionResult {
  dbPath: string;
  durationMs: number;
}

/**
 * Index a TypeScript/JavaScript project natively (no V1 `cbm` binary needed).
 *
 * 1. Opens the SQLite DB at defaultCodeDbPath(project)
 * 2. Initializes the schema (compatible with V1)
 * 3. Discovers .ts/.tsx/.js/.jsx/.mjs/.cjs files (skips node_modules, dist, etc.)
 * 4. Extracts nodes (File, Class, Function, Method, Variable) and edges
 *    (CONTAINS, IMPORTS, CALLS) using ts-morph
 * 5. Updates file_hashes for incremental indexing
 * 6. Updates projects table with final counts
 *
 * Limitations vs V1:
 *   - Only TS/JS (V1 supports 158 languages via tree-sitter)
 *   - No simhash/minhash similarity detection
 *   - No cross-repo intelligence
 *   - No git history analysis
 *   - No trace ingestion
 *   - No LSP-based call resolution (uses static analysis only)
 */
export function indexProject(opts: IndexOptions): IndexResult {
  const start = Date.now();
  const dbPath = defaultCodeDbPath(opts.project);

  if (opts.dryRun) {
    const files = discoverSourceFiles(opts.rootPath);
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: files.length,
      skipped: 0,
      errors: [],
    };
  }

  const db = new Database(dbPath);
  initIndexerSchema(db);

  // Clear existing data for this project (full re-index)
  // (Incremental mode skips unchanged files, but still clears + re-indexes
  //  changed ones. A future optimization could do true delta indexing.)
  clearProjectData(db, opts.project);

  const files = discoverSourceFiles(opts.rootPath);
  const result = extractFromFiles(
    db,
    opts.project,
    opts.rootPath,
    files,
    opts.incremental ?? false,
  );

  // Update project stats
  updateProjectStats(db, opts.project, opts.rootPath, result.nodes, result.edges);

  db.close();

  return {
    ...result,
    dbPath,
    durationMs: Date.now() - start,
  };
}
