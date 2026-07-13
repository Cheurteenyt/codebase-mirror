/**
 * R169B-STEP2 — Durable Generation Publisher (public API).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This module is the public API for the R169B generation publisher. It
 * composes the R169A generation-store foundation (paths, validators,
 * atomic writers, layout durability) with the R169B CAS store
 * (publication-cas.sqlite) to provide a four-stage pipeline:
 *
 *   1. RESERVE  — reserveGenerationStaging(project, options?)
 *      Creates an exclusive tmp/generation-<uuid>.db file (mode 0600)
 *      for the indexer to populate.
 *
 *   2. PREPARE  — prepareGenerationForPublication(reservation, input, options?)
 *      Opens the staging DB, finalizes its WAL (checkpoint + DELETE
 *      mode + synchronous=FULL), runs integrity checks, counts
 *      nodes/edges/file_hashes from the DB, computes a streaming
 *      SHA-256, detects mutation between hash and re-stat, builds a
 *      canonical manifest from DB-derived values, and returns an
 *      opaque single-use PreparedGeneration handle.
 *
 *   3. PUBLISH  — publishPreparedGeneration(prepared, options, storeOptions?)
 *      Validates the token, opens the CAS DB, BEGIN IMMEDIATE,
 *      reconciles CAS from the active manifest, checks
 *      expectedActiveGenerationId, checks dedup, promotes the staging
 *      DB via link() (no-clobber, NOT rename), fsyncs the generations/
 *      directory, writes the metadata sidecar + active manifest
 *      atomically, re-verifies, updates the CAS catalog/history/
 *      revision, COMMITs, and returns a PublicationResult.
 *
 *   4. DISCARD  — discardPreparedGeneration(prepared, options?)
 *      Best-effort cleanup of a staging DB that will NOT be published.
 *      Only deletes if directory identity can be proven; otherwise the
 *      artifact is left in place and a STAGING_ALIAS_CLEANUP_DEFERRED
 *      warning is surfaced.
 *
 * DEPENDENCY DIRECTION (R169B-STEP2):
 *   types -> paths/validation -> internal I/O + CAS store -> public facades
 *
 *   - This module imports types from `./generation-types.js`.
 *   - This module imports path helpers from `./generation-paths.js`.
 *   - This module imports validators / trust-root checks from
 *     `./generation-validation.js`.
 *   - This module imports the internal I/O harness (PROD_OPS,
 *     writeJsonAtomically, ensureGenerationStoreLayoutDurableInternal,
 *     openDirectoryNoFollow, prepareGenerationManifestForWrite) from
 *     `./internal/generation-store-io.js`.
 *   - This module imports the CAS store (openCasStore, CAS_DB_FILENAME)
 *     from `./internal/generation-cas-store.js`.
 *   - This module imports `better-sqlite3`, `node:fs`, `node:path`,
 *     `node:crypto`.
 *   - This module does NOT import from the GC module (the GC imports
 *     from this module's CAS dependency, not from the publisher).
 *
 * SECURITY / DURABILITY CONTRACTS (§7-15):
 *   - link() is used for promotion, NOT rename(). link() fails with
 *     EEXIST if the target already exists (no-clobber on POSIX).
 *   - The SHA-256 is computed in streaming 64 KiB chunks (NOT
 *     readFileSync) so the publisher can handle large DBs without
 *     buffering them into memory.
 *   - A re-stat after the hash verifies dev/ino/size unchanged —
 *     detects a TOCTOU swap of the staging file mid-hash.
 *   - The PreparedGeneration handle is opaque, single-use, and
 *     forge-resistant: the token is held in a private module-scope
 *     WeakMap keyed by the actual object reference. A spread, JSON
 *     clone, or cast from an arbitrary object produces a NEW reference
 *     that is NOT in the WeakMap → PUBLICATION_TOKEN_INVALID.
 *   - The CAS uses BEGIN IMMEDIATE to serialize concurrent
 *     publications.
 *   - The metadata sidecar + active manifest are written via the
 *     R169A atomic writer (temp-rename-fsync, O_NOFOLLOW, dir-fsync).
 *
 * R169B remains FOUNDATION / INACTIVE: no production code calls these
 * functions yet — the indexer still writes to the legacy DB path.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  unlinkSync,
  linkSync,
  existsSync,
  readSync,
  constants as fsConstants,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import {
  randomUUID,
  createHash,
} from "node:crypto";

import {
  GenerationStoreError,
  type GenerationStoreWarning,
  type GenerationManifestV1,
  type GenerationStagingReservation,
  type PreparedGeneration,
  type PreparedGenerationInput,
  type PublicationResult,
  type DiscardResult,
  type PublishPreparedGenerationOptions,
  type CasGenerationCatalogEntry,
} from "./generation-types.js";
import {
  getCacheRoot,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  GENERATIONS_SUBDIR,
  type GenerationStoreOptions,
} from "./generation-paths.js";
import {
  assertTrustedRootNoSymlinks,
  assertPathInsideNoSymlinks,
  validateGenerationManifest,
  parseGenerationManifest,
} from "./generation-validation.js";
import {
  PROD_OPS,
  writeJsonAtomically,
  ensureGenerationStoreLayoutDurableInternal,
  openDirectoryNoFollow,
  prepareGenerationManifestForWrite,
} from "./internal/generation-store-io.js";
import { openCasStore } from "./internal/generation-cas-store.js";

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * R169B-STEP2: Required tables in the staging DB. The publisher
 * verifies all of these exist before computing the hash. The set
 * mirrors the indexer's `initIndexerSchema` (v2/src/indexer/schema.ts).
 */
const REQUIRED_TABLES = [
  "nodes",
  "edges",
  "file_hashes",
  "projects",
  "call_sites",
  "imports",
  "exports",
  "alias_history",
] as const;

/**
 * R169B-STEP2: SHA-256 streaming chunk size (64 KiB). Large enough to
 * amortize the read syscall overhead, small enough to keep memory
 * pressure low even on multi-GB DBs.
 */
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * R169B-STEP2: Canonical metadata sidecar filename template
 * (`generation-<uuid>.json`). Lives in the `generations/` directory
 * alongside the DB. Immutable after publication.
 */
function metadataSidecarPath(projectStore: string, generationId: string): string {
  return join(projectStore, GENERATIONS_SUBDIR, `generation-${generationId}.json`);
}

/**
 * R169B-STEP2: Canonical final DB path
 * (`<projectStore>/generations/generation-<uuid>.db`).
 */
function finalDbPath(projectStore: string, generationId: string): string {
  return join(projectStore, GENERATIONS_SUBDIR, `generation-${generationId}.db`);
}

// ─── PreparedGeneration token (forge-resistant) ──────────────────────────

/**
 * R169B-STEP2: The private token held in the module-scope WeakMap.
 *
 * `consumed` is set to true by `publishPreparedGeneration` (or
 * `discardPreparedGeneration`) so a second call raises
 * `PUBLICATION_TOKEN_CONSUMED`.
 *
 * `preStat` records the staging file's dev/ino/size at prepare time
 * so `discardPreparedGeneration` can verify directory identity before
 * unlinking (defense against a TOCTOU swap of the staging file between
 * prepare and discard).
 */
interface PreparedToken {
  consumed: boolean;
  preStat: { dev: number; ino: number; size: number };
}

/**
 * R169B-STEP2: The private WeakMap that holds the PreparedGeneration
 * tokens. Keyed by the ACTUAL object reference returned by
 * `prepareGenerationForPublication`. A spread / JSON clone / cast
 * produces a different reference and is therefore NOT in the WeakMap —
 * `publishPreparedGeneration` raises `PUBLICATION_TOKEN_INVALID`.
 *
 * The WeakMap is module-scope and not exported. A consumer cannot
 * reach into it to forge a token.
 */
const preparedTokens: WeakMap<PreparedGeneration, PreparedToken> = new WeakMap();

/**
 * R169B-STEP2: Internal PreparedGeneration shape (mutable, before
 * freezing). The publisher creates this object, freezes it, and
 * registers it in `preparedTokens`.
 */
interface PreparedGenerationInternal extends PreparedGeneration {}

/**
 * R169B-STEP2: Look up the token for a PreparedGeneration. Returns
 * undefined if the handle is forged (not in the WeakMap).
 */
function peekToken(prepared: PreparedGeneration): PreparedToken | undefined {
  return preparedTokens.get(prepared);
}

// ─── RESERVE: reserveGenerationStaging ────────────────────────────────────

/**
 * R169B-STEP2 §7: Reserve a staging slot for a new generation.
 *
 * The reservation creates an EXCLUSIVE empty file at
 * `<projectStore>/tmp/generation-<uuid>.db` (mode 0600). The indexer
 * opens this file with better-sqlite3, initializes its schema, and
 * writes graph data into it. After populating the DB, the indexer
 * invokes `prepareGenerationForPublication` to validate, finalize,
 * and hash it.
 *
 * The reservation is NOT a publication act:
 *   - No manifest is written.
 *   - No CAS state is mutated.
 *   - The active generation is unchanged.
 *   - The staging DB is invisible to readers (it lives in tmp/).
 *
 * The reservation:
 *   - Generates a fresh UUID v4 (crypto.randomUUID).
 *   - Ensures the project store layout is durable (calls the R169A
 *     layout durability helper, which mkdir's the chain with mode
 *     0700 and fsyncs each directory).
 *   - Creates the staging file with O_CREAT|O_EXCL|O_WRONLY (mode
 *     0600) — EEXIST is treated as a Staging-create conflict
 *     (extremely unlikely with UUID v4, but possible if an attacker
 *     can predict the UUID; the EXCL guard closes that).
 *   - Validates the staging file is a regular file, not a symlink,
 *     and fsyncs it before returning.
 *   - Runs the full trust-root + containment validation chain
 *     (assertTrustedRootNoSymlinks + assertPathInsideNoSymlinks on
 *     the staging path).
 *
 * Throws:
 *   - STAGING_CREATE_FAILED — open(O_EXCL) failed for a reason other
 *     than EEXIST; or mkdir of the project store / tmp dir failed.
 *   - STAGING_TARGET_INVALID — the staging path escaped tmp/ or is a
 *     symlink (defense in depth; the layout helper already validates
 *     this, but the publisher re-validates after creation).
 *   - PATH_TRAVERSAL_REJECTED — the trust root or containment check
 *     failed.
 */
export function reserveGenerationStaging(
  project: string,
  options?: GenerationStoreOptions,
): GenerationStagingReservation {
  const phase = "reserveGenerationStaging";
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PROJECT_KEY_INVALID",
      phase,
      String(project),
      "project must be a non-empty string",
    );
  }
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();

  // 1. Validate the trust root BEFORE any filesystem mutation.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  // 2. Ensure the layout (cbm → projects → projectStore → generations,
  //    tmp) is durable. The R169A helper mkdir's each directory with
  //    mode 0700 and fsyncs it (and its parent, if newly created).
  ensureGenerationStoreLayoutDurableInternal(project, options, PROD_OPS);

  // 3. Generate a fresh UUID v4.
  const generationId = randomUUID();

  // 4. Derive the staging path: <projectStore>/tmp/generation-<uuid>.db
  const tmp = tmpDir(project, cacheRoot);
  const stagingPath = join(tmp, `generation-${generationId}.db`);

  // 5. Containment check: staging path must be inside tmp/.
  assertPathInsideNoSymlinks(
    tmp,
    stagingPath,
    project,
    phase,
    "STAGING_TARGET_INVALID",
  );

  // 6. Create the staging file exclusively (O_CREAT|O_EXCL|O_WRONLY).
  //    Mode 0600: owner read/write only.
  const O_CREAT = fsConstants.O_CREAT;
  const O_EXCL = fsConstants.O_EXCL;
  const O_WRONLY = fsConstants.O_WRONLY;
  let fd: number | null = null;
  try {
    fd = openSync(stagingPath, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "EEXIST") {
      throw new GenerationStoreError(
        "STAGING_CREATE_FAILED",
        phase,
        project,
        `Staging file already exists (UUID collision or race): ${stagingPath}`,
        generationId,
      );
    }
    throw new GenerationStoreError(
      "STAGING_CREATE_FAILED",
      phase,
      project,
      `Failed to create staging file exclusively at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }

  // 7. fsync the empty file (durability — the file's existence is now
  //    durable on disk).
  try {
    fsyncSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(stagingPath); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "STAGING_CREATE_FAILED",
      phase,
      project,
      `Failed to fsync staging file at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }

  try {
    closeSync(fd);
  } catch (e) {
    try { unlinkSync(stagingPath); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "STAGING_CREATE_FAILED",
      phase,
      project,
      `Failed to close staging file at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }
  fd = null;

  // 8. Re-stat the staging file and validate it is a regular file (not
  //    a symlink, not a directory). This is defense-in-depth — the
  //    O_EXCL guard already prevents symlink attacks (O_EXCL|O_CREAT
  //    does NOT follow symlinks), but we re-validate after creation.
  let st: Stats;
  try {
    st = lstatSync(stagingPath);
  } catch (e) {
    throw new GenerationStoreError(
      "STAGING_TARGET_INVALID",
      phase,
      project,
      `Cannot stat staging file after creation: "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }
  if (st.isSymbolicLink()) {
    throw new GenerationStoreError(
      "STAGING_TARGET_INVALID",
      phase,
      project,
      `Staging file is a symlink (rejected): ${stagingPath}`,
      generationId,
    );
  }
  if (!st.isFile()) {
    throw new GenerationStoreError(
      "STAGING_TARGET_INVALID",
      phase,
      project,
      `Staging path is not a regular file: ${stagingPath} (mode=0o${st.mode.toString(8)})`,
      generationId,
    );
  }

  return {
    project,
    generationId,
    stagingPath,
    cacheRoot,
    createdAt: new Date().toISOString(),
  };
}

// ─── PREPARE: prepareGenerationForPublication ─────────────────────────────

/**
 * R169B-STEP2 §8-11: Prepare a staging DB for publication.
 *
 * Stages:
 *   1. Open the staging DB read/write.
 *   2. PRAGMA wal_checkpoint(TRUNCATE) — flush the WAL into the main
 *      DB file and truncate the WAL to zero bytes.
 *   3. PRAGMA journal_mode = DELETE — switch from WAL to rollback
 *      journal mode (so the published DB has no -wal/-shm sidecars).
 *   4. PRAGMA synchronous = FULL — ensure the next writer's commits
 *      are durable (informational; the publisher does not write data).
 *   5. Close the connection.
 *   6. Verify no -wal / -shm / -journal sidecars exist on disk.
 *   7. Open the DB read-only.
 *   8. PRAGMA quick_check — must return "ok" (no mutation; read-only).
 *   9. PRAGMA foreign_key_check — must return zero rows.
 *  10. Validate all required tables exist.
 *  11. Validate the projects table has exactly one row matching the
 *      expected project name.
 *  12. Validate root_fingerprint (cross-check with input.rootFingerprint
 *      if provided).
 *  13. Validate extractor_semantics_version == 8.
 *  14. Validate discovery_policy_version == 2.
 *  15. Validate cross_file_calls_stale == 0.
 *  16. Validate last_index_error IS NULL.
 *  17. Validate last_successful_index_at IS NOT NULL.
 *  18. Count nodes, edges, file_hashes from the DB (NOT from the
 *      caller).
 *  19. Verify projects.node_count == COUNT(nodes), projects.edge_count
 *      == COUNT(edges).
 *  20. Check dangling edges (LEFT JOIN where source or target is
 *      NULL) — must be zero.
 *  21. Close the read-only connection.
 *  22. Compute SHA-256 in streaming 64 KiB chunks (NOT readFileSync).
 *  23. Compute sizeBytes from the post-hash stat.
 *  24. Re-stat the staging file and verify dev/ino/size unchanged
 *      from the pre-hash stat (TOCTOU swap detection).
 *  25. Build the manifest from DB-derived values (NOT caller-provided).
 *  26. Validate the manifest (validateGenerationManifest).
 *  27. Create the PreparedGeneration handle (frozen) and register the
 *      token in the module-scope WeakMap.
 *  28. Return the PreparedGeneration.
 *
 * Throws:
 *   - STAGING_DB_BUSY — the staging DB could not be opened (locked).
 *   - STAGING_DB_INTEGRITY_FAILED — PRAGMA quick_check returned
 *     anything other than "ok".
 *   - STAGING_DB_SCHEMA_INVALID — a required table is missing.
 *   - STAGING_DB_PROJECT_MISMATCH — the projects table has zero rows,
 *     more than one row, or a row whose name does not match the
 *     expected project.
 *   - STAGING_DB_STATE_INVALID — versions / cross_file_calls_stale /
 *     last_index_error / last_successful_index_at checks failed.
 *   - STAGING_DB_WAL_DIRTY — the -wal / -shm / -journal sidecar
 *     files exist after the WAL finalization (the close did not
 *     clean them up).
 *   - GENERATION_HASH_FAILED — the streaming hash could not be
 *     computed (read error).
 *   - PUBLICATION_TOKEN_INVALID — the TOCTOU re-stat detected a
 *     dev/ino/size mismatch (the staging file was swapped mid-hash).
 */
export function prepareGenerationForPublication(
  reservation: GenerationStagingReservation,
  input?: PreparedGenerationInput,
  options?: GenerationStoreOptions,
): PreparedGeneration {
  const phase = "prepareGenerationForPublication";
  const project = reservation.project;
  const generationId = reservation.generationId;
  const stagingPath = reservation.stagingPath;
  const cacheRoot = options?.cacheRoot ?? reservation.cacheRoot ?? getCacheRoot();

  // Re-validate the trust root (the reservation may have been created
  // in a different process; defense in depth).
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);
  assertPathInsideNoSymlinks(
    tmpDir(project, cacheRoot),
    stagingPath,
    project,
    phase,
    "STAGING_TARGET_INVALID",
  );

  // 1. Open the staging DB read/write to finalize the WAL.
  let db: DatabaseType;
  try {
    db = new Database(stagingPath, { fileMustExist: true });
  } catch (e) {
    throw new GenerationStoreError(
      "STAGING_DB_BUSY",
      phase,
      project,
      `Failed to open staging DB at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }

  try {
    db.pragma("busy_timeout = 5000");
    // 2. WAL checkpoint TRUNCATE — flush WAL into main DB, truncate WAL.
    try {
      const chk = db.pragma("wal_checkpoint(TRUNCATE)", { simple: true }) as
        | { log: number; checkpoint: number; busy: number }
        | number
        | unknown;
      // better-sqlite3 returns { log, checkpoint, busy } for wal_checkpoint
      // in newer versions, or a number in older. We treat any error below.
      void chk;
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `wal_checkpoint(TRUNCATE) failed: ${(e as Error).message}`,
        generationId,
      );
    }
    // 3. Switch journal_mode to DELETE (closes the WAL).
    let journalMode: string;
    try {
      journalMode = db.pragma("journal_mode = DELETE", { simple: true }) as string;
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `journal_mode = DELETE failed: ${(e as Error).message}`,
        generationId,
      );
    }
    if (String(journalMode).toLowerCase() !== "delete") {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `journal_mode = DELETE did not switch (got: ${JSON.stringify(journalMode)})`,
        generationId,
      );
    }
    // 4. PRAGMA synchronous = FULL (durability for the next writer).
    try {
      db.pragma("synchronous = FULL");
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `synchronous = FULL failed: ${(e as Error).message}`,
        generationId,
      );
    }
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }

  // 6. Verify no sidecars exist.
  const sidecars = [
    `${stagingPath}-wal`,
    `${stagingPath}-shm`,
    `${stagingPath}-journal`,
  ];
  for (const sidecar of sidecars) {
    if (existsSync(sidecar)) {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `WAL sidecar exists after journal_mode=DELETE: ${sidecar}`,
        generationId,
      );
    }
  }

  // 7-21. Open read-only and validate.
  let dbReadOnly: DatabaseType;
  try {
    dbReadOnly = new Database(stagingPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new GenerationStoreError(
      "STAGING_DB_BUSY",
      phase,
      project,
      `Failed to open staging DB read-only at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }

  let nodeCount = 0;
  let edgeCount = 0;
  let fileCount = 0;
  let rootFingerprintFromDb = "";
  let extractorSemanticsVersion = 0;
  let discoveryPolicyVersion = 0;

  try {
    dbReadOnly.pragma("busy_timeout = 5000");

    // 8. PRAGMA quick_check — must return "ok".
    let quickCheck: unknown;
    try {
      quickCheck = dbReadOnly.pragma("quick_check");
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_INTEGRITY_FAILED",
        phase,
        project,
        `PRAGMA quick_check errored: ${(e as Error).message}`,
        generationId,
      );
    }
    // quick_check returns an array of { quick_check: "ok" | "..." }.
    const quickCheckRows = quickCheck as Array<{ quick_check: string }>;
    if (
      !Array.isArray(quickCheckRows) ||
      quickCheckRows.length !== 1 ||
      quickCheckRows[0].quick_check !== "ok"
    ) {
      throw new GenerationStoreError(
        "STAGING_DB_INTEGRITY_FAILED",
        phase,
        project,
        `PRAGMA quick_check did not return "ok": ${JSON.stringify(quickCheck)}`,
        generationId,
      );
    }

    // 9. PRAGMA foreign_key_check — must return zero rows.
    let fkCheck: unknown;
    try {
      fkCheck = dbReadOnly.pragma("foreign_key_check");
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_INTEGRITY_FAILED",
        phase,
        project,
        `PRAGMA foreign_key_check errored: ${(e as Error).message}`,
        generationId,
      );
    }
    if (Array.isArray(fkCheck) && fkCheck.length > 0) {
      throw new GenerationStoreError(
        "STAGING_DB_INTEGRITY_FAILED",
        phase,
        project,
        `PRAGMA foreign_key_check returned ${fkCheck.length} violation(s): ${JSON.stringify(fkCheck)}`,
        generationId,
      );
    }

    // 10. Validate required tables exist.
    const tableRows = dbReadOnly
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableSet = new Set(tableRows.map((r) => r.name));
    for (const required of REQUIRED_TABLES) {
      if (!tableSet.has(required)) {
        throw new GenerationStoreError(
          "STAGING_DB_SCHEMA_INVALID",
          phase,
          project,
          `Required table "${required}" is missing from the staging DB`,
          generationId,
        );
      }
    }

    // 11. Validate projects table — exactly one row matching the project.
    const projectRows = dbReadOnly
      .prepare("SELECT name, root_path, node_count, edge_count, cross_file_calls_stale, extractor_semantics_version, discovery_policy_version, last_index_error, last_successful_index_at, root_fingerprint FROM projects")
      .all() as Array<{
        name: string;
        root_path: string;
        node_count: number;
        edge_count: number;
        cross_file_calls_stale: number;
        extractor_semantics_version: number;
        discovery_policy_version: number;
        last_index_error: string | null;
        last_successful_index_at: string | null;
        root_fingerprint: string | null;
      }>;
    if (projectRows.length === 0) {
      throw new GenerationStoreError(
        "STAGING_DB_PROJECT_MISMATCH",
        phase,
        project,
        `projects table is empty`,
        generationId,
      );
    }
    if (projectRows.length > 1) {
      throw new GenerationStoreError(
        "STAGING_DB_PROJECT_MISMATCH",
        phase,
        project,
        `projects table has ${projectRows.length} rows (expected 1)`,
        generationId,
      );
    }
    const projectRow = projectRows[0];
    if (projectRow.name !== project) {
      throw new GenerationStoreError(
        "STAGING_DB_PROJECT_MISMATCH",
        phase,
        project,
        `projects.name="${projectRow.name}" does not match expected project="${project}"`,
        generationId,
      );
    }

    // 12. Validate root_fingerprint (cross-check with input if provided).
    if (projectRow.root_fingerprint === null || projectRow.root_fingerprint === "") {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.root_fingerprint is NULL or empty`,
        generationId,
      );
    }
    rootFingerprintFromDb = projectRow.root_fingerprint;
    if (input?.rootFingerprint !== undefined && input.rootFingerprint !== rootFingerprintFromDb) {
      throw new GenerationStoreError(
        "STAGING_DB_PROJECT_MISMATCH",
        phase,
        project,
        `projects.root_fingerprint="${rootFingerprintFromDb}" does not match expected "${input.rootFingerprint}"`,
        generationId,
      );
    }

    // 13. Validate extractor_semantics_version == 8.
    extractorSemanticsVersion = projectRow.extractor_semantics_version;
    if (extractorSemanticsVersion !== 8) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.extractor_semantics_version=${extractorSemanticsVersion} (expected 8)`,
        generationId,
      );
    }

    // 14. Validate discovery_policy_version == 2.
    discoveryPolicyVersion = projectRow.discovery_policy_version;
    if (discoveryPolicyVersion !== 2) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.discovery_policy_version=${discoveryPolicyVersion} (expected 2)`,
        generationId,
      );
    }

    // 15. Validate cross_file_calls_stale == 0.
    if (projectRow.cross_file_calls_stale !== 0) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.cross_file_calls_stale=${projectRow.cross_file_calls_stale} (expected 0)`,
        generationId,
      );
    }

    // 16. Validate last_index_error IS NULL.
    if (projectRow.last_index_error !== null) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.last_index_error is not NULL: ${JSON.stringify(projectRow.last_index_error)}`,
        generationId,
      );
    }

    // 17. Validate last_successful_index_at IS NOT NULL.
    if (projectRow.last_successful_index_at === null) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.last_successful_index_at is NULL`,
        generationId,
      );
    }

    // 18. Count nodes, edges, file_hashes from the DB.
    const nodeRow = dbReadOnly
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?")
      .get(project) as { c: number };
    nodeCount = nodeRow.c;
    const edgeRow = dbReadOnly
      .prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ?")
      .get(project) as { c: number };
    edgeCount = edgeRow.c;
    const fileRow = dbReadOnly
      .prepare("SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?")
      .get(project) as { c: number };
    fileCount = fileRow.c;

    // 19. Verify projects.node_count == COUNT(nodes), etc.
    if (projectRow.node_count !== nodeCount) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.node_count=${projectRow.node_count} does not match COUNT(nodes)=${nodeCount}`,
        generationId,
      );
    }
    if (projectRow.edge_count !== edgeCount) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.edge_count=${projectRow.edge_count} does not match COUNT(edges)=${edgeCount}`,
        generationId,
      );
    }

    // 20. Check dangling edges (LEFT JOIN where source or target IS NULL).
    const danglingRow = dbReadOnly
      .prepare(`
        SELECT COUNT(*) AS c FROM edges e
        LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
        LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
        WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
      `)
      .get(project) as { c: number };
    if (danglingRow.c !== 0) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `Found ${danglingRow.c} dangling edges (source or target node missing)`,
        generationId,
      );
    }
  } finally {
    try { dbReadOnly.close(); } catch { /* best effort */ }
  }

  // 22-24. Streaming SHA-256 + sizeBytes + TOCTOU re-stat.
  const preStat = lstatSync(stagingPath);
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new GenerationStoreError(
      "STAGING_TARGET_INVALID",
      phase,
      project,
      `Staging file is not a regular file at hash time: ${stagingPath}`,
      generationId,
    );
  }
  const preDev = preStat.dev;
  const preIno = preStat.ino;
  const preSize = preStat.size;

  let hashFd: number | null = null;
  let sha256: string;
  try {
    hashFd = openSync(stagingPath, fsConstants.O_RDONLY);
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let totalRead = 0;
    while (true) {
      let bytesRead: number;
      try {
        bytesRead = readSync(hashFd, chunk, 0, HASH_CHUNK_BYTES, null);
      } catch (e) {
        throw new GenerationStoreError(
          "GENERATION_HASH_FAILED",
          phase,
          project,
          `readSync failed at offset ${totalRead}: ${(e as Error).message}`,
          generationId,
        );
      }
      if (bytesRead === 0) break;
      hasher.update(chunk.subarray(0, bytesRead));
      totalRead += bytesRead;
    }
    sha256 = hasher.digest("hex");
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    throw new GenerationStoreError(
      "GENERATION_HASH_FAILED",
      phase,
      project,
      `Failed to compute SHA-256: ${(e as Error).message}`,
      generationId,
    );
  } finally {
    if (hashFd !== null) {
      try { closeSync(hashFd); } catch { /* best effort */ }
    }
  }

  // Re-stat after hash, verify dev/ino/size unchanged.
  const postStat = lstatSync(stagingPath);
  if (
    postStat.dev !== preDev ||
    postStat.ino !== preIno ||
    postStat.size !== preSize
  ) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_INVALID",
      phase,
      project,
      `TOCTOU: staging file identity changed between hash start and re-stat (dev/ino/size: pre=${preDev}/${preIno}/${preSize}, post=${postStat.dev}/${postStat.ino}/${postStat.size})`,
      generationId,
    );
  }
  const sizeBytes = postStat.size;

  // 25-26. Build the manifest from DB-derived values.
  const manifestInput: GenerationManifestV1 = {
    formatVersion: 1,
    project,
    generationId,
    dbFile: `${GENERATIONS_SUBDIR}/generation-${generationId}.db`,
    createdAt: new Date().toISOString(),
    rootFingerprint: rootFingerprintFromDb,
    extractorSemanticsVersion,
    discoveryPolicyVersion,
    nodeCount,
    edgeCount,
    fileCount,
    sizeBytes,
    sha256,
  };
  // validateGenerationManifest throws on any schema error.
  const manifest = validateGenerationManifest(manifestInput, project);

  // 27. Create the PreparedGeneration handle (frozen) + register token.
  const prepared: PreparedGenerationInternal = {
    project,
    generationId,
    stagingPath,
    cacheRoot,
    manifest,
    preparedAt: new Date().toISOString(),
    warnings: [],
  };
  Object.freeze(prepared);
  Object.freeze(prepared.manifest);
  preparedTokens.set(prepared, {
    consumed: false,
    preStat: { dev: preDev, ino: preIno, size: preSize },
  });

  return prepared;
}

// ─── PUBLISH: publishPreparedGeneration ───────────────────────────────────

/**
 * R169B-STEP2 §12-15: Publish a prepared generation.
 *
 * Stages:
 *   1. Validate the PreparedGeneration token (WeakMap lookup).
 *      Throws PUBLICATION_TOKEN_INVALID if forged.
 *   2. Check consumed flag. Throws PUBLICATION_TOKEN_CONSUMED if
 *      already published/discarded.
 *   3. Mark as consumed (BEFORE any I/O — so a crash mid-publish
 *      cannot re-publish).
 *   4. Re-validate the trust root.
 *   5. Open the CAS DB. BEGIN IMMEDIATE.
 *   6. Reconcile CAS state from the active manifest.
 *   7. Compare expectedActiveGenerationId (if provided).
 *   8. Check dedup candidate. If found, this is a dedup publication.
 *   9. If NOT dedup:
 *      a. link(staging, final) — no-clobber. EEXIST →
 *         GENERATION_PROMOTION_CONFLICT.
 *      b. fsync the generations/ directory.
 *      c. Unlink the staging alias (best-effort; on failure →
 *         STAGING_ALIAS_CLEANUP_DEFERRED warning).
 *  10. Write the metadata sidecar (generation-<uuid>.json) atomically.
 *  11. Write active-generation.json atomically (canonical payload).
 *  12. Re-read and verify the active manifest + DB exists + metadata
 *      exists.
 *  13. Update CAS:
 *      a. upsertGenerationCatalog (insert or update last_seen_at).
 *      b. setActiveGenerationId(generationId).
 *      c. appendPublicationHistory(generationId, project, "PUBLISH",
 *         previousActiveId).
 *      d. incrementRevision.
 *      e. setCatalogPinned if options.pin.
 *  14. COMMIT.
 *  15. Return PublicationResult.
 *
 * Durability:
 *   - link() makes the DB file visible under the canonical path. The
 *     staging file's inode is now also reachable via the final path.
 *   - fsync(generations/) makes the new directory entry durable.
 *   - The atomic manifest writer (writeJsonAtomically) does
 *     temp-write-fsync-close-rename-dir-fsync. So the manifest
 *     publication is fully durable.
 *   - If the generations/ fsync fails AFTER the link succeeded, the
 *     link is on disk but the directory entry may not survive a
 *     crash. The publisher surfaces this as
 *     GENERATION_PROMOTION_DURABILITY_UNKNOWN (the publication
 *     continues — the manifest write will fsync the directory again
 *     and succeed; if that ALSO fails, the atomic writer raises
 *     ATOMIC_DURABILITY_UNKNOWN).
 *   - If the post-manifest CAS COMMIT fails, the CAS is out of sync
 *     with the manifest. The next publication's reconcileFromManifest
 *     will fix the active_generation_id (but the catalog entry may
 *     be missing — the next GC pass will treat the active generation
 *     as "unknown to CAS" and protect it).
 */
export function publishPreparedGeneration(
  prepared: PreparedGeneration,
  options?: PublishPreparedGenerationOptions,
  storeOptions?: GenerationStoreOptions,
): PublicationResult {
  const phase = "publishPreparedGeneration";
  const project = prepared.project;
  const generationId = prepared.generationId;
  const stagingPath = prepared.stagingPath;
  const cacheRoot = storeOptions?.cacheRoot ?? prepared.cacheRoot ?? getCacheRoot();
  const manifest = prepared.manifest;

  // 1. Validate token.
  const token = peekToken(prepared);
  if (!token) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_INVALID",
      phase,
      project,
      `PreparedGeneration handle is not registered (forged, spread, JSON-cloned, or cast from an arbitrary object)`,
      generationId,
    );
  }
  // 2. Check consumed.
  if (token.consumed) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle has already been published or discarded`,
      generationId,
    );
  }
  // 3. Mark as consumed BEFORE any I/O.
  token.consumed = true;

  // 4. Re-validate the trust root.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const finalPath = finalDbPath(projectStore, generationId);
  const metadataPath = metadataSidecarPath(projectStore, generationId);
  const manifestPath = activeManifestPath(project, cacheRoot);

  // Re-validate containment on the final DB path (it must be inside
  // generations/).
  assertPathInsideNoSymlinks(
    generations,
    finalPath,
    project,
    phase,
    "GENERATION_TARGET_SYMLINK_REJECTED",
  );
  assertPathInsideNoSymlinks(
    generations,
    metadataPath,
    project,
    phase,
    "GENERATION_TARGET_SYMLINK_REJECTED",
  );

  const warnings: GenerationStoreWarning[] = [];
  let promotionState: "PUBLISHED" | "DURABILITY_UNKNOWN" = "PUBLISHED";

  // 5. Open the CAS DB. BEGIN IMMEDIATE.
  const cas = openCasStore(project, cacheRoot);
  let casCommitted = false;
  try {
    cas.beginImmediate();

    // 6. Reconcile CAS from the active manifest.
    let activeManifest: GenerationManifestV1 | null = null;
    try {
      activeManifest = parseGenerationManifest(manifestPath, project);
    } catch (e) {
      if (e instanceof GenerationStoreError) {
        // Manifest missing or invalid → treat as no active generation.
        // (parseGenerationManifest throws MANIFEST_PARSE_ERROR on
        // ENOENT; we treat that as "no manifest".)
        if (e.code !== "MANIFEST_PARSE_ERROR") {
          // Rethrow unexpected errors (e.g. MANIFEST_SYMLINK_REJECTED).
          throw e;
        }
        activeManifest = null;
      } else {
        throw e;
      }
    }
    const reconcile = cas.reconcileFromManifest(activeManifest);
    const previousActiveId = reconcile.activeGenerationId;

    // 7. Compare expectedActiveGenerationId.
    if (options?.expectedActiveGenerationId !== undefined) {
      const expected = options.expectedActiveGenerationId;
      if (expected !== previousActiveId) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_MISMATCH",
          phase,
          project,
          `expectedActiveGenerationId=${JSON.stringify(expected)} does not match CAS active=${JSON.stringify(previousActiveId)}`,
          generationId,
        );
      }
    }

    // 8. Check dedup candidate.
    const dedup = cas.findDedupCandidate(
      manifest.sha256,
      manifest.sizeBytes,
      manifest.rootFingerprint,
      manifest.extractorSemanticsVersion,
      manifest.discoveryPolicyVersion,
    );
    const deduped = !!dedup;

    // 9. Promote the DB (link) unless deduped.
    if (!deduped) {
      // link() — no-clobber on POSIX.
      try {
        linkSync(stagingPath, finalPath);
      } catch (e) {
        const errCode = (e as NodeJS.ErrnoException).code;
        if (errCode === "EEXIST") {
          throw new GenerationStoreError(
            "GENERATION_PROMOTION_CONFLICT",
            phase,
            project,
            `link() target already exists: ${finalPath} (EEXIST — generation UUID was previously published and not GC'd)`,
            generationId,
          );
        }
        throw new GenerationStoreError(
          "GENERATION_PROMOTION_FAILED",
          phase,
          project,
          `link("${stagingPath}", "${finalPath}") failed: ${(e as Error).message}`,
          generationId,
        );
      }

      // fsync the generations/ directory.
      let dirFd: number | null = null;
      try {
        const opened = openDirectoryNoFollow(generations, PROD_OPS);
        dirFd = opened.fd;
        PROD_OPS.fsyncSync(dirFd);
        PROD_OPS.closeSync(dirFd);
        dirFd = null;
      } catch (e) {
        if (dirFd !== null) {
          try { PROD_OPS.closeSync(dirFd); } catch { /* best effort */ }
        }
        // The link succeeded but the dir fsync failed. The new
        // directory entry may not be durable. We continue with the
        // publication (the manifest writer will fsync the dir again
        // and may succeed; if THAT fails too, the atomic writer
        // raises ATOMIC_DURABILITY_UNKNOWN). Surface as a warning.
        promotionState = "DURABILITY_UNKNOWN";
        warnings.push({
          code: "ATOMIC_TEMP_ORPHANED",
          message: `fsync of generations/ directory failed after link (promotion durability unknown): ${(e as Error).message}`,
        });
      }

      // Unlink the staging alias (best-effort).
      try {
        unlinkSync(stagingPath);
      } catch (e) {
        // The staging file is still on disk under tmp/. The
        // publication succeeded (the final path is canonical), but
        // the staging alias is leftover. Surface as a warning — the
        // next GC pass will sweep it.
        warnings.push({
          code: "STAGING_ALIAS_CLEANUP_DEFERRED",
          message: `Failed to unlink staging alias "${stagingPath}" after promotion: ${(e as Error).message}`,
        });
      }
    } else {
      // Deduped: the existing generation-<dedup.generationId>.db is
      // already canonical. Unlink the staging file (best-effort).
      try {
        unlinkSync(stagingPath);
      } catch (e) {
        warnings.push({
          code: "STAGING_ALIAS_CLEANUP_DEFERRED",
          message: `Failed to unlink staging alias after dedup: ${(e as Error).message}`,
        });
      }
    }

    // 10. Write the metadata sidecar (generation-<uuid>.json).
    //     The sidecar is the immutable publication record. It contains
    //     the canonical manifest + CAS publication metadata.
    const metadataPayload = buildMetadataPayload(manifest, {
      publishedAt: new Date().toISOString(),
      deduped,
      dedupSourceGenerationId: dedup?.generationId ?? null,
      previousActiveGenerationId: previousActiveId,
      pinned: !!options?.pin,
    });
    writeMetadataSidecarAtomically(metadataPath, metadataPayload, project, phase, generationId);

    // 11. Write active-generation.json atomically (canonical payload).
    //     Uses the R169A internal writer (prepareGenerationManifestForWrite
    //     + writeJsonAtomically) so the manifest is validated and
    //     written via temp-rename-fsync with O_NOFOLLOW + dir-fsync.
    const preparedPayload = prepareGenerationManifestForWrite(manifest, project);
    // For the dedup case, the active manifest must point at the
    // DEDUP source's generation ID (not the staging UUID), because
    // the DB file is generation-<dedupSource>.db. We rewrite the
    // manifest to point at the dedup source.
    if (deduped && dedup) {
      const dedupManifest: GenerationManifestV1 = {
        ...manifest,
        generationId: dedup.generationId,
        dbFile: `${GENERATIONS_SUBDIR}/generation-${dedup.generationId}.db`,
      };
      const dedupPayload = prepareGenerationManifestForWrite(dedupManifest, project);
      writeJsonAtomically(manifestPath, dedupPayload.payload, project, phase, PROD_OPS);
    } else {
      writeJsonAtomically(manifestPath, preparedPayload.payload, project, phase, PROD_OPS);
    }

    // 12. Re-read and verify the active manifest + DB exists + metadata exists.
    let verifiedManifest: GenerationManifestV1;
    try {
      verifiedManifest = parseGenerationManifest(manifestPath, project);
    } catch (e) {
      throw new GenerationStoreError(
        "PUBLICATION_VERIFY_FAILED",
        phase,
        project,
        `Re-read of active manifest failed after publication: ${(e as Error).message}`,
        generationId,
      );
    }
    const verifiedGenerationId = deduped && dedup ? dedup.generationId : generationId;
    if (verifiedManifest.generationId !== verifiedGenerationId) {
      throw new GenerationStoreError(
        "PUBLICATION_VERIFY_FAILED",
        phase,
        project,
        `Re-read manifest generationId="${verifiedManifest.generationId}" does not match expected="${verifiedGenerationId}"`,
        generationId,
      );
    }
    const verifiedDbPath = join(projectStore, verifiedManifest.dbFile);
    if (!existsSync(verifiedDbPath)) {
      throw new GenerationStoreError(
        "PUBLICATION_VERIFY_FAILED",
        phase,
        project,
        `DB file missing after publication: ${verifiedDbPath}`,
        generationId,
      );
    }
    if (!existsSync(metadataPath)) {
      throw new GenerationStoreError(
        "PUBLICATION_VERIFY_FAILED",
        phase,
        project,
        `Metadata sidecar missing after publication: ${metadataPath}`,
        generationId,
      );
    }

    // 13. Update CAS.
    const effectiveGenerationId = verifiedGenerationId;
    const now = new Date().toISOString();
    const existingEntry = cas.getGenerationCatalogEntry(effectiveGenerationId);
    const catalogEntry: CasGenerationCatalogEntry = {
      generationId: effectiveGenerationId,
      project,
      sha256: manifest.sha256,
      sizeBytes: manifest.sizeBytes,
      rootFingerprint: manifest.rootFingerprint,
      extractorSemanticsVersion: manifest.extractorSemanticsVersion,
      discoveryPolicyVersion: manifest.discoveryPolicyVersion,
      firstPublishedAt: existingEntry?.firstPublishedAt ?? now,
      lastSeenAt: now,
      pinned: (existingEntry?.pinned ?? false) || !!options?.pin,
      status: "ACTIVE",
    };
    cas.upsertGenerationCatalog(catalogEntry);
    cas.setActiveGenerationId(effectiveGenerationId);
    cas.appendPublicationHistory(
      effectiveGenerationId,
      project,
      "PUBLISH",
      previousActiveId,
    );
    if (options?.pin) {
      cas.setCatalogPinned(effectiveGenerationId, true);
      cas.appendPublicationHistory(effectiveGenerationId, project, "PIN", null);
    }
    const newRevision = cas.incrementRevision();

    // 14. COMMIT.
    cas.commit();
    casCommitted = true;

    return {
      project,
      generationId: effectiveGenerationId,
      dbPath: verifiedDbPath,
      manifestPath,
      metadataPath,
      manifest: verifiedManifest,
      publicationState: promotionState,
      warnings,
      cas: {
        revision: newRevision,
        deduped,
        previousActiveGenerationId: previousActiveId,
      },
    };
  } catch (e) {
    // Rollback the CAS transaction if it is still open.
    if (!casCommitted) {
      try { cas.rollback(); } catch { /* best effort */ }
    }
    if (e instanceof GenerationStoreError) throw e;
    throw new GenerationStoreError(
      "PUBLICATION_VERIFY_FAILED",
      phase,
      project,
      `Publication failed: ${(e as Error).message}`,
      generationId,
    );
  } finally {
    cas.close();
  }
}

// ─── DISCARD: discardPreparedGeneration ───────────────────────────────────

/**
 * R169B-STEP2 §17: Discard a prepared generation.
 *
 * Best-effort cleanup of a staging DB that will NOT be published. The
 * discard:
 *   1. Validates the PreparedGeneration token (WeakMap lookup).
 *   2. Marks the token as consumed (single-use, even on discard).
 *   3. Stats the staging file. Compares dev/ino/size against the
 *      preStat recorded at prepare time.
 *   4. If the identity matches → safe to delete → unlink.
 *   5. If the identity does NOT match → DO NOT delete (the path may
 *      now point elsewhere) → return STAGING_ALIAS_CLEANUP_DEFERRED
 *      warning so the operator / next GC pass can clean it up.
 *
 * The discard NEVER throws on unlink failure — it surfaces the
 * failure as a warning. The caller's primary concern is "the
 * PreparedGeneration handle is now consumed"; the cleanup is
 * secondary.
 */
export function discardPreparedGeneration(
  prepared: PreparedGeneration,
  options?: GenerationStoreOptions,
): DiscardResult {
  const phase = "discardPreparedGeneration";
  const project = prepared.project;
  const generationId = prepared.generationId;
  const stagingPath = prepared.stagingPath;
  // options.cacheRoot is intentionally ignored — the discard operates
  // on the stagingPath recorded in the PreparedGeneration handle, which
  // is the path the caller must clean up. The cacheRoot option is
  // accepted for API symmetry with the other publisher functions.
  void options;

  // 1. Validate token.
  const token = peekToken(prepared);
  if (!token) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_INVALID",
      phase,
      project,
      `PreparedGeneration handle is not registered (forged)`,
      generationId,
    );
  }
  // 2. Mark as consumed.
  if (token.consumed) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle has already been published or discarded`,
      generationId,
    );
  }
  token.consumed = true;

  const warnings: GenerationStoreWarning[] = [];
  let deleted = false;

  // 3. Stat the staging file.
  let currentStat: Stats;
  try {
    currentStat = lstatSync(stagingPath);
  } catch (e) {
    // The staging file is already gone. That's fine — nothing to
    // discard. Return deleted=false (nothing was deleted by this
    // call) and a warning so the caller knows.
    warnings.push({
      code: "STAGING_ALIAS_CLEANUP_DEFERRED",
      message: `Staging file no longer exists at "${stagingPath}": ${(e as Error).message}`,
    });
    return {
      project,
      generationId,
      stagingPath,
      deleted: false,
      warnings,
    };
  }

  // 4. Compare dev/ino/size against the preStat.
  const preStat = token.preStat;
  if (
    currentStat.dev !== preStat.dev ||
    currentStat.ino !== preStat.ino ||
    currentStat.size !== preStat.size
  ) {
    // Identity mismatch — DO NOT delete. The path may now point to a
    // different file (TOCTOU swap).
    warnings.push({
      code: "STAGING_ALIAS_CLEANUP_DEFERRED",
      message:
        `Staging file identity changed between prepare and discard ` +
        `(dev/ino/size: pre=${preStat.dev}/${preStat.ino}/${preStat.size}, ` +
        `current=${currentStat.dev}/${currentStat.ino}/${currentStat.size}). ` +
        `Leaving artifact in place — operator / next GC pass must clean up "${stagingPath}".`,
    });
    return {
      project,
      generationId,
      stagingPath,
      deleted: false,
      warnings,
    };
  }

  // 5. Safe to delete.
  try {
    unlinkSync(stagingPath);
    deleted = true;
  } catch (e) {
    warnings.push({
      code: "STAGING_ALIAS_CLEANUP_DEFERRED",
      message: `Failed to unlink staging file "${stagingPath}": ${(e as Error).message}`,
    });
  }

  return {
    project,
    generationId,
    stagingPath,
    deleted,
    warnings,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * R169B-STEP2: Build the metadata sidecar payload (a JSON-serializable
 * object). The sidecar is the immutable publication record.
 */
function buildMetadataPayload(
  manifest: GenerationManifestV1,
  meta: {
    publishedAt: string;
    deduped: boolean;
    dedupSourceGenerationId: string | null;
    previousActiveGenerationId: string | null;
    pinned: boolean;
  },
): object {
  return {
    formatVersion: 1 as const,
    manifest,
    publishedAt: meta.publishedAt,
    deduped: meta.deduped,
    dedupSourceGenerationId: meta.dedupSourceGenerationId,
    previousActiveGenerationId: meta.previousActiveGenerationId,
    pinned: meta.pinned,
  };
}

/**
 * R169B-STEP2: Write the metadata sidecar atomically.
 *
 * The sidecar is written via the R169A atomic writer
 * (writeJsonAtomically), which uses temp-rename-fsync with O_NOFOLLOW
 * and dir-fsync. The payload is pre-serialized to a Buffer (so the
 * writer never calls JSON.stringify on an arbitrary object — closes
 * the canonical-payload gap from R169A-FIX-R4 DATA-R169A-R4-01).
 */
function writeMetadataSidecarAtomically(
  metadataPath: string,
  payload: object,
  project: string,
  phase: string,
  generationId: string,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload, null, 2);
  } catch (e) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `JSON serialization of metadata sidecar failed: ${(e as Error).message}`,
      generationId,
    );
  }
  // Re-parse to verify the serialized form is valid JSON.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serialized);
  } catch (e) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `JSON reparse of metadata sidecar failed: ${(e as Error).message}`,
      generationId,
    );
  }
  if (reparsed === null || typeof reparsed !== "object" || Array.isArray(reparsed)) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `Metadata sidecar payload did not round-trip to a JSON object`,
      generationId,
    );
  }
  const buffer = Buffer.from(serialized + "\n", "utf8");
  try {
    writeJsonAtomically(metadataPath, buffer, project, phase, PROD_OPS);
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `Failed to write metadata sidecar atomically: ${(e as Error).message}`,
      generationId,
    );
  }
}
