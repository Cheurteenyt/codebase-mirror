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
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { join, relative as nodeRelative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { WorkerBatch, WorkerBatchResult } from './worker.js';

export interface IndexOptions {
  project: string;
  rootPath: string;
  /** If true, skip files whose content hash hasn't changed since last index. */
  incremental?: boolean;
  /** If true, don't write to DB (just report what would be indexed). */
  dryRun?: boolean;
  /** Use WASM tree-sitter (112 languages). If false, uses ts-morph (TS/JS only). */
  useWasm?: boolean;
  /** Number of worker threads (0 = single-threaded). Default: auto (cpu count - 1). */
  workers?: number;
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
  parallel?: boolean;
  workerCount?: number;
}

/**
 * Index a project using web-tree-sitter (WASM). Supports 112 languages.
 * No V1 `cbm` binary needed.
 *
 * R69: replaces the ts-morph extractor (R68, TS/JS only) with a WASM-based
 * extractor that supports 112 languages via tree-sitter WASM grammars.
 *
 * R71: adds parallel mode using worker_threads. Files are grouped by language,
 * split into batches, and distributed across worker threads. Each worker
 * parses its batch and returns extracted nodes/edges. The main thread
 * collects results and writes to SQLite in a single transaction.
 */
export async function indexProjectWasm(opts: IndexOptions): Promise<IndexResult> {
  const start = Date.now();
  const dbPath = defaultCodeDbPath(opts.project);
  // R71: use at least 2 workers for parallelism, even on 2-core machines.
  // WASM parsing is CPU-bound but also has I/O (file reads), so 2 workers
  // on a 2-core machine still provides overlap. On 1-core machines (CI),
  // falls back to single-threaded.
  const numWorkers = opts.workers ?? Math.max(2, cpus().length - 1);

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

  // Detect languages and group files by language
  const langGroups = new Map<string, string[]>();
  const allLangs = new Set<string>();
  for (const f of files) {
    const lang = detectLanguage(f);
    if (lang) {
      allLangs.add(lang);
      const group = langGroups.get(lang) ?? [];
      group.push(f);
      langGroups.set(lang, group);
    }
  }

  // Preload grammars (needed for single-thread mode, and for the main thread
  // to have them ready if needed)
  await preloadGrammars(allLangs);

  // R71: use parallel mode for large codebases (100+ files). Below that,
  // worker thread overhead (spawning, WASM init, serialization) exceeds
  // the parallelism gain. On 8+ core machines, the threshold could be
  // lower — but 100 is a safe default that doesn't regress small projects.
  const useParallel = numWorkers > 1 && files.length > 100;

  let result;
  if (useParallel) {
    result = await indexParallel(db, opts.project, opts.rootPath, langGroups, numWorkers, opts.incremental ?? false);
  } else {
    result = await extractFromFilesWasm(
      db, opts.project, opts.rootPath, files, opts.incremental ?? false,
    );
  }

  updateProjectStats(db, opts.project, opts.rootPath, result.nodes, result.edges);
  db.close();

  return {
    ...result,
    dbPath,
    durationMs: Date.now() - start,
    languages: result.languages ?? allLangs,
    parallel: useParallel,
    workerCount: useParallel ? numWorkers : 0,
  };
}

/**
 * R71: Parallel indexing using worker_threads.
 *
 * Files are grouped by language, split into batches (one per worker),
 * and processed in parallel. Each worker parses its batch and returns
 * serialized nodes/edges. The main thread collects all results and
 * writes to SQLite in a single transaction.
 *
 * Limitation: cross-file CALLS edge resolution is limited to within
 * each batch (workers can't see other workers' name→QN maps). Intra-file
 * calls work correctly. A future improvement could do a second pass
 * on the main thread to resolve cross-file calls.
 */
async function indexParallel(
  db: Database.Database,
  project: string,
  rootPath: string,
  langGroups: Map<string, string[]>,
  numWorkers: number,
  incremental: boolean,
): Promise<{ nodes: number; edges: number; files: number; skipped: number; errors: Array<{ file: string; error: string }>; languages: Set<string> }> {
  // Build batches: group files by language, then split into worker-sized chunks
  const batches: WorkerBatch[] = [];
  const languages = new Set<string>();

  for (const [lang, langFiles] of langGroups) {
    languages.add(lang);
    // Skip unchanged files for incremental mode
    const filesToIndex: string[] = [];
    for (const f of langFiles) {
      if (incremental) {
        const relPath = nodeRelative(rootPath, f);
        const stat = statSync(f);
        const content = readFileSync(f, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        const existing = db.prepare(
          'SELECT content_hash FROM file_hashes WHERE project = ? AND file_path = ?'
        ).get(project, relPath) as { content_hash: string } | undefined;
        if (existing && existing.content_hash === hash) continue;
        // Update hash
        db.prepare(`
          INSERT INTO file_hashes (project, file_path, content_hash, mtime, indexed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            content_hash = excluded.content_hash, mtime = excluded.mtime, indexed_at = excluded.indexed_at
        `).run(project, relPath, hash, Math.floor(stat.mtimeMs), new Date().toISOString());
      }
      filesToIndex.push(f);
    }

    // Split into batches of ~ceil(files / numWorkers) per language
    const batchSize = Math.max(1, Math.ceil(filesToIndex.length / numWorkers));
    for (let i = 0; i < filesToIndex.length; i += batchSize) {
      batches.push({
        files: filesToIndex.slice(i, i + batchSize),
        language: lang,
        rootPath,
        project,
      });
    }
  }

  if (batches.length === 0) {
    return { nodes: 0, edges: 0, files: 0, skipped: 0, errors: [], languages };
  }

  // Dispatch batches to workers
  const workerPath = join(new URL('.', import.meta.url).pathname, 'worker.js');
  const results: WorkerBatchResult[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let batchIndex = 0;

  // Process batches with a pool of workers
  const workerPromises: Promise<void>[] = [];

  for (let w = 0; w < Math.min(numWorkers, batches.length); w++) {
    workerPromises.push((async () => {
      while (batchIndex < batches.length) {
        const myBatch = batches[batchIndex++];
        if (!myBatch) break;

        try {
          const result = await runWorker(workerPath, myBatch);
          results.push(result);
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          for (const f of myBatch.files) {
            errors.push({ file: nodeRelative(rootPath, f), error: errMsg });
          }
        }
      }
    })());
  }

  await Promise.all(workerPromises);

  // Collect all results and write to SQLite in a single transaction
  let nodeCount = 0;
  let edgeCount = 0;
  let fileCount = 0;
  let nextNodeId = 1;
  let nextEdgeId = 1;

  // Build a global QN→ID map for edge resolution
  const qnToId = new Map<string, number>();

  const insertNode = db.prepare(`
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges (project, source_id, target_id, type, properties_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // First pass: insert all nodes and build QN→ID map
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (fileResult.error) {
          errors.push({ file: fileResult.filePath, error: fileResult.error });
          continue;
        }

        for (const node of fileResult.nodes) {
          const nodeId = nextNodeId++;
          insertNode.run(
            project, node.label, node.name, node.qualifiedName, node.filePath,
            node.startLine, node.endLine, node.properties
          );
          qnToId.set(node.qualifiedName, nodeId);
          nodeCount++;
        }
        fileCount++;
      }
    }

    // Second pass: insert edges, resolving QNs to IDs
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (fileResult.error) continue;

        for (const edge of fileResult.edges) {
          const sourceId = qnToId.get(edge.sourceQn);
          const targetId = qnToId.get(edge.targetQn);
          if (sourceId && targetId) {
            insertEdge.run(project, sourceId, targetId, edge.type, edge.properties);
            nextEdgeId++;
            edgeCount++;
          }
        }
      }
    }
  });
  tx();

  return { nodes: nodeCount, edges: edgeCount, files: fileCount, skipped: 0, errors, languages };
}

/**
 * Run a single worker thread to process a batch of files.
 */
function runWorker(workerPath: string, batch: WorkerBatch): Promise<WorkerBatchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: batch });
    worker.on('message', (result: WorkerBatchResult) => {
      worker.terminate();
      resolve(result);
    });
    worker.on('error', (err: Error) => {
      worker.terminate();
      reject(err);
    });
    worker.on('exit', (code: number) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

// R78: removed buggy custom relative() helper. It used startsWith() which
// returns true for sibling-prefix paths (e.g. '/foo/bar' is a prefix of
// '/foo/barbaz'), producing wrong relative paths in incremental mode.
// Now using node:path.relative (imported as nodeRelative) everywhere.
// See docs/RIGOROUS_BENCHMARK_R78.md Bug 4 for details.
