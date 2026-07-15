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
  fstatSync,
  fchmodSync as fs_fchmodSync,
  unlinkSync,
  linkSync,
  writeSync,
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
  type PublicationMutationState,
  type FileIdentity,
  type FinalCleanupResult,
  type ReservationToken,
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
  readOptionalGenerationManifest,
  validateGenerationMetadata,
} from "./generation-validation.js";
import {
  PROD_OPS,
  writeJsonAtomically,
  ensureGenerationStoreLayoutDurableInternal,
  openDirectoryNoFollow,
  prepareGenerationManifestForWrite,
} from "./internal/generation-store-io.js";
import { openCasStore } from "./internal/generation-cas-store.js";
import { PROD_PUBLISHER_OPS } from "./internal/generation-publisher-ops.js";
import type { PublisherOps } from "./generation-types.js";
import {
  CURRENT_DISCOVERY_POLICY_VERSION,
  CURRENT_EXTRACTOR_SEMANTICS_VERSION,
} from "../indexer/schema.js";
import { AsyncLocalStorage } from "node:async_hooks";

// ─── R169B-STEP10 (§12 POST-PUSH): Crash harness context isolation ──────
//
// Replaces the dangerous module-level `_injectedPublisherOps` and
// `_injectedBarrier` with an AsyncLocalStorage context. This ensures
// that two concurrent publish calls in the same process cannot
// interfere with each other's injected ops or barriers.
//
// The context is scoped to the async call chain originating from
// `publishPreparedGenerationInternal`. The public
// `publishPreparedGeneration` calls `_ops()` which returns
// PROD_PUBLISHER_OPS when no context is active (production path).

interface PublisherContext {
  readonly ops: PublisherOps;
  readonly barrier: ((point: string) => void) | null;
}

const _publisherContext: AsyncLocalStorage<PublisherContext> = new AsyncLocalStorage();

/**
 * Returns the active PublisherOps for the current async context.
 * If no context is active (production path), returns PROD_PUBLISHER_OPS.
 */
function _ops(): PublisherOps {
  const ctx = _publisherContext.getStore();
  return ctx?.ops ?? PROD_PUBLISHER_OPS;
}

/**
 * Invokes the barrier callback (if any) at a named crash point.
 * Uses the async context to find the correct barrier for the current
 * publish call. Errors in the barrier are swallowed (best-effort).
 */
function _barrier(point: string): void {
  const ctx = _publisherContext.getStore();
  if (ctx?.barrier) {
    try { ctx.barrier(point); } catch { /* best effort */ }
  }
}

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
 * `state` is the token state machine:
 *   - PREPARED: just prepared, no publish/discard started.
 *   - PUBLISHING: publish in progress (only one in-process call at a time).
 *   - CONSUMED: publish or discard completed (terminal).
 *   - DISCARDED: discard completed (terminal).
 *
 * R169B-STEP3 (TOKEN-R169B-A1-10): the token is NOT consumed before
 * I/O. The state transitions PREPARED → PUBLISHING happen atomically
 * (single-threaded JS event loop). If the publish fails BEFORE any
 * visible mutation (CAS mismatch, CAS busy, staging mutated, trust
 * root error), the state reverts to PREPARED so the caller can retry
 * or discard. If the publish fails AFTER a visible mutation (link
 * succeeded, manifest written), the state goes to CONSUMED and the
 * caller must run recovery — the publisher raises a structured
 * `GenerationStoreError`.
 *
 * `preStat` records the staging file's dev/ino/size at prepare time.
 * `sha256` records the hash computed at prepare time. Both are used
 * at publish time to re-validate the staging content (DATA-R169B-A1-03).
 */
type PreparedTokenState = "PREPARED" | "PUBLISHING" | "CONSUMED" | "DISCARDED";

interface PreparedToken {
  state: PreparedTokenState;
  preStat: { dev: number; ino: number; size: number };
  sha256: string;
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
 * R169B-STEP6 (RESERVATION-R169B-A4-09): the private WeakMap that
 * holds the reservation tokens. Keyed by the ACTUAL object reference
 * returned by `reserveGenerationStaging`. A spread / JSON clone / cast
 * produces a different reference and is therefore NOT in the WeakMap —
 * `prepareGenerationForPublication` raises `PUBLICATION_RESERVATION_INVALID`.
 */
const reservationTokens: WeakMap<GenerationStagingReservation, ReservationToken> = new WeakMap();

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

  // Persist the new directory entry as well as the file contents. A
  // file fsync alone does not make its name durable across a crash.
  let tmpDirFd: number | null = null;
  try {
    const opened = openDirectoryNoFollow(tmp, PROD_OPS);
    tmpDirFd = opened.fd;
    PROD_OPS.fsyncSync(tmpDirFd);
    PROD_OPS.closeSync(tmpDirFd);
    tmpDirFd = null;
  } catch (e) {
    if (tmpDirFd !== null) {
      try { PROD_OPS.closeSync(tmpDirFd); } catch { /* best effort */ }
    }
    try { unlinkSync(stagingPath); } catch { /* best effort */ }
    // Best effort: make the compensating unlink durable too.
    let cleanupDirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(tmp, PROD_OPS);
      cleanupDirFd = opened.fd;
      PROD_OPS.fsyncSync(cleanupDirFd);
      PROD_OPS.closeSync(cleanupDirFd);
      cleanupDirFd = null;
    } catch {
      if (cleanupDirFd !== null) {
        try { PROD_OPS.closeSync(cleanupDirFd); } catch { /* best effort */ }
      }
    }
    throw new GenerationStoreError(
      "STAGING_CREATE_FAILED",
      phase,
      project,
      `Failed to fsync tmp/ after creating staging file at "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }

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

  const reservation: GenerationStagingReservation = {
    project,
    generationId,
    stagingPath,
    cacheRoot,
    createdAt: new Date().toISOString(),
  };
  Object.freeze(reservation);
  // R169B-STEP6 (RESERVATION-R169B-A4-09): register the reservation
  // token in the WeakMap so prepareGenerationForPublication can
  // authenticate it.
  reservationTokens.set(reservation, {
    state: "RESERVED",
    generationId,
    stagingPath,
    cacheRoot,
    project,
    identity: { dev: st.dev, ino: st.ino },
  });
  return reservation;
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
 *  13. Validate extractor_semantics_version against the current schema contract.
 *  14. Validate discovery_policy_version against the current policy.
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
  // R169B-STEP6 (RESERVATION-R169B-A4-09): authenticate the reservation
  // via the WeakMap. A literal/spread/JSON-clone produces a new
  // reference that is NOT in the WeakMap → PUBLICATION_RESERVATION_INVALID.
  const resToken = reservationTokens.get(reservation);
  if (!resToken) {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      reservation.project,
      `Reservation is not authentic (not in the private WeakMap). Reservations MUST be produced by reserveGenerationStaging in the same process; spread/JSON-clone/literal objects are rejected.`,
      reservation.generationId,
    );
  }
  if (resToken.state !== "RESERVED") {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      reservation.project,
      `Reservation is in state ${resToken.state} (expected RESERVED). A reservation is single-use.`,
      reservation.generationId,
    );
  }
  // Verify the reservation fields match the token.
  const project = reservation.project;
  const generationId = reservation.generationId;
  const stagingPath = reservation.stagingPath;
  if (
    resToken.project !== project ||
    resToken.generationId !== generationId ||
    resToken.stagingPath !== stagingPath
  ) {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      project,
      `Reservation fields do not match the token (project/stagingPath/generationId mismatch)`,
      generationId,
    );
  }
  // Transition RESERVED → PREPARING.
  resToken.state = "PREPARING";
  // R169B-STEP7 (RESERVATION-R169B-A5-04): wrap the prepare body in a
  // try/catch. If the failure happens BEFORE the SQLite DB is opened
  // (trust-root, cacheRoot, containment), the staging is untouched and
  // the reservation can revert to RESERVED (retryable). If the failure
  // happens AFTER the SQLite DB is opened (WAL, validation, hash), the
  // staging may be in an inconsistent state and the reservation is
  // terminal (DISCARDED).
  let sqliteOpened = false;
  try {
  const cacheRoot = options?.cacheRoot ?? reservation.cacheRoot ?? getCacheRoot();
  // Verify cacheRoot matches the token.
  if (resToken.cacheRoot !== cacheRoot && options?.cacheRoot !== undefined) {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      project,
      `options.cacheRoot="${options.cacheRoot}" does not match reservation cacheRoot="${resToken.cacheRoot}"`,
      generationId,
    );
  }

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
    sqliteOpened = true; // R169B-STEP7 (RESERVATION-R169B-A5-04)
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
    // R169B-STEP4 (SQLITE-R169B-A2-03): set synchronous = FULL BEFORE
    // the checkpoint so the checkpoint itself is durable. The previous
    // code set synchronous = FULL AFTER the checkpoint, which did not
    // retroactively strengthen the checkpoint.
    try {
      db.pragma("synchronous = FULL");
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `synchronous = FULL failed (pre-checkpoint): ${(e as Error).message}`,
        generationId,
      );
    }
    // 2. WAL checkpoint TRUNCATE — flush WAL into main DB, truncate WAL.
    // R169B-STEP4 (SQLITE-R169B-A2-03): inspect the result precisely.
    // The result is an array of { log, checkpoint, busy }:
    //   - busy: 0 means the checkpoint completed; 1 means it was busy
    //     and could not complete.
    //   - log: number of frames in the WAL log. 0 after TRUNCATE on a
    //     WAL-mode DB. -1 means the DB is NOT in WAL mode (e.g. the
    //     staging DB was copied from a DELETE-mode published DB for
    //     dedup testing) — there is no WAL to checkpoint, which is OK.
    //   - checkpoint: number of frames checkpointed. 0 or -1 (same
    //     semantics as log).
    // We require busy == 0. log == 0 (WAL emptied) or log == -1 (no WAL).
    try {
      const chkRaw = db.pragma("wal_checkpoint(TRUNCATE)");
      const chkRows = chkRaw as Array<{ log: number; checkpoint: number; busy: number }>;
      if (!Array.isArray(chkRows) || chkRows.length === 0) {
        throw new Error(`wal_checkpoint(TRUNCATE) returned no rows: ${JSON.stringify(chkRaw)}`);
      }
      const chk = chkRows[0];
      if (chk.busy !== 0) {
        throw new Error(`wal_checkpoint(TRUNCATE) was busy (busy=${chk.busy}) — another connection is holding a read lock`);
      }
      // log == -1 means the DB is not in WAL mode (no WAL to checkpoint).
      // log == 0 means the WAL was emptied. Both are OK.
      // Any other log value means the checkpoint did not empty the WAL.
      if (chk.log !== 0 && chk.log !== -1) {
        throw new Error(`wal_checkpoint(TRUNCATE) did not empty the WAL (log=${chk.log})`);
      }
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `wal_checkpoint(TRUNCATE) failed or incomplete: ${(e as Error).message}`,
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
  } finally {
    // R169B-STEP10 (FINAL-05): SQLite close failure is NOT best-effort.
    // A failed close can mean the WAL was not properly checkpointed or
    // the connection is in an error state. We must fail-closed.
    try {
      db.close();
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `SQLite close failed during WAL finalization: ${(e as Error).message}`,
        generationId,
      );
    }
  }

  // R169B-STEP4 (SQLITE-R169B-A2-03): fsync the staging DB file after
  // close. SQLite's close does not guarantee the file's bytes are
  // durable on disk — we must fsync explicitly. This makes the WAL
  // checkpoint and journal_mode switch durable.
  let stagingFd: number | null = null;
  try {
    stagingFd = openSync(stagingPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    fsyncSync(stagingFd);
    closeSync(stagingFd);
    stagingFd = null;
  } catch (e) {
    if (stagingFd !== null) {
      try { closeSync(stagingFd); } catch { /* best effort */ }
    }
    throw new GenerationStoreError(
      "STAGING_DB_WAL_DIRTY",
      phase,
      project,
      `fsync of staging DB after WAL finalization failed: ${(e as Error).message}`,
      generationId,
    );
  }

  // 6. Verify no sidecars exist.
  // R169B-STEP10 (FINAL-04): use lstat ENOENT, not existsSync.
  // existsSync returns false on EACCES/EIO/ENOTDIR, masking real errors.
  const sidecars = [
    `${stagingPath}-wal`,
    `${stagingPath}-shm`,
    `${stagingPath}-journal`,
  ];
  for (const sidecar of sidecars) {
    try {
      lstatSync(sidecar);
      // If lstat succeeded, the sidecar exists → dirty.
      throw new GenerationStoreError(
        "STAGING_DB_WAL_DIRTY",
        phase,
        project,
        `WAL sidecar exists after journal_mode=DELETE: ${sidecar}`,
        generationId,
      );
    } catch (e) {
      if (e instanceof GenerationStoreError) throw e;
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode !== "ENOENT") {
        // Any error other than ENOENT = fail-closed.
        throw new GenerationStoreError(
          "STAGING_DB_WAL_DIRTY",
          phase,
          project,
          `Cannot lstat sidecar "${sidecar}": ${errCode} (${(e as Error).message})`,
          generationId,
        );
      }
      // ENOENT — sidecar is genuinely absent. OK.
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

    // 13. Validate against the shared schema constant so future bumps remain publishable.
    extractorSemanticsVersion = projectRow.extractor_semantics_version;
    if (extractorSemanticsVersion !== CURRENT_EXTRACTOR_SEMANTICS_VERSION) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.extractor_semantics_version=${extractorSemanticsVersion} (expected ${CURRENT_EXTRACTOR_SEMANTICS_VERSION})`,
        generationId,
      );
    }

    // 14. Validate discovery_policy_version against the current policy.
    discoveryPolicyVersion = projectRow.discovery_policy_version;
    if (discoveryPolicyVersion !== CURRENT_DISCOVERY_POLICY_VERSION) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `projects.discovery_policy_version=${discoveryPolicyVersion} (expected ${CURRENT_DISCOVERY_POLICY_VERSION})`,
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
    // R169B-STEP10 (FINAL-05): read-only close failure is also fail-closed.
    try {
      dbReadOnly.close();
    } catch (e) {
      throw new GenerationStoreError(
        "STAGING_DB_STATE_INVALID",
        phase,
        project,
        `SQLite read-only close failed: ${(e as Error).message}`,
        generationId,
      );
    }
  }

  // 22-24. Streaming SHA-256 + sizeBytes + TOCTOU re-stat.
  // R169B-STEP4 (HASH-R169B-A2-04): use the unified secure hash
  // primitive (computeSha256WithIdentityChecks) — same one used at
  // publish time and for dedup candidate validation. The previous
  // code used a non-secure inline hash (no O_NOFOLLOW, no fstat
  // identity checks, no mid-hash swap detection).
  const sha256 = computeSha256WithIdentityChecks(stagingPath, project, phase, generationId);
  // sizeBytes is derived from a fresh lstat (the secure hash primitive
  // already verifies dev/ino/size stability internally).
  const preStat = lstatSync(stagingPath);
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new GenerationStoreError(
      "STAGING_TARGET_INVALID",
      phase,
      project,
      `Staging file is not a regular file at token-creation time: ${stagingPath}`,
      generationId,
    );
  }
  const preDev = preStat.dev;
  const preIno = preStat.ino;
  const preSize = preStat.size;
  const sizeBytes = preStat.size;

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
    state: "PREPARED",
    preStat: { dev: preDev, ino: preIno, size: preSize },
    sha256,
  });
  // R169B-STEP6 (RESERVATION-R169B-A4-09): transition the reservation
  // token to PREPARED (single-use — cannot prepare the same reservation
  // twice).
  resToken.state = "PREPARED";

  return prepared;
  } catch (e) {
    // R169B-STEP7 (RESERVATION-R169B-A5-04): revert the reservation
    // state on failure. If SQLite was NOT opened (failure before the
    // DB open), the staging is untouched → revert to RESERVED (retryable).
    // If SQLite WAS opened (WAL, validation, hash), the staging may be
    // in an inconsistent state → mark DISCARDED (terminal, needs cleanup).
    if (!sqliteOpened) {
      resToken.state = "RESERVED";
    } else {
      resToken.state = "DISCARDED";
    }
    throw e;
  }
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
  options: PublishPreparedGenerationOptions,
  storeOptions?: GenerationStoreOptions,
): PublicationResult {
  const phase = "publishPreparedGeneration";
  const project = prepared.project;
  const generationId = prepared.generationId;
  const stagingPath = prepared.stagingPath;
  const manifest = prepared.manifest;

  // R169B-STEP3 (ROOT-R169B-A1-16): cacheRoot is part of the
  // PreparedGeneration's identity. The storeOptions.cacheRoot MUST
  // match (or be absent). No override.
  const cacheRoot = prepared.cacheRoot;
  if (storeOptions?.cacheRoot !== undefined && storeOptions.cacheRoot !== cacheRoot) {
    throw new GenerationStoreError(
      "PUBLICATION_CACHE_ROOT_MISMATCH",
      phase,
      project,
      `storeOptions.cacheRoot="${storeOptions.cacheRoot}" does not match prepared.cacheRoot="${cacheRoot}" (the cacheRoot is part of the generation's identity and cannot be overridden)`,
      generationId,
    );
  }

  // R169B-STEP3 (CAS-R169B-A1-09): expectedActiveGenerationId is REQUIRED.
  // The types enforce this, but we also assert at runtime in case the
  // caller is JS (not TS) and omitted the field.
  if (options === null || options === undefined || options.expectedActiveGenerationId === undefined) {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_INVALID",
      phase,
      project,
      `options.expectedActiveGenerationId is REQUIRED (pass null for first publication, or the current active generation ID for an optimistic-lock guard)`,
      generationId,
    );
  }
  const expectedActive = options.expectedActiveGenerationId;

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
  // 2. Check state machine.
  if (token.state === "CONSUMED" || token.state === "DISCARDED") {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle has already been published or discarded (state=${token.state})`,
      generationId,
    );
  }
  if (token.state === "PUBLISHING") {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle is currently being published (concurrent call?)`,
      generationId,
    );
  }
  // 3. Transition PREPARED → PUBLISHING.
  // R169B-STEP3 (TOKEN-R169B-A1-10): NOT consumed before I/O. If the
  // publish fails BEFORE any visible mutation (CAS mismatch, CAS busy,
  // staging mutated, trust root error), the state reverts to PREPARED
  // so the caller can retry or discard.
  token.state = "PUBLISHING";

  // 4. Re-validate the trust root.
  try {
    assertTrustedRootNoSymlinks(cacheRoot, project, phase);
  } catch (e) {
    // Pre-mutation failure — revert token state.
    token.state = "PREPARED";
    throw e;
  }

  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const finalPath = finalDbPath(projectStore, generationId);
  const metadataPath = metadataSidecarPath(projectStore, generationId);
  const manifestPath = activeManifestPath(project, cacheRoot);

  // Re-validate containment on the final DB path (it must be inside
  // generations/).
  try {
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
  } catch (e) {
    token.state = "PREPARED";
    throw e;
  }

  // R169B-STEP3 (DATA-R169B-A1-03): Re-validate the staging content
  // BEFORE any publication I/O. The prepare function computed the
  // SHA-256 and recorded dev/ino/size in the token. We re-stat the
  // staging file; if dev/ino/size changed, the file was swapped
  // between prepare and publish — raise PUBLICATION_STAGING_MUTATED.
  // We also re-hash the staging file and compare against the
  // manifest's sha256. This catches the case where the file content
  // was mutated but dev/ino/size stayed the same (write-through
  // caching, in-place mutation).
  //
  // This is a Pre-mutation check: failure reverts the token to PREPARED.
  try {
    revalidateStagingContent(stagingPath, token, manifest.sha256, project, phase, generationId);
  } catch (e) {
    token.state = "PREPARED";
    throw e;
  }

  const warnings: GenerationStoreWarning[] = [];

  // 5. Open the CAS DB. BEGIN IMMEDIATE.
  let cas: ReturnType<typeof openCasStore> | null = null;
  let casCommitted = false;
  // R169B-STEP6 (PHASE-R169B-A4-02): replace the linear enum with a
  // structured PublicationMutationState. The fields are independent,
  // so we can correctly handle the dedup path (metadataCreated=false)
  // and the non-dedup path (metadataCreated=true).
  const mutationState: PublicationMutationState = {
    stagingRemoved: false,
    finalDb: { created: false, identity: null, durable: false },
    metadata: { created: false, preexisted: false, durable: false },
    manifestVisible: false,
    casCommitted: false,
  };
  try {
    cas = openCasStore(project, cacheRoot);
    cas.beginImmediate();

    // 6. Reconcile CAS from the active manifest.
    // R169B-STEP3 (MANIFEST-R169B-A1-04): use readOptionalGenerationManifest
    // (returns null ONLY on real ENOENT; raises on any other failure).
    let activeManifest: GenerationManifestV1 | null;
    try {
      activeManifest = readOptionalGenerationManifest(manifestPath, project);
    } catch (e) {
      // Manifest is present but corrupt/unreadable — fail-closed.
      if (e instanceof GenerationStoreError) {
        throw new GenerationStoreError(
          "PUBLICATION_VERIFY_FAILED",
          phase,
          project,
          `Active manifest is corrupt/unreadable (fail-closed): [${e.code}] ${e.message}`,
          generationId,
        );
      }
      throw e;
    }
    const reconcile = cas.reconcileFromManifest(activeManifest);
    const previousActiveId = reconcile.activeGenerationId;

    // 7. Compare expectedActiveGenerationId (REQUIRED — see above).
    if (expectedActive !== previousActiveId) {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_MISMATCH",
        phase,
        project,
        `expectedActiveGenerationId=${JSON.stringify(expectedActive)} does not match CAS active=${JSON.stringify(previousActiveId)}`,
        generationId,
      );
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
    const dedupSourceGenerationId: string | null = dedup?.generationId ?? null;

    // R169B-STEP3 (DEDUP-R169B-A1-05): For dedup, derive effective
    // paths from dedup.generationId. Validate the dedup candidate's
    // DB and metadata on disk (existence, regular non-symlink, hash
    // match, size match, metadata valid, manifest project/UUID match).
    let effectiveGenerationId: string;
    let effectiveMetadataPath: string;
    let effectiveManifest: GenerationManifestV1;
    if (deduped && dedup) {
      const dedupGenId = dedup.generationId;
      // Validate the dedup candidate's DB and metadata.
      const dedupDbPath = finalDbPath(projectStore, dedupGenId);
      const dedupMetadataPath = metadataSidecarPath(projectStore, dedupGenId);
      // Containment.
      assertPathInsideNoSymlinks(generations, dedupDbPath, project, phase, "GENERATION_TARGET_SYMLINK_REJECTED");
      assertPathInsideNoSymlinks(generations, dedupMetadataPath, project, phase, "GENERATION_TARGET_SYMLINK_REJECTED");
      // DB exists, regular, non-symlink, hash matches.
      const dbStat = lstatSync(dedupDbPath);
      if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate DB is not a regular file: ${dedupDbPath}`,
          generationId,
        );
      }
      if (dbStat.size !== manifest.sizeBytes) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate DB size ${dbStat.size} does not match manifest sizeBytes ${manifest.sizeBytes}`,
          generationId,
        );
      }
      // Re-hash the dedup DB and verify it matches the manifest.
      const dedupHash = computeSha256(dedupDbPath, project, phase, generationId);
      if (dedupHash !== manifest.sha256) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate DB sha256 ${dedupHash} does not match manifest sha256 ${manifest.sha256}`,
          generationId,
        );
      }
      // Metadata exists, regular, non-symlink, valid.
      if (!existsSync(dedupMetadataPath)) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate metadata sidecar missing: ${dedupMetadataPath}`,
          generationId,
        );
      }
      const metaStat = lstatSync(dedupMetadataPath);
      if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate metadata is not a regular file: ${dedupMetadataPath}`,
          generationId,
        );
      }
      // Read + parse + validate metadata sidecar (strict V1 schema).
      let metadataRaw: string;
      try {
        metadataRaw = readFileSyncText(dedupMetadataPath, MAX_METADATA_SIDECAR_BYTES);
      } catch (e) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Failed to read dedup candidate metadata: ${(e as Error).message}`,
          generationId,
        );
      }
      let metadataParsed: unknown;
      try {
        metadataParsed = JSON.parse(metadataRaw);
      } catch (e) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate metadata is not valid JSON: ${(e as Error).message}`,
          generationId,
        );
      }
      const metadataValidated = validateGenerationMetadata(metadataParsed, project);
      // Verify the metadata's manifest matches our prepared manifest
      // (project, sha256, sizeBytes, rootFingerprint, versions).
      const dm = metadataValidated.manifest;
      if (
        dm.project !== manifest.project ||
        dm.sha256 !== manifest.sha256 ||
        dm.sizeBytes !== manifest.sizeBytes ||
        dm.rootFingerprint !== manifest.rootFingerprint ||
        dm.extractorSemanticsVersion !== manifest.extractorSemanticsVersion ||
        dm.discoveryPolicyVersion !== manifest.discoveryPolicyVersion
      ) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate metadata manifest does not match prepared manifest`,
          generationId,
        );
      }
      // Verify the metadata's manifest generationId == dedup.generationId.
      if (dm.generationId !== dedupGenId) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Dedup candidate metadata manifest generationId=${dm.generationId} does not match dedup generationId=${dedupGenId}`,
          generationId,
        );
      }
      // All checks passed — use the dedup candidate's identity.
      // R169B-STEP10 (A1-01): use metadataValidated.manifest as the
      // authority for effectiveManifest. The dedup reuses an EXISTING
      // generation — its createdAt, sha256, sizeBytes, counts, etc.
      // are all from the original publication. The new staging's
      // manifest is only used to prove content equality (hash/size/
      // fingerprint/versions match); the dedup candidate's metadata
      // is the immutable authority.
      effectiveGenerationId = dedupGenId;
      effectiveMetadataPath = dedupMetadataPath;
      effectiveManifest = metadataValidated.manifest;
      // Unlink the staging file (best-effort).
      // R169B-STEP6 (PHASE-R169B-A4-02): mark stagingRemoved — the
      // staging is gone. If the publication fails after this, the
      // token cannot revert to PREPARED (the staging is absent).
      // R169B-STEP6 (META-R169B-A4-08): in dedup, the metadata
      // preexisted (we did NOT create it). metadataCreated stays false.
      // Unlink staging via centralized primitive (A3).
      // R169B (§5 GATE): pass the staging identity (dev/ino from
      // token.preStat) so the cleanup can detect replacement.
      {
        const tmpD = tmpDir(project, cacheRoot);
        const cleanupRes = unlinkStagingDurably(stagingPath, { dev: token.preStat.dev, ino: token.preStat.ino }, tmpD, warnings);
        if (cleanupRes.removed && cleanupRes.confirmedAbsent) {
          mutationState.stagingRemoved = true;
        }
      }
      mutationState.metadata.preexisted = true;
    } else {
      // R169B-STEP9 (TEMP-ID-R169B-A7-01 P0): fd-based temp promotion.
      // The temp fd is kept open during copy+hash. Identity is captured
      // at exclusive-create time via fstat(fd), not after copy. Cleanup
      // compares dev/ino/size before unlinking.
      effectiveGenerationId = generationId;
      effectiveMetadataPath = metadataPath;
      effectiveManifest = manifest;

      // 1. Open staging source O_RDONLY|O_NOFOLLOW.
      let sourceFd: number | null = null;
      try {
        sourceFd = openSync(stagingPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (e) {
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `Failed to open staging source: ${(e as Error).message}`, generationId);
      }
      // fstat source and compare to token preStat.
      let sourceStat: Stats;
      try {
        sourceStat = fstatSync(sourceFd);
        if (sourceStat.dev !== token.preStat.dev || sourceStat.ino !== token.preStat.ino || sourceStat.size !== token.preStat.size) {
          try { closeSync(sourceFd); } catch {}
          throw new GenerationStoreError("PUBLICATION_STAGING_MUTATED", phase, project,
            `Staging identity changed since prepare: dev=${sourceStat.dev}/${token.preStat.dev} ino=${sourceStat.ino}/${token.preStat.ino} size=${sourceStat.size}/${token.preStat.size}`, generationId);
        }
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        try { closeSync(sourceFd); } catch {}
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `fstat of staging source failed: ${(e as Error).message}`, generationId);
      }

      // 2. Create temp O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW, mode 0600.
      const tempNonce = randomUUID();
      const tempPath = join(generations, `.publish-${generationId}-${tempNonce}.db`);
      let tempFd: number | null = null;
      try {
        tempFd = openSync(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
      } catch (e) {
        try { closeSync(sourceFd); } catch {}
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `Failed to create temp: ${(e as Error).message}`, generationId);
      }

      // 3. Capture temp identity IMMEDIATELY via fstat(fd).
      let tempIdentity: FileIdentity;
      try {
        const ts = fstatSync(tempFd);
        if (ts.isSymbolicLink() || !ts.isFile()) {
          try { closeSync(tempFd); } catch {}
          try { closeSync(sourceFd); } catch {}
          try { unlinkSync(tempPath); } catch {}
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Temp is not a regular file: ${tempPath}`, generationId);
        }
        tempIdentity = { dev: ts.dev, ino: ts.ino, size: ts.size };
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        try { closeSync(tempFd); } catch {}
        try { closeSync(sourceFd); } catch {}
        try { unlinkSync(tempPath); } catch {}
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `fstat of temp failed: ${(e as Error).message}`, generationId);
      }
      mutationState.finalDb.created = true;
      mutationState.finalDb.identity = tempIdentity;

      // R169B-STEP10 (CLEANUP-TEMP-01): Authenticated cleanup.
      // Pipeline: lstat → ENOENT? skip to fsync → present? compare dev/ino
      // → unlink → fsync generations/ → confirm ENOENT.
      // Only ENOENT means absent. EACCES/EIO/ENOTDIR = NOT absent.
      const cleanupTemp = (): { certified: boolean } => {
        let identityMatched = false;
        let removed = false;
        let directoryDurable = false;
        let confirmedAbsent = false;

        // 1. lstat temp.
        try {
          const cs = lstatSync(tempPath);
          if (cs.dev === tempIdentity.dev && cs.ino === tempIdentity.ino) {
            identityMatched = true;
            // 3. Unlink.
            try {
              unlinkSync(tempPath);
              removed = true;
            } catch {
              return { certified: false };
            }
          } else {
            // Identity mismatch — do NOT unlink.
            return { certified: false };
          }
        } catch (e) {
          const errCode = (e as NodeJS.ErrnoException).code;
          if (errCode === "ENOENT") {
            // 2. ENOENT — already gone. Skip to fsync + confirm.
            identityMatched = true; // nothing to match against
            removed = true; // nothing to remove
          } else {
            // EACCES/EIO/ENOTDIR/ELOOP — NOT absent, fail-closed.
            return { certified: false };
          }
        }

        // 4. fsync generations/.
        let cdf: number | null = null;
        try {
          const opened = openDirectoryNoFollow(generations, PROD_OPS);
          cdf = opened.fd;
          PROD_OPS.fsyncSync(cdf);
          PROD_OPS.closeSync(cdf);
          cdf = null;
          directoryDurable = true;
        } catch {
          if (cdf !== null) { try { PROD_OPS.closeSync(cdf); } catch {} }
          return { certified: false };
        }

        // 5. Confirm ENOENT.
        try {
          lstatSync(tempPath);
          // Still exists — not confirmed.
          return { certified: false };
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === "ENOENT") {
            confirmedAbsent = true;
          } else {
            // EACCES/EIO — not confirmed.
            return { certified: false };
          }
        }

        // 6. Certified only if all four guarantees are true.
        return { certified: identityMatched && removed && directoryDurable && confirmedAbsent };
      };

      // 4. fd-based copy + hash (single pass: read source → hash → write temp).
      let copyError: Error | null = null;
      let totalWritten = 0;
      try {
        const hasher = createHash("sha256");
        const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
        while (true) {
          let bytesRead: number;
          try {
            bytesRead = readSync(sourceFd, chunk, 0, HASH_CHUNK_BYTES, null);
          } catch (e) {
            copyError = e as Error;
            break;
          }
          if (bytesRead === 0) break;
          hasher.update(chunk.subarray(0, bytesRead));
          // Write all bytes to temp fd.
          let written = 0;
          while (written < bytesRead) {
            try {
              const n = writeSync(tempFd, chunk, written, bytesRead - written, null);
              if (n <= 0) { copyError = new Error("zero-progress write"); break; }
              written += n;
            } catch (e) {
              copyError = e as Error;
              break;
            }
          }
          if (copyError) break;
          totalWritten += bytesRead;
        }
        if (!copyError) {
          // Verify source stability (fstat before/after).
          const sourceAfter = fstatSync(sourceFd);
          if (sourceAfter.dev !== sourceStat.dev || sourceAfter.ino !== sourceStat.ino || sourceAfter.size !== sourceStat.size) {
            copyError = new Error("source mutated during copy");
          }
          // Compute hash.
          const tempHash = hasher.digest("hex");
          if (tempHash !== manifest.sha256) {
            copyError = new Error(`hash mismatch: ${tempHash} != ${manifest.sha256}`);
          }
          if (totalWritten !== sourceStat.size) {
            copyError = new Error(`short copy: ${totalWritten} != ${sourceStat.size}`);
          }
        }
      } catch (e) {
        copyError = e as Error;
      }

      // Close source fd.
      try { closeSync(sourceFd); } catch {}
      sourceFd = null;

      // R169B-STEP10 (TEMP-CONTENT-FINAL-01): fstat(tempFd) post-copy.
      // Verify dev/ino unchanged AND size == totalWritten AND
      // size == manifest.sizeBytes.
      try {
        const tempAfter = fstatSync(tempFd!);
        if (tempAfter.dev !== tempIdentity.dev || tempAfter.ino !== tempIdentity.ino) {
          try { closeSync(tempFd!); } catch {}
          tempFd = null;
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Post-copy temp identity changed: dev=${tempAfter.dev}/${tempIdentity.dev} ino=${tempAfter.ino}/${tempIdentity.ino}`, generationId);
        }
        // R169B-STEP10 (TEMP-CONTENT-FINAL-01): verify temp size.
        if (tempAfter.size !== totalWritten) {
          try { closeSync(tempFd!); } catch {}
          tempFd = null;
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Post-copy temp size ${tempAfter.size} != totalWritten ${totalWritten}`, generationId);
        }
        if (tempAfter.size !== manifest.sizeBytes) {
          try { closeSync(tempFd!); } catch {}
          tempFd = null;
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Post-copy temp size ${tempAfter.size} != manifest.sizeBytes ${manifest.sizeBytes}`, generationId);
        }
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        try { closeSync(tempFd!); } catch {}
        tempFd = null;
        const r = cleanupTemp();
        if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `Post-copy fstat(tempFd) failed: ${(e as Error).message}`, generationId);
      }

      // R169B-STEP10 (TEMP-MODE-FINAL-02): fchmod(tempFd, 0600) fail-closed.
      // On Linux (certified platform), fchmod failure is fatal.
      try {
        fs_fchmodSync(tempFd, 0o600);
      } catch (e) {
        try { closeSync(tempFd!); } catch {}
        tempFd = null;
        const r = cleanupTemp();
        if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `fchmod(tempFd, 0600) failed: ${(e as Error).message}`, generationId);
      }
      // Verify mode and owner via fstat.
      try {
        const modeStat = fstatSync(tempFd!);
        if ((modeStat.mode & 0o777) !== 0o600) {
          try { closeSync(tempFd!); } catch {}
          tempFd = null;
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Temp mode is 0o${(modeStat.mode & 0o777).toString(8)} (expected 0600): ${tempPath}`, generationId);
        }
        if (typeof process.getuid === "function" && modeStat.uid !== process.getuid()) {
          try { closeSync(tempFd!); } catch {}
          tempFd = null;
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Temp owner uid=${modeStat.uid} != process uid=${process.getuid()}: ${tempPath}`, generationId);
        }
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        try { closeSync(tempFd!); } catch {}
        tempFd = null;
        const r = cleanupTemp();
        if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `Post-fchmod fstat failed: ${(e as Error).message}`, generationId);
      }

      // R169B-STEP10 (P0): fsync(tempFd) failure MUST block promotion.
      // R169B-STEP3 (C3): routed through _ops() for fault injection.
      _barrier("pre-fsync-temp");
      let tempFsyncFailed = false;
      try {
        _ops().fsyncSync(tempFd!);
      } catch (e) {
        tempFsyncFailed = true;
      }
      try { closeSync(tempFd!); } catch {}
      tempFd = null;
      _barrier("after-temp-fsync");

      if (tempFsyncFailed) {
        // fsync failed — the temp bytes may not survive a crash.
        // Block the promotion: cleanup the temp and abort.
        const r = cleanupTemp();
        if (r.certified) {
          mutationState.finalDb.created = false;
          mutationState.finalDb.identity = null;
        }
        throw new GenerationStoreError(
          "GENERATION_PROMOTION_DURABILITY_UNKNOWN",
          phase,
          project,
          `fsync of temp DB failed — promotion BLOCKED (temp bytes may not be durable)`,
          generationId,
        );
      }

      // R169B (§18 GATE): copy/hash error taxonomy. Distinguish:
      // SOURCE_MUTATED / HASH_MISMATCH / SHORT_COPY → PUBLICATION_STAGING_MUTATED
      // READ_FAILED / WRITE_FAILED / ZERO_PROGRESS → GENERATION_PROMOTION_FAILED
      if (copyError) {
        const result = cleanupTemp();
        if (!result.certified) {
          // Cleanup failed — do NOT reset mutation state.
        } else {
          mutationState.finalDb.created = false;
          mutationState.finalDb.identity = null;
        }
        const msg = copyError.message;
        const isStagingMutation =
          msg.includes("source mutated") ||
          msg.includes("hash mismatch") ||
          msg.includes("short copy");
        const errorCode = isStagingMutation
          ? "PUBLICATION_STAGING_MUTATED" as const
          : "GENERATION_PROMOTION_FAILED" as const;
        throw new GenerationStoreError(errorCode, phase, project,
          `Copy/hash failed: ${msg}`, generationId);
      }

      // 5. Verify temp identity is still ours (lstat == fstat).
      try {
        const pre = lstatSync(tempPath);
        if (pre.dev !== tempIdentity.dev || pre.ino !== tempIdentity.ino) {
          const r = cleanupTemp();
          if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Temp identity changed before link`, generationId);
        }
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        const r = cleanupTemp();
        if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `lstat temp before link failed: ${(e as Error).message}`, generationId);
      }

      // 6. link(temp, final) — no-clobber.
      // R169B-STEP3 (C3): routed through _ops() for fault injection.
      _barrier("pre-link");
      try {
        _ops().linkSync(tempPath, finalPath);
      } catch (e) {
        const errCode = (e as NodeJS.ErrnoException).code;
        const r = cleanupTemp();
        if (r.certified) { mutationState.finalDb.created = false; mutationState.finalDb.identity = null; }
        if (errCode === "EEXIST") {
          throw new GenerationStoreError("GENERATION_PROMOTION_CONFLICT", phase, project,
            `link target exists: ${finalPath}`, generationId);
        }
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `link(temp, final) failed: ${(e as Error).message}`, generationId);
      }
      _barrier("after-link");

      // R169B-STEP10 (FINAL-06): verify final dev/ino immediately after link.
      // The final DB must be the same inode as the temp we just linked.
      try {
        const finalStat = lstatSync(finalPath);
        if (finalStat.dev !== tempIdentity.dev || finalStat.ino !== tempIdentity.ino) {
          // The final path does not point to our temp — something replaced it.
          cleanupTemp();
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Post-link identity mismatch: final dev/ino=${finalStat.dev}/${finalStat.ino} != temp dev/ino=${tempIdentity.dev}/${tempIdentity.ino}`, generationId);
        }
        if (finalStat.size !== manifest.sizeBytes) {
          cleanupTemp();
          throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
            `Post-link size mismatch: final size=${finalStat.size} != manifest sizeBytes=${manifest.sizeBytes}`, generationId);
        }
      } catch (e) {
        if (e instanceof GenerationStoreError) throw e;
        cleanupTemp();
        throw new GenerationStoreError("GENERATION_PROMOTION_FAILED", phase, project,
          `Post-link lstat failed: ${(e as Error).message}`, generationId);
      }

      // 7. fsync generations/ (makes the final dir entry durable).
      let dirFd: number | null = null;
      try {
        const opened = openDirectoryNoFollow(generations, PROD_OPS);
        dirFd = opened.fd;
        PROD_OPS.fsyncSync(dirFd);
        PROD_OPS.closeSync(dirFd);
        dirFd = null;
      } catch (e) {
        if (dirFd !== null) { try { PROD_OPS.closeSync(dirFd); } catch {} }
        // The link succeeded but dir fsync failed. Temp still exists — clean up.
        cleanupTemp();
        throw new GenerationStoreError("GENERATION_PROMOTION_DURABILITY_UNKNOWN", phase, project,
          `fsync generations/ after link failed: ${(e as Error).message}`, generationId);
      }
      _barrier("after-generations-fsync");
      mutationState.finalDb.durable = true;

      // 8. Unlink temp (after identity re-check).
      try {
        const preUnlink = lstatSync(tempPath);
        if (preUnlink.dev === tempIdentity.dev && preUnlink.ino === tempIdentity.ino) {
          unlinkSync(tempPath);
        } else {
          warnings.push({ code: "PROMOTION_TEMP_CLEANUP_DEFERRED", message: `Temp identity mismatch before unlink — leaving temp in place: ${tempPath}` });
        }
      } catch (e) {
        const ec = (e as NodeJS.ErrnoException).code;
        if (ec !== "ENOENT") {
          warnings.push({ code: "PROMOTION_TEMP_CLEANUP_DEFERRED", message: `Failed to unlink temp: ${(e as Error).message}` });
        }
      }

      // 9. fsync generations/ after temp unlink.
      let dirFd2: number | null = null;
      try {
        const opened = openDirectoryNoFollow(generations, PROD_OPS);
        dirFd2 = opened.fd;
        PROD_OPS.fsyncSync(dirFd2);
        PROD_OPS.closeSync(dirFd2);
        dirFd2 = null;
      } catch {
        if (dirFd2 !== null) { try { PROD_OPS.closeSync(dirFd2); } catch {} }
        warnings.push({ code: "PROMOTION_TEMP_CLEANUP_DEFERRED", message: "fsync generations/ after temp unlink failed (non-fatal)" });
      }

      // 10. Unlink staging via centralized primitive (A3).
      // R169B (§5 GATE): pass the staging identity (dev/ino from
      // token.preStat) so the cleanup can detect replacement.
      {
        const tmpD = tmpDir(project, cacheRoot);
        const cleanupRes = unlinkStagingDurably(stagingPath, { dev: token.preStat.dev, ino: token.preStat.ino }, tmpD, warnings);
        if (cleanupRes.removed && cleanupRes.confirmedAbsent) {
          mutationState.stagingRemoved = true;
        }
      }
    }

    // 10. Write the metadata sidecar (generation-<effectiveUuid>.json).
    //     R169B-STEP3 (DEDUP-R169B-A1-05 B + META-R169B-A1-17): for
    //     dedup, do NOT write a new sidecar — the existing one is
    //     immutable and we validated it above. For non-dedup, write
    //     the sidecar atomically with strict V1 schema.
    //     R169B-STEP5 (META-R169B-A3-07): the writer now calls
    //     validateGenerationMetadata before writing.
    if (!deduped) {
      const metadataPayload = buildMetadataPayload(effectiveManifest, {
        publishedAt: new Date().toISOString(),
        deduped,
        dedupSourceGenerationId,
        previousActiveGenerationId: previousActiveId,
        pinned: !!options?.pin,
      });
      writeMetadataSidecarAtomically(effectiveMetadataPath, metadataPayload, project, phase, effectiveGenerationId);
      _barrier("after-metadata");
    }
    // R169B-STEP6 (PHASE-R169B-A4-02): metadata is durable (for non-dedup)
    // or already existed (for dedup). Mark metadataCreated=true only for
    // non-dedup (we actually wrote it). For dedup, metadataCreated stays
    // false (the metadata preexisted).
    if (!deduped) {
      mutationState.metadata.created = true;
      mutationState.metadata.durable = true;
    }

    // R169B-STEP10 (A1-02): verifyPublicationCandidateStrict — verify
    // DB + metadata BEFORE writing the manifest. If this fails, the
    // manifest is NOT written and readers continue to see the old
    // generation. This closes the window where a reader could see a
    // manifest pointing at a corrupt/missing DB.
    try {
      // DB: lstat, regular, non-symlink, mode 0600, owner, size, hash.
      const candidateDbPath = join(projectStore, effectiveManifest.dbFile);
      const candidateStat = lstatSync(candidateDbPath);
      if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
        throw new Error(`candidate DB is not a regular file: ${candidateDbPath}`);
      }
      if ((candidateStat.mode & 0o777) !== 0o600) {
        throw new Error(`candidate DB mode is 0o${(candidateStat.mode & 0o777).toString(8)} (expected 0600)`);
      }
      if (typeof process.getuid === "function" && candidateStat.uid !== process.getuid()) {
        throw new Error(`candidate DB owner uid=${candidateStat.uid} != process uid=${process.getuid()}`);
      }
      if (candidateStat.size !== effectiveManifest.sizeBytes) {
        throw new Error(`candidate DB size ${candidateStat.size} != manifest ${effectiveManifest.sizeBytes}`);
      }
      // Verify dev/ino for non-dedup.
      if (!deduped && mutationState.finalDb.identity) {
        if (candidateStat.dev !== mutationState.finalDb.identity.dev ||
            candidateStat.ino !== mutationState.finalDb.identity.ino) {
          throw new Error(`candidate DB dev/ino mismatch`);
        }
      }
      // Candidate hash verification.
      const candidateHash = computeSha256WithIdentityChecks(candidateDbPath, project, phase, generationId);
      if (candidateHash !== effectiveManifest.sha256) {
        throw new Error(`candidate DB sha256 ${candidateHash} != manifest ${effectiveManifest.sha256}`);
      }
      // Metadata: lstat, regular, non-symlink, mode 0600, owner, size bound, schema.
      const candidateMetaStat = lstatSync(effectiveMetadataPath);
      if (candidateMetaStat.isSymbolicLink() || !candidateMetaStat.isFile()) {
        throw new Error(`candidate metadata is not a regular file: ${effectiveMetadataPath}`);
      }
      if ((candidateMetaStat.mode & 0o777) !== 0o600) {
        throw new Error(`candidate metadata mode is 0o${(candidateMetaStat.mode & 0o777).toString(8)}`);
      }
      if (typeof process.getuid === "function" && candidateMetaStat.uid !== process.getuid()) {
        throw new Error(`candidate metadata owner uid mismatch`);
      }
      if (candidateMetaStat.size > MAX_METADATA_SIDECAR_BYTES) {
        throw new Error(`candidate metadata size ${candidateMetaStat.size} exceeds max`);
      }
      // Read + validate metadata.
      const candidateMetaRaw = readFileSyncText(effectiveMetadataPath, MAX_METADATA_SIDECAR_BYTES);
      const candidateMetaParsed = JSON.parse(candidateMetaRaw);
      const candidateMetaValidated = validateGenerationMetadata(candidateMetaParsed, project);
      // R169B (§5 GATE): compare ALL 13 manifest fields between the
      // metadata's manifest and the effectiveManifest. A metadata from
      // a different generation (valid schema, same project) must NOT
      // pass candidate verify — otherwise it becomes visible when the
      // manifest is written, opening a reader window.
      const cm = candidateMetaValidated.manifest;
      const em = effectiveManifest;
      if (cm.formatVersion !== em.formatVersion ||
          cm.project !== em.project ||
          cm.generationId !== em.generationId ||
          cm.dbFile !== em.dbFile ||
          cm.createdAt !== em.createdAt ||
          cm.rootFingerprint !== em.rootFingerprint ||
          cm.extractorSemanticsVersion !== em.extractorSemanticsVersion ||
          cm.discoveryPolicyVersion !== em.discoveryPolicyVersion ||
          cm.nodeCount !== em.nodeCount ||
          cm.edgeCount !== em.edgeCount ||
          cm.fileCount !== em.fileCount ||
          cm.sizeBytes !== em.sizeBytes ||
          cm.sha256 !== em.sha256) {
        throw new Error(
          `candidate metadata.manifest does not match effectiveManifest ` +
          `(differs on one or more of the 13 required fields)`,
        );
      }
    } catch (e) {
      if (e instanceof GenerationStoreError) throw e;
      throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
        `Candidate verification (pre-manifest) failed: ${(e as Error).message}`, generationId);
    }

    // 11. Write active-generation.json atomically (canonical payload).
    const preparedPayload = prepareGenerationManifestForWrite(effectiveManifest, project);
    writeJsonAtomically(manifestPath, preparedPayload.payload, project, phase, PROD_OPS);
    _barrier("after-manifest");
    // R169B-STEP6 (PHASE-R169B-A4-02): the manifest is now visible to
    // readers. This is a point of no return — the token is CONSUMED.
    mutationState.manifestVisible = true;

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
    if (verifiedManifest.generationId !== effectiveGenerationId) {
      throw new GenerationStoreError(
        "PUBLICATION_VERIFY_FAILED",
        phase,
        project,
        `Re-read manifest generationId="${verifiedManifest.generationId}" does not match expected="${effectiveGenerationId}"`,
        generationId,
      );
    }
    const verifiedDbPath = join(projectStore, verifiedManifest.dbFile);
    // R169B-STEP10 (A1): verifyPublishedGenerationStrict — full post-verify.
    // Manifest: compare ALL fields to effectiveManifest (not just generationId).
    // DB: lstat, regular, non-symlink, mode 0600, owner, size, dev/ino (if
    // non-dedup, compare to tempIdentity), SHA-256 hash (O_NOFOLLOW + fstat).
    // Metadata: lstat, regular, non-symlink, mode 0600, owner, size bound,
    // UTF-8 fatal, GenerationMetadataV1 strict, metadata.manifest == active.
    try {
      // --- Manifest: compare ALL fields ---
      const m = verifiedManifest;
      const e = effectiveManifest;
      if (m.formatVersion !== e.formatVersion || m.project !== e.project ||
          m.generationId !== e.generationId || m.dbFile !== e.dbFile ||
          m.createdAt !== e.createdAt || m.rootFingerprint !== e.rootFingerprint ||
          m.extractorSemanticsVersion !== e.extractorSemanticsVersion ||
          m.discoveryPolicyVersion !== e.discoveryPolicyVersion ||
          m.nodeCount !== e.nodeCount || m.edgeCount !== e.edgeCount ||
          m.fileCount !== e.fileCount || m.sizeBytes !== e.sizeBytes ||
          m.sha256 !== e.sha256) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: manifest fields do not match effectiveManifest`, generationId);
      }
      // --- DB: lstat, regular, mode, owner, size, identity, hash ---
      const dbVerifyStat = lstatSync(verifiedDbPath);
      if (dbVerifyStat.isSymbolicLink() || !dbVerifyStat.isFile()) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: DB is not a regular file: ${verifiedDbPath}`, generationId);
      }
      if ((dbVerifyStat.mode & 0o777) !== 0o600) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: DB mode is 0o${(dbVerifyStat.mode & 0o777).toString(8)} (expected 0600): ${verifiedDbPath}`, generationId);
      }
      if (typeof process.getuid === "function" && dbVerifyStat.uid !== process.getuid()) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: DB owner uid=${dbVerifyStat.uid} != process uid=${process.getuid()}: ${verifiedDbPath}`, generationId);
      }
      if (dbVerifyStat.size !== verifiedManifest.sizeBytes) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: DB size ${dbVerifyStat.size} != manifest ${verifiedManifest.sizeBytes}: ${verifiedDbPath}`, generationId);
      }
      // R169B-STEP10 (A1): verify dev/ino for non-dedup (must match temp identity).
      if (!deduped && mutationState.finalDb.identity) {
        if (dbVerifyStat.dev !== mutationState.finalDb.identity.dev ||
            dbVerifyStat.ino !== mutationState.finalDb.identity.ino) {
          throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
            `Post-verify: DB dev/ino mismatch: expected ${mutationState.finalDb.identity.dev}/${mutationState.finalDb.identity.ino}, got ${dbVerifyStat.dev}/${dbVerifyStat.ino}`, generationId);
        }
      }
      // R169B-STEP10 (A1): post-link SHA-256 hash verification.
      // The hash prepared at copy time proves the bytes copied. This hash
      // proves the bytes at the final path after link are unchanged.
      const postLinkHash = computeSha256WithIdentityChecks(verifiedDbPath, project, phase, generationId);
      if (postLinkHash !== verifiedManifest.sha256) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: DB sha256 ${postLinkHash} != manifest ${verifiedManifest.sha256}: ${verifiedDbPath}`, generationId);
      }
      // --- Metadata: lstat, regular, mode, owner, size, schema, manifest ---
      const metaVerifyStat = lstatSync(effectiveMetadataPath);
      if (metaVerifyStat.isSymbolicLink() || !metaVerifyStat.isFile()) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: metadata is not a regular file: ${effectiveMetadataPath}`, generationId);
      }
      if ((metaVerifyStat.mode & 0o777) !== 0o600) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: metadata mode is 0o${(metaVerifyStat.mode & 0o777).toString(8)} (expected 0600): ${effectiveMetadataPath}`, generationId);
      }
      if (typeof process.getuid === "function" && metaVerifyStat.uid !== process.getuid()) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: metadata owner uid=${metaVerifyStat.uid} != process uid=${process.getuid()}: ${effectiveMetadataPath}`, generationId);
      }
      if (metaVerifyStat.size > MAX_METADATA_SIDECAR_BYTES) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: metadata size ${metaVerifyStat.size} exceeds max ${MAX_METADATA_SIDECAR_BYTES}: ${effectiveMetadataPath}`, generationId);
      }
      // Read + validate metadata sidecar.
      const metaRaw = readFileSyncText(effectiveMetadataPath, MAX_METADATA_SIDECAR_BYTES);
      const metaParsed = JSON.parse(metaRaw);
      const metaValidated = validateGenerationMetadata(metaParsed, project);
      // Verify metadata.manifest matches the active manifest exactly.
      const dm = metaValidated.manifest;
      if (dm.formatVersion !== m.formatVersion || dm.project !== m.project ||
          dm.generationId !== m.generationId || dm.dbFile !== m.dbFile ||
          dm.createdAt !== m.createdAt || dm.rootFingerprint !== m.rootFingerprint ||
          dm.extractorSemanticsVersion !== m.extractorSemanticsVersion ||
          dm.discoveryPolicyVersion !== m.discoveryPolicyVersion ||
          dm.nodeCount !== m.nodeCount || dm.edgeCount !== m.edgeCount ||
          dm.fileCount !== m.fileCount || dm.sizeBytes !== m.sizeBytes ||
          dm.sha256 !== m.sha256) {
        throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
          `Post-verify: metadata.manifest does not match active manifest`, generationId);
      }
    } catch (e) {
      if (e instanceof GenerationStoreError) throw e;
      throw new GenerationStoreError("PUBLICATION_VERIFY_FAILED", phase, project,
        `Post-verify failed: ${(e as Error).message}`, generationId);
    }

    // 13. Update CAS.
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
    // R169B-STEP3 (CAS-R169B-A1-18): appendPublicationHistory now
    // increments the revision internally. Do NOT call
    // incrementRevision separately.
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
    const newRevision = cas.getRevision();

    // 14. COMMIT.
    // R169B-STEP3 (C3): barrier before CAS commit (crash harness sync point).
    _barrier("pre-cas-commit");
    cas.commit();
    casCommitted = true;
    mutationState.casCommitted = true;
    _barrier("after-cas-commit");

    // 15. Transition token → CONSUMED.
    token.state = "CONSUMED";

    return {
      project,
      generationId: effectiveGenerationId,
      dbPath: verifiedDbPath,
      manifestPath,
      metadataPath: effectiveMetadataPath,
      manifest: verifiedManifest,
      publicationState: "PUBLISHED",
      warnings,
      cas: {
        revision: newRevision,
        deduped,
        previousActiveGenerationId: previousActiveId,
      },
    };
  } catch (e) {
    // Rollback the CAS transaction if it is still open.
    if (cas !== null && !casCommitted) {
      try { cas.rollback(); } catch { /* best effort */ }
    }
    // R169B-STEP6 (PHASE-R169B-A4-02 + CLEANUP-R169B-A4-01): the token
    // state depends on the mutation state. Only revert to PREPARED if NO
    // visible mutation happened (all changed fields false/zero).
    // R169B-STEP7 (PHASE-R169B-A5-02): metadata.preexisted is NOT a
    // mutation — it describes a state that existed before this attempt.
    // Only count fields that this attempt actually changed.
    const noMutation =
      !mutationState.stagingRemoved &&
      !mutationState.finalDb.created &&
      !mutationState.metadata.created &&
      !mutationState.manifestVisible &&
      !mutationState.casCommitted;
    if (noMutation) {
      token.state = "PREPARED";
    } else {
      token.state = "CONSUMED";
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
    if (cas !== null) {
      cas.close();
    }
  }
}

// ─── R169B (C3): publishPreparedGenerationInternal ──────────────────────
//
// Test-facing wrapper around `publishPreparedGeneration` that injects
// a faultable PublisherOps and a barrier callback for the crash
// harness. The injection is scoped to a single call via AsyncLocalStorage
// so concurrent calls do NOT interfere.
//
// @internal — NOT part of the public API. Not re-exported from
// generation-store.ts. Not used by any production code path. Only
// imported by tests/storage/r169b-crash-harness.test.ts and
// scripts/publication-benchmark-r169b.ts.
//
// Production code NEVER calls this — it calls the public
// `publishPreparedGeneration` directly. Only the crash harness tests
// (tests/storage/r169b-crash-harness.test.ts) import this function.
//
// The `ops` parameter is wrapped via `createFaultablePublisherOps` by
// the caller; this function just stores it module-level so the
// `_ops()` helper inside `publishPreparedGeneration` picks it up.
//
// The `onBarrier` callback is invoked at named crash points:
//   - "pre-fsync-temp"   — before fsync(tempFd)
//   - "pre-link"         — before link(temp, final)
//   - "pre-cas-commit"   — before cas.commit()
// The crash harness uses these to synchronize child-process kills.

export function publishPreparedGenerationInternal(
  prepared: PreparedGeneration,
  options: PublishPreparedGenerationOptions,
  storeOptions: GenerationStoreOptions | undefined,
  ops: PublisherOps,
  onBarrier?: (point: string) => void,
): PublicationResult {
  // R169B-STEP10 (§12): Use AsyncLocalStorage instead of module-level
  // state. This ensures concurrent publish calls in the same process
  // cannot interfere with each other's injected ops or barriers.
  const ctx: PublisherContext = {
    ops,
    barrier: onBarrier ?? null,
  };
  return _publisherContext.run(ctx, () =>
    publishPreparedGeneration(prepared, options, storeOptions),
  );
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
  // 2. Check state machine.
  if (token.state === "CONSUMED" || token.state === "DISCARDED") {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle has already been published or discarded (state=${token.state})`,
      generationId,
    );
  }
  if (token.state === "PUBLISHING") {
    throw new GenerationStoreError(
      "PUBLICATION_TOKEN_CONSUMED",
      phase,
      project,
      `PreparedGeneration handle is currently being published (concurrent call?)`,
      generationId,
    );
  }
  // Transition PREPARED → DISCARDED.
  token.state = "DISCARDED";

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

  // 5. Safe to delete via centralized primitive (A3).
  {
    const tmpD = tmpDir(prepared.project, prepared.cacheRoot);
    const cleanupRes = unlinkStagingDurably(stagingPath, { dev: preStat.dev, ino: preStat.ino }, tmpD, warnings);
    deleted = cleanupRes.removed && cleanupRes.confirmedAbsent;
  }

  return {
    project,
    generationId,
    stagingPath,
    deleted,
    warnings,
  };
}

// ─── DISCARD RESERVATION: discardGenerationReservation ────────────────────

/**
 * R169B-STEP10 (§8): Discard a reservation that failed during prepare.
 *
 * When `prepareGenerationForPublication` fails terminally (after SQLite
 * was opened), the reservation is marked DISCARDED and the staging DB
 * is left on disk. This function provides the caller with an API to
 * clean up that staging DB safely.
 *
 * The function:
 *   1. Validates the reservation token (WeakMap lookup).
 *   2. Checks the reservation state (must be DISCARDED or RESERVED).
 *   3. Stats the staging file and verifies it exists.
 *   4. Unlinks the staging file.
 *   5. fsyncs the tmp/ directory (durability).
 *   6. Confirms absence via lstat ENOENT.
 *
 * Returns a `DiscardResult` (same shape as `discardPreparedGeneration`).
 */
export function discardGenerationReservation(
  reservation: GenerationStagingReservation,
  options?: GenerationStoreOptions,
): DiscardResult {
  const phase = "discardGenerationReservation";
  const project = reservation.project;
  const generationId = reservation.generationId;
  const stagingPath = reservation.stagingPath;
  // R169B-STEP10 (A2): verify cacheRoot matches the token if provided.
  const resToken = reservationTokens.get(reservation);
  if (!resToken) {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      project,
      `Reservation is not authentic (not in the private WeakMap)`,
      generationId,
    );
  }
  if (options?.cacheRoot !== undefined && options.cacheRoot !== resToken.cacheRoot) {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      project,
      `options.cacheRoot="${options.cacheRoot}" does not match reservation cacheRoot="${resToken.cacheRoot}"`,
      generationId,
    );
  }
  const cacheRoot = resToken.cacheRoot;

  // 2. Check state — must be RESERVED or DISCARDED (not PREPARING/PREPARED).
  if (resToken.state === "PREPARING" || resToken.state === "PREPARED") {
    throw new GenerationStoreError(
      "PUBLICATION_RESERVATION_INVALID",
      phase,
      project,
      `Reservation is in state ${resToken.state} (expected RESERVED or DISCARDED)`,
      generationId,
    );
  }

  const warnings: GenerationStoreWarning[] = [];
  let deleted = false;

  // Use centralized primitive (A3).
  {
    const tmpD = tmpDir(project, cacheRoot);
    const cleanupRes = unlinkStagingDurably(stagingPath, resToken.identity, tmpD, warnings);
    deleted = cleanupRes.removed && cleanupRes.confirmedAbsent;
  }

  // Mark reservation as DISCARDED.
  resToken.state = "DISCARDED";

  return { project, generationId, stagingPath, deleted, warnings };
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * R169B-STEP10 (A3): Centralized staging cleanup primitive.
 * Used by: publication normale, dedup, discardPreparedGeneration,
 * discardGenerationReservation, recovery.
 *
 * Pipeline:
 *   1. lstat staging path (ENOENT only = absent, EACCES/EIO = fail-closed)
 *   2. If present: compare dev/ino to expectedIdentity (if provided)
 *   3. unlink
 *   4. fsync tmp/ directory
 *   5. Confirm ENOENT
 *
 * Returns StagingCleanupResult with four boolean guarantees.
 * A cleanup is certified only if all four are true.
 */
interface StagingCleanupResult {
  identityMatched: boolean;
  removed: boolean;
  directoryDurable: boolean;
  confirmedAbsent: boolean;
  warnings: GenerationStoreWarning[];
}

function unlinkStagingDurably(
  stagingPath: string,
  expectedIdentity: { dev: number; ino: number } | null,
  tmpDirectory: string,
  warnings: GenerationStoreWarning[],
): StagingCleanupResult {
  const result: StagingCleanupResult = {
    identityMatched: false,
    removed: false,
    directoryDurable: false,
    confirmedAbsent: false,
    warnings,
  };

  // 1. lstat staging path.
  let stat: Stats | null = null;
  try {
    stat = lstatSync(stagingPath);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Already gone — skip to fsync + confirm.
      result.identityMatched = true;
      result.removed = true;
    } else {
      // EACCES/EIO/ENOTDIR — fail-closed.
      warnings.push({
        code: "STAGING_CLEANUP_DEFERRED",
        message: `Cannot lstat staging file: ${errCode} (${(e as Error).message})`,
      });
      return result;
    }
  }

  // 2. Verify identity (if stat succeeded).
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push({
        code: "STAGING_CLEANUP_DEFERRED",
        message: `Staging file is not a regular file: ${stagingPath}`,
      });
      return result;
    }
    if (expectedIdentity) {
      if (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
        warnings.push({
          code: "STAGING_CLEANUP_DEFERRED",
          message: `Staging identity mismatch (expected dev=${expectedIdentity.dev} ino=${expectedIdentity.ino}, got dev=${stat.dev} ino=${stat.ino}) — not unlinking`,
        });
        return result;
      }
    }
    result.identityMatched = true;

    // 3. Unlink.
    try {
      unlinkSync(stagingPath);
      result.removed = true;
    } catch (e) {
      warnings.push({
        code: "STAGING_CLEANUP_DEFERRED",
        message: `Failed to unlink staging file: ${(e as Error).message}`,
      });
      return result;
    }
  }

  // 4. fsync tmp/ directory.
  let tmpFd: number | null = null;
  try {
    const opened = openDirectoryNoFollow(tmpDirectory, PROD_OPS);
    tmpFd = opened.fd;
    PROD_OPS.fsyncSync(tmpFd);
    PROD_OPS.closeSync(tmpFd);
    tmpFd = null;
    result.directoryDurable = true;
  } catch (e) {
    if (tmpFd !== null) { try { PROD_OPS.closeSync(tmpFd); } catch {} }
    warnings.push({
      code: "TMP_DIR_FSYNC_DEFERRED",
      message: `fsync of tmp/ failed (non-fatal): ${(e as Error).message}`,
    });
  }

  // 5. Confirm ENOENT.
  try {
    lstatSync(stagingPath);
    // Still exists — not confirmed.
    warnings.push({
      code: "STAGING_CLEANUP_DEFERRED",
      message: `Staging file still exists after unlink: ${stagingPath}`,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      result.confirmedAbsent = true;
    } else {
      warnings.push({
        code: "STAGING_CLEANUP_DEFERRED",
        message: `lstat after unlink returned unexpected error: ${(e as Error).message}`,
      });
    }
  }

  return result;
}

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
  // R169B-STEP5 (META-R169B-A3-07): validate the metadata payload
  // against the strict V1 schema before writing. This catches any
  // missing/extra keys, invalid types, or incoherent dedup fields.
  try {
    validateGenerationMetadata(reparsed, project);
  } catch (e) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `Metadata sidecar payload failed V1 validation: ${(e as Error).message}`,
      generationId,
    );
  }
  // R169B-STEP10 (A4): Metadata no-clobber via link(temp, target).
  // Replace the raceable lstat → trim comparison → rename pipeline
  // with: create temp metadata O_EXCL → write → fsync → link(temp,
  // target) no-clobber → fsync generations/ → unlink temp → fsync.
  // On EEXIST: open target O_RDONLY|O_NOFOLLOW, read bounded, UTF-8
  // fatal, validate V1, compare canonical bytes exact (not trim).
  const metadataBuffer = Buffer.from(serialized + "\n", "utf8");
  const metadataTempNonce = randomUUID();
  const metadataTempPath = join(join(metadataPath, ".."), `.metadata-${generationId}-${metadataTempNonce}.tmp`);
  let metaTempFd: number | null = null;
  try {
    metaTempFd = openSync(metadataTempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (e) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `Failed to create metadata temp file: ${(e as Error).message}`,
      generationId,
    );
  }
  try {
    // Write the full payload.
    let offset = 0;
    while (offset < metadataBuffer.length) {
      const n = writeSync(metaTempFd, metadataBuffer, offset, metadataBuffer.length - offset, null);
      if (n <= 0) throw new Error("zero-progress write on metadata temp");
      offset += n;
    }
    // R169B (§6 GATE): fchmod(metaTempFd, 0600) + fstat verify.
    // The openSync with mode 0o600 is filtered by umask. fchmod forces
    // the exact mode regardless of umask. fstat verifies owner + mode.
    try {
      fs_fchmodSync(metaTempFd, 0o600);
      const modeStat = fstatSync(metaTempFd);
      if ((modeStat.mode & 0o777) !== 0o600) {
        throw new Error(`metadata temp mode is 0o${(modeStat.mode & 0o777).toString(8)} after fchmod (expected 0600)`);
      }
      if (typeof process.getuid === "function" && modeStat.uid !== process.getuid()) {
        throw new Error(`metadata temp owner uid=${modeStat.uid} != process uid=${process.getuid()}`);
      }
    } catch (e) {
      try { closeSync(metaTempFd); } catch {}
      try { unlinkSync(metadataTempPath); } catch {}
      throw new GenerationStoreError(
        "GENERATION_METADATA_INVALID",
        phase,
        project,
        `fchmod/fstat on metadata temp failed: ${(e as Error).message}`,
        generationId,
      );
    }
    // fsync the temp.
    fsyncSync(metaTempFd);
  } catch (e) {
    try { closeSync(metaTempFd); } catch {}
    try { unlinkSync(metadataTempPath); } catch {}
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `Failed to write/fsync metadata temp: ${(e as Error).message}`,
      generationId,
    );
  }
  try { closeSync(metaTempFd); } catch {}
  metaTempFd = null;

  // link(temp, target) — no-clobber.
  try {
    linkSync(metadataTempPath, metadataPath);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "EEXIST") {
      // Target already exists — verify it's byte-identical.
      try {
        const existingRaw = readFileSyncText(metadataPath, MAX_METADATA_SIDECAR_BYTES);
        // R169B-STEP10 (A4): exact byte comparison (not trim).
        if (existingRaw !== serialized + "\n") {
          // Not identical — corruption.
          try { unlinkSync(metadataTempPath); } catch {}
          throw new GenerationStoreError(
            "GENERATION_METADATA_INVALID",
            phase,
            project,
            `Existing metadata differs from new payload (no-clobber violation) — corruption detected`,
            generationId,
          );
        }
        // Byte-identical — idempotent re-publication. Clean up temp.
        try { unlinkSync(metadataTempPath); } catch {}
        return; // Skip the write — existing is identical.
      } catch (e2) {
        if (e2 instanceof GenerationStoreError) throw e2;
        try { unlinkSync(metadataTempPath); } catch {}
        throw new GenerationStoreError(
          "GENERATION_METADATA_INVALID",
          phase,
          project,
          `Failed to read existing metadata for comparison: ${(e2 as Error).message}`,
          generationId,
        );
      }
    } else {
      try { unlinkSync(metadataTempPath); } catch {}
      throw new GenerationStoreError(
        "GENERATION_METADATA_INVALID",
        phase,
        project,
        `link(temp, target) failed: ${(e as Error).message}`,
        generationId,
      );
    }
  }

  // link succeeded — fsync generations/ to make the directory entry durable.
  // R169B-STEP10 (§6 POST-PUSH): fsync failure here is FATAL. If the
  // directory entry is not durable, a crash could leave the manifest
  // pointing at a metadata file that doesn't exist on disk. This
  // violates the R169B contract and breaks recovery/GC.
  let metaDirFd: number | null = null;
  try {
    const metaDir = join(metadataPath, "..");
    const opened = openDirectoryNoFollow(metaDir, PROD_OPS);
    metaDirFd = opened.fd;
    PROD_OPS.fsyncSync(metaDirFd);
    PROD_OPS.closeSync(metaDirFd);
    metaDirFd = null;
  } catch (e) {
    if (metaDirFd !== null) { try { PROD_OPS.closeSync(metaDirFd); } catch {} }
    // FATAL: the metadata link may not survive a crash. Block the
    // manifest write by throwing. The caller will NOT mark metadata
    // as durable, and the manifest will not be written.
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      project,
      `fsync of generations/ after metadata link failed — metadata directory entry may not be durable: ${(e as Error).message}`,
      generationId,
    );
  }

  // Unlink temp (best-effort), then fsync generations/ again to make
  // the temp unlink durable.
  try { unlinkSync(metadataTempPath); } catch {}
  let metaDirFd2: number | null = null;
  try {
    const metaDir = join(metadataPath, "..");
    const opened = openDirectoryNoFollow(metaDir, PROD_OPS);
    metaDirFd2 = opened.fd;
    PROD_OPS.fsyncSync(metaDirFd2);
    PROD_OPS.closeSync(metaDirFd2);
    metaDirFd2 = null;
  } catch (e) {
    if (metaDirFd2 !== null) { try { PROD_OPS.closeSync(metaDirFd2); } catch {} }
    // Non-fatal — the temp unlink is best-effort. The metadata link
    // is already durable. An orphan temp will be swept by GC.
  }
}

// ─── R169B-STEP3 — Internal helpers (re-validation, hashing, IO) ─────────

/**
 * R169B-STEP3: Maximum size, in bytes, of a metadata sidecar file.
 * 256 KiB is generous for the V1 schema (which serializes to <4 KiB)
 * but bounded enough to prevent a malicious / corrupted sidecar from
 * exhausting memory.
 */
const MAX_METADATA_SIDECAR_BYTES = 256 * 1024;

/**
 * R169B-STEP3 (DATA-R169B-A1-03): Re-validate the staging content
 * before publication. The prepare function computed the SHA-256 and
 * recorded dev/ino/size in the token. We:
 *   1. lstat the staging file (reject symlink, require regular file).
 *   2. Compare dev/ino/size against the token's preStat.
 *   3. Open the file with O_RDONLY | O_NOFOLLOW (SEC-R169B-A1-07).
 *   4. fstat the fd and compare dev/ino against the lstat (TOCTOU).
 *   5. Compute the SHA-256 in streaming 64 KiB chunks.
 *   6. fstat the fd again and compare size/dev/ino against the
 *      pre-hash fstat (mid-hash swap detection).
 *   7. Compare the recomputed hash against the manifest's sha256.
 *
 * If any check fails, raise PUBLICATION_STAGING_MUTATED.
 */
function revalidateStagingContent(
  stagingPath: string,
  token: PreparedToken,
  expectedSha256: string,
  project: string,
  phase: string,
  generationId: string,
): void {
  // 1. lstat.
  let preStat: Stats;
  try {
    preStat = lstatSync(stagingPath);
  } catch (e) {
    throw new GenerationStoreError(
      "PUBLICATION_STAGING_MUTATED",
      phase,
      project,
      `Re-validation: cannot stat staging file "${stagingPath}": ${(e as Error).message}`,
      generationId,
    );
  }
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new GenerationStoreError(
      "PUBLICATION_STAGING_MUTATED",
      phase,
      project,
      `Re-validation: staging file is not a regular file: ${stagingPath}`,
      generationId,
    );
  }
  // 2. Compare dev/ino/size against the token's preStat.
  if (
    preStat.dev !== token.preStat.dev ||
    preStat.ino !== token.preStat.ino ||
    preStat.size !== token.preStat.size
  ) {
    throw new GenerationStoreError(
      "PUBLICATION_STAGING_MUTATED",
      phase,
      project,
      `Re-validation: staging file identity changed between prepare and publish (dev/ino/size: prepare=${token.preStat.dev}/${token.preStat.ino}/${token.preStat.size}, publish=${preStat.dev}/${preStat.ino}/${preStat.size})`,
      generationId,
    );
  }
  // 3-7. Re-hash with O_NOFOLLOW + fstat identity checks.
  const recomputedHash = computeSha256WithIdentityChecks(stagingPath, project, phase, generationId);
  if (recomputedHash !== expectedSha256) {
    throw new GenerationStoreError(
      "PUBLICATION_STAGING_MUTATED",
      phase,
      project,
      `Re-validation: staging file sha256 changed between prepare and publish (prepare=${expectedSha256}, publish=${recomputedHash})`,
      generationId,
    );
  }
}

/**
 * R169B-STEP3 (SEC-R169B-A1-07): Compute the SHA-256 of a file with
 * O_NOFOLLOW + fstat identity checks. Used by both the prepare
 * function (initial hash) and the publish function (re-validation),
 * and by the dedup candidate validation.
 *
 * Steps:
 *   1. lstat the path (reject symlink, require regular file).
 *   2. open with O_RDONLY | O_NOFOLLOW (Linux).
 *   3. fstat the fd and compare dev/ino against the lstat (TOCTOU).
 *   4. Read in 64 KiB chunks, updating the hasher.
 *   5. fstat the fd again and compare size/dev/ino against the
 *      pre-hash fstat (mid-read swap detection).
 *   6. Close the fd.
 *   7. Return the hex digest.
 */
function computeSha256WithIdentityChecks(
  path: string,
  project: string,
  phase: string,
  generationId: string,
): string {
  // 1. lstat.
  let preStat: Stats;
  try {
    preStat = lstatSync(path);
  } catch (e) {
    throw new GenerationStoreError(
      "GENERATION_HASH_FAILED",
      phase,
      project,
      `Cannot lstat file for hashing "${path}": ${(e as Error).message}`,
      generationId,
    );
  }
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new GenerationStoreError(
      "GENERATION_HASH_FAILED",
      phase,
      project,
      `File is not a regular file (symlink or other): ${path}`,
      generationId,
    );
  }
  // 2. open with O_NOFOLLOW.
  let fd: number | null = null;
  try {
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    fd = openSync(path, flags);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ELOOP") {
      throw new GenerationStoreError(
        "GENERATION_HASH_FAILED",
        phase,
        project,
        `File is a symlink (rejected by O_NOFOLLOW): ${path}`,
        generationId,
      );
    }
    throw new GenerationStoreError(
      "GENERATION_HASH_FAILED",
      phase,
      project,
      `Failed to open file for hashing "${path}" with O_NOFOLLOW: ${(e as Error).message}`,
      generationId,
    );
  }
  try {
    // 3. fstat the fd and compare against lstat.
    let fdStat: Stats;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fdStat = fstatSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "GENERATION_HASH_FAILED",
        phase,
        project,
        `fstat of fd failed for "${path}": ${(e as Error).message}`,
        generationId,
      );
    }
    if (fdStat.dev !== preStat.dev || fdStat.ino !== preStat.ino) {
      throw new GenerationStoreError(
        "GENERATION_HASH_FAILED",
        phase,
        project,
        `File was swapped between lstat and open (dev/ino mismatch): ${path}`,
        generationId,
      );
    }
    // 4. Read + hash.
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let totalRead = 0;
    while (true) {
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, chunk, 0, HASH_CHUNK_BYTES, null);
      } catch (e) {
        throw new GenerationStoreError(
          "GENERATION_HASH_FAILED",
          phase,
          project,
          `readSync failed at offset ${totalRead} for "${path}": ${(e as Error).message}`,
          generationId,
        );
      }
      if (bytesRead === 0) break;
      hasher.update(chunk.subarray(0, bytesRead));
      totalRead += bytesRead;
    }
    // 5. fstat again and compare.
    let postStat: Stats;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      postStat = fstatSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "GENERATION_HASH_FAILED",
        phase,
        project,
        `post-read fstat failed for "${path}": ${(e as Error).message}`,
        generationId,
      );
    }
    if (postStat.dev !== fdStat.dev || postStat.ino !== fdStat.ino || postStat.size !== fdStat.size) {
      throw new GenerationStoreError(
        "GENERATION_HASH_FAILED",
        phase,
        project,
        `File was mutated during hashing (dev/ino/size mismatch): ${path}`,
        generationId,
      );
    }
    return hasher.digest("hex");
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * R169B-STEP3: Compute the SHA-256 of a file (without the identity
 * checks). Used by the dedup candidate validation where the file is
 * already opened/validated separately. Delegates to
 * `computeSha256WithIdentityChecks` for safety.
 */
function computeSha256(
  path: string,
  project: string,
  phase: string,
  generationId: string,
): string {
  return computeSha256WithIdentityChecks(path, project, phase, generationId);
}

/**
 * R169B-STEP3: Read a file as UTF-8 text with a size bound. Used to
 * read the metadata sidecar for dedup validation. Rejects files
 * larger than `maxBytes`.
 */
function readFileSyncText(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const st = fstatSync(fd);
    if (st.size > maxBytes) {
      throw new Error(`file size ${st.size} exceeds max ${maxBytes}`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, null);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== buf.length) {
      throw new Error(`short read: expected ${buf.length} bytes, got ${offset}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// ─── R169B-STEP5 — Identity-safe cleanup helper (CLEANUP-R169B-A3-03) ────

/**
 * R169B-STEP5 (CLEANUP-R169B-A3-03): Identity-safe cleanup of an
 * unreferenced final DB. Used when the publication fails AFTER the
 * copy/reflink but BEFORE the manifest is written. The final DB is
 * on disk but no manifest points at it — it's an orphan.
 *
 * Steps:
 *   1. lstat the final DB (reject symlink, require regular file).
 *   2. unlink.
 *   3. fsync the generations/ directory.
 *   4. lstat to confirm ENOENT (not existsSync — lstat distinguishes
 *      ENOENT from EACCES/EIO).
 *   5. If any step fails, surface a structured warning (the orphan
 *      stays on disk; the next GC orphan pass will sweep it).
 *
 * This helper NEVER throws — it surfaces failures as warnings so the
 * caller can continue with the abort.
 */
export function _removeUnreferencedFinalOrRecordRecovery(
  finalPath: string,
  generationsDir: string,
  project: string,
  phase: string,
  generationId: string,
  expectedIdentity: FileIdentity | null,
  warnings: GenerationStoreWarning[],
): FinalCleanupResult {
  void project; void phase; void generationId;
  const result: {
    removed: boolean;
    durable: boolean;
    confirmedAbsent: boolean;
    identityMatched: boolean;
    warnings: GenerationStoreWarning[];
  } = {
    removed: false,
    durable: false,
    confirmedAbsent: false,
    identityMatched: false,
    warnings,
  };
  // 1. lstat the final DB.
  let st: Stats;
  try {
    st = lstatSync(finalPath);
    if (st.isSymbolicLink()) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Cleanup: final DB is a symlink (not unlinking): ${finalPath}`,
      });
      return result;
    }
    if (!st.isFile()) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Cleanup: final DB is not a regular file (not unlinking): ${finalPath}`,
      });
      return result;
    }
    // R169B-STEP6 (CLEANUP-R169B-A4-01): verify the identity matches
    // the expected identity (dev/ino/size). If it doesn't match, the
    // file was replaced — do NOT unlink (could be another process's file).
    if (expectedIdentity !== null) {
      if (st.dev !== expectedIdentity.dev || st.ino !== expectedIdentity.ino || st.size !== expectedIdentity.size) {
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Cleanup: final DB identity mismatch (expected dev=${expectedIdentity.dev} ino=${expectedIdentity.ino} size=${expectedIdentity.size}, got dev=${st.dev} ino=${st.ino} size=${st.size}) — not unlinking: ${finalPath}`,
        });
        return result;
      }
    }
    result.identityMatched = true;
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Already gone — nothing to clean up. This is a successful
      // idempotent cleanup.
      result.removed = true;
      result.confirmedAbsent = true;
      result.identityMatched = true; // no identity to match against
      return result;
    }
    warnings.push({
      code: "GC_DELETE_FAILED",
      message: `Cleanup: lstat of final DB failed: ${(e as Error).message}`,
    });
    return result;
  }
  // 2. unlink.
  try {
    unlinkSync(finalPath);
    result.removed = true;
  } catch (e) {
    warnings.push({
      code: "GC_DELETE_FAILED",
      message: `Cleanup: unlink of final DB failed: ${(e as Error).message}`,
    });
    return result;
  }
  // 3. fsync the generations/ directory.
  let dirFd: number | null = null;
  try {
    const opened = openDirectoryNoFollow(generationsDir, PROD_OPS);
    dirFd = opened.fd;
    PROD_OPS.fsyncSync(dirFd);
    PROD_OPS.closeSync(dirFd);
    dirFd = null;
    result.durable = true;
  } catch (e) {
    if (dirFd !== null) {
      try { PROD_OPS.closeSync(dirFd); } catch { /* best effort */ }
    }
    warnings.push({
      code: "GC_DELETE_FAILED",
      message: `Cleanup: fsync of generations/ after unlink failed: ${(e as Error).message}`,
    });
  }
  // 4. lstat to confirm ENOENT.
  try {
    lstatSync(finalPath);
    // If lstat succeeded, the file is still there.
    warnings.push({
      code: "GC_DELETE_FAILED",
      message: `Cleanup: final DB still exists after unlink: ${finalPath}`,
    });
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      result.confirmedAbsent = true;
    } else {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Cleanup: lstat after unlink returned ${errCode}: ${finalPath}`,
      });
    }
  }
  return result;
}
