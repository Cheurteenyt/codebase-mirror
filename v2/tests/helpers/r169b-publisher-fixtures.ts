/**
 * R169B-STEP2: Test-only fixtures for the publisher / CAS / GC tests.
 *
 * These helpers create REAL SQLite DBs (via better-sqlite3 +
 * initIndexerSchema) with valid project state so the publisher's
 * validation pipeline can be exercised end-to-end without mocks.
 *
 * The fixtures live in the tests/ directory (excluded from the
 * package build) so they can import from src/ and use better-sqlite3
 * directly without polluting the public API surface.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initIndexerSchema,
  updateProjectStats,
  computeRootFingerprint,
} from "../../src/indexer/schema.js";
import {
  cbmCacheDir,
  generationStoreRoot,
  projectStoreDir,
  generationsDir,
  tmpDir,
} from "../../src/storage/generation-paths.js";

// ─── Constants ───────────────────────────────────────────────────────────

export const FIXTURE_ROOT_FINGERPRINT = "/canonical/root:123:456";
export const FIXTURE_PROJECT_NAME = "r169b-test-project";

// ─── Cache-root helper ───────────────────────────────────────────────────

/**
 * Create a fresh cache root under the OS tmpdir, with the cbm +
 * projects + projectStore layout pre-created at mode 0700 so the
 * R169A trust-root permission check passes.
 *
 * Returns the absolute cacheRoot path.
 */
export function freshCacheRoot(prefix: string = "r169b-test-"): string {
  const cacheRoot = mkdtempSync(join(tmpdir(), prefix));
  // Force mode 0700 on the cacheRoot (mkdtemp uses 0700 already, but
  // be explicit).
  try { chmodSync(cacheRoot, 0o700); } catch { /* best effort */ }
  // Pre-create cbm + projects + projectStore at 0700 so the publisher's
  // trust-root check passes.
  for (const dir of [
    cbmCacheDir(cacheRoot),
    generationStoreRoot(cacheRoot),
    projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
    generationsDir(FIXTURE_PROJECT_NAME, cacheRoot),
    tmpDir(FIXTURE_PROJECT_NAME, cacheRoot),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    }
  }
  return cacheRoot;
}

// ─── Staging-DB builder ──────────────────────────────────────────────────

/**
 * Options for `createValidStagingDb`.
 */
export interface CreateStagingDbOptions {
  /** Number of nodes / edges / file_hashes to insert (default 3). */
  readonly counts?: {
    readonly nodes?: number;
    readonly edges?: number;
    readonly fileHashes?: number;
  };
  /** Root fingerprint to write into the projects table. */
  readonly rootFingerprint?: string;
  /** Project name (defaults to FIXTURE_PROJECT_NAME). */
  readonly project?: string;
  /** Root path (defaults to a synthetic value). */
  readonly rootPath?: string;
  /** If true, leave cross_file_calls_stale=1 (causes STAGING_DB_STATE_INVALID). */
  readonly stale?: boolean;
  /** If true, leave last_index_error non-null (causes STAGING_DB_STATE_INVALID). */
  readonly withLastError?: string;
  /** If true, leave last_successful_index_at NULL (causes STAGING_DB_STATE_INVALID). */
  readonly noSuccessfulIndex?: boolean;
  /** If true, set extractor_semantics_version=7 (causes STAGING_DB_STATE_INVALID). */
  readonly wrongSemantics?: number;
  /** If true, set discovery_policy_version=1 (causes STAGING_DB_STATE_INVALID). */
  readonly wrongDiscovery?: number;
  /** If true, insert a second project row (causes STAGING_DB_PROJECT_MISMATCH). */
  readonly secondProjectRow?: string;
  /** If true, insert a dangling edge (causes STAGING_DB_STATE_INVALID). */
  readonly danglingEdge?: boolean;
  /** If true, drop the alias_history table (causes STAGING_DB_SCHEMA_INVALID). */
  readonly dropAliasHistory?: boolean;
  /** If true, drop the imports table (causes STAGING_DB_SCHEMA_INVALID). */
  readonly dropImports?: boolean;
  /** If provided, override node_count/edge_count in projects to mismatch (causes STAGING_DB_STATE_INVALID). */
  readonly mismatchedCounts?: { nodeCount?: number; edgeCount?: number };
  /** If true, do NOT set the root_fingerprint (causes STAGING_DB_STATE_INVALID). */
  readonly nullRootFingerprint?: boolean;
  /** If true, do NOT run wal_checkpoint — leave WAL dirty (causes STAGING_DB_WAL_DIRTY after our close). */
  readonly leaveWalDirty?: boolean;
}

/**
 * Create a valid staging DB at the given path with the indexer schema,
 * a projects row matching the expected state, and N nodes / edges /
 * file_hashes. Returns a function to close the DB (the caller should
 * close before invoking `prepareGenerationForPublication`).
 *
 * The DB is opened in WAL mode (matching initIndexerSchema). The
 * caller may optionally leave the WAL dirty for the negative test
 * STAGING_DB_WAL_DIRTY (but normally the publisher's own
 * wal_checkpoint + journal_mode=DELETE will clean it up).
 */
export function createValidStagingDb(
  dbPath: string,
  options: CreateStagingDbOptions = {},
): { db: DatabaseType; close: () => void } {
  const project = options.project ?? FIXTURE_PROJECT_NAME;
  const rootPath = options.rootPath ?? "/canonical/root";
  const rootFingerprint = options.rootFingerprint ?? FIXTURE_ROOT_FINGERPRINT;
  const nNodes = options.counts?.nodes ?? 3;
  const nEdges = options.counts?.edges ?? 3;
  const nFiles = options.counts?.fileHashes ?? 3;

  const db = new Database(dbPath, { fileMustExist: false });
  initIndexerSchema(db);

  // Insert N nodes.
  const insertNode = db.prepare(`
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < nNodes; i++) {
    insertNode.run(project, "function", `func${i}`, `${project}::func${i}`, `/root/file${i}.ts`, 1 + i * 10, 5 + i * 10);
  }

  // Insert N edges (referencing existing nodes — no dangling).
  const insertEdge = db.prepare(`
    INSERT INTO edges (project, source_id, target_id, type)
    VALUES (?, ?, ?, ?)
  `);
  for (let i = 0; i < nEdges; i++) {
    const sourceId = (i % nNodes) + 1;
    const targetId = ((i + 1) % nNodes) + 1;
    insertEdge.run(project, sourceId, targetId, "CALLS");
  }
  if (options.danglingEdge) {
    // Insert a dangling edge referencing a non-existent node.
    insertEdge.run(project, 99999, 1, "CALLS");
  }

  // Insert N file_hashes.
  const insertFile = db.prepare(`
    INSERT INTO file_hashes (project, file_path, content_hash, mtime, size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < nFiles; i++) {
    insertFile.run(project, `/root/file${i}.ts`, `hash${i}`, Date.now(), 100, new Date().toISOString());
  }

  // Update the projects row with the expected state.
  const effectiveNodeCount = options.mismatchedCounts?.nodeCount ?? nNodes;
  const effectiveEdgeCount = options.mismatchedCounts?.edgeCount ?? nEdges;
  updateProjectStats(
    db,
    project,
    rootPath,
    effectiveNodeCount,
    effectiveEdgeCount,
    options.stale ?? false, // crossFileCallsStale
    true, // callSitesInitialized
    options.wrongSemantics ?? 8, // extractorSemanticsVersion
    options.withLastError ?? null, // indexError
    true, // aliasHistoryInitialized
    options.wrongDiscovery ?? 2, // discoveryPolicyVersion
    options.nullRootFingerprint ? null : rootFingerprint,
  );

  // Override last_successful_index_at to NULL if requested.
  if (options.noSuccessfulIndex) {
    db.prepare("UPDATE projects SET last_successful_index_at = NULL WHERE name = ?").run(project);
  }

  // Optionally insert a second project row.
  if (options.secondProjectRow) {
    db.prepare(`
      INSERT INTO projects (name, root_path, indexed_at, node_count, edge_count, cross_file_calls_stale,
                            call_sites_initialized, extractor_semantics_version, last_index_attempt_at,
                            last_successful_index_at, last_index_error, alias_history_initialized,
                            discovery_policy_version, root_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.secondProjectRow, "/other/root", new Date().toISOString(), 0, 0, 0, 1, 8,
      new Date().toISOString(), new Date().toISOString(), null, 1, 2, "/other/root:1:2",
    );
  }

  // Optionally drop a required table.
  if (options.dropAliasHistory) {
    db.exec("DROP TABLE IF EXISTS alias_history");
  }
  if (options.dropImports) {
    db.exec("DROP TABLE IF EXISTS imports");
  }

  // If leaveWalDirty is set, write something to the WAL and do NOT
  // checkpoint. Otherwise, the publisher's own wal_checkpoint will
  // handle it.
  if (options.leaveWalDirty) {
    // Force a WAL write that is NOT checkpointed.
    db.prepare("INSERT INTO file_hashes (project, file_path, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(project, "/root/wal-test.ts", "walhash", Date.now(), 1, new Date().toISOString());
  }

  return {
    db,
    close: () => {
      try { db.close(); } catch { /* best effort */ }
    },
  };
}

// ─── Convenience: open a staging DB at the reservation's path ────────────

/**
 * Convenience: reserve a staging slot, then create a valid staging DB
 * at the reserved path. Returns the reservation (the caller passes
 * it to `prepareGenerationForPublication`).
 *
 * `overrides` let the caller customize the staging DB contents (for
 * negative tests).
 */
export function reserveAndPopulate(
  reserveFn: (project: string, options?: { cacheRoot?: string }) => { project: string; generationId: string; stagingPath: string; cacheRoot: string; createdAt: string },
  cacheRoot: string,
  overrides: CreateStagingDbOptions = {},
): { project: string; generationId: string; stagingPath: string; cacheRoot: string; createdAt: string } {
  const project = overrides.project ?? FIXTURE_PROJECT_NAME;
  const reservation = reserveFn(project, { cacheRoot });
  const { close } = createValidStagingDb(reservation.stagingPath, overrides);
  close();
  return reservation;
}

// ─── Path helpers re-exported for convenience ────────────────────────────

export {
  cbmCacheDir,
  generationStoreRoot,
  projectStoreDir,
  generationsDir,
  tmpDir,
  computeRootFingerprint,
};

// ─── Misc helpers ────────────────────────────────────────────────────────

/**
 * Write a fake file at the given path (used for negative tests where
 * a file should exist but not be a valid DB).
 */
export function writeFakeFile(path: string, contents: string = "not a DB"): void {
  writeFileSync(path, contents, "utf-8");
}
