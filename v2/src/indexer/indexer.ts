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
import { initIndexerSchema, clearProjectData, updateProjectStats, CURRENT_EXTRACTOR_SEMANTICS_VERSION } from './schema.js';
import { discoverSourceFilesStructured, detectLanguage, extractFromFilesWasm, preloadGrammars } from './wasm-extractor.js';
import type { DiscoveryResult } from './wasm-extractor.js';
import { replaceCallSitesForFiles, replaceImportsForFiles, replaceExportsForFiles, rebuildCrossFileCallsEdges, clearCrossFileCallEdges, isCallSitesInitialized } from './cross-file-resolver.js';
import { assertDiscoveryRoot, DiscoveryRootError } from '../utils/safe-path.js';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { join, relative as nodeRelative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { WorkerBatch, WorkerBatchResult } from './worker.js';
import type { UnresolvedCallSite, ImportBinding, ExportBinding } from './fast-walker.js';
import { existsSync } from 'node:fs';

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

/**
 * R143/R144 (STATE-R143-01, DATA-R143-01, MIG-R144-02, STATE-R144-02):
 * Mark a project as stale in the DB WITHOUT touching nodes/edges/version.
 * Used by ALL error branches (root failure, full partial, incremental
 * partial) so that Graph Status reflects the failure and the existing
 * graph is preserved.
 *
 * R144 (MIG-R144-02): Unified cleanup. This helper now ALSO reads the
 * extractor semantics version and clears cross-file edges if the version
 * mismatches. R143 only did this in the incremental-partial branch,
 * leaving old v7 exact edges in the DB on root failure and full partial.
 * Now ALL error paths get the same cleanup.
 *
 * R144 (STATE-R144-02): The return value is now an object with `stalePersisted`
 * and `edgesCleared` so callers can report whether the persistence succeeded.
 * R143 returned a boolean that callers ignored, making the invariant
 * "stale returned → stale persisted" unverifiable.
 *
 * R144 (STATE-R144-03): Also sets last_index_attempt_at and last_index_error
 * so Graph Status can distinguish a successful index from a failed attempt.
 *
 * Safety guarantees:
 *   - Does NOT create the DB if it doesn't exist (DATA-R143-01). Uses
 *     existsSync first.
 *   - Uses try/finally to guarantee the DB handle is closed.
 *   - Only updates the projects row if it already exists.
 */
function markProjectStalePreservingGraph(
  dbPath: string,
  project: string,
  errorMessage: string | null = null,
): { stalePersisted: boolean; edgesCleared: boolean } {
  // R143 (DATA-R143-01): do NOT create the DB file. existsSync check first.
  if (!existsSync(dbPath)) {
    return { stalePersisted: false, edgesCleared: false };
  }
  let db: Database.Database | null = null;
  let stalePersisted = false;
  let edgesCleared = false;
  try {
    db = new Database(dbPath);
    const dbNonNull = db;
    // R145 (MIG-R145-01): Migrate the DB schema BEFORE writing state. A real
    // R143 DB doesn't have last_index_attempt_at, last_index_error, or
    // last_successful_index_at columns. R144's UPDATE would fail with
    // "no such column", the catch would swallow it, and stale would NOT be
    // persisted. Now we run the migration first (adds columns if missing),
    // then the UPDATE succeeds. The migration is idempotent (ALTER TABLE
    // ADD COLUMN with PRAGMA table_info check).
    initIndexerSchema(dbNonNull);
    const existing = dbNonNull.prepare(
      'SELECT extractor_semantics_version AS version FROM projects WHERE name = ?'
    ).get(project) as { version?: number } | undefined;
    if (!existing) {
      return { stalePersisted: false, edgesCleared: false };
    }
    const tx = dbNonNull.transaction(() => {
      const now = new Date().toISOString();
      // R144 (STATE-R144-03): persist last_index_attempt_at and last_index_error.
      dbNonNull.prepare(`
        UPDATE projects SET
          cross_file_calls_stale = 1,
          last_index_attempt_at = ?,
          last_index_error = ?
        WHERE name = ?
      `).run(now, errorMessage, project);
      stalePersisted = true;
      // R144 (MIG-R144-02): clear cross-file edges on semantic mismatch.
      const storedVersion = existing.version ?? 0;
      if (storedVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION) {
        clearCrossFileCallEdges(dbNonNull, project);
        edgesCleared = true;
      }
    });
    tx();
  } catch {
    // DB is corrupt or locked — nothing we can do. The in-memory
    // IndexResult still carries the error and stale flag.
  } finally {
    if (db !== null) {
      try { db.close(); } catch { /* ignore close error */ }
    }
  }
  return { stalePersisted, edgesCleared };
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

  // R145 (DRY-R145-01): Dry-run check FIRST. R144's root-failure handler
  // ran BEFORE the dry-run check, so `cbm-v2 index --dry-run --root /missing`
  // could write stale=1, last_index_error, and clear cross-file edges —
  // violating the dry-run contract (zero DB writes). Now dry-run is checked
  // before ANY DB operation. Dry-run only discovers files and reports; it
  // never opens the DB for writes.
  if (opts.dryRun) {
    let canonicalRoot: string;
    try {
      canonicalRoot = assertDiscoveryRoot(opts.rootPath);
    } catch (error) {
      const message = error instanceof DiscoveryRootError
        ? `Discovery root error (${error.reason}): "${error.rootPath}"`
        : `Discovery root error: "${opts.rootPath}" (${(error as Error).message})`;
      return {
        dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
        files: 0, skipped: 0,
        errors: [{ file: opts.rootPath, error: message }],
        languages: new Set(),
        parallel: false,
        workerCount: 0,
        crossFileCallsStale: true,
      };
    }
    let discovery: DiscoveryResult;
    try {
      discovery = discoverSourceFilesStructured(opts.rootPath, canonicalRoot);
    } catch (error) {
      return {
        dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
        files: 0, skipped: 0,
        errors: [{ file: opts.rootPath, error: (error as Error).message }],
        languages: new Set(),
        parallel: false,
        workerCount: 0,
        crossFileCallsStale: true,
      };
    }
    const langs = new Set<string>();
    for (const f of discovery.files) {
      const lang = detectLanguage(f);
      if (lang) langs.add(lang);
    }
    return {
      dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
      files: discovery.files.length, skipped: 0,
      errors: discovery.errors.map(e => ({ file: e.path, error: `${e.code}: ${e.message}` })),
      languages: langs,
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: !discovery.complete,
    };
  }

  // R141/R142 (DATA-R142-01, PATH-R142-01, STATE-R142-01): Validate the
  // discovery root BEFORE opening the DB or BEFORE clearProjectData (full
  // mode) or BEFORE computing deletedRelPaths (incremental mode). The
  // previous flow let a missing or unreadable root silently produce an
  // empty result that wiped the graph.
  //
  // R145 (MIG-R145-01): The root-failure handler now migrates the DB schema
  // BEFORE writing state, so a real R143 DB (without last_* columns) is
  // handled correctly. R144's helper assumed the columns existed.
  let canonicalRoot: string;
  try {
    canonicalRoot = assertDiscoveryRoot(opts.rootPath);
  } catch (error) {
    const message = error instanceof DiscoveryRootError
      ? `Discovery root error (${error.reason}): "${error.rootPath}"`
      : `Discovery root error: "${opts.rootPath}" (${(error as Error).message})`;
    // R144 (MIG-R144-02, STATE-R144-02): persist stale=true in the DB
    // via the unified helper. R145 (MIG-R145-01): the helper now migrates
    // the DB schema first (adds last_* columns if missing) so the UPDATE
    // doesn't fail on a real R143 DB.
    const staleResult = markProjectStalePreservingGraph(dbPath, opts.project, message);
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [{ file: opts.rootPath, error: message + (staleResult.stalePersisted ? '' : ' [WARNING: stale flag could not be persisted to DB]') }],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
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
  // R141 (DATA-R141-01): root was already validated above. As an additional
  // TOCTOU safeguard, we run discoverSourceFilesStructured BEFORE
  // clearProjectData in full mode. If discovery throws (extremely unlikely
  // after the root preflight, but possible for exotic filesystems), the
  // existing graph is preserved instead of being wiped.
  // R142 (PERF-R142-01): pass canonicalRoot to avoid redundant stat+realpath.
  // R142 (DATA-R142-02): capture discovery.errors — if non-empty, the
  // discovery is partial. In full mode we do NOT clearProjectData; in
  // incremental mode we do NOT compute deletedRelPaths.
  let discovery: DiscoveryResult;
  try {
    discovery = discoverSourceFilesStructured(opts.rootPath, canonicalRoot);
  } catch (error) {
    // R141 (DATA-R141-01): discovery failed AFTER root validation — likely a
    // transient I/O error or a TOCTOU race. Do NOT clearProjectData.
    // R145 (MIG-R145-02): Use the unified helper to persist stale + cleanup.
    // R144 just closed the DB and returned — no stale persistence, no edge
    // cleanup, no last_index_error. Now we use markProjectStalePreservingGraph
    // for the same state transition as all other error paths.
    db.close();
    const message = (error as Error).message;
    const fullMsg = `Discovery failed: ${message}`;
    markProjectStalePreservingGraph(dbPath, opts.project, fullMsg);
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [{ file: opts.rootPath, error: fullMsg }],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
    };
  }

  // R143 (PERF-R143-01) / R144 (PERF-R144-01): Bound diagnostics. A repo
  // with thousands of broken symlinks could produce a multi-megabyte error
  // string and OOM. We cap the inline message at 20 samples and include
  // the total count from discovery.totalErrors (NOT errors.length, which
  // is capped at 100 — R144 fix: R143 used errors.length, reporting only
  // 100 for 10000 errors).
  function formatDiscoveryErrors(d: { totalErrors: number; errors: { path: string; code: string; message: string }[]; countsByCode: Record<string, number> }): string {
    const total = d.totalErrors;
    const samples = d.errors.slice(0, 20);
    const sampleStr = samples.map(e => `${e.path}: ${e.code}`).join('; ');
    const codeSummary = Object.entries(d.countsByCode).map(([c, n]) => `${c}=${n}`).join(', ');
    if (total > samples.length) {
      return `${total} discovery errors (showing ${samples.length}, codes: ${codeSummary}): ${sampleStr}; ...`;
    }
    return `${total} discovery error(s) (codes: ${codeSummary}): ${sampleStr}`;
  }

  // R142 (DATA-R142-02): Partial discovery lock. If discovery encountered
  // errors (subtree EACCES, fatal symlink errors, etc.), the file list may
  // be incomplete. In full mode, clearing the existing graph would destroy
  // valid nodes we can't rediscover. In incremental mode, computing
  // deletedRelPaths would treat the missing files as deleted.
  //
  // R144 (MIG-R144-02): Unified cleanup via markProjectStalePreservingGraph.
  // R143 had three separate code paths (root failure, full partial,
  // incremental partial) with inconsistent cleanup. The root failure and
  // full partial branches did NOT clear cross-file edges on semantic
  // mismatch. Now ALL error paths use the same helper, which:
  //   1. reads the version;
  //   2. marks stale=1;
  //   3. clears cross-file edges on mismatch;
  //   4. persists last_index_attempt_at + last_index_error;
  //   5. preserves nodes, hashes, and the old version.
  if (!discovery.complete) {
    const errorMsg = formatDiscoveryErrors(discovery);
    const fullMsg = `Discovery incomplete: ${errorMsg}`;
    if (!opts.incremental) {
      // R144 (MIG-R144-02): full mode + partial → persist stale=1, clear
      // edges on mismatch, preserve graph.
      db.close();
      markProjectStalePreservingGraph(dbPath, opts.project, fullMsg);
      return {
        dbPath,
        durationMs: Date.now() - start,
        nodes: 0,
        edges: 0,
        files: 0,
        skipped: 0,
        errors: [{ file: opts.rootPath, error: fullMsg }],
        languages: new Set(),
        parallel: false,
        workerCount: 0,
        crossFileCallsStale: true,
      };
    }
    // R144 (MIG-R144-02): incremental mode + partial → same unified helper.
    // The helper handles stale=1 + edge cleanup + last_index_error.
    // We close the DB first (the helper opens its own connection).
    db.close();
    markProjectStalePreservingGraph(dbPath, opts.project, fullMsg);
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [{ file: opts.rootPath, error: fullMsg }],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
    };
  }

  // R142 (PATH-R142-01): use canonicalRoot (from assertDiscoveryRoot) for
  // all relative-path computation. This ensures file_path values never
  // contain `..` even when the configured root is a symlink.
  const files = discovery.files;
  const effectiveRoot = canonicalRoot;

  // R148 (DATA-R148-01): Full mode uncertainty lock. If discovery had
  // uncertain paths/subtrees (ENOENT race — file temporarily absent),
  // `discovery.complete` is still true (warnings don't make it incomplete).
  // But in full mode, `clearProjectData` would destroy the existing graph
  // and replace it with an incomplete one missing the uncertain files.
  // An atomic-save race could thus lose nodes/edges for a file that still
  // exists on disk. Now: if there's ANY uncertainty in full mode, we do NOT
  // clear — we preserve the old graph and return stale+error.
  const hasUncertainty = discovery.uncertainPaths.length > 0 || discovery.uncertainSubtrees.length > 0;
  if (!opts.incremental && hasUncertainty) {
    db.close();
    const uncertainMsg = `Discovery uncertain: ${discovery.uncertainPaths.length} path(s), ${discovery.uncertainSubtrees.length} subtree(s) temporarily absent. Full index aborted to preserve existing graph. Retry when filesystem is stable.`;
    markProjectStalePreservingGraph(dbPath, opts.project, uncertainMsg);
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [{ file: opts.rootPath, error: uncertainMsg }],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
    };
  }

  if (!opts.incremental) {
    clearProjectData(db, opts.project);
  }
  // In incremental mode, we do NOT clear nodes/edges here. The extractor
  // will delete old nodes for changed files before re-inserting.

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
      // R142 (PATH-R142-01): use canonicalRoot for relative path.
      const relPath = nodeRelative(effectiveRoot, f);
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
  // R142 (PATH-R142-01): use canonicalRoot for relative paths.
  let deletedRelPaths: string[] = [];
  if (opts.incremental) {
    const currentRelPaths = new Set(files.map(f => nodeRelative(effectiveRoot, f)));
    const indexedPaths = db.prepare(
      `SELECT DISTINCT file_path FROM nodes WHERE project = ?
       UNION
       SELECT file_path FROM file_hashes WHERE project = ?`
    ).all(opts.project, opts.project) as Array<{ file_path: string }>;
    deletedRelPaths = indexedPaths
      .map(r => r.file_path)
      .filter(p => !currentRelPaths.has(p));

    // R147 (DATA-R147-01/02): Deletion-safe race lock. Uncertain paths
    // (ENOENT race — file temporarily absent during discovery) and
    // uncertain subtrees (directory temporarily absent) MUST NOT be
    // treated as confirmed deletions. The file/directory may have been
    // temporarily absent (atomic save, codegen, package manager). Without
    // this filter, a single TOCTOU race could silently delete nodes,
    // hashes, call_sites, imports, and exports for a file that still
    // exists on disk.
    if (discovery.uncertainPaths.length > 0 || discovery.uncertainSubtrees.length > 0) {
      const uncertainPathSet = new Set(discovery.uncertainPaths);
      const uncertainSubtreePrefixes = discovery.uncertainSubtrees;
      // R148 (COMPAT-R148-01): Use path.sep instead of hardcoded '/' for
      // cross-platform subtree prefix matching. On Windows, path.relative()
      // produces backslash-separated paths, so '/' would never match.
      deletedRelPaths = deletedRelPaths.filter(p => {
        // Exact match — the file was seen as uncertain.
        if (uncertainPathSet.has(p)) return false;
        // Subtree match — the path is under an uncertain directory.
        for (const prefix of uncertainSubtreePrefixes) {
          if (p === prefix || p.startsWith(prefix + sep)) return false;
        }
        return true;
      });
    }
  }

  // R127: Centralized semantic-state read. ALL fast paths and the main path
  // must use this single read to decide whether the project's extractor
  // semantics are current. This closes the MIG-R127-01 (no-op bypass) and
  // MIG-R127-02 (deletion-only bypass) gaps: previously, each fast path read
  // the version independently and some forgot to compare it to CURRENT.
  //
  // `semanticsStale` is true iff:
  //   - incremental mode (full mode always produces fresh data), AND
  //   - the stored version ≠ CURRENT_EXTRACTOR_SEMANTICS_VERSION
  //
  // When semanticsStale is true:
  //   - crossFileCallsStale MUST be true (force full reindex)
  //   - the resolver MUST NOT publish legacy fallback edges (MIG-R127-03)
  //   - the version is preserved (not upgraded) so the next run still detects it
  const projectState = opts.incremental
    ? (db.prepare(
        'SELECT cross_file_calls_stale AS stale, call_sites_initialized AS initialized, extractor_semantics_version AS version FROM projects WHERE name = ?'
      ).get(opts.project) as { stale?: number; initialized?: number; version?: number } | undefined)
    : undefined;
  const existingStale = projectState?.stale === 1;
  const existingInitialized = projectState?.initialized === 1;
  const existingSemanticsVersion = projectState?.version ?? 0;
  const semanticsStale = opts.incremental
    ? existingSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION
    : false;

  // R89: Bug 31 fix — early return for no-op incremental. If estimatedFilesToIndex
  // is 0 AND no deleted files, skip the entire extraction phase.
  // R104: don't early-return if there are deleted files to clean up.
  // R106: deletion-only has its OWN fast path (see next block) that also
  // rebuilds cross-file CALLS from the persistent call_sites table.
  // R127: MIG-R127-01 — even a no-op must respect semanticsStale. A stale
  // DB (version=0) with stale=false must be flipped to stale=true so the
  // caller knows a full reindex is required.
  if (opts.incremental && estimatedFilesToIndex === 0 && deletedRelPaths.length === 0) {
    // R128: MIG-R128-01 — no-op must clean stale cross-file edges when
    // semanticsStale. Previously the no-op only set the stale flag but left
    // old edges readable by MCP/UI. Now we delete them in the same transaction
    // as the flag update, so consumers can't read stale data.
    const noOpTx = db.transaction(() => {
      if (semanticsStale) {
        clearCrossFileCallEdges(db, opts.project);
      }
      const totals = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
          (SELECT COUNT(*) FROM edges WHERE project = ?) AS edges
      `).get(opts.project, opts.project) as { nodes: number; edges: number };
      const noOpStale = existingStale || semanticsStale;
      // R145 (STATE-R145-04): no-op stale must NOT set last_successful_index_at.
      // R144 passed null (success), which set last_successful=now and cleared
      // last_index_error even when a full reindex was required. Now we pass
      // an explicit error when stale so the DB reflects the real state.
      const noOpError = noOpStale
        ? (semanticsStale
            ? `Semantics version ${existingSemanticsVersion} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`
            : 'Project was already stale; no-op incremental did not refresh')
        : null;
      updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, noOpStale, existingInitialized, existingSemanticsVersion, noOpError);
      return { noOpStale };
    });
    const { noOpStale } = noOpTx();
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
      crossFileCallsStale: noOpStale,
    };
  }

  // R106: P2 perf fix — deletion-only fast path.
  // If incremental mode has 0 files to extract BUT has deleted files to clean
  // up, skip the extraction phase entirely. Just do the cleanup + rebuild
  // cross-file CALLS from the persistent call_sites table.
  // Before R106, this case fell through to extractFromFilesWasm() which would
  // stat+skip every file (wasteful) before the cleanup transaction ran.
  // R107: use isCallSitesInitialized() for legacy DB detection.
  // R127: MIG-R127-02 — semanticsStale must force stale=true even if the
  // resolver ran. MIG-R127-03 — when semanticsStale, DON'T run the resolver
  // (it would publish legacy fallback edges). Just clean up nodes/edges for
  // deleted files and mark stale=true so the caller does a full reindex.
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
      // R119: also clean up exports for deleted files.
      db.prepare(`DELETE FROM exports WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);

      // 2. Rebuild cross-file CALLS from the post-cleanup state.
      //    R108: when callSitesInitialized=true, ALWAYS rebuild (even if
      //    call_sites is empty) to clean up stale edges and mark state complete.
      //    R109: when callSitesInitialized=true && nodesCount=0 (all files
      //    deleted), the empty graph is COMPLETE — mark resolved=true without
      //    calling rebuild (nothing to rebuild).
      //    R127: MIG-R127-03 — when semanticsStale, DON'T run the resolver.
      //    The resolver would publish legacy fallback edges (semanticsCurrent=false)
      //    which remain in the DB even though we set stale=true afterwards.
      //    Instead, delete all cross-file edges (cleanup) and mark stale=true.
      const nodesCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(opts.project) as { c: number }).c;
      if (semanticsStale) {
        // R127: stale semantics — delete cross-file edges but don't rebuild.
        // R128: use clearCrossFileCallEdges helper (single source of truth).
        clearCrossFileCallEdges(db, opts.project);
        // Don't set crossFileResolved=true — we want stale=true.
      } else if (callSitesInitialized && nodesCount > 0) {
        rebuildCrossFileCallsEdges(db, opts.project, true);
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
    // R127: MIG-R127-02 — semanticsStale forces stale=true even if the
    // resolver ran. Previously, crossFileResolved=true forced stale=false,
    // which could make a stale DB falsely fresh after a deletion.
    const crossFileStale = semanticsStale
      ? true
      : crossFileResolved
        ? false
        : (callSitesInitialized ? existingStale : true);
    // R107: preserve call_sites_initialized (deletion-only doesn't change it)
    // R126: preserve extractor_semantics_version (deletion-only doesn't change it)
    // R145 (STATE-R145-04): pass indexError when stale (semantics mismatch).
    const deletionError = crossFileStale && semanticsStale
      ? `Semantics version ${existingSemanticsVersion} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`
      : null;
    updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, crossFileStale, callSitesInitialized, existingSemanticsVersion, deletionError);
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
    result = await indexParallel(db, opts.project, effectiveRoot, langGroups, numWorkers, opts.incremental ?? false);
  } else {
    result = await extractFromFilesWasm(
      db, opts.project, effectiveRoot, files, opts.incremental ?? false,
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
      // R119: clean up exports for deleted files.
      db.prepare(`DELETE FROM exports WHERE project = ? AND file_path IN (${ph})`)
        .run(opts.project, ...deletedRelPaths);

      // R106: rebuild cross-file CALLS to remove edges that pointed to deleted
      // nodes and re-resolve call_sites that may now match different candidates.
      // The extraction transaction already rebuilt cross-file CALLS, but that
      // used the pre-cleanup state (deleted files' nodes were still present).
      // This second rebuild uses the post-cleanup state.
      // R108: use isCallSitesInitialized (not hasCallSites) — always rebuild
      // when initialized=true, even if call_sites is empty.
      // R127: MIG-R127-03 — when semanticsStale, DON'T run the resolver.
      // R128: MIG-R128-02 — semanticsStale MUST dominate callSitesInitialized.
      // Previously this was gated behind `isCallSitesInitialized(...)`, which
      // meant a DB with initialized=false (partial full index) would skip the
      // stale-semantics cleanup. Now we check semanticsStale first.
      if (semanticsStale) {
        clearCrossFileCallEdges(db, opts.project);
      } else if (isCallSitesInitialized(db, opts.project)) {
        rebuildCrossFileCallsEdges(db, opts.project, true);
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
  // R126/R127: extractor_semantics_version is set to CURRENT after a full
  // reindex; preserved by incremental. The centralized `semanticsStale`
  // (computed before the fast paths) is used here. When stale, the resolver
  // was skipped (MIG-R127-03), so result.crossFileCallsResolved=false, which
  // correctly makes crossFileStale=true. No separate version read needed here.
  // R127: DATA-R127-01 — full mode only certifies CURRENT if no errors.
  // R146 (STATE-R146-01): Extraction errors MUST force stale=true regardless
  // of whether the resolver succeeded. R145's logic only set stale when
  // `crossFileCallsResolved=false`, but the resolver can rebuild edges from
  // OLD call_sites even when extraction of a changed file failed (the old
  // nodes are preserved). This meant `crossFileStale=false` + `indexError=null`
  // → `last_successful_index_at=now` → graph appeared fresh despite extraction
  // errors. Now: `result.errors.length > 0` forces `crossFileStale=true`
  // in BOTH full and incremental modes.
  const fullModeHadErrors = !opts.incremental && result.errors.length > 0;
  const incrementalHadErrors = opts.incremental && result.errors.length > 0;
  // R148 (STATE-R148-01): Uncertainty forces stale in incremental mode.
  // When a file was temporarily absent (ENOENT race), its old data is
  // preserved (excluded from deletedRelPaths). But the old data may not
  // match the new file content on disk (the file may have been modified
  // during the atomic save). The graph must NOT be certified as fresh.
  // R148: reuse hasUncertainty computed earlier (before clearProjectData).
  const crossFileStale = opts.incremental
    ? semanticsStale || incrementalHadErrors || hasUncertainty
        ? true
        : (result.crossFileCallsResolved ?? false)
          ? false
          : (existingStale || result.files > 0 || deletedRelPaths.length > 0)
    : fullModeHadErrors; // R127: full with errors → stale=true (don't trust partial graph)
  // R107: full reindex sets call_sites_initialized=true; incremental preserves it.
  // R127: DATA-R127-01 — full mode with errors does NOT set initialized=true.
  const callSitesInitialized = opts.incremental
    ? existingInitialized
    : !fullModeHadErrors;
  // R126: full reindex sets extractor_semantics_version=CURRENT; incremental
  // preserves it (so the stale-version gate can fire on the next incremental).
  // R127: DATA-R127-01 — full mode with errors does NOT certify CURRENT.
  const semanticsVersion = opts.incremental
    ? existingSemanticsVersion
    : (fullModeHadErrors ? 0 : CURRENT_EXTRACTOR_SEMANTICS_VERSION);
  // R145 (STATE-R145-03): Pass indexError when there were extraction errors
  // or when stale. R144 always passed null (success), which set
  // last_successful_index_at=now even on partial/failed extraction.
  // R146 (STATE-R146-01): incremental extraction errors ALSO set indexError.
  // R145 only set it when `crossFileStale && (semanticsStale || ...)`, but
  // crossFileStale is now always true when there are extraction errors.
  // So: errors → indexError → last_successful NOT updated.
  let indexError: string | null = null;
  if (!opts.incremental && fullModeHadErrors) {
    indexError = result.errors.length > 0
      ? `Extraction errors (${result.errors.length}): ${result.errors.slice(0, 5).map(e => e.error).join('; ')}`
      : 'Full index completed with errors';
  } else if (opts.incremental && incrementalHadErrors) {
    indexError = `Incremental extraction errors (${result.errors.length}): ${result.errors.slice(0, 5).map(e => e.error).join('; ')}`;
  } else if (opts.incremental && hasUncertainty) {
    // R148 (STATE-R148-01): uncertainty → stale, last_success unchanged.
    indexError = `Source snapshot uncertain: ${discovery.uncertainPaths.length} path(s), ${discovery.uncertainSubtrees.length} subtree(s) temporarily absent. Retry incremental when filesystem is stable.`;
  } else if (opts.incremental && crossFileStale && semanticsStale) {
    indexError = `Semantics version ${existingSemanticsVersion} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`;
  }
  updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, crossFileStale, callSitesInitialized, semanticsVersion, indexError);
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
        // R111/R132: store default export QN + count as a marker row.
        // R132: count stored in source_module for collision detection.
        if (fileResult.defaultExportQn || fileResult.defaultExportCount > 0) {
          newImports.push({
            localName: '__default_export__',
            sourceModule: String(fileResult.defaultExportCount),
            importedName: fileResult.defaultExportQn || '',
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

    // R119: persist exports (same pattern as imports).
    const newExports: ExportBinding[] = [];
    for (const batchResult of results) {
      for (const fileResult of batchResult.results) {
        if (fileResult.error || !fileResult.exports) continue;
        newExports.push(...fileResult.exports);
      }
    }
    if (incremental) {
      replaceExportsForFiles(db, project, changedToApply, newExports);
    } else {
      replaceExportsForFiles(db, project, [], newExports);
    }

    // Step 3: rebuild cross-file CALLS edges.
    // R108: when callSitesInitialized=true, ALWAYS run rebuildCrossFileCallsEdges
    // (even if call_sites is empty). See wasm-extractor.ts for full explanation.
    // R109: when callSitesInitialized=true && nodesCount=0, mark resolved=true
    // without calling rebuild (empty graph is complete).
    // R126: pass semanticsCurrent. Full mode → true (fresh extraction).
    // R127: MIG-R127-03 — when semantics are stale (incremental with old
    // extractor_semantics_version), DON'T run the resolver. Delete cross-file
    // edges and leave crossFileResolved=false so the caller sets stale=true.
    if (incremental) {
      const nodesCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE project = ?').get(project) as { c: number }).c;
      const semCurrent = (db.prepare('SELECT extractor_semantics_version AS v FROM projects WHERE name = ?').get(project) as { v?: number } | undefined)?.v === CURRENT_EXTRACTOR_SEMANTICS_VERSION;
      // R128: MIG-R128-02 — semanticsStale dominates callSitesInitialized.
      if (!semCurrent) {
        // R127: MIG-R127-03 — stale semantics. Don't run the resolver.
        // R128: use clearCrossFileCallEdges helper.
        clearCrossFileCallEdges(db, project);
      } else if (!callSitesInitialized) {
        // R107: Legacy DB. Skip resolution. Caller marks stale=true.
      } else if (nodesCount > 0) {
        // R108: initialized=true → always rebuild (even if call_sites=0).
        const added = rebuildCrossFileCallsEdges(db, project, true);
        edgeCount += added;
        crossFileResolved = true;
      } else {
        // R109: initialized=true && nodesCount=0 → empty graph is COMPLETE.
        crossFileResolved = true;
      }
    } else {
      // Full mode: always rebuild.
      // R126: full reindex → semanticsCurrent=true.
      const added = rebuildCrossFileCallsEdges(db, project, true);
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
