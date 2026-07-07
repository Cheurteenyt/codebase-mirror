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
import { discoverSourceFilesWasm, detectLanguage, extractFromFilesWasm, preloadGrammars } from './wasm-extractor.js';

export interface IndexOptions {
  project: string;
  rootPath: string;
  /** If true, skip files whose content hash hasn't changed since last index. */
  incremental?: boolean;
  /** If true, don't write to DB (just report what would be indexed). */
  dryRun?: boolean;
  /** Use WASM tree-sitter (112 languages). If false, uses ts-morph (TS/JS only). */
  useWasm?: boolean;
}

export interface IndexResult {
  dbPath: string;
  durationMs: number;
  nodes: number;
  edges: number;
  files: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  languages?: Set<string>;
}

/**
 * Index a project using web-tree-sitter (WASM). Supports 112 languages.
 * No V1 `cbm` binary needed.
 *
 * R69: replaces the ts-morph extractor (R68, TS/JS only) with a WASM-based
 * extractor that supports 112 languages via tree-sitter WASM grammars.
 */
export async function indexProjectWasm(opts: IndexOptions): Promise<IndexResult> {
  const start = Date.now();
  const dbPath = defaultCodeDbPath(opts.project);

  if (opts.dryRun) {
    const files = discoverSourceFilesWasm(opts.rootPath);
    const langs = new Set<string>();
    for (const f of files) {
      const lang = detectLanguage(f);
      if (lang) langs.add(lang);
    }
    return {
      dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
      files: files.length, skipped: 0, errors: [], languages: langs,
    };
  }

  const db = new Database(dbPath);
  initIndexerSchema(db);
  clearProjectData(db, opts.project);

  const files = discoverSourceFilesWasm(opts.rootPath);

  // Detect languages and preload WASM grammars
  const langs = new Set<string>();
  for (const f of files) {
    const lang = detectLanguage(f);
    if (lang) langs.add(lang);
  }
  await preloadGrammars(langs);

  const result = await extractFromFilesWasm(
    db, opts.project, opts.rootPath, files, opts.incremental ?? false,
  );

  updateProjectStats(db, opts.project, opts.rootPath, result.nodes, result.edges);
  db.close();

  return {
    ...result,
    dbPath,
    durationMs: Date.now() - start,
    languages: result.languages,
  };
}
