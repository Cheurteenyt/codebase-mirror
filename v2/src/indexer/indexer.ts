// v2/src/indexer/indexer.ts
// R69: Native WASM-based code indexer — orchestrateur.
//
// Walks a project directory, extracts code structure using web-tree-sitter
// (WASM, 112 languages), and writes to SQLite (compatible with V1's schema).
//
// R69 replaced the R68 ts-morph extractor (TS/JS only) with a WASM-based
// extractor that supports 112 languages via tree-sitter WASM grammars.
// No V1 `cbm` binary is needed.
//
// R153: Added alias_history table for historical-target protection. When a
// symlink alias was previously valid and is now broken (ENOENT/ELOOP), the
// old canonical target's data is preserved (filtered from deletedRelPaths
// in incremental mode; forces hasUncertainty in full mode).

import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { initIndexerSchema, clearProjectData, updateProjectStats, CURRENT_EXTRACTOR_SEMANTICS_VERSION, CURRENT_DISCOVERY_POLICY_VERSION, loadAliasHistory, computeRootFingerprint, commitAliasStateAtomically } from './schema.js';
import { discoverSourceFilesStructured, detectLanguage, extractFromFilesWasm, preloadGrammars } from './wasm-extractor.js';
import type { DiscoveryResult } from './wasm-extractor.js';
import { replaceCallSitesForFiles, replaceImportsForFiles, replaceExportsForFiles, rebuildCrossFileCallsEdges, clearCrossFileCallEdges, isCallSitesInitialized } from './cross-file-resolver.js';
import { assertDiscoveryRoot, DiscoveryRootError } from '../utils/safe-path.js';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { join, relative as nodeRelative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
  /**
   * R152 (OBS-R152-01): Discovery warnings propagated to the caller.
   * Includes broken symlinks, ELOOP, ENOENT_LSTAT, etc.
   * Lets the CLI/UI/MCP show warnings even when the index succeeded.
   *
   * R153 (OBS-R153-01): Now propagated in ALL return paths that have a
   * discovery result (dry-run, partial discovery, full uncertainty, no-op,
   * deletion-only, main path). Previously several early returns dropped
   * the warnings field.
   */
  warnings?: {
    total: number;
    countsByCode: Record<string, number>;
    samples: Array<{ path: string; code: string }>;
  };
  /**
   * R153 (OUTCOME-R153-01): Typed outcome for explicit CLI/UI/MCP contracts.
   * Replaces the implicit "errors=0 AND stale=false → success" logic that
   * was scattered across consumers. The outcome is computed by the indexer
   * based on errors, stale, and warnings:
   *
   *   - 'SUCCESS': no errors, not stale, no warnings.
   *   - 'SUCCESS_WITH_WARNINGS': no errors, not stale, but warnings present
   *     (e.g., broken symlinks that don't block the index).
   *   - 'STALE': no errors but crossFileCallsStale=true (semantics mismatch,
   *     uncertainty, partial discovery aborted to preserve graph).
   *   - 'PARTIAL': errors present but --allow-partial would still exit 0.
   *   - 'FAILED': errors present and the index did not complete.
   *
   * The CLI uses this to print the correct banner BEFORE warnings (so the
   * user sees the outcome first, then the diagnostic detail).
   */
  outcome?: 'SUCCESS' | 'SUCCESS_WITH_WARNINGS' | 'STALE' | 'PARTIAL' | 'FAILED';
  /**
   * R156 (OBS-R156-01): Structured stale reason.
   *
   * R159 (OBS-R159-03): Added `totalPaths` + `pathsTruncated` so consumers can
   * display "(showing 100 of N)" when the cap kicks in. R158 silently capped
   * at 100 with no signal, hiding the magnitude of filesystem breakage.
   */
  staleReason?: {
    code:
      | 'DISCOVERY_UNCERTAIN'
      | 'HISTORICAL_ALIAS_BROKEN'
      | 'COLD_START_LOCK'
      | 'SEMANTICS_MISMATCH'
      | 'PREVIOUSLY_STALE'
      | 'PERSIST_FAILURE';
    message: string;
    paths: string[];
    /** R159: total broken paths before capping. Undefined when not applicable. */
    totalPaths?: number;
    /** R159: true when paths were truncated to MAX_STALE_PATHS. */
    pathsTruncated?: boolean;
  };
  /**
   * R156 (OBS-R156-01): Recovery recommendation.
   */
  recovery?: 'retry_incremental' | 'fix_filesystem' | 'full_reindex' | 'none';
  /**
   * R158 (OUTCOME-R158-01): Structured system failure. When the index fails
   * due to a system error (publication failure, DB error, extraction crash),
   * this field carries the specific failure info. `errors[]` is reserved for
   * per-file extraction errors only.
   */
  failure?: {
    // R160 (API-R160-03): expanded failure code taxonomy. R159 used DB_ERROR
    // for non-DB errors (missing root, discovery failure). R160 splits these
    // into ROOT_ERROR (root validation), DISCOVERY_ERROR (discovery throw),
    // DISCOVERY_PARTIAL (incomplete discovery), RESOLVER_ERROR (cross-file
    // resolver crash — declared but not yet emitted), DB_ERROR (raw DB
    // operation failure during cleanup/totals/publish), EXTRACTION_CRASH
    // (preload/extraction crash), PERSIST_FAILURE (publication commit
    // failure), UNKNOWN (declared but not yet emitted).
    code: 'ROOT_ERROR' | 'DISCOVERY_ERROR' | 'DISCOVERY_PARTIAL' | 'DB_ERROR' | 'RESOLVER_ERROR' | 'EXTRACTION_CRASH' | 'PERSIST_FAILURE' | 'UNKNOWN';
    message: string;
    phase: string;
  };
}

/**
 * R153 (OBS-R153-01): Build the warnings field from a discovery result.
 * Returns `undefined` when there are no warnings (so the field is omitted
 * from the JSON-serialized IndexResult for clean runs).
 *
 * This helper is called IMMEDIATELY after discovery succeeds, so all
 * subsequent return paths can include `warnings: discoveryWarnings` without
 * re-computing it. R152 built this field AFTER several early returns,
 * causing warnings to be dropped from dry-run, partial discovery, and
 * full-uncertainty returns.
 */
function buildDiscoveryWarnings(discovery: DiscoveryResult): IndexResult['warnings'] {
  if (discovery.totalWarnings === 0) return undefined;
  return {
    total: discovery.totalWarnings,
    countsByCode: discovery.warningCountsByCode,
    samples: discovery.warningSamples,
  };
}

/**
 * R153 (OUTCOME-R153-01): Compute the typed outcome from the final state.
 * The CLI uses this to print the correct banner. The outcome is determined
 * by errors, stale flag, and warnings presence:
 *   - errors > 0 → 'PARTIAL' (allow-partial would still exit 0) or 'FAILED'
 *   - stale → 'STALE'
 *   - warnings > 0 → 'SUCCESS_WITH_WARNINGS'
 *   - else → 'SUCCESS'
 *
 * Note: 'PARTIAL' vs 'FAILED' distinction is informational — the CLI's exit
 * code logic (separate from this) decides whether to exit 0 or 1 based on
 * --allow-partial. We mark errors > 0 as 'PARTIAL' when the run otherwise
 * completed (discovery succeeded, extraction produced partial results) and
 * 'FAILED' when the run aborted before extraction (root failure, discovery
 * exception, partial discovery lock).
 */
function computeOutcome(
  errors: Array<{ file: string; error: string }>,
  crossFileCallsStale: boolean,
  warnings: IndexResult['warnings'],
  aborted: boolean,
): 'SUCCESS' | 'SUCCESS_WITH_WARNINGS' | 'STALE' | 'PARTIAL' | 'FAILED' {
  if (errors.length > 0) {
    return aborted ? 'FAILED' : 'PARTIAL';
  }
  if (crossFileCallsStale) {
    return 'STALE';
  }
  if (warnings !== undefined && warnings.total > 0) {
    return 'SUCCESS_WITH_WARNINGS';
  }
  return 'SUCCESS';
}

/**
 * R158 (OBS-R158-01/02/03): Unified stale reason classifier.
 * Used by ALL paths (no-op, deletion-only, main) to ensure consistent
 * staleReason codes, messages, and recovery recommendations.
 *
 * R159 (OUTCOME-R159-01): Reordered priority. Filesystem blockers
 * (COLD_START_LOCK, HISTORICAL_ALIAS_BROKEN) now come BEFORE
 * SEMANTICS_MISMATCH. Rationale: if the filesystem is broken (alias or
 * cold-start lock), recommending full_reindex is circular — the full
 * will be blocked by the broken alias. Fix the filesystem FIRST, then
 * do the full reindex. R158 put SEMANTICS_MISMATCH first, which meant a
 * project with both semantics mismatch AND a broken alias would be told
 * to do a full_reindex that immediately aborts with
 * HISTORICAL_ALIAS_BROKEN — circular recovery.
 *
 * Priority order (first match wins):
 *   1. PERSIST_FAILURE — publication commit failed (handled by catch blocks)
 *   2. COLD_START_LOCK — history not initialized, broken aliases present
 *      (filesystem blocker — full will be blocked)
 *   3. HISTORICAL_ALIAS_BROKEN — previously-valid alias now broken, target absent
 *      (filesystem blocker — full will be blocked)
 *   4. SEMANTICS_MISMATCH — extractor_semantics_version != CURRENT
 *      (recommends full_reindex — only useful if filesystem is healthy)
 *   5. DISCOVERY_UNCERTAIN — TOCTOU races (uncertainPaths/subtrees)
 *   6. PREVIOUSLY_STALE — project was already stale, no-op didn't refresh
 *
 * R159 (OUTCOME-R159-02): When `hasExtractionErrors=true` AND no other
 * cause matched, returns `undefined`. The errors are in `result.errors`
 * and `outcome=PARTIAL` — no staleReason is needed. R158 already did
 * this, but the main path's staleReason builder fell back to
 * `PREVIOUSLY_STALE` with the indexError message, mislabeling extraction
 * errors. R159 fixes the main path builder to respect `undefined`.
 *
 * R160 (OBS-R160-01): The classifier now accepts and returns `paths`.
 * R159's fast paths (no-op, deletion-only, main) returned `paths: []`
 * even when the staleReason was HISTORICAL_ALIAS_BROKEN or
 * COLD_START_LOCK — hiding the affected aliases from the user. R160
 * passes `brokenAliasPaths`, `uncertainPathsList`, and
 * `uncertainSubtreesList` to the classifier, which returns the
 * appropriate list (capped at MAX_STALE_PATHS=100) based on which
 * condition matched.
 */
function classifyStaleReason(params: {
  semanticsStale: boolean;
  hasEffectiveHistoricalBrokenAliases: boolean;
  coldStartLock: boolean;
  hasUncertainty: boolean;
  existingStale: boolean;
  hasExtractionErrors: boolean;
  callSitesInitialized: boolean;
  // R160 (OBS-R160-01): path lists for the classifier to surface in
  // staleReason.paths. brokenAliasPaths is used for COLD_START_LOCK and
  // HISTORICAL_ALIAS_BROKEN; uncertainPathsList + uncertainSubtreesList
  // are used for DISCOVERY_UNCERTAIN. The classifier caps the returned
  // list at MAX_STALE_PATHS = 100.
  brokenAliasPaths?: string[];
  uncertainPathsList?: string[];
  uncertainSubtreesList?: string[];
}): { code: NonNullable<NonNullable<IndexResult['staleReason']>['code']>; message: string; recovery: NonNullable<IndexResult['recovery']>; paths: string[] } | undefined {
  const { semanticsStale, hasEffectiveHistoricalBrokenAliases, coldStartLock, hasUncertainty, existingStale, hasExtractionErrors, callSitesInitialized } = params;
  // R160 (OBS-R160-01): MAX_STALE_PATHS cap, consistent with the
  // full-uncertainty return's cap.
  const MAX_STALE_PATHS = 100;
  const cap = (arr: string[]): string[] => arr.slice(0, MAX_STALE_PATHS);

  // R159 (OUTCOME-R159-01): COLD_START_LOCK first — filesystem blocker.
  // If we recommend full_reindex here, the full will be blocked by the
  // cold-start lock on the next run. Fix the filesystem first.
  if (coldStartLock) {
    return {
      code: 'COLD_START_LOCK',
      message: `Cold-start lock: alias_history not yet initialized and broken aliases present. Fix or remove the broken symlinks, then rerun.`,
      recovery: 'fix_filesystem',
      // R160 (OBS-R160-01): surface the broken alias paths.
      paths: cap(params.brokenAliasPaths ?? []),
    };
  }
  // R159 (OUTCOME-R159-01): HISTORICAL_ALIAS_BROKEN second — filesystem blocker.
  // Same rationale: full_reindex would be blocked by the broken alias.
  if (hasEffectiveHistoricalBrokenAliases) {
    return {
      code: 'HISTORICAL_ALIAS_BROKEN',
      message: `Historically-valid alias(es) now broken with target absent. Fix or restore the broken alias targets, then rerun.`,
      recovery: 'fix_filesystem',
      // R160 (OBS-R160-01): surface the broken alias paths.
      paths: cap(params.brokenAliasPaths ?? []),
    };
  }
  // R159 (OUTCOME-R159-01): SEMANTICS_MISMATCH third — only useful if filesystem
  // is healthy. Now that filesystem blockers are checked first, recommending
  // full_reindex here is safe (the full won't be blocked).
  if (semanticsStale) {
    return {
      code: 'SEMANTICS_MISMATCH',
      message: `Semantics version mismatch — full reindex required`,
      recovery: 'full_reindex',
      paths: [],
    };
  }
  if (hasUncertainty) {
    return {
      code: 'DISCOVERY_UNCERTAIN',
      message: `Source snapshot uncertain: paths temporarily absent. Retry when filesystem is stable.`,
      recovery: 'retry_incremental',
      // R160 (OBS-R160-01): surface the uncertain paths + subtrees.
      paths: cap([...(params.uncertainPathsList ?? []), ...(params.uncertainSubtreesList ?? [])]),
    };
  }
  if (hasExtractionErrors) {
    return undefined; // R159 (OUTCOME-R159-02): errors are in result.errors, outcome=PARTIAL
  }
  if (!callSitesInitialized) {
    return {
      code: 'PREVIOUSLY_STALE',
      message: `Call sites not initialized — full reindex required`,
      recovery: 'full_reindex',
      paths: [],
    };
  }
  if (existingStale) {
    return {
      code: 'PREVIOUSLY_STALE',
      message: `Project was already stale; incremental did not refresh`,
      recovery: 'full_reindex',
      paths: [],
    };
  }
  return undefined;
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
  // R154 (PERF-R154-01) + R155 (CONC-R155-01): runId for alias_history GC.
  // R154 used Date.now() which can collide between concurrent indexers started
  // in the same millisecond. R155 uses randomUUID() — collision-proof.
  const runId = randomUUID();
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
        outcome: 'FAILED',
        // R159 (API-R159-01): structured failure for programmatic triage.
        // R160 (API-R160-03 + OUTCOME-R160-01): ROOT_ERROR (was DB_ERROR) —
        // a missing/unreadable root is a filesystem issue, not a DB issue.
        // Recovery is fix_filesystem (was retry_incremental) — the user must
        // fix or remove the missing root before retrying.
        failure: { code: 'ROOT_ERROR', message, phase: 'dry-run-root' },
        recovery: 'fix_filesystem',
      };
    }
    let discovery: DiscoveryResult;
    try {
      discovery = discoverSourceFilesStructured(opts.rootPath, canonicalRoot);
    } catch (error) {
      const discoveryMsg = (error as Error).message;
      return {
        dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
        files: 0, skipped: 0,
        errors: [{ file: opts.rootPath, error: discoveryMsg }],
        languages: new Set(),
        parallel: false,
        workerCount: 0,
        crossFileCallsStale: true,
        outcome: 'FAILED',
        // R159 (API-R159-01): structured failure for programmatic triage.
        // R160 (API-R160-03 + OUTCOME-R160-01): DISCOVERY_ERROR (was DB_ERROR)
        // — a discovery throw is a filesystem issue, not a DB issue. Recovery
        // is fix_filesystem (was retry_incremental).
        failure: { code: 'DISCOVERY_ERROR', message: `Discovery failed: ${discoveryMsg}`, phase: 'dry-run-discovery' },
        recovery: 'fix_filesystem',
      };
    }
    const langs = new Set<string>();
    for (const f of discovery.files) {
      const lang = detectLanguage(f);
      if (lang) langs.add(lang);
    }
    // R153 (OBS-R153-01): Build warnings immediately after discovery so all
    // return paths can include them. R152 dropped warnings from dry-run.
    const dryRunWarnings = buildDiscoveryWarnings(discovery);
    const dryRunStale = !discovery.complete;
    // R160 (API-R160-02): extract the outcome into a variable so we can
    // attach a `failure` field when the dry-run discovery was partial
    // (errors>0 + aborted=true → FAILED). R159 returned FAILED with no
    // `failure` field, so programmatic consumers couldn't distinguish a
    // dry-run partial discovery from a clean dry-run via the failure.code.
    const dryRunOutcome = computeOutcome(
      discovery.errors.map(e => ({ file: e.path, error: `${e.code}: ${e.message}` })),
      dryRunStale,
      dryRunWarnings,
      true,
    );
    return {
      dbPath, durationMs: Date.now() - start, nodes: 0, edges: 0,
      files: discovery.files.length, skipped: 0,
      errors: discovery.errors.map(e => ({ file: e.path, error: `${e.code}: ${e.message}` })),
      languages: langs,
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: dryRunStale,
      warnings: dryRunWarnings,
      outcome: dryRunOutcome,
      // R160 (API-R160-02): FAILED outcome now carries a structured failure
      // with code=DISCOVERY_PARTIAL and phase=dry-run-discovery-partial.
      // Recovery is fix_filesystem (the discovery errors are filesystem
      // issues — broken symlinks, EACCES on subtrees, etc.).
      failure: dryRunOutcome === 'FAILED'
        ? { code: 'DISCOVERY_PARTIAL', message: `Dry-run discovery incomplete: ${discovery.totalErrors} error(s)`, phase: 'dry-run-discovery-partial' }
        : undefined,
      recovery: dryRunOutcome === 'FAILED' ? 'fix_filesystem' : undefined,
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
      outcome: 'FAILED',
      // R159 (API-R159-01): structured failure for programmatic triage.
      // R160 (API-R160-03 + OUTCOME-R160-01): ROOT_ERROR (was DB_ERROR) —
      // a missing/unreadable root is a filesystem issue. Recovery is
      // fix_filesystem (was retry_incremental).
      failure: { code: 'ROOT_ERROR', message, phase: 'root-validation' },
      recovery: 'fix_filesystem',
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
      outcome: 'FAILED',
      // R159 (API-R159-01): structured failure for programmatic triage.
      // R160 (API-R160-03 + OUTCOME-R160-01): DISCOVERY_ERROR (was DB_ERROR)
      // — a discovery throw is a filesystem issue. Recovery is fix_filesystem
      // (was retry_incremental).
      failure: { code: 'DISCOVERY_ERROR', message: fullMsg, phase: 'discovery' },
      recovery: 'fix_filesystem',
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

  // R153 (OBS-R153-01): Build warnings IMMEDIATELY after discovery succeeds,
  // BEFORE the partial discovery check. R152 built this field AFTER the
  // partial-discovery returns, causing warnings to be dropped when discovery
  // was partial. Now all return paths (partial, full uncertainty, no-op,
  // deletion-only, main) can include `warnings: discoveryWarnings`.
  const discoveryWarnings = buildDiscoveryWarnings(discovery);

  // R153 (DATA-R153-01/02) + R154 (ALIAS-R154-01, MIG-R154-01, ALIAS-R154-03):
  // Alias history lookup. For each broken alias in discovery.brokenAliases,
  // check if it was previously valid (has an entry in alias_history scoped by
  // root_fingerprint). If so, the old canonical target must be protected
  // from deletion:
  //   - file target → protected exact path (excluded from deletedRelPaths)
  //   - directory target → protected subtree (prefix match)
  //
  // R154 (ALIAS-R154-01): The history is scoped by root_fingerprint so a
  // project reconfigured to a different root does NOT inherit stale history.
  //
  // R154 (MIG-R154-01): Cold-start lock. If alias_history is not yet
  // initialized for this project (alias_history_initialized=0 OR
  // discovery_policy_version < CURRENT), we cannot trust the history. In this
  // case, if there are ANY broken aliases AND existing nodes, we apply the
  // cold-start lock: no deletions allowed, full-mode uncertainty. This closes
  // the R152→R153 cold-start gap where a DB with nodes but no history could
  // silently lose data.
  //
  // R154 (ALIAS-R154-03): Target visibility check. Even if a broken alias has
  // a history entry, if the target is STILL visible in the current discovery
  // (either directly or via another alias), we do NOT need to protect it —
  // the target's data is already in currentRelPaths. We only protect targets
  // that are genuinely absent from the current discovery.
  const rootFingerprint = computeRootFingerprint(canonicalRoot);
  const aliasHistory = loadAliasHistory(db, opts.project, rootFingerprint);
  const protectedPaths = new Set<string>();
  const protectedSubtrees: string[] = [];
  const historicalBrokenAliases: Array<{ aliasPath: string; canonicalTarget: string; targetKind: string; code: string }> = [];
  for (const broken of discovery.brokenAliases) {
    const entry = aliasHistory.get(broken.aliasPath);
    if (entry) {
      historicalBrokenAliases.push({
        aliasPath: broken.aliasPath,
        canonicalTarget: entry.canonicalTarget,
        targetKind: entry.targetKind,
        code: broken.code,
      });
      if (entry.targetKind === 'directory') {
        protectedSubtrees.push(entry.canonicalTarget);
      } else {
        protectedPaths.add(entry.canonicalTarget);
      }
    }
  }
  // R154 (ALIAS-R154-03): hasHistoricalBrokenAliases is computed AFTER the
  // visibility filter (hasEffectiveHistoricalBrokenAliases) — see below.

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
        warnings: discoveryWarnings,
        outcome: 'FAILED',
        // R159 (API-R159-01): structured failure for programmatic triage.
        // R160 (API-R160-03): DISCOVERY_PARTIAL (was DB_ERROR) — the
        // discovery was incomplete (subtree EACCES, fatal symlink errors).
        // R160 (OUTCOME-R160-01): recovery is retry_incremental (unchanged)
        // — the filesystem may be transiently unreadable (EACCES, lock),
        // so retrying may succeed once the underlying issue clears.
        failure: { code: 'DISCOVERY_PARTIAL', message: fullMsg, phase: 'discovery-partial' },
        recovery: 'retry_incremental',
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
      warnings: discoveryWarnings,
      outcome: 'FAILED',
      // R159 (API-R159-01): structured failure for programmatic triage.
      // R160 (API-R160-03): DISCOVERY_PARTIAL (was DB_ERROR).
      // R160 (OUTCOME-R160-01): recovery is retry_incremental (unchanged).
      failure: { code: 'DISCOVERY_PARTIAL', message: fullMsg, phase: 'discovery-partial' },
      recovery: 'retry_incremental',
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
  // R150 (DATA-R150-02): globalDeletionUncertainty (broken symlinks) also
  // triggers the full lock — the symlink may have been valid at the previous
  // run, so the full could destroy old data for a target that's temporarily
  // absent.
  // R152 (AVAIL-R152-01 + CONSIST-R152-01): Broken symlink idempotence.
  // R151 introduced non-idempotent behavior: first full (no existing graph)
  // succeeded but second full (with existing graph) blocked — same filesystem,
  // different outcomes. The root cause was that R150's globalDeletionUncertainty
  // was applied only when nodes existed, creating a state-dependent policy.
  //
  // R152 fix: broken symlinks (ENOENT on realpath) are ALWAYS warnings, NEVER
  // block. They don't produce uncertainPaths or globalDeletionUncertainty.
  // The rationale: without alias history, we cannot distinguish permanently
  // broken from temporarily broken. Blocking ALL fulls permanently (R150) or
  // blocking only subsequent fulls (R151) both create unacceptable trade-offs.
  //
  // R153 (DATA-R153-01/02): Alias history now provides the missing information.
  // A broken alias that was previously valid (has an entry in alias_history)
  // MUST trigger the full-mode uncertainty lock — the old canonical target's
  // data would be destroyed by clearProjectData. The lock preserves the old
  // graph until the target is restored and a successful re-index repopulates
  // alias_history with the new (valid) target.
  //
  // A broken alias that was NEVER valid (no history entry) remains a warning
  // only — there's no old target data to protect.
  //
  // R154 (MIG-R154-01): Cold-start lock. Read the project's bootstrap state
  // (alias_history_initialized, discovery_policy_version) and existing node
  // count. If the history is not yet initialized (or the policy version is
  // stale), AND there are broken aliases, AND the project has existing nodes,
  // we cannot trust that the broken aliases were never valid — the history
  // might just be empty because it was never populated. In this case, we
  // apply the cold-start lock: treat ALL broken aliases as potentially
  // historical, forcing hasUncertainty (full mode aborts) and blocking all
  // deletions (incremental mode preserves everything). This closes the
  // R152→R153 cold-start gap.
  //
  // R154 (ALIAS-R154-03): Target visibility check. Even if a broken alias has
  // a history entry, if the target is STILL visible in the current discovery
  // (either directly as a file, or via another still-valid alias), we do NOT
  // need to protect it — the target's data is already in currentRelPaths.
  // We only protect targets that are genuinely absent from the current
  // discovery. This prevents false stale when the target is accessible via
  // another path.
  const projectBootstrap = db.prepare(
    'SELECT alias_history_initialized AS historyInit, discovery_policy_version AS policyVersion FROM projects WHERE name = ?'
  ).get(opts.project) as { historyInit?: number; policyVersion?: number } | undefined;
  const historyInitialized = projectBootstrap?.historyInit === 1;
  const policyVersionCurrent = (projectBootstrap?.policyVersion ?? 0) >= CURRENT_DISCOVERY_POLICY_VERSION;
  const bootstrapComplete = historyInitialized && policyVersionCurrent;

  // R154 (ALIAS-R154-03): Build the set of current relative paths (files only)
  // to check target visibility. A target that's still in this set doesn't need
  // protection — it's already being indexed.
  const currentRelPathsSet = new Set<string>();
  for (const f of discovery.files) {
    currentRelPathsSet.add(nodeRelative(canonicalRoot, f));
  }

  // R154 (ALIAS-R154-03): Filter protected paths/subtrees to only those whose
  // target is genuinely absent from the current discovery. If the target is
  // still visible (directly or via another alias), remove it from protection.
  // This prevents false stale when e.g. real.ts exists directly AND alias.ts
  // is broken — real.ts is already in currentRelPaths, so no protection needed.
  const visibleProtectedPaths = new Set<string>();
  for (const p of protectedPaths) {
    if (!currentRelPathsSet.has(p)) {
      visibleProtectedPaths.add(p);
    }
  }
  const visibleProtectedSubtrees = protectedSubtrees.filter(prefix => {
    // A directory target is "visible" if ANY current path is under it.
    for (const current of currentRelPathsSet) {
      if (current === prefix || current.startsWith(prefix + sep)) {
        return false; // visible — don't protect
      }
    }
    return true; // genuinely absent — protect
  });
  // Recompute historicalBrokenAliases to only include those with genuinely
  // absent targets. This drives the uncertainty decision and the message.
  const effectiveHistoricalBrokenAliases = historicalBrokenAliases.filter(a => {
    if (a.targetKind === 'directory') {
      return visibleProtectedSubtrees.includes(a.canonicalTarget);
    }
    return visibleProtectedPaths.has(a.canonicalTarget);
  });
  const hasEffectiveHistoricalBrokenAliases = effectiveHistoricalBrokenAliases.length > 0;

  // R154 (MIG-R154-01): Cold-start lock. If bootstrap is not complete AND
  // there are broken aliases AND the project has existing data, apply the
  // lock. We can't trust that the broken aliases were never valid.
  // R155 (PERF-R155-04): Use EXISTS instead of COUNT(*) for the existence
  // check — COUNT(*) scans all matching rows while EXISTS short-circuits at
  // the first match. Also check file_hashes/call_sites to catch partial DBs
  // that have hashes but no nodes (pre-R79 full mode).
  let coldStartLock = false;
  if (!bootstrapComplete && discovery.brokenAliases.length > 0) {
    const hasExistingData = (db.prepare(
      'SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ? LIMIT 1) AS e'
    ).get(opts.project) as { e: number }).e === 1
      || (db.prepare(
        'SELECT EXISTS(SELECT 1 FROM file_hashes WHERE project = ? LIMIT 1) AS e'
      ).get(opts.project) as { e: number }).e === 1;
    if (hasExistingData) {
      coldStartLock = true;
    }
  }

  // R154 (ALIAS-R154-03): Update protectedPaths/protectedSubtrees to the
  // visibility-filtered versions so downstream deletion filtering uses them.
  protectedPaths.clear();
  for (const p of visibleProtectedPaths) protectedPaths.add(p);
  protectedSubtrees.length = 0;
  for (const s of visibleProtectedSubtrees) protectedSubtrees.push(s);

  // The remaining sources of `hasUncertainty` are:
  //   - uncertainPaths (ENOENT_LSTAT, ENOENT_IDENTITY — TOCTOU races on files
  //     that were confirmed to exist by readdir)
  //   - uncertainSubtrees (ENOENT_REALPATH_DIR — TOCTOU races on directories)
  //   - empty relTarget (DATA-R151-01 — root-level uncertainty)
  //   - effectiveHistoricalBrokenAliases (R153+R154 — previously-valid alias
  //     now broken, target genuinely absent)
  //   - coldStartLock (R154 — history not initialized, can't trust broken aliases)
  const hasEmptyRelTarget = discovery.uncertainSubtrees.some(s => s === '');
  const effectiveGlobalDeletionUncertainty = hasEmptyRelTarget || coldStartLock;
  const hasUncertainty = discovery.uncertainPaths.length > 0 || discovery.uncertainSubtrees.length > 0 || effectiveGlobalDeletionUncertainty || hasEffectiveHistoricalBrokenAliases;
  if (!opts.incremental && hasUncertainty) {
    db.close();
    // R156 (OBS-R156-01 + AVAIL-R156-01): Build structured staleReason + recovery.
    let staleCode: 'DISCOVERY_UNCERTAIN' | 'HISTORICAL_ALIAS_BROKEN' | 'COLD_START_LOCK';
    let staleMsg: string;
    let recovery: 'fix_filesystem' | 'retry_incremental';
    const brokenPaths: string[] = [];
    if (coldStartLock) {
      staleCode = 'COLD_START_LOCK';
      for (const a of discovery.brokenAliases) brokenPaths.push(a.aliasPath);
      staleMsg = `Cold-start lock: alias_history not yet initialized and ${discovery.brokenAliases.length} broken alias(es) present. Fix or remove the broken symlinks (see paths below), then rerun. The full index is blocked until the broken aliases are resolved or the history is populated by a successful run without broken aliases.`;
      recovery = 'fix_filesystem';
    } else if (hasEffectiveHistoricalBrokenAliases) {
      staleCode = 'HISTORICAL_ALIAS_BROKEN';
      for (const a of effectiveHistoricalBrokenAliases) brokenPaths.push(a.aliasPath);
      staleMsg = `${effectiveHistoricalBrokenAliases.length} historically-valid alias(es) now broken with target absent. Full index aborted to preserve existing graph. Fix or restore the broken alias targets, then rerun.`;
      recovery = 'fix_filesystem';
    } else {
      staleCode = 'DISCOVERY_UNCERTAIN';
      for (const p of discovery.uncertainPaths) brokenPaths.push(p);
      for (const s of discovery.uncertainSubtrees) brokenPaths.push(s);
      staleMsg = `Discovery uncertain: ${discovery.uncertainPaths.length} path(s), ${discovery.uncertainSubtrees.length} subtree(s) temporarily absent. Full index aborted to preserve existing graph. Retry when filesystem is stable.`;
      recovery = 'retry_incremental';
    }
    markProjectStalePreservingGraph(dbPath, opts.project, staleMsg);
    // R158 (PERF-R158-01): Cap staleReason.paths at 100 so a repo with
    // thousands of broken symlinks doesn't produce a multi-MB IndexResult.
    // R159 (OBS-R159-03): Also expose `totalPaths` + `pathsTruncated` so
    // consumers can display "(showing 100 of N)". R158's silent cap hid the
    // magnitude of filesystem breakage.
    const MAX_STALE_PATHS = 100;
    const cappedPaths = brokenPaths.slice(0, MAX_STALE_PATHS);
    const pathsTruncated = brokenPaths.length > MAX_STALE_PATHS;
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
      warnings: discoveryWarnings,
      outcome: 'STALE',
      staleReason: {
        code: staleCode,
        message: staleMsg,
        paths: cappedPaths,
        // R159 (OBS-R159-03): expose truncation info.
        totalPaths: brokenPaths.length,
        pathsTruncated,
      },
      recovery,
    };
  }

  // R157 (ordering fix): Read projectState BEFORE the premark below. The
  // premark sets cross_file_calls_stale=1 via UPSERT; if this read ran after
  // it, existingStale would always be true (from the premark), breaking the
  // no-op and deletion-only fast paths which rely on the TRUE pre-premark state.
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

  // R157 (DATA-R157-01 + STATE-R157-03): Premark stale BEFORE clearProjectData
  // and BEFORE any graph mutation. This runs AFTER the no-op and deletion-only
  // fast paths have returned, so it only affects the MAIN path.
  // Uses INSERT ON CONFLICT (UPSERT) so it works on first full index too.
  // R158 (ROOT-R158-01): the ON CONFLICT DO UPDATE clause also set
  // root_path = excluded.root_path so a project reconfigured to a new root
  // had its root_path updated atomically with the premark.
  // R160 (STATE-R160-02): REMOVED `root_path = excluded.root_path` from the
  // ON CONFLICT DO UPDATE clause. The premark should NOT update root_path —
  // only the final commit (commitAliasStateAtomically or updateProjectStats)
  // should update root_path on success. The premark represents an ATTEMPTED
  // root, not a confirmed snapshot root. If the premark updated root_path
  // and the index then failed, the DB would record the attempted (possibly
  // broken) root as the project's root_path, misleading Graph Status and
  // the next run's root_fingerprint computation. Now the premark only
  // updates stale/last_index_attempt_at/last_index_error; root_path is
  // written by the INSERT (first full index) and updated only by the final
  // commit on success.
  {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at, last_index_error)
      VALUES (?, ?, ?, 1, ?, 'Index publication in progress')
      ON CONFLICT(name) DO UPDATE SET
        cross_file_calls_stale = 1,
        last_index_attempt_at = excluded.last_index_attempt_at,
        last_index_error = excluded.last_index_error
    `).run(opts.project, effectiveRoot, now, now);
  }

  if (!opts.incremental) {
    clearProjectData(db, opts.project);
  }
  // In incremental mode, we do NOT clear nodes/edges here. The extractor
  // will delete old nodes for changed files before re-inserting.

  // R154 (ALIAS-R154-02): Contribution filter. Only persist resolved aliases
  // that actually contributed code to the graph. A file alias is contributive
  // if its target has a supported language (detectLanguage !== null). A
  // directory alias is contributive if at least one discovered file is under
  // its canonical target prefix. Non-contributive aliases (e.g. alias →
  // LICENSE.txt, alias → empty directory, alias → FIFO) are NOT historized,
  // so when they break later they don't force stale/full-abort despite never
  // having contributed code data.
  const contributiveAliases = discovery.resolvedAliases.filter(a => {
    if (a.targetKind === 'file') {
      // Re-check: does the target have a supported language?
      const targetAbs = join(canonicalRoot, a.canonicalTarget);
      return detectLanguage(targetAbs) !== null;
    }
    // Directory: contributive if at least one discovered file is under the prefix.
    const prefix = a.canonicalTarget;
    for (const f of discovery.files) {
      const rel = nodeRelative(canonicalRoot, f);
      if (rel === prefix || rel.startsWith(prefix + sep)) {
        return true;
      }
    }
    return false;
  });

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
    // R150 (DATA-R150-02): If globalDeletionUncertainty is set, block ALL
    // deletions — we can't distinguish permanently broken from temporarily
    // broken symlinks without alias history.
    // R151 (AVAIL-R151-01): Use effectiveGlobalDeletionUncertainty instead
    // of discovery.globalDeletionUncertainty — the indexer decides based on
    // whether the project has existing nodes (first-index policy).
    // R153 (DATA-R153-01/02): Also filter out protected paths from alias
    // history. A previously-valid alias whose target is now broken must
    // NOT have its old canonical target deleted. Protected paths are
    // computed from brokenAliases ∩ aliasHistory above.
    if (effectiveGlobalDeletionUncertainty) {
      deletedRelPaths = [];
    } else {
      const uncertainPathSet = new Set(discovery.uncertainPaths);
      const uncertainSubtreePrefixes = discovery.uncertainSubtrees;
      // R148 (COMPAT-R148-01): Use path.sep instead of hardcoded '/' for
      // cross-platform subtree prefix matching. On Windows, path.relative()
      // produces backslash-separated paths, so '/' would never match.
      deletedRelPaths = deletedRelPaths.filter(p => {
        // R153: alias-history protection — exact match.
        if (protectedPaths.has(p)) return false;
        // R153: alias-history protection — subtree match.
        for (const prefix of protectedSubtrees) {
          if (p === prefix || p.startsWith(prefix + sep)) return false;
        }
        // R147: uncertain path — exact match.
        if (uncertainPathSet.has(p)) return false;
        // R147: uncertain subtree — prefix match.
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
      const noOpStale = existingStale || semanticsStale || hasUncertainty;
      // R145 (STATE-R145-04): no-op stale must NOT set last_successful_index_at.
      // R144 passed null (success), which set last_successful=now and cleared
      // last_index_error even when a full reindex was required. Now we pass
      // an explicit error when stale so the DB reflects the real state.
      // R149 (STATE-R149-01): no-op must include hasUncertainty. R148 only
      // checked uncertainty in the main path — the fast path returned
      // stale=false + last_success=now despite uncertain paths. Now
      // hasUncertainty forces stale + indexError in the no-op path too.
      const noOpError = noOpStale
        ? (semanticsStale
            ? `Semantics version ${existingSemanticsVersion} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`
            : hasUncertainty
              ? `Source snapshot uncertain: ${discovery.uncertainPaths.length} path(s), ${discovery.uncertainSubtrees.length} subtree(s) temporarily absent. Retry incremental when filesystem is stable.`
              : 'Project was already stale; no-op incremental did not refresh')
        : null;
      // R155 (TX-R155-01): On STALE no-op, use updateProjectStats alone (no
      // alias_history changes — the run didn't succeed). On SUCCESS no-op,
      // we'll use commitAliasStateAtomically AFTER this transaction (it does
      // its own transaction). So here we only write stats when stale.
      if (noOpStale) {
        updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, noOpStale, existingInitialized, existingSemanticsVersion, noOpError);
      }
      return { noOpStale, totals };
    });
    const { noOpStale, totals } = noOpTx();
    // R155 (TX-R155-01) + R157 (STATE-R157-02): Atomic alias state commit.
    // R157 adds a catch block — if the commit fails, the no-op returns FAILED
    // with PERSIST_FAILURE (not silently fresh).
    let noOpPubFailed = false;
    let noOpErrMsg = '';
    try {
      if (!noOpStale) {
        const liveAliasPaths = new Set<string>();
        for (const a of contributiveAliases) liveAliasPaths.add(a.aliasPath);
        for (const a of discovery.brokenAliases) liveAliasPaths.add(a.aliasPath);
        commitAliasStateAtomically(
          db, opts.project, effectiveRoot, totals.nodes, totals.edges,
          existingInitialized, existingSemanticsVersion,
          rootFingerprint, runId, contributiveAliases, liveAliasPaths,
        );
      }
    } catch (commitError) {
      // R157 (STATE-R157-02): no-op publication failure.
      noOpPubFailed = true;
      noOpErrMsg = `Index publication failed: ${commitError instanceof Error ? commitError.message : String(commitError)}`;
      try {
        const now = new Date().toISOString();
        db.prepare('UPDATE projects SET cross_file_calls_stale = 1, last_index_attempt_at = ?, last_index_error = ? WHERE name = ?').run(now, noOpErrMsg, opts.project);
      } catch { /* best-effort */ }
    } finally {
      try { db.close(); } catch { /* ignore close error */ }
    }
    // R157 (OUTCOME-R157-01): publication failure = FAILED.
    // R158 (OUTCOME-R158-01): add structured `failure` field with phase.
    if (noOpPubFailed) {
      return {
        dbPath, durationMs: Date.now() - start,
        nodes: 0, edges: 0, files: 0, skipped: files.length,
        errors: [], languages: allLangs, parallel: false, workerCount: 0,
        crossFileCallsStale: true, warnings: discoveryWarnings,
        outcome: 'FAILED',
        staleReason: { code: 'PERSIST_FAILURE', message: 'Index publication failed during no-op commit.', paths: [] },
        recovery: 'retry_incremental',
        failure: { code: 'PERSIST_FAILURE', message: noOpErrMsg, phase: 'no-op-commit' },
      };
    }
    // R158 (OBS-R158-01): unified classifier for no-op stale path.
    // R160 (OBS-R160-01): pass brokenAliasPaths + uncertainPathsList +
    // uncertainSubtreesList so the classifier can surface affected paths
    // in staleReason.paths (was `paths: []` in R159, hiding the aliases).
    const noOpClassified = noOpStale
      ? classifyStaleReason({
          semanticsStale,
          hasEffectiveHistoricalBrokenAliases,
          coldStartLock,
          hasUncertainty,
          existingStale,
          hasExtractionErrors: false,
          callSitesInitialized: existingInitialized,
          brokenAliasPaths: discovery.brokenAliases.map(a => a.aliasPath),
          uncertainPathsList: discovery.uncertainPaths,
          uncertainSubtreesList: discovery.uncertainSubtrees,
        })
      : undefined;
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
      warnings: discoveryWarnings,
      outcome: computeOutcome([], noOpStale, discoveryWarnings, false),
      // R158: classified staleReason/recovery for no-op stale path.
      // R160 (OBS-R160-01): use the classifier's returned paths (was `paths: []`).
      staleReason: noOpClassified
        ? { code: noOpClassified.code, message: noOpClassified.message, paths: noOpClassified.paths }
        : undefined,
      recovery: noOpClassified?.recovery,
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
    // R157 (STATE-R157-01): Premark stale BEFORE the deletion cleanup.
    // R156 had no premark here — if commitAliasStateAtomically failed after
    // the cleanup transaction committed, the graph was modified but projects
    // could be fresh. R157 premarks so the graph is truthfully stale.
    // R158 (ROOT-R158-01): the ON CONFLICT DO UPDATE clause also set
    // root_path = excluded.root_path so a project reconfigured to a new root
    // had its root_path updated atomically with the premark.
    // R160 (STATE-R160-02): REMOVED `root_path = excluded.root_path` (same
    // rationale as the main-path premark above — the premark is an attempted
    // root, not a confirmed snapshot root; only the final commit should
    // update root_path on success).
    {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO projects (name, root_path, indexed_at, cross_file_calls_stale, last_index_attempt_at, last_index_error)
        VALUES (?, ?, ?, 1, ?, 'Index publication in progress')
        ON CONFLICT(name) DO UPDATE SET
          cross_file_calls_stale = 1,
          last_index_attempt_at = excluded.last_index_attempt_at,
          last_index_error = excluded.last_index_error
      `).run(opts.project, effectiveRoot, now, now);
    }
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
    // R149 (STATE-R149-02): hasUncertainty forces stale=true in deletion-only.
    // R148 only checked uncertainty in the main path — the deletion-only
    // fast path returned stale=false despite uncertain paths. Now
    // hasUncertainty forces stale + indexError in the deletion-only path too.
    const crossFileStale = semanticsStale || hasUncertainty
      ? true
      : crossFileResolved
        ? false
        : (callSitesInitialized ? existingStale : true);
    // R107: preserve call_sites_initialized (deletion-only doesn't change it)
    // R126: preserve extractor_semantics_version (deletion-only doesn't change it)
    // R145 (STATE-R145-04): pass indexError when stale (semantics mismatch).
    // R149 (STATE-R149-02): also pass indexError for uncertainty.
    const deletionError = crossFileStale
      ? (semanticsStale
          ? `Semantics version ${existingSemanticsVersion} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`
          : hasUncertainty
            ? `Source snapshot uncertain: ${discovery.uncertainPaths.length} path(s), ${discovery.uncertainSubtrees.length} subtree(s) temporarily absent. Retry incremental when filesystem is stable.`
            : null)
      : null;
    // R155 (TX-R155-01): On STALE deletion-only, use updateProjectStats alone.
    // On SUCCESS deletion-only, use commitAliasStateAtomically (atomic).
    if (crossFileStale) {
      updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, crossFileStale, callSitesInitialized, existingSemanticsVersion, deletionError);
      db.close();
    } else {
      const liveAliasPaths = new Set<string>();
      for (const a of contributiveAliases) liveAliasPaths.add(a.aliasPath);
      for (const a of discovery.brokenAliases) liveAliasPaths.add(a.aliasPath);
      // R157 (STATE-R157-01): catch commit failure — deletion-only path.
      // R158 (OUTCOME-R158-01): carry structured failure info for diagnosis.
      let deletionPubFailed = false;
      let deletionErrMsg = '';
      try {
        commitAliasStateAtomically(
          db, opts.project, effectiveRoot, totals.nodes, totals.edges,
          callSitesInitialized, existingSemanticsVersion,
          rootFingerprint, runId, contributiveAliases, liveAliasPaths,
        );
      } catch (commitError) {
        // R157: publication failure. The pre-marked stale=1 remains.
        deletionPubFailed = true;
        deletionErrMsg = `Index publication failed: ${commitError instanceof Error ? commitError.message : String(commitError)}`;
        try {
          const now = new Date().toISOString();
          db.prepare('UPDATE projects SET cross_file_calls_stale = 1, last_index_attempt_at = ?, last_index_error = ? WHERE name = ?').run(now, deletionErrMsg, opts.project);
        } catch { /* best-effort */ }
      } finally {
        try { db.close(); } catch { /* ignore close error */ }
      }
      // R157 (OUTCOME-R157-01): publication failure = FAILED, not PARTIAL.
      // R158 (OUTCOME-R158-01): add structured `failure` field with phase.
      if (deletionPubFailed) {
        return {
          dbPath,
          durationMs: Date.now() - start,
          nodes: 0, edges: 0, files: 0, skipped: files.length,
          errors: [],
          languages: allLangs, parallel: false, workerCount: 0,
          crossFileCallsStale: true,
          warnings: discoveryWarnings,
          outcome: 'FAILED',
          staleReason: { code: 'PERSIST_FAILURE', message: 'Index publication failed during deletion-only commit.', paths: [] },
          recovery: 'retry_incremental',
          failure: { code: 'PERSIST_FAILURE', message: deletionErrMsg, phase: 'deletion-only-commit' },
        };
      }
    }
    // R158 (OBS-R158-02): unified classifier for deletion-only stale path.
    // R160 (OBS-R160-01): pass brokenAliasPaths + uncertainPathsList +
    // uncertainSubtreesList so the classifier can surface affected paths
    // in staleReason.paths (was `paths: []` in R159).
    const deletionClassified = crossFileStale
      ? classifyStaleReason({
          semanticsStale,
          hasEffectiveHistoricalBrokenAliases,
          coldStartLock,
          hasUncertainty,
          existingStale,
          hasExtractionErrors: false,
          callSitesInitialized,
          brokenAliasPaths: discovery.brokenAliases.map(a => a.aliasPath),
          uncertainPathsList: discovery.uncertainPaths,
          uncertainSubtreesList: discovery.uncertainSubtrees,
        })
      : undefined;
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
      warnings: discoveryWarnings,
      outcome: computeOutcome([], crossFileStale, discoveryWarnings, false),
      // R158: classified staleReason/recovery for deletion-only stale path.
      // R160 (OBS-R160-01): use the classifier's returned paths (was `paths: []`).
      staleReason: deletionClassified
        ? { code: deletionClassified.code, message: deletionClassified.message, paths: deletionClassified.paths }
        : undefined,
      recovery: deletionClassified?.recovery,
    };
  }

  // R157: The premark stale was already done above (before clearProjectData).
  // No need to re-mark here.

  // R159 (RES-R159-01): Outer try/catch/finally around the ENTIRE main path.
  // The inner try/catch around `commitAliasStateAtomically` (further below)
  // remains — it provides specific PERSIST_FAILURE diagnosis. The outer catch
  // is a fallback for ANY other exception during preloadGrammars,
  // extractFromFilesWasm/indexParallel, deleteTx, totals computation,
  // updateProjectStats, or the classifier. Without this outer catch, those
  // exceptions escaped without a structured `failure` field and without a
  // guaranteed `db.close()` — leaving the DB handle dangling.
  //
  // The outer `finally` is the ONLY place `db.close()` is called for the main
  // path. The inner `db.close()` calls at the crossFileStale branch and the
  // PERSIST_FAILURE finally have been removed — the outer finally handles them.
  // The no-op and deletion-only fast paths return BEFORE this try and have
  // their own db.close() in their finally blocks (untouched).
  //
  // R160 (API-R160-04): `currentPhase` tracks which phase the orchestrator is
  // in. The outer catch maps it to a failure code (EXTRACTION_CRASH for
  // preload/extraction, DB_ERROR for cleanup/totals/publish). R159 always
  // returned EXTRACTION_CRASH — too broad. A crash during cleanup/totals/
  // publish is a DB operation, not extraction. The phase is also embedded in
  // the failure.phase string (`main-path-<phase>`) for fine-grained triage.
  let currentPhase: 'preload' | 'extraction' | 'cleanup' | 'totals' | 'publish' = 'preload';
  try {
    if (!useParallel) {
      // Single-thread: main thread needs the grammars
      await preloadGrammars(allLangs);
    }
    // Parallel: workers will load grammars themselves; skip main-thread preload
    currentPhase = 'extraction';
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
      currentPhase = 'cleanup';
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

    // R160 (API-R160-04): enter totals phase. The totals query is a DB read;
    // a crash here is DB_ERROR, not EXTRACTION_CRASH.
    currentPhase = 'totals';
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
    // R156 (TX-R156-01): crossFileStale is now `let` — the catch block can
    // override it to true if the final commit fails.
    let crossFileStale = opts.incremental
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
    // R155 (TX-R155-01): Atomic alias state commit. On SUCCESS, combine
    // alias_history persist + project stats in ONE transaction. If persist
    // fails, the ENTIRE transaction rolls back — graph stays stale,
    // history_initialized stays 0, last_successful_index_at NOT advanced.
    // This closes the R154 TX-R155-01 gap where the graph was marked fresh
    // BEFORE alias_history persist, and a persist failure left the graph
    // fresh + initialized=1 but history empty/stale.
    // On STALE/FAILED, use updateProjectStats alone (no alias_history changes).
    // R160 (API-R160-04): enter publish phase. Both updateProjectStats and
    // commitAliasStateAtomically do DB writes; a crash here is DB_ERROR.
    currentPhase = 'publish';
    if (crossFileStale) {
      updateProjectStats(db, opts.project, effectiveRoot, totals.nodes, totals.edges, crossFileStale, callSitesInitialized, semanticsVersion, indexError);
      // R159 (RES-R159-01): removed db.close() — outer finally handles it.
    } else {
      const liveAliasPaths = new Set<string>();
      for (const a of contributiveAliases) liveAliasPaths.add(a.aliasPath);
      for (const a of discovery.brokenAliases) liveAliasPaths.add(a.aliasPath);
      try {
        commitAliasStateAtomically(
          db, opts.project, effectiveRoot, totals.nodes, totals.edges,
          callSitesInitialized, semanticsVersion,
          rootFingerprint, runId, contributiveAliases, liveAliasPaths,
        );
      } catch (commitError) {
        // R157 (TX-R156-01 + OUTCOME-R157-01): The atomic commit failed. The
        // graph has already been mutated. The pre-marked stale=1 is still in
        // the DB. R156 pushed the error to result.errors and let computeOutcome
        // return PARTIAL — which --allow-partial could mask as exit 0. R157
        // returns FAILED with PERSIST_FAILURE instead. Publication failure must
        // NEVER be masked.
        // R158 (OUTCOME-R158-01): add structured `failure` field with phase.
        // R159 (RES-R159-01): removed the inner `finally { db.close() }` —
        // the outer finally handles db.close(). This avoids double-close when
        // the PERSIST_FAILURE return path is taken.
        const errMsg = `Index publication failed: ${commitError instanceof Error ? commitError.message : String(commitError)}`;
        try {
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE projects SET
              cross_file_calls_stale = 1,
              last_index_attempt_at = ?,
              last_index_error = ?
            WHERE name = ?
          `).run(now, errMsg, opts.project);
        } catch {
          // Best-effort — if even this fails, the pre-marked stale=1 remains.
        }
        crossFileStale = true;
        // R157: return FAILED immediately — don't fall through to computeOutcome.
        return {
          ...result,
          dbPath,
          durationMs: Date.now() - start,
          languages: result.languages ?? allLangs,
          parallel: useParallel,
          workerCount: useParallel ? numWorkers : 0,
          crossFileCallsStale: true,
          warnings: discoveryWarnings,
          outcome: 'FAILED',
          staleReason: { code: 'PERSIST_FAILURE', message: errMsg, paths: [] },
          recovery: 'retry_incremental',
          failure: { code: 'PERSIST_FAILURE', message: errMsg, phase: 'main-commit' },
        };
      }
    }

    // R158 (OBS-R158-03): Unified classifier for main path. Replaces the
    // hand-rolled staleCode builder. The classifier returns the canonical
    // {code, message, recovery, paths} tuple or undefined (e.g., for extraction
    // errors, where the failure is per-file in `errors[]` not a staleReason).
    // R160 (OBS-R160-01): pass brokenAliasPaths + uncertainPathsList +
    // uncertainSubtreesList so the classifier can surface affected paths
    // in staleReason.paths (was `paths: []` in R159).
    const mainClassified = crossFileStale
      ? classifyStaleReason({
          semanticsStale,
          hasEffectiveHistoricalBrokenAliases,
          coldStartLock,
          hasUncertainty,
          existingStale,
          hasExtractionErrors: Boolean(fullModeHadErrors || incrementalHadErrors),
          callSitesInitialized,
          brokenAliasPaths: discovery.brokenAliases.map(a => a.aliasPath),
          uncertainPathsList: discovery.uncertainPaths,
          uncertainSubtreesList: discovery.uncertainSubtrees,
        })
      : undefined;

    return {
      ...result,
      dbPath,
      durationMs: Date.now() - start,
      languages: result.languages ?? allLangs,
      parallel: useParallel,
      workerCount: useParallel ? numWorkers : 0,
      crossFileCallsStale: crossFileStale,
      warnings: discoveryWarnings,
      outcome: computeOutcome(result.errors, crossFileStale, discoveryWarnings, false),
      // R159 (OUTCOME-R159-02): When the classifier returns undefined (e.g.,
      // extraction errors), DON'T fall back to PREVIOUSLY_STALE with the
      // indexError message. R158's fallback mislabeled extraction errors as
      // PREVIOUSLY_STALE, which recommends full_reindex — wrong when the
      // cause is per-file extraction errors (the right recovery is
      // retry_incremental). Now: if classifier returned undefined, staleReason
      // is undefined. The per-file errors are in result.errors[]; outcome is
      // PARTIAL/FAILED based on errors.length. Recovery falls back to
      // 'retry_incremental' when crossFileStale && !mainClassified.
      // R160 (OBS-R160-01): use the classifier's returned paths (was `paths: []`).
      staleReason: mainClassified
        ? { code: mainClassified.code, message: mainClassified.message, paths: mainClassified.paths }
        : undefined,
      recovery: mainClassified?.recovery ?? (crossFileStale
        ? 'retry_incremental'
        : undefined),
    };
  } catch (error) {
    // R159 (RES-R159-01): outer catch — best-effort persist stale + error.
    // The premark at line ~857 already set cross_file_calls_stale=1 with
    // last_index_error='Index publication in progress'. Now overwrite with
    // the real error message so Graph Status shows the actual failure.
    // R160 (API-R160-04): map the currentPhase to a specific failure code.
    // R159 always returned EXTRACTION_CRASH — too broad. A crash during
    // cleanup/totals/publish is a DB operation, not extraction. R160 splits:
    //   - preload/extraction → EXTRACTION_CRASH
    //   - cleanup/totals/publish → DB_ERROR
    // R160 (OUTCOME-R160-01): recovery is full_reindex in full mode (the
    // graph may be partially mutated; a full reindex is the safe recovery),
    // retry_incremental in incremental mode (the existing graph is preserved;
    // retrying the incremental may succeed).
    let failCode: 'EXTRACTION_CRASH' | 'DB_ERROR' | 'RESOLVER_ERROR' = 'EXTRACTION_CRASH';
    if (currentPhase === 'cleanup' || currentPhase === 'totals' || currentPhase === 'publish') {
      failCode = 'DB_ERROR';
    }
    const errMsg = `Index failed during ${currentPhase}: ${error instanceof Error ? error.message : String(error)}`;
    try {
      const now = new Date().toISOString();
      db.prepare('UPDATE projects SET cross_file_calls_stale = 1, last_index_attempt_at = ?, last_index_error = ? WHERE name = ?').run(now, errMsg, opts.project);
    } catch { /* best-effort — DB may be locked or closed */ }
    return {
      dbPath,
      durationMs: Date.now() - start,
      nodes: 0,
      edges: 0,
      files: 0,
      skipped: 0,
      errors: [],
      languages: new Set(),
      parallel: false,
      workerCount: 0,
      crossFileCallsStale: true,
      outcome: 'FAILED',
      // R159 (API-R159-01 + RES-R159-01): structured failure with EXTRACTION_CRASH.
      // R160 (API-R160-04): now phase-tracked — EXTRACTION_CRASH for
      // preload/extraction, DB_ERROR for cleanup/totals/publish.
      // R160 (OUTCOME-R160-01): recovery is full_reindex in full mode,
      // retry_incremental in incremental mode.
      failure: { code: failCode, message: errMsg, phase: `main-path-${currentPhase}` },
      recovery: opts.incremental ? 'retry_incremental' : 'full_reindex',
    };
  } finally {
    // R159 (RES-R159-01): guaranteed DB close. This is the ONLY db.close()
    // for the main path — the inner db.close() calls have been removed.
    // The no-op and deletion-only fast paths have their own db.close() in
    // their finally blocks (they return BEFORE this try).
    try { db.close(); } catch { /* ignore close error */ }
  }
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
