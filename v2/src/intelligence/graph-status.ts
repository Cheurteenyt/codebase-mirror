// v2/src/intelligence/graph-status.ts
// Graph freshness detection — knows if the code graph is stale, how stale,
// and what files changed since the last index.
//
// R36: added TTL cache (30s) for getGraphStatus. This function runs
// execFileSync('git', ['log', ...]) which is expensive (50-200ms). With the cache,
// repeated calls within 30s return instantly. The cache is invalidated
// when the DB mutation notification arrives (via invalidateGraphStatusCache).

import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SwrCache } from './swr-cache.js';
import Database from 'better-sqlite3';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../indexer/schema.js';

// R37: replaced TtlCache with SwrCache (Stale-While-Revalidate).
// Fresh TTL: 30s (value is served immediately).
// Stale window: 30s (stale value served + background refresh triggered).
// Total cache lifetime: 60s.
// Adaptive TTL: entries accessed 3+ times get 60s fresh TTL; 10+ times get 120s.
// Memory budget: 2MB (graph status objects are ~500 bytes each).
const graphStatusCache = new SwrCache<string, GraphStatus>({
  ttlMs: 30000,
  staleMs: 30000,
  maxTtlMs: 120000,
  maxBytes: 2_000_000,
  maxEntries: 50,
  sizeFn: (v) => JSON.stringify(v).length,
});

/**
 * R36/R37: Invalidate the cached graph status for a specific project.
 * Call this when the code graph DB is known to have changed (e.g., after
 * a re-index or when a NotifyHub 'graph_reindexed' event arrives).
 */
export function invalidateGraphStatusCache(project: string): void {
  graphStatusCache.invalidatePrefix(`${project}:`);
}

/**
 * R36/R37: Get the cache statistics for diagnostics.
 * Now includes SWR-specific stats: freshHits, staleHits, backgroundRefreshes.
 */
export function getGraphStatusCacheStats() {
  return graphStatusCache.getStats();
}

// File extensions that are NOT code (excluded from stale file detection).
const NON_CODE_EXTENSIONS = new Set([
  'md', 'json', 'lock', 'yml', 'yaml', 'txt', 'gitignore', 'toml',
  'map', 'd.ts', 'license', 'env', 'dockerignore', 'editorconfig',
]);

function isCodePath(filePath: string): boolean {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) return false;
  const ext = filePath.substring(lastDot + 1).toLowerCase();
  if (ext === 'ts' && filePath.toLowerCase().endsWith('.d.ts')) return false;
  return !NON_CODE_EXTENSIONS.has(ext);
}

function parsePorcelainPaths(output: string): string[] {
  const records = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    // In porcelain v1 -z, rename/copy records carry the second path in the
    // next NUL-delimited field. Include both sides so an indexed old path is
    // not missed when the new path is untracked by the graph.
    if (status.includes('R') || status.includes('C')) {
      const secondPath = records[index + 1];
      if (secondPath) paths.push(secondPath);
      index += 1;
    }
  }
  return paths;
}

export interface GraphStatus {
  available: boolean;
  last_indexed: string | null;
  age_seconds: number | null;
  stale: boolean;
  stale_reason: string | null;
  stale_files_count: number;
  stale_files_sample: string[];
  total_nodes: number;
  total_edges: number;
  nodes_by_label: Record<string, number>;
  recommendation: string;
  /**
   * R143 (STATE-R143-02): Persistent index state read from the DB.
   * Dominates the age/git heuristics — if `db_stale=true` or
   * `semantics_version != CURRENT`, the graph is untrustworthy regardless
   * of how recent the DB file is.
   */
  db_stale: boolean | null;
  db_semantics_version: number | null;
  db_semantics_current: boolean | null;
  /**
   * R145 (OBS-R145-01): The last index error message (from
   * `last_index_error` in the projects table). NULL if the last index
   * succeeded or if the column doesn't exist (legacy DB). Exposed so
   * UI/MCP can show WHY the graph is stale, not just that it is.
   */
  last_index_error: string | null;
}

export function getGraphStatus(
  project: string,
  codeReader: CodeGraphReader | undefined,
  projectRoot: string
): GraphStatus {
  // R36: check cache first. The cache key includes projectRoot because
  // the same project name could be used from different working directories
  // (unlikely but correct).
  //
  // R144 (STATE-R144-01): The cache key included the DB file's mtimeNs.
  // R145 (STATE-R145-01): WAL coherence fix. SQLite is in WAL mode
  // (schema.ts PRAGMA journal_mode = WAL). In WAL mode, commits write to
  // `.db-wal`, and the main `.db` file mtime may NOT change until
  // checkpoint. With a reader (CodeGraphReader) open, checkpoint can't
  // complete, so the `.db` mtime stays the same → cache key stays the
  // same → stale FRESH is served. R144's test closed the reader before
  // the write, allowing checkpoint, so it didn't reproduce the bug.
  //
  // R145 fix: include the mtimeNs of `.db`, `.db-wal`, AND `.db-shm` in
  // the cache key. In WAL mode, `.db-wal` changes on every commit even
  // when `.db` doesn't. This ensures cross-process coherence without
  // requiring inter-process notifications or PRAGMA data_version (which
  // would require a persistent connection).
  const dbPath = defaultCodeDbPath(project);
  let dbMtimeNs = 'none';
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const parts: string[] = [];
  for (const p of [dbPath, walPath, shmPath]) {
    if (existsSync(p)) {
      try {
        const st = statSync(p, { bigint: true });
        parts.push(`${st.mtimeNs}:${st.size}`);
      } catch {
        parts.push('err');
      }
    } else {
      parts.push('none');
    }
  }
  dbMtimeNs = parts.join('|');
  const cacheKey = `${project}:${projectRoot}:${dbMtimeNs}`;
  return graphStatusCache.getOrCompute(cacheKey, () => {
    return computeGraphStatus(project, codeReader, projectRoot);
  });
}

/**
 * R36: the actual computation, extracted from getGraphStatus for caching.
 */
function computeGraphStatus(
  project: string,
  codeReader: CodeGraphReader | undefined,
  projectRoot: string
): GraphStatus {
  const status: GraphStatus = {
    available: false,
    last_indexed: null,
    age_seconds: null,
    stale: false,
    stale_reason: null,
    stale_files_count: 0,
    stale_files_sample: [],
    total_nodes: 0,
    total_edges: 0,
    nodes_by_label: {},
    recommendation: '',
    db_stale: null,
    db_semantics_version: null,
    db_semantics_current: null,
    last_index_error: null,
  };

  if (!codeReader) {
    status.recommendation = 'Code graph not available. Run "cbm-v2 index --project <name> --root <path>" to build it.';
    return status;
  }

  status.available = true;

  // Use the SAME path construction as CodeGraphReader to avoid divergence.
  const dbPath = defaultCodeDbPath(project);
  let dbMtime: Date | null = null;
  if (existsSync(dbPath)) {
    const stat = statSync(dbPath);
    dbMtime = stat.mtime;
    // R144 (STATE-R144-03): Don't use dbMtime for last_indexed — it's
    // updated by ANY write (including stale=1 on failure), which made
    // Graph Status show "last_indexed: now" after a failed index. The
    // correct value (last_successful_index_at) is read from the DB below.
  }

  // R143 (STATE-R143-02) / R144 (STATE-R144-03): Read persistent index
  // state from the DB. This dominates the age/git heuristics — a DB with
  // cross_file_calls_stale=1 is untrustworthy regardless of how recent the
  // file is. A DB with a non-current extractor_semantics_version was
  // produced by a previous extractor and may have stale edges.
  //
  // R144 (STATE-R144-03): Also read last_successful_index_at (the correct
  // "last indexed" value — NOT dbMtime, which is updated by any write
  // including failed index attempts). Falls back to indexed_at if the
  // column doesn't exist (legacy DB).
  //
  // We open the DB read-only (better-sqlite3 readonly mode) to avoid
  // creating it if missing. If the DB doesn't exist or the projects row
  // is absent, the fields stay null (treated as "unknown — not authoritative").
  if (existsSync(dbPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      // R145 (STATE-R145-02): Progressive column detection. R144 queried
      // last_successful_index_at + last_index_error in a single SELECT. On
      // a real R143 DB (without these columns), the entire query failed,
      // and the catch left db_stale=null → Graph Status could show FRESH
      // for a v7 DB. Now we query the legacy columns (stale, version) FIRST
      // — these exist on all DBs since R101/R126. Then we detect the new
      // columns via PRAGMA table_info and enrich if available.
      const row = db.prepare(
        'SELECT cross_file_calls_stale AS stale, extractor_semantics_version AS version FROM projects WHERE name = ?'
      ).get(project) as { stale?: number; version?: number } | undefined;
      if (row) {
        status.db_stale = row.stale === 1;
        status.db_semantics_version = row.version ?? 0;
        status.db_semantics_current = row.version === CURRENT_EXTRACTOR_SEMANTICS_VERSION;

        // R145: detect new columns and enrich if available.
        const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
        const colNames = new Set(cols.map(c => c.name));
        if (colNames.has('last_successful_index_at') && colNames.has('last_index_error')) {
          const enriched = db.prepare(
            'SELECT last_successful_index_at AS last_success, last_index_error AS last_error FROM projects WHERE name = ?'
          ).get(project) as { last_success?: string | null; last_error?: string | null } | undefined;
          if (enriched) {
            // R144 (STATE-R144-03): use last_successful_index_at for last_indexed.
            const lastSuccess = enriched.last_success ?? null;
            if (lastSuccess) {
              status.last_indexed = lastSuccess;
              const lastSuccessDate = new Date(lastSuccess);
              status.age_seconds = Math.floor((Date.now() - lastSuccessDate.getTime()) / 1000);
            } else if (dbMtime) {
              status.last_indexed = dbMtime.toISOString();
              status.age_seconds = Math.floor((Date.now() - dbMtime.getTime()) / 1000);
            }
            // R145 (OBS-R145-01): expose last_index_error in GraphStatus.
            if (enriched.last_error) {
              status.last_index_error = enriched.last_error;
            }
          }
        } else if (dbMtime) {
          // Legacy DB (pre-R144) without new columns — fall back to dbMtime.
          status.last_indexed = dbMtime.toISOString();
          status.age_seconds = Math.floor((Date.now() - dbMtime.getTime()) / 1000);
        }
      }
    } catch {
      // DB is corrupt or locked — leave fields null.
    } finally {
      if (db !== null) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }

  // Graph stats.
  try {
    status.total_nodes = codeReader.countNodes(project);
    status.total_edges = codeReader.countEdges(project);
    status.nodes_by_label = codeReader.countNodesByLabel(project);
  } catch {
    // ignore — graph may be empty or corrupt
  }

  // Detect stale files via git (uses Unix timestamp for cross-platform compat).
  // R145 (TIME-R145-01): Use last_successful_index_at (if available) instead
  // of dbMtime for the Git --since timestamp. R144 used dbMtime, which is
  // updated by ANY DB write (including failed index attempts that set
  // stale=1). After a failed index, the DB mtime advances to "now", so Git
  // --since=@now would miss files modified between the last SUCCESSFUL index
  // and the failed attempt. Using last_successful_index_at ensures we
  // detect ALL files modified since the last time the graph was actually
  // trustworthy.
  const gitSinceDate = status.last_indexed ? new Date(status.last_indexed) : dbMtime;
  let gitFreshnessCheckFailed = false;
  if (gitSinceDate && existsSync(join(projectRoot, '.git'))) {
    try {
      const unixTs = Math.floor(gitSinceDate.getTime() / 1000);
      const gitResult = execFileSync(
        'git',
        [
          'log',
          '--name-only',
          '--pretty=format:',
          `--since=@${unixTs}`,
          '--diff-filter=ACDMRTUXB',
        ],
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024,
          shell: false,
        }
      );

      // `git log` cannot see working-tree changes. Read porcelain status too,
      // then only flag existing dirty/untracked files whose mtime is newer
      // than the successful index. A deleted/renamed-away path is stale only
      // when that exact file still exists in the graph.
      const worktreeResult = execFileSync(
        'git',
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024,
          shell: false,
        },
      );
      const dirtyAfterIndex = parsePorcelainPaths(worktreeResult).filter((filePath) => {
        const absolutePath = join(projectRoot, filePath);
        if (existsSync(absolutePath)) {
          return statSync(absolutePath).mtimeMs > gitSinceDate.getTime();
        }
        return codeReader.findNodesByFilePath(project, filePath, 50)
          .some((node) => node.file_path.replace(/\\/gu, '/') === filePath.replace(/\\/gu, '/'));
      });
      const changedFiles = [...new Set([
        ...gitResult.split(/\r?\n/).filter((filePath) => filePath.length > 0),
        ...dirtyAfterIndex,
      ])];
      const codeFiles = changedFiles.filter(isCodePath).sort();
      status.stale_files_count = codeFiles.length;
      status.stale_files_sample = codeFiles.slice(0, 10);
    } catch {
      // Fail closed: an unavailable, timed-out, or oversized Git query means
      // we cannot prove that the graph matches the working tree. Never turn
      // that uncertainty into a misleading FRESH status.
      gitFreshnessCheckFailed = true;
    }
  }

  // R143 (STATE-R143-02): DB persistent state DOMINATES the age/git
  // heuristics. If the indexer marked the project stale (root failure,
  // partial discovery, semantic mismatch), the graph is untrustworthy
  // even if the DB file is recent and git shows no changes.
  if (status.db_stale === true) {
    status.stale = true;
    status.stale_reason = 'Indexer marked this project as stale (discovery error or semantic mismatch)';
  } else if (status.db_semantics_current === false) {
    // R143: semantics version mismatch — the graph was produced by a
    // previous extractor version and may have stale/incorrect edges.
    status.stale = true;
    status.stale_reason = `Extractor semantics version ${status.db_semantics_version} ≠ current ${CURRENT_EXTRACTOR_SEMANTICS_VERSION} — full reindex required`;
  } else if (status.stale_files_count > 0) {
    status.stale = true;
    status.stale_reason = `${status.stale_files_count} source file(s) modified since last index`;
  } else if (gitFreshnessCheckFailed) {
    status.stale = true;
    status.stale_reason = 'Unable to verify source changes since last index (Git history query failed)';
  } else if (status.age_seconds !== null && status.age_seconds > 3600) {
    status.stale = true;
    status.stale_reason = `Code graph is ${Math.floor(status.age_seconds / 3600)}h old`;
  }

  // Recommendation.
  if (status.stale) {
    status.recommendation = `STALE: ${status.stale_reason}. Run "cbm-v2 index" to refresh.`;
  } else if (status.total_nodes === 0) {
    status.recommendation = 'Code graph is empty. Run "cbm-v2 index".';
  } else {
    status.recommendation = 'FRESH';
  }

  return status;
}

export function getFreshnessScore(status: GraphStatus): number {
  // R143 (STATE-R143-02): DB stale/semantics mismatch → score 0.0 (critical).
  if (status.db_stale === true || status.db_semantics_current === false) return 0.0;
  if (!status.available || status.total_nodes === 0) return 0.0;
  if (status.stale_files_count > 50) return 0.2;
  if (status.stale_files_count > 10) return 0.4;
  if (status.stale_files_count > 0) return 0.6;
  if (status.age_seconds !== null && status.age_seconds > 86400) return 0.5;
  if (status.age_seconds !== null && status.age_seconds > 3600) return 0.8;
  return 1.0;
}

export function freshnessLabel(score: number): string {
  if (score >= 0.9) return 'FRESH';
  if (score >= 0.7) return 'RECENT';
  if (score >= 0.5) return 'STALE';
  if (score >= 0.3) return 'OLD';
  return 'CRITICAL';
}
