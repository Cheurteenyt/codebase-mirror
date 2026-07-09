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
import { replaceCallSitesForFiles, replaceImportsForFiles, rebuildCrossFileCallsEdges, isCallSitesInitialized } from './cross-file-resolver.js';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { join, relative as nodeRelative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { WorkerBatch, WorkerBatchResult } from './worker.js';
import type { UnresolvedCallSite, ImportBinding } from './fast-walker.js';

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
  // R100: true when incremental mode changed files and cross-file CALLS
  // edges may be stale (not rebuilt). Consumers should recommend full reindex.
  crossFileCallsStale?: boolean;
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
    // R90: prepare statement once outside the loop (was re-preparing per file)
    const getHashMeta = db.prepare(
      'SELECT mtime_ns, mtime, size FROM file_hashes WHERE project = ? AND file_path = ?'
    );
    for (const f of files) {
      const relPath = nodeRelative(opts.rootPath, f);
      const stat = statSync(f, { bigint: true });
      const fileMtimeNs = stat.mtimeNs.toString();
      const fileSize = Number(stat.size);
      const existing = getHashMeta.get(opts.project, relPath) as { mtime_ns: string | null; mtime: number; size: number } | undefined;
      if (!existing) {
        estimatedFilesToIndex++;
      } else {
        // R91: Bug 32 fix — if mtime_ns is NULL (legacy pre-R85 DB), don't
        // fast-skip on mtime+size alone. Force a re-hash to backfill mtime_ns.
        // Without this, mtime_ns stays NULL forever for unchanged files,
        // keeping them exposed to the old Math.floor(mtimeMs) false-skip risk.
        if (!existing.mtime_ns) {
          estimatedFilesToIndex++;
        } else {
          const mtimeMatches = existing.mtime_ns === fileMtimeNs;
          if (!mtimeMatches || existing.size !== fileSize) {
            estimatedFilesToIndex++;
          }
        }
      }
    }
  }

  // R81: Bug 17 fix — compute useParallel BEFORE preloadGrammars. In parallel
  // mode, workers load their own grammars, so the main thread doesn't need
  // to preload. This saves Parser.init() + Language.load() cost on LARGE.
  // R86: Bug 28 fix — use estimatedFilesToIndex, not files.length
  const useParallel = numWorkers > 1 && estimatedFilesToIndex > 20;

  // R104/R105: Bug 37 fix — detect deleted files in incremental mode.
  // R105: use nodes ∪ file_hashes to catch legacy DBs where file_hashes
  // may be incomplete (pre-R79 full mode didn't store hashes).
  let deletedRelPaths: string[] = [];
  if (opts.incremental) {
    const currentRelPaths = new Set(files.map(f => nodeRelative(opts.rootPath, f)));
    const indexedPaths = db.prepare(
      `SELECT DISTINCT file_path FROM nodes WHERE project = ?
       UNION
       SELECT file_path FROM file_hashes WHERE project = ?`
    ).all(opts.project, opts.project) as Array<{ file_path: string }>;
    deletedRelPaths = indexedPaths
      .map(r => r.file_path)
      .filter(p => !currentRelPaths.has(p));
  }

  // R89: Bug 31 fix — early return for no-op incremental. If estimatedFilesToIndex
  // is 0 AND no deleted files, skip the entire extraction phase.
  // R104: don't early-return if there are deleted files to clean up.
  // R106: deletion-only has its OWN fast path (see next block) that also
  // rebuilds cross-file CALLS from the persistent call_sites table.
  if (opts.incremental && estimatedFilesToIndex === 0 && deletedRelPaths.length === 0) {
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
        (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges
    `).get(opts.project, opts.project) as { nodes: number; edges: number };
    // R102: Bug 35 fix — preserve existing cross_file_calls_stale from DB.
    // A no-op incremental must NOT reset stale to false. The graphe may still
    // be stale from a previous incremental that changed files. Only a full
    // reindex can reset stale to false.
    const existingRow = db.prepare(
      'SELECT cross_file_calls_stale, call_sites_initialized FROM projects WHERE name = ?'
    ).get(opts.project) as { cross_file_calls_stale?: number; call_sites_initialized?: number } | undefined;
    const existingStale = existingRow?.cross_file_calls_stale === 1;
    // R107: preserve existing call_sites_initialized (no-op doesn't change it)
    const existingInitialized = existingRow?.call_sites_initialized === 1;
    updateProjectStats(db, opts.project, opts.rootPath, totals.nodes, totals.edges, existingStale, existingInitialized);
    db.close();
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: files.length,
      errors: [],
      languages: allLangs,
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: existingStale,
    };
  }

  // R106: P2 perf fix — deletion-only fast path.
  // If incremental mode has 0 files to extract BUT has deleted files to clean
  // up, skip the extraction phase entirely. Just do the cleanup + rebuild
  // cross-file CALLS from the persistent call_sites table.
  // Before R106, this case fell through to extractFromFilesWasm() which would
  // stat+skip every file (wasteful) before the cleanup transaction ran.
  // R107: use isCallSitesInitialized() for legacy DB detection.
  if (opts.incremental && estimatedFilesToIndex === 0 && deletedRelPaths.length > 0) {
    // R107: capture initialized flag BEFORE the transaction (it won't change inside).
    const callSitesInitialized = isCallSitesInitialized(db, opts.project);
    let crossFileResolved = false;
    const cleanupTx = db.transaction(() => {
      // 1. Delete nodes/edges/file_hashes/call_sites for deleted files.
      const ph = deletedRelPaths.map(() => '?').join(',');
      const oldNodeIds = db.prepare(
        `SELECT id FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).all(opts.project, ...deletedRelPaths) as Array<{ id: number }>;
      if (oldNodeIds.length > 0) {
        const idPh = oldNodeIds.map(() => '?').join(',');
        const idParams = oldNodeIds.map(r => r.id);
        db.prepare(
          `DELETE FROM edges WHERE project = ? AND (source_id IN (${idPh}) OR target_id IN (${idPh}))`
        ).run(opts.project, ...idParams, ...idParams);
      }
      db.prepare(`DELETE FROM nodes WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      db.prepare(`DELETE FROM file_hashes WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      // R106: also clean up call_sites for deleted files.
      db.prepare(`DELETE FROM call_sites WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      // R110: also clean up imports for deleted files.
      db.prepare(`DELETE FROM imports WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);

      // 2. Rebuild cross-file CALLS from the post-cleanup state.
      //    R108: when callSitesInitialized=true, ALWAYS rebuild (even if
      //    call_sites is empty) to clean up stale edges and mark state complete.
      //    R109: when callSitesInitialized=true && nodesCount=0 (all files
      //    deleted), the empty graph is COMPLETE — mark resolved=true without
      //    calling rebuild (nothing to rebuild).
      const nodesCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(opts.project) as { c: number }).c;
      if (callSitesInitialized && nodesCount > 0) {
        rebuildCrossFileCallsEdges(db, opts.project);
        crossFileResolved = true;
      } else if (callSitesInitialized && nodesCount === 0) {
        // R109: empty graph is complete — no rebuild needed.
        crossFileResolved = true;
      }
    });
    cleanupTx();

    // Compute totals + stale + initialized.
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
        (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges
    `).get(opts.project, opts.project) as { nodes: number; edges: number };
    // R107: if resolver ran, stale=false. If legacy DB (not initialized),
    // stale=true to force full reindex. Otherwise preserve existing stale.
    const existingStaleRow = db.prepare(
      'SELECT cross_file_calls_stale FROM projects WHERE name = ?'
    ).get(opts.project) as { cross_file_calls_stale?: number } | undefined;
    const existingStale = existingStaleRow?.cross_file_calls_stale === 1;
    const crossFileStale = crossFileResolved
      ? false
      : (callSitesInitialized ? existingStale : true);
    // R107: preserve call_sites_initialized (deletion-only doesn't change it)
    updateProjectStats(db, opts.project, opts.rootPath, totals.nodes, totals.edges, crossFileStale, callSitesInitialized);
    db.close();
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: files.length,
      errors: [],
      languages: allLangs,
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: crossFileStale,
    };
  }

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

  // R104: Bug 37 fix — clean up deleted files in incremental mode.
  // Delete nodes, edges, and file_hashes for files that no longer exist on disk.
  // R106: also delete call_sites for deleted files, and rebuild cross-file CALLS
  // to remove edges that pointed to deleted nodes.
  // Note: this block only runs when there were BOTH changed files to extract
  // AND deleted files to clean up. Deletion-only is handled by the fast path above.
  if (opts.incremental && deletedRelPaths.length > 0) {
    const deleteTx = db.transaction(() => {
      const ph = deletedRelPaths.map(() => '?').join(',');
      // Get node IDs for deleted files
      const oldNodeIds = db.prepare(
        `SELECT id FROM nodes WHERE project = ? AND file_path IN (${ph})`
      ).all(opts.project, ...deletedRelPaths) as Array<{ id: number }>;
      if (oldNodeIds.length > 0) {
        const idPh = oldNodeIds.map(() => '?').join(',');
        const idParams = oldNodeIds.map(r => r.id);
        db.prepare(
          `DELETE FROM edges WHERE project = ? AND (source_id IN (${idPh}) OR target_id IN (${idPh}))`
        ).run(opts.project, ...idParams, ...idParams);
      }
      db.prepare(`DELETE FROM nodes WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      db.prepare(`DELETE FROM file_hashes WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      // R106: clean up call_sites for deleted files.
      db.prepare(`DELETE FROM call_sites WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);
      // R110: clean up imports for deleted files.
      db.prepare(`DELETE FROM imports WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);

      // R106: rebuild cross-file CALLS to remove edges that pointed to deleted
      // nodes and re-resolve call_sites that may now match different candidates.
      // The extraction transaction already rebuilt cross-file CALLS, but that
      // used the pre-cleanup state (deleted files' nodes were still present).
      // This second rebuild uses the post-cleanup state.
      // R108: use isCallSitesInitialized (not hasCallSites) — always rebuild
      // when initialized=true, even if call_sites is empty.
      if (isCallSitesInitialized(db, opts.project)) {
        rebuildCrossFileCallsEdges(db, opts.project);
      }
    });
    deleteTx();
  }

  // R81: Bug 18 fix — after incremental, projects.node_count/edge_count must
  // reflect the TOTAL in the DB, not just the nodes/edges inserted in this run.
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
      (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges
  `).get(opts.project, opts.project) as { nodes: number; edges: number };
  // R101/R102/R103/R104: persist crossFileCallsStale in DB + return in IndexResult
  // R106: with persistent call_sites, incremental mode can now rebuild cross-file
  // CALLS. If result.crossFileCallsResolved is true, stale=false. If false
  // (legacy DB without call_sites), preserve existing stale or set to true.
  // R107: call_sites_initialized is set to true after full reindex, preserved
  // by incremental. This is the authoritative legacy DB signal.
  const existingRow = opts.incremental
    ? db.prepare('SELECT cross_file_calls_stale, call_sites_initialized FROM projects WHERE name = ?').get(opts.project) as { cross_file_calls_stale?: number; call_sites_initialized?: number } | undefined
    : undefined;
  const existingStale = existingRow?.cross_file_calls_stale === 1;
  const existingInitialized = existingRow?.call_sites_initialized === 1;
  const crossFileStale = opts.incremental
    ? // R106: if resolver ran successfully, not stale. Otherwise, preserve
      // existing stale (could be true from a previous run) or set true if
      // files changed but resolver couldn't run (legacy DB case).
      (result.crossFileCallsResolved ?? false)
        ? false
        : (existingStale || result.files > 0 || deletedRelPaths.length > 0)
    : false; // full reindex always resets stale (resolver always runs in full mode)
  // R107: full reindex sets call_sites_initialized=true; incremental preserves it.
  const callSitesInitialized = opts.incremental ? existingInitialized : true;
  updateProjectStats(db, opts.project, opts.rootPath, totals.nodes, totals.edges, crossFileStale, callSitesInitialized);
  db.close();

  return {
    ...result,
    dbPath,
    durationMs: Date.now() - start,
    languages: result.languages ?? allLangs,
    parallel: useParallel,
    workerCount: useParallel ? numWorkers : 0,
    crossFileCallsStale: crossFileStale,
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
 * R101: Cross-file CALLS are resolved in full mode by a main-thread second pass
 * after all nodes are inserted. In incremental mode they are intentionally
 * marked stale (crossFileCallsStale=true) until a full reindex or a persistent
 * call_sites table is implemented.
 * R106: persistent call_sites table is now implemented. Cross-file CALLS are
 * resolved in BOTH full and incremental modes using the shared
 * rebuildCrossFileCallsEdges() helper from cross-file-resolver.ts.
 */
async function indexParallel(
  db: Database.Database,
  project: string,
  rootPath: string,
  langGroups: Map<string, string[]>,
  numWorkers: number,
  incremental: boolean,
): Promise<{ nodes: number; edges: number; files: number; skipped: number; errors: Array<{ file: string; error: string }>; languages: Set<string>; crossFileCallsResolved: boolean }> {
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

    // R90: prepare statement once outside the per-file loop
    const getHashMetaParallel = db.prepare(
      'SELECT content_hash, mtime, mtime_ns, size FROM file_hashes WHERE project = ? AND file_path = ?'
    );

    for (const f of langFiles) {
      if (incremental) {
        const relPath = nodeRelative(rootPath, f);
        // R85: use bigint stat for nanosecond mtime precision
        const stat = statSync(f, { bigint: true });
        const fileMtime = Math.floor(Number(stat.mtimeMs));
        const fileMtimeNs = stat.mtimeNs.toString();
        const fileSize = Number(stat.size);

        // R85: mtimeNs+size fast skip — nanosecond precision
        // R90: prepare statement once outside the loop
        const existing = getHashMetaParallel.get(project, relPath) as { content_hash: string; mtime: number; mtime_ns: string | null; size: number } | undefined;

        if (existing) {
          // R93: Bug 33 fix — never fast-skip on mtime integer alone when
          // mtime_ns is NULL. Force read+hash to backfill mtime_ns.
          if (existing.mtime_ns && existing.mtime_ns === fileMtimeNs && existing.size === fileSize) {
            totalSkipped++;
            continue;
          }
          // mtime_ns is NULL or mismatch — must read+hash to confirm
          const content = readFileSync(f, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          if (existing.content_hash === hash) {
            // R84/R93: content unchanged, update metadata only (backfills mtime_ns if NULL)
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
    // R88: Bug 30 fix — if all files are metadata-only (no batches needed),
    // we must still apply the metadata-only hash updates before returning.
    // Previously, the early return skipped the transaction that applies
    // allMetadataOnlyHashUpdates, so mtime_ns/size were never persisted.
    // Next run would re-stat + re-read + re-hash all "metadata-only" files.
    if (allMetadataOnlyHashUpdates.length > 0) {
      const upsertHash = db.prepare(`
        INSERT INTO file_hashes (project, file_path, content_hash, mtime, mtime_ns, size, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, file_path) DO UPDATE SET
          content_hash = excluded.content_hash, mtime = excluded.mtime,
          mtime_ns = excluded.mtime_ns, size = excluded.size, indexed_at = excluded.indexed_at
      `);
      const metaTx = db.transaction(() => {
        for (const h of allMetadataOnlyHashUpdates) {
          upsertHash.run(project, h.relPath, h.hash, h.mtime, h.mtimeNs, h.size, h.indexedAt);
        }
      });
      metaTx();
    }
    return { nodes: 0, edges: 0, files: 0, skipped: totalSkipped, errors: [], languages, crossFileCallsResolved: false };
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
  // R106: tracks whether cross-file CALLS resolution ran successfully.
  let crossFileResolved = false;

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

    // R106: Cross-file CALLS resolution via persistent call_sites table.
    //
    // Full mode:
    //   1. call_sites for the project were cleared by clearProjectData() before
    //      extraction. Now we insert all new call_sites from worker results.
    //   2. Then rebuildCrossFileCallsEdges() rebuilds ALL cross-file CALLS edges
    //      from the persistent table + all current nodes.
    //   3. Mark call_sites_initialized=1 (R107).
    //
    // Incremental mode:
    //   1. Delete call_sites for changed files (changedToApply).
    //   2. Insert new call_sites from worker results (only changed files).
    //   3. rebuildCrossFileCallsEdges() rebuilds ALL cross-file CALLS edges from
    //      the persistent table (has call_sites for both changed and unchanged
    //      files) + all current nodes (has nodes for both changed and unchanged).
    //   4. crossFileCallsStale = false (no longer stale!).
    //
    // R107: legacy DB detection now uses isCallSitesInitialized() instead of
    // hasCallSites(). See cross-file-resolver.ts for explanation.

    // R107: capture initialized flag BEFORE inserting new call_sites.
    const callSitesInitialized = isCallSitesInitialized(db, project);

    // Step 1: collect new call_sites from worker results.
    const newCallSites: UnresolvedCallSite[] = [];
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (fileResult.error || !fileResult.unresolvedCalls) continue;
        newCallSites.push(...fileResult.unresolvedCalls);
      }
    }

    // Step 2: persist call_sites.
    if (incremental) {
      // Delete + re-insert call_sites for changed files only.
      // call_sites for unchanged files remain in the table.
      replaceCallSitesForFiles(db, project, changedToApply, newCallSites);
    } else {
      // Full mode: table was cleared by clearProjectData. Just insert.
      replaceCallSitesForFiles(db, project, [], newCallSites);
    }

    // R110: persist imports (same pattern as call_sites).
    // R111: also persist default export QN as a marker row.
    const newImports: ImportBinding[] = [];
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (fileResult.error || !fileResult.imports) continue;
        newImports.push(...fileResult.imports);
        // R111: store default export QN as a marker row
        if (fileResult.defaultExportQn) {
          newImports.push({
            localName: '__default_export__',
            sourceModule: '',
            importedName: fileResult.defaultExportQn,
            importKind: 'default_export',
            line: 0,
            filePath: fileResult.filePath,
          });
        }
      }
    }
    if (incremental) {
      replaceImportsForFiles(db, project, changedToApply, newImports);
    } else {
      replaceImportsForFiles(db, project, [], newImports);
    }

    // Step 3: rebuild cross-file CALLS edges.
    // R108: when callSitesInitialized=true, ALWAYS run rebuildCrossFileCallsEdges
    // (even if call_sites is empty). See wasm-extractor.ts for full explanation.
    // R109: when callSitesInitialized=true && nodesCount=0, mark resolved=true
    // without calling rebuild (empty graph is complete).
    if (incremental) {
      const nodesCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(project) as { c: number }).c;
      if (!callSitesInitialized) {
        // R107: Legacy DB. Skip resolution. Caller marks stale=true.
      } else if (nodesCount > 0) {
        // R108: initialized=true → always rebuild (even if call_sites=0).
        const added = rebuildCrossFileCallsEdges(db, project);
        edgeCount += added;
        crossFileResolved = true;
      } else {
        // R109: initialized=true && nodesCount=0 → empty graph is COMPLETE.
        crossFileResolved = true;
      }
    } else {
      // Full mode: always rebuild.
      const added = rebuildCrossFileCallsEdges(db, project);
      edgeCount += added;
      crossFileResolved = true;
    }
  });
  tx();

  return { nodes: nodeCount, edges: edgeCount, files: fileCount, skipped: totalSkipped, errors, languages, crossFileCallsResolved: crossFileResolved };
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
