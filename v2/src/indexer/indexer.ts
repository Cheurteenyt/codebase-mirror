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
  // R79: use at least 2 workers for parallelism, even on 2-core machines.
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
  // R79: Bug 9 fix — incremental mode preserves nodes/edges for unchanged files.
  // Previously clearProjectData deleted everything, then incremental skipped
  // unchanged files, losing their nodes. Now:
  // - Full mode: clear everything (as before)
  // - Incremental mode: don't clear; per-file deletes happen in extractFromFilesWasm
  //   for files that have changed (identified by hash mismatch)
  if (!opts.incremental) {
    clearProjectData(db, opts.project);
  }
  // In incremental mode, we do NOT clear nodes/edges here. The extractor
  // will delete old nodes for changed files before re-inserting.

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

  // R86: Bug 28 fix — useParallel should be based on filesToIndex (after fast-skip),
  // not files.length (total). In incremental mode with 1 file changed out of 10000,
  // spawning workers is wasteful. We do a quick stat+lookup pass to estimate.
  let estimatedFilesToIndex = files.length;
  if (opts.incremental) {
    estimatedFilesToIndex = 0;
    for (const f of files) {
      const relPath = nodeRelative(opts.rootPath, f);
      const stat = statSync(f, { bigint: true });
      const fileMtimeNs = stat.mtimeNs.toString();
      const fileSize = Number(stat.size);
      const existing = db.prepare(
        'SELECT mtime_ns, mtime, size FROM file_hashes WHERE project = ? AND file_path = ?'
      ).get(opts.project, relPath) as { mtime_ns: string | null; mtime: number; size: number } | undefined;
      if (!existing) {
        estimatedFilesToIndex++;
      } else {
        const mtimeMatches = existing.mtime_ns
          ? existing.mtime_ns === fileMtimeNs
          : existing.mtime === Math.floor(Number(stat.mtimeMs));
        if (!mtimeMatches || existing.size !== fileSize) {
          estimatedFilesToIndex++;
        }
      }
    }
  }

  // R81: Bug 17 fix — compute useParallel BEFORE preloadGrammars. In parallel
  // mode, workers load their own grammars, so the main thread doesn't need
  // to preload. This saves Parser.init() + Language.load() cost on LARGE.
  // R86: Bug 28 fix — use estimatedFilesToIndex, not files.length
  const useParallel = numWorkers > 1 && estimatedFilesToIndex > 20;

  if (!useParallel) {
    // Single-thread: main thread needs the grammars
    await preloadGrammars(allLangs);
  }
  // Parallel: workers will load grammars themselves; skip main-thread preload

  let result;
  if (useParallel) {
    result = await indexParallel(db, opts.project, opts.rootPath, langGroups, numWorkers, opts.incremental ?? false);
  } else {
    result = await extractFromFilesWasm(
      db, opts.project, opts.rootPath, files, opts.incremental ?? false,
    );
  }

  // R81: Bug 18 fix — after incremental, projects.node_count/edge_count must
  // reflect the TOTAL in the DB, not just the nodes/edges inserted in this run.
  // Previously, a no-op incremental would set node_count=0 (result.nodes=0).
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
      (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges
  `).get(opts.project, opts.project) as { nodes: number; edges: number };
  updateProjectStats(db, opts.project, opts.rootPath, totals.nodes, totals.edges);
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
  // R80: Bug 11 fix — collect pending hash updates and changed paths here,
  // write them atomically in the transaction AFTER workers succeed.
  const allPendingChangedRelPaths: string[] = [];
  const allPendingHashUpdates: Array<{ relPath: string; hash: string; mtime: number; mtimeNs: string; size: number; indexedAt: string }> = [];
  // R84: Bug 25 — metadata-only hash updates for parallel path (same as single-thread Bug 24)
  const allMetadataOnlyHashUpdates: Array<{ relPath: string; hash: string; mtime: number; mtimeNs: string; size: number; indexedAt: string }> = [];
  let totalSkipped = 0;

  for (const [lang, langFiles] of langGroups) {
    languages.add(lang);
    const filesToIndex: string[] = [];

    for (const f of langFiles) {
      if (incremental) {
        const relPath = nodeRelative(rootPath, f);
        // R85: use bigint stat for nanosecond mtime precision
        const stat = statSync(f, { bigint: true });
        const fileMtime = Math.floor(Number(stat.mtimeMs));
        const fileMtimeNs = stat.mtimeNs.toString();
        const fileSize = Number(stat.size);

        // R85: mtimeNs+size fast skip — nanosecond precision
        const existing = db.prepare(
          'SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?'
        ).get(project, relPath) as { content_hash: string; mtime: number; mtime_ns: string | null; size: number } | undefined;

        if (existing) {
          // R85: use mtime_ns if available, fall back to mtime for pre-R85 DBs
          const mtimeMatches = existing.mtime_ns
            ? existing.mtime_ns === fileMtimeNs
            : existing.mtime === fileMtime;
          if (mtimeMatches && existing.size === fileSize) {
            totalSkipped++;
            continue;
          }
          // mtime or size changed — must read+hash to confirm
          const content = readFileSync(f, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          if (existing.content_hash === hash) {
            // R84: content unchanged, update metadata only
            totalSkipped++;
            allMetadataOnlyHashUpdates.push({ relPath, hash, mtime: fileMtime, mtimeNs: fileMtimeNs, size: fileSize, indexedAt: new Date().toISOString() });
            continue;
          }
          // Content changed — re-index
          allPendingChangedRelPaths.push(relPath);
          allPendingHashUpdates.push({ relPath, hash, mtime: fileMtime, mtimeNs: fileMtimeNs, size: fileSize, indexedAt: new Date().toISOString() });
        } else {
          // New file — read+hash
          const content = readFileSync(f, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          allPendingChangedRelPaths.push(relPath);
          allPendingHashUpdates.push({ relPath, hash, mtime: fileMtime, mtimeNs: fileMtimeNs, size: fileSize, indexedAt: new Date().toISOString() });
        }
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
    return { nodes: 0, edges: 0, files: 0, skipped: totalSkipped, errors: [], languages };
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

  // R81: Bug 19 fix — sort worker results by batch order and file path for
  // deterministic node IDs. Without this, worker scheduling order determines
  // which batch gets IDs 1..N vs N+1..2N, making benchmarks non-reproducible.
  results.sort((a, b) => {
    // Sort by language first (batches are per-language), then by first file path
    const langCmp = a.language.localeCompare(b.language);
    if (langCmp !== 0) return langCmp;
    const aFirst = a.results[0]?.filePath ?? '';
    const bFirst = b.results[0]?.filePath ?? '';
    return aFirst.localeCompare(bFirst);
  });
  for (const batchResult of results) {
    batchResult.results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  // Collect all results and write to SQLite in a single transaction
  let nodeCount = 0;
  let edgeCount = 0;
  let fileCount = 0;

  // Build a global QN→ID map for edge resolution
  const qnToId = new Map<string, number>();

  // R80: Bug 10 fix — INSERT with explicit id. The old code used
  // nextNodeId=1 and relied on SQLite auto-assigning 1..N, which only works
  // on an empty table. In incremental/multi-project, real IDs are MAX(id)+1.
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges (project, source_id, target_id, type, properties_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // R82: Bug 21 fix — filter changedRelPaths and hashUpdates to only successful
    // files. Previously (R81), all changed files were scheduled for delete+hash
    // update BEFORE workers ran. A worker failure would still delete old nodes
    // and update the hash, causing silent corruption.
    const successfulRelPaths = new Set<string>();
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (!fileResult.error) {
          successfulRelPaths.add(fileResult.filePath);
        }
      }
    }
    const changedToApply = allPendingChangedRelPaths.filter(p => successfulRelPaths.has(p));
    const hashesToApply = allPendingHashUpdates.filter(h => successfulRelPaths.has(h.relPath));

    // R80: Bug 11 fix — for incremental mode, delete old nodes/edges for changed
    // files BEFORE inserting new ones. R82: only for SUCCESSFUL files.
    if (incremental && changedToApply.length > 0) {
      const ph = changedToApply.map(() => '?').join(',');
      const oldNodeIds = db.prepare(
        `SELECT id FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).all(project, ...changedToApply) as Array<{ id: number }>;
      if (oldNodeIds.length > 0) {
        const idPh = oldNodeIds.map(() => '?').join(',');
        const idParams = oldNodeIds.map(r => r.id);
        db.prepare(
          `DELETE FROM edges WHERE project = ? AND (source_id IN (${idPh}) OR target_id IN (${idPh}))`
        ).run(project, ...idParams, ...idParams);
      }
      db.prepare(
        `DELETE FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).run(project, ...changedToApply);
    }

    // R80: Bug 10 fix — get real MAX(id) so explicit IDs match SQLite reality.
    const maxNodeRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM nodes').get() as { max_id: number };
    let nextNodeId = maxNodeRow.max_id + 1;

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
            nodeId, project, node.label, node.name, node.qualifiedName, node.filePath,
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
            edgeCount++;
          }
        }
      }
    }

    // R82: Bug 21 fix — upsert file hashes ONLY for successful files.
    // R80: only after all nodes/edges are inserted.
    // R83: P3 perf — prepare statement once outside the loop
    const upsertHash = db.prepare(`
      INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, file_path) DO UPDATE SET
        content_hash = excluded.content_hash, mtime = excluded.mtime, mtime_ns = excluded.mtime_ns, size = excluded.size, indexed_at = excluded.indexed_at
    `);
    // R86: Bug 29 fix — in full mode, allPendingHashUpdates is empty because
    // hashes were only collected in the `if (incremental)` block. Now workers
    // return hashInfo, so we can store hashes for all successful files in full
    // mode too. This is critical: without it, the first incremental after a
    // full parallel index re-indexes everything (no hashes to compare against).
    if (!incremental) {
      // Full mode: use hashInfo from workers for all successful files
      for (const batchResult of results) {
        for (const fileResult of batchResult.results) {
          if (fileResult.error || !fileResult.hashInfo) continue;
          upsertHash.run(project, fileResult.filePath, fileResult.hashInfo.hash,
            fileResult.hashInfo.mtime, fileResult.hashInfo.mtimeNs,
            fileResult.hashInfo.size, new Date().toISOString());
        }
      }
    } else {
      // Incremental mode: only upsert hashes for changed files that succeeded
      for (const h of hashesToApply) {
        upsertHash.run(project, h.relPath, h.hash, h.mtime, h.mtimeNs, h.size, h.indexedAt);
      }
    }
    // R84: Bug 25 — metadata-only updates for parallel path (incremental only)
    for (const h of allMetadataOnlyHashUpdates) {
      upsertHash.run(project, h.relPath, h.hash, h.mtime, h.mtimeNs, h.size, h.indexedAt);
    }
  });
  tx();

  return { nodes: nodeCount, edges: edgeCount, files: fileCount, skipped: totalSkipped, errors, languages };
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
