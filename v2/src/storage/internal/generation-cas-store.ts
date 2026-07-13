/**
 * R169B-STEP2 — Content-Addressable Storage (CAS) SQLite store for the
 * generation publisher.
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This module owns the per-project CAS SQLite database
 * (`<projectStore>/publication-cas.sqlite`). The CAS is the publisher's
 * authoritative record of:
 *   - which generation is currently active (publication_state singleton),
 *   - which generations have ever been published (generation_catalog),
 *   - the append-only history of publication acts (publication_history).
 *
 * The CAS is the GC's source of truth for "which generations exist"
 * and "in what order were they published". The publisher uses the CAS
 * to:
 *   - serialize concurrent publications (BEGIN IMMEDIATE),
 *   - detect dedup candidates (same sha256+size+fingerprint+versions),
 *   - record the previous active ID for rollback / undo,
 *   - increment the revision (used by GC's stale-plan check).
 *
 * DEPENDENCY DIRECTION (R169B-STEP2):
 *   types -> paths/validation -> internal I/O + CAS store -> public facades
 *
 *   - This module imports types from `../generation-types.js`.
 *   - This module imports path helpers from `../generation-paths.js`.
 *   - This module imports trust-root / path-safety validators from
 *     `../generation-validation.js`.
 *   - This module imports `better-sqlite3` and `node:fs` / `node:path`.
 *   - The publisher (`../generation-publisher.js`) and the GC
 *     (`../generation-gc.js`) import from this module.
 *   - This module does NOT import from the public facades — the
 *     R169B-STEP1 module cycle is preserved as broken.
 *
 * TRANSACTION POLICY:
 *   - All write operations MUST run inside an explicit transaction.
 *   - The publisher uses `BEGIN IMMEDIATE` to serialize concurrent
 *     writers (a second writer blocks on the first COMMIT/ROLLBACK
 *     instead of dying with SQLITE_BUSY mid-statement).
 *   - The CAS DB is opened with `busy_timeout = 5000` so the second
 *     writer waits up to 5 seconds for the lock before failing.
 *
 * RECONCILE-FROM-MANIFEST POLICY (§16):
 *   - The active manifest (`active-generation.json`) is the GROUND
 *     TRUTH for "which generation is active". If the CAS disagrees
 *     (e.g. the CAS was restored from a backup that predates the
 *     current manifest), the CAS is reconciled to match the manifest.
 *   - The manifest is authoritative because it is the file readers
 *     consult; a CAS that disagrees with the manifest would be a lie.
 *   - Reconciliation increments the CAS revision (so a concurrent GC
 *     plan detects the change and aborts with GC_PLAN_STALE).
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync, lstatSync, chmodSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import {
  GenerationStoreError,
  type GenerationManifestV1,
  type CasGenerationCatalogEntry,
  type CasPublicationHistoryEntry,
  type CasReconcileResult,
  type CasDedupCandidate,
} from "../generation-types.js";
import {
  projectStoreDir,
  GENERATIONS_SUBDIR,
} from "../generation-paths.js";
import {
  assertTrustedRootNoSymlinks,
} from "../generation-validation.js";

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * The filename of the CAS SQLite DB inside the project store directory.
 */
export const CAS_DB_FILENAME = "publication-cas.sqlite";

/**
 * The schema for the CAS DB. Idempotent — uses CREATE IF NOT EXISTS.
 */
const CAS_SCHEMA_SQL = `
  -- Singleton: one row, primary key = 1. Holds the active generation ID
  -- and a monotonically increasing revision counter. The revision is
  -- bumped on every publication / reconciliation / pin / delete so a
  -- concurrent GC plan can detect that the CAS state changed between
  -- plan and apply (GC_PLAN_STALE).
  CREATE TABLE IF NOT EXISTS publication_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_generation_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    last_updated_at TEXT NOT NULL
  );

  -- Catalog: one row per generation ever published (including deleted).
  -- The GC uses status to skip DELETED entries; the publisher uses
  -- (sha256, size_bytes, root_fingerprint, extractor_semantics_version,
  -- discovery_policy_version) for dedup detection.
  CREATE TABLE IF NOT EXISTS generation_catalog (
    generation_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    root_fingerprint TEXT NOT NULL,
    extractor_semantics_version INTEGER NOT NULL,
    discovery_policy_version INTEGER NOT NULL,
    first_published_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETING', 'DELETED'))
  );

  -- Append-only history of publication acts. The GC uses
  -- (published_at DESC, history_id DESC) to order previous generations
  -- WITHOUT relying on mtime or readdir order.
  CREATE TABLE IF NOT EXISTS publication_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL,
    project TEXT NOT NULL,
    published_at TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('PUBLISH', 'UNPUBLISH', 'DELETE', 'PIN', 'UNPIN', 'MARK_DELETING')),
    previous_active_generation_id TEXT,
    cas_revision INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_publication_history_gen ON publication_history(generation_id);
  CREATE INDEX IF NOT EXISTS idx_publication_history_published ON publication_history(published_at);
  CREATE INDEX IF NOT EXISTS idx_generation_catalog_status ON generation_catalog(status);
  CREATE INDEX IF NOT EXISTS idx_generation_catalog_sha ON generation_catalog(sha256, size_bytes);
`;

// ─── CAS store interface ─────────────────────────────────────────────────

/**
 * R169B-STEP2: The CAS store handle. Wraps a `better-sqlite3` Database
 * connection and exposes the operations the publisher and GC need.
 *
 * The handle is created by `openCasStore` and MUST be closed by the
 * caller via `close()` when done. Holding the handle for the duration
 * of a publication / GC pass is the intended usage.
 */
export interface CasStore {
  /** The absolute path to the CAS DB file. */
  readonly dbPath: string;

  /** Begin a write transaction with BEGIN IMMEDIATE (serializes writers). */
  beginImmediate(): void;

  /** Commit the current transaction. */
  commit(): void;

  /** Rollback the current transaction. Safe to call if no txn is active. */
  rollback(): void;

  /**
   * Get the active generation ID from the CAS singleton. Returns null
   * if no generation has ever been published (or the singleton row
   * does not exist yet — `openCasStore` initializes it to NULL/0).
   */
  getActiveGenerationId(): string | null;

  /**
   * Set the active generation ID. The caller MUST have started a
   * transaction (beginImmediate) and MUST increment the revision
   * in the same transaction. This method does NOT increment the
   * revision by itself — use `incrementRevision` for that.
   */
  setActiveGenerationId(generationId: string | null): void;

  /** Get the current CAS revision (0 on a fresh DB). */
  getRevision(): number;

  /**
   * Increment the CAS revision by 1 and return the new value. The
   * caller MUST have started a transaction.
   */
  incrementRevision(): number;

  /**
   * Insert or update a catalog entry. The caller MUST have started a
   * transaction.
   */
  upsertGenerationCatalog(entry: CasGenerationCatalogEntry): void;

  /**
   * Look up a catalog entry by generation ID. Returns undefined if not
   * found. Read-only — does not require a transaction.
   */
  getGenerationCatalogEntry(generationId: string): CasGenerationCatalogEntry | undefined;

  /**
   * List all catalog entries with the given status. Read-only.
   */
  listCatalogEntriesByStatus(status: "ACTIVE" | "DELETING" | "DELETED"): CasGenerationCatalogEntry[];

  /**
   * Find a dedup candidate: an ACTIVE catalog entry whose sha256,
   * size_bytes, root_fingerprint, extractor_semantics_version, and
   * discovery_policy_version all match the prepared generation's
   * values. Returns undefined if no match. Read-only.
   */
  findDedupCandidate(
    sha256: string,
    sizeBytes: number,
    rootFingerprint: string,
    extractorSemanticsVersion: number,
    discoveryPolicyVersion: number,
  ): CasDedupCandidate | undefined;

  /**
   * Append a row to publication_history. The caller MUST have started
   * a transaction.
   */
  appendPublicationHistory(
    generationId: string,
    project: string,
    action: CasPublicationHistoryEntry["action"],
    previousActiveGenerationId: string | null,
  ): void;

  /**
   * List publication_history entries for a project, ordered
   * most-recent-first (published_at DESC, history_id DESC). The GC
   * uses this to determine the order of previous generations without
   * relying on mtime or readdir order. Read-only.
   */
  listPublicationHistory(project: string): CasPublicationHistoryEntry[];

  /**
   * Mark a catalog entry's status (e.g. ACTIVE -> DELETING -> DELETED).
   * The caller MUST have started a transaction.
   */
  setCatalogStatus(generationId: string, status: "ACTIVE" | "DELETING" | "DELETED"): void;

  /**
   * Set the pinned flag on a catalog entry. The caller MUST have
   * started a transaction.
   */
  setCatalogPinned(generationId: string, pinned: boolean): void;

  /**
   * R169B-STEP2 §16: Reconcile CAS state from the active manifest.
   *
   * The active manifest is GROUND TRUTH. If the CAS's
   * active_generation_id differs from the manifest's
   * generationId (or the manifest is absent and the CAS has a
   * non-null active ID), the CAS is updated to match and the revision
   * is incremented. This is safe to call INSIDE an existing
   * transaction (it does not begin/commit on its own).
   *
   * Returns the reconciled state.
   */
  reconcileFromManifest(manifest: GenerationManifestV1 | null): CasReconcileResult;

  /** Close the underlying DB connection. */
  close(): void;
}

// ─── Open / create ───────────────────────────────────────────────────────

/**
 * R169B-STEP2: Open (or create) the CAS DB for a project.
 *
 * The CAS DB lives at `<projectStore>/publication-cas.sqlite`. If the
 * file does not exist, it is created with the CAS schema and an
 * initial singleton row (active_generation_id=NULL, revision=0).
 *
 * The DB is opened with `busy_timeout = 5000` so concurrent writers
 * block (up to 5 seconds) instead of failing immediately with
 * SQLITE_BUSY. The publisher still uses `BEGIN IMMEDIATE` to serialize
 * — the busy_timeout is a safety net for the rare race where two
 * publishers start at exactly the same instant.
 *
 * The trust root (cacheRoot -> cbm -> projects -> project-key) is
 * validated BEFORE the DB is opened, closing the bypass where a
 * symlinked parent could redirect the open to an attacker-controlled
 * path.
 */
export function openCasStore(
  project: string,
  cacheRoot?: string,
): CasStore {
  const phase = "openCasStore";
  assertTrustedRootNoSymlinks(cacheRoot ?? "", project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  // Ensure the project store directory exists with mode 0o700. The
  // layout durability helper from R169A would also fsync the parent
  // chain; here we only need the leaf to exist so the CAS DB file can
  // be created. Tests typically pre-create the layout via
  // ensureGenerationStoreLayoutDurable.
  if (!existsSync(projectStore)) {
    try {
      mkdirSync(projectStore, { recursive: true, mode: 0o700 });
      // mkdirSync mode is filtered by umask — force the exact mode.
      chmodSync(projectStore, 0o700);
    } catch (e) {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_STATE_CORRUPT",
        phase,
        project,
        `Failed to create project store directory "${projectStore}" for CAS DB: ${(e as Error).message}`,
      );
    }
  }

  const dbPath = join(projectStore, CAS_DB_FILENAME);

  // R169B-STEP3 (CAS-R169B-A1-08): Harden the CAS DB path BEFORE
  // opening it. If the file already exists, it MUST be a regular
  // file (not a symlink, not a directory, not a FIFO). If it does
  // not exist, we open it with O_CREAT|O_EXCL|O_WRONLY mode 0600
  // so it is created with the right permissions and we fsync the
  // parent directory so the new directory entry is durable.
  try {
    const st = lstatSync(dbPath);
    if (st.isSymbolicLink()) {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_STATE_CORRUPT",
        phase,
        project,
        `CAS DB is a symlink (rejected): ${dbPath}`,
      );
    }
    if (!st.isFile()) {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_STATE_CORRUPT",
        phase,
        project,
        `CAS DB path is not a regular file: ${dbPath} (mode=0o${st.mode.toString(8)})`,
      );
    }
    // Force the mode to 0600 (owner read/write only). If the file
    // was created by an older version with 0644, fix it.
    if ((st.mode & 0o777) !== 0o600) {
      try {
        chmodSync(dbPath, 0o600);
      } catch (e) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `CAS DB has insecure mode 0o${(st.mode & 0o777).toString(8)} and chmod to 0600 failed: ${(e as Error).message}`,
        );
      }
    }
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode !== "ENOENT") {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_STATE_CORRUPT",
        phase,
        project,
        `Failed to lstat CAS DB at "${dbPath}": ${(e as Error).message}`,
      );
    }
    // ENOENT — the file does not exist yet. Create it exclusively
    // with mode 0600 so better-sqlite3 inherits the right mode.
    let fd: number | null = null;
    try {
      fd = openSync(dbPath, "wx", 0o600);
    } catch (e2) {
      // Race: another process created it. That's fine — re-lstat
      // will pick up the existing file. If the open failed for
      // another reason, raise.
      const errCode2 = (e2 as NodeJS.ErrnoException).code;
      if (errCode2 !== "EEXIST") {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `Failed to exclusively create CAS DB at "${dbPath}": ${(e2 as Error).message}`,
        );
      }
    }
    if (fd !== null) {
      try { fsyncSync(fd); } catch { /* best effort */ }
      try { closeSync(fd); } catch { /* best effort */ }
      // fsync the parent directory so the new directory entry is durable.
      let parentFd: number | null = null;
      try {
        parentFd = openSync(projectStore, "r");
        fsyncSync(parentFd);
      } catch {
        // Best-effort — the parent fsync is not strictly required
        // for correctness (the next publication / GC will retry),
        // but it is recommended.
      } finally {
        if (parentFd !== null) {
          try { closeSync(parentFd); } catch { /* best effort */ }
        }
      }
    }
  }

  let db: DatabaseType;
  try {
    db = new Database(dbPath, { fileMustExist: false });
  } catch (e) {
    throw new GenerationStoreError(
      "PUBLICATION_CAS_STATE_CORRUPT",
      phase,
      project,
      `Failed to open CAS DB at "${dbPath}": ${(e as Error).message}`,
    );
  }

  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    // R169B-STEP3 (SQLITE-R169B-A1-06): CAS DB uses DELETE journal
    // mode (was WAL). The CAS is small, mono-project, and serialized
    // by BEGIN IMMEDIATE. DELETE simplifies the durability contract:
    // there are no -wal/-shm sidecars to leak / chmod / fsync. The
    // previous WAL choice contradicted the commit message and
    // complicated crash-recovery reasoning.
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = FULL");
    db.exec(CAS_SCHEMA_SQL);

    // Initialize the singleton row if it does not exist.
    const row = db.prepare("SELECT COUNT(*) AS c FROM publication_state WHERE id = 1").get() as { c: number };
    if (row.c === 0) {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO publication_state (id, active_generation_id, revision, last_updated_at) VALUES (1, NULL, 0, ?)",
      ).run(now);
    }
  } catch (e) {
    try { db.close(); } catch { /* best effort */ }
    if (e instanceof GenerationStoreError) throw e;
    throw new GenerationStoreError(
      "PUBLICATION_CAS_STATE_CORRUPT",
      phase,
      project,
      `Failed to initialize CAS schema at "${dbPath}": ${(e as Error).message}`,
    );
  }

  return createCasStoreHandle(db, dbPath, project);
}

// ─── Internal: handle implementation ─────────────────────────────────────

/**
 * Create the CasStore handle around an open DB connection. Split out
 * from `openCasStore` so tests can wrap an existing connection (e.g.
 * to inject a fault-inducing DB).
 */
function createCasStoreHandle(
  db: DatabaseType,
  dbPath: string,
  project: string,
): CasStore {
  const phase = "CasStore";

  function ensureTxn(action: string): void {
    if (!db.inTransaction) {
      throw new GenerationStoreError(
        "PUBLICATION_CAS_STATE_CORRUPT",
        phase,
        project,
        `${action} called outside a transaction (use beginImmediate first)`,
      );
    }
  }

  return {
    dbPath,

    beginImmediate(): void {
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (e) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_BUSY",
          phase,
          project,
          `BEGIN IMMEDIATE failed (concurrent writer holding lock?): ${(e as Error).message}`,
        );
      }
    },

    commit(): void {
      try {
        db.exec("COMMIT");
      } catch (e) {
        // Best-effort rollback to avoid leaving a dangling txn.
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `COMMIT failed: ${(e as Error).message}`,
        );
      }
    },

    rollback(): void {
      try {
        if (db.inTransaction) {
          db.exec("ROLLBACK");
        }
      } catch {
        // Ignore — rollback is best-effort cleanup.
      }
    },

    getActiveGenerationId(): string | null {
      const row = db
        .prepare("SELECT active_generation_id AS a FROM publication_state WHERE id = 1")
        .get() as { a: string | null } | undefined;
      return row?.a ?? null;
    },

    setActiveGenerationId(generationId: string | null): void {
      ensureTxn("setActiveGenerationId");
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE publication_state SET active_generation_id = ?, last_updated_at = ? WHERE id = 1",
      ).run(generationId, now);
    },

    getRevision(): number {
      const row = db
        .prepare("SELECT revision AS r FROM publication_state WHERE id = 1")
        .get() as { r: number } | undefined;
      return row?.r ?? 0;
    },

    incrementRevision(): number {
      ensureTxn("incrementRevision");
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE publication_state SET revision = revision + 1, last_updated_at = ? WHERE id = 1",
      ).run(now);
      const row = db
        .prepare("SELECT revision AS r FROM publication_state WHERE id = 1")
        .get() as { r: number };
      return row.r;
    },

    upsertGenerationCatalog(entry: CasGenerationCatalogEntry): void {
      ensureTxn("upsertGenerationCatalog");
      // R169B-STEP3 (CAS-R169B-A1-18): An existing UUID is IMMUTABLE.
      // sha256, size_bytes, root_fingerprint, extractor_semantics_version,
      // discovery_policy_version, project, first_published_at cannot
      // change. Only last_seen_at, pinned, status can transition
      // (according to a valid state machine). A content mismatch on an
      // existing UUID is corruption — we raise instead of overwriting.
      const existing = db.prepare(`
        SELECT generation_id, project, sha256, size_bytes, root_fingerprint,
               extractor_semantics_version, discovery_policy_version,
               first_published_at
        FROM generation_catalog WHERE generation_id = ?
      `).get(entry.generationId) as
        | {
            generation_id: string;
            project: string;
            sha256: string;
            size_bytes: number;
            root_fingerprint: string;
            extractor_semantics_version: number;
            discovery_policy_version: number;
            first_published_at: string;
          }
        | undefined;
      if (existing === undefined) {
        // New entry — INSERT as-is.
        db.prepare(`
          INSERT INTO generation_catalog (
            generation_id, project, sha256, size_bytes, root_fingerprint,
            extractor_semantics_version, discovery_policy_version,
            first_published_at, last_seen_at, pinned, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.generationId,
          entry.project,
          entry.sha256,
          entry.sizeBytes,
          entry.rootFingerprint,
          entry.extractorSemanticsVersion,
          entry.discoveryPolicyVersion,
          entry.firstPublishedAt,
          entry.lastSeenAt,
          entry.pinned ? 1 : 0,
          entry.status,
        );
        return;
      }
      // Existing entry — verify content is byte-identical.
      if (
        existing.project !== entry.project ||
        existing.sha256 !== entry.sha256 ||
        existing.size_bytes !== entry.sizeBytes ||
        existing.root_fingerprint !== entry.rootFingerprint ||
        existing.extractor_semantics_version !== entry.extractorSemanticsVersion ||
        existing.discovery_policy_version !== entry.discoveryPolicyVersion ||
        existing.first_published_at !== entry.firstPublishedAt
      ) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          entry.project,
          `Refused to mutate immutable content fields of existing catalog entry ${entry.generationId} (sha256/size/fingerprint/versions/project/firstPublishedAt mismatch)`,
          entry.generationId,
        );
      }
      // Update only the mutable fields: last_seen_at, pinned, status.
      // Status transitions are validated: ACTIVE -> DELETING -> DELETED
      // is the only allowed path (DELETED is terminal).
      const allowedTransitions: Record<string, Set<string>> = {
        ACTIVE: new Set(["ACTIVE", "DELETING"]),
        DELETING: new Set(["DELETING", "DELETED"]),
        DELETED: new Set(["DELETED"]),
      };
      const currentStatusRow = db.prepare(
        "SELECT status AS s FROM generation_catalog WHERE generation_id = ?",
      ).get(entry.generationId) as { s: string };
      const currentStatus = currentStatusRow.s;
      const allowed = allowedTransitions[currentStatus] ?? new Set<string>();
      if (!allowed.has(entry.status)) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          entry.project,
          `Refused invalid catalog status transition for ${entry.generationId}: ${currentStatus} -> ${entry.status}`,
          entry.generationId,
        );
      }
      db.prepare(`
        UPDATE generation_catalog SET
          last_seen_at = ?,
          pinned = ?,
          status = ?
        WHERE generation_id = ?
      `).run(
        entry.lastSeenAt,
        entry.pinned ? 1 : 0,
        entry.status,
        entry.generationId,
      );
    },

    getGenerationCatalogEntry(generationId: string): CasGenerationCatalogEntry | undefined {
      const row = db.prepare(`
        SELECT generation_id, project, sha256, size_bytes, root_fingerprint,
               extractor_semantics_version, discovery_policy_version,
               first_published_at, last_seen_at, pinned, status
        FROM generation_catalog WHERE generation_id = ?
      `).get(generationId) as
        | {
            generation_id: string;
            project: string;
            sha256: string;
            size_bytes: number;
            root_fingerprint: string;
            extractor_semantics_version: number;
            discovery_policy_version: number;
            first_published_at: string;
            last_seen_at: string;
            pinned: number;
            status: string;
          }
        | undefined;
      if (!row) return undefined;
      return {
        generationId: row.generation_id,
        project: row.project,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        rootFingerprint: row.root_fingerprint,
        extractorSemanticsVersion: row.extractor_semantics_version,
        discoveryPolicyVersion: row.discovery_policy_version,
        firstPublishedAt: row.first_published_at,
        lastSeenAt: row.last_seen_at,
        pinned: row.pinned === 1,
        status: row.status as "ACTIVE" | "DELETING" | "DELETED",
      };
    },

    listCatalogEntriesByStatus(status: "ACTIVE" | "DELETING" | "DELETED"): CasGenerationCatalogEntry[] {
      const rows = db.prepare(`
        SELECT generation_id, project, sha256, size_bytes, root_fingerprint,
               extractor_semantics_version, discovery_policy_version,
               first_published_at, last_seen_at, pinned, status
        FROM generation_catalog WHERE status = ?
        ORDER BY first_published_at ASC
      `).all(status) as Array<{
        generation_id: string;
        project: string;
        sha256: string;
        size_bytes: number;
        root_fingerprint: string;
        extractor_semantics_version: number;
        discovery_policy_version: number;
        first_published_at: string;
        last_seen_at: string;
        pinned: number;
        status: string;
      }>;
      return rows.map((row) => ({
        generationId: row.generation_id,
        project: row.project,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        rootFingerprint: row.root_fingerprint,
        extractorSemanticsVersion: row.extractor_semantics_version,
        discoveryPolicyVersion: row.discovery_policy_version,
        firstPublishedAt: row.first_published_at,
        lastSeenAt: row.last_seen_at,
        pinned: row.pinned === 1,
        status: row.status as "ACTIVE" | "DELETING" | "DELETED",
      }));
    },

    findDedupCandidate(
      sha256: string,
      sizeBytes: number,
      rootFingerprint: string,
      extractorSemanticsVersion: number,
      discoveryPolicyVersion: number,
    ): CasDedupCandidate | undefined {
      const row = db.prepare(`
        SELECT generation_id, sha256, size_bytes, root_fingerprint,
               extractor_semantics_version, discovery_policy_version
        FROM generation_catalog
        WHERE status = 'ACTIVE'
          AND sha256 = ?
          AND size_bytes = ?
          AND root_fingerprint = ?
          AND extractor_semantics_version = ?
          AND discovery_policy_version = ?
        ORDER BY last_seen_at DESC
        LIMIT 1
      `).get(sha256, sizeBytes, rootFingerprint, extractorSemanticsVersion, discoveryPolicyVersion) as
        | {
            generation_id: string;
            sha256: string;
            size_bytes: number;
            root_fingerprint: string;
            extractor_semantics_version: number;
            discovery_policy_version: number;
          }
        | undefined;
      if (!row) return undefined;
      return {
        generationId: row.generation_id,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        rootFingerprint: row.root_fingerprint,
        extractorSemanticsVersion: row.extractor_semantics_version,
        discoveryPolicyVersion: row.discovery_policy_version,
      };
    },

    appendPublicationHistory(
      generationId: string,
      projectArg: string,
      action: CasPublicationHistoryEntry["action"],
      previousActiveGenerationId: string | null,
    ): void {
      ensureTxn("appendPublicationHistory");
      // R169B-STEP3 (CAS-R169B-A1-18): incrementRevision MUST be called
      // BEFORE appending the history row, so cas_revision in the row
      // is the NEW revision (not the old one). The previous code read
      // the revision before incrementing, so the history row was off
      // by one.
      // Also: do NOT write an empty generation_id (was the bug when
      // reconcileFromManifest(null) wrote action=UNPUBLISH with
      // generation_id=""). The history row's generation_id is the
      // generation the action is ABOUT — for UNPUBLISH it is the
      // generation that WAS active (i.e. previousActiveGenerationId).
      // For PUBLISH/PIN/UNPIN/MARK_DELETING/DELETE it is the
      // generation the action targets.
      const effectiveGenerationId = generationId === "" ? (previousActiveGenerationId ?? "") : generationId;
      if (effectiveGenerationId === "") {
        // Refuse to write a history row with no generation_id and no
        // previousActiveGenerationId — that would be a meaningless row.
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          projectArg,
          `appendPublicationHistory: refusing to write history row with empty generation_id and empty previousActiveGenerationId (action=${action})`,
        );
      }
      const now = new Date().toISOString();
      // Increment revision FIRST.
      db.prepare(
        "UPDATE publication_state SET revision = revision + 1, last_updated_at = ? WHERE id = 1",
      ).run(now);
      const newRev = (db
        .prepare("SELECT revision AS r FROM publication_state WHERE id = 1")
        .get() as { r: number }).r;
      db.prepare(`
        INSERT INTO publication_history (
          generation_id, project, published_at, action,
          previous_active_generation_id, cas_revision
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        effectiveGenerationId,
        projectArg,
        now,
        action,
        previousActiveGenerationId,
        newRev,
      );
    },

    listPublicationHistory(projectArg: string): CasPublicationHistoryEntry[] {
      const rows = db.prepare(`
        SELECT history_id, generation_id, project, published_at, action,
               previous_active_generation_id, cas_revision
        FROM publication_history
        WHERE project = ?
        ORDER BY published_at DESC, history_id DESC
      `).all(projectArg) as Array<{
        history_id: number;
        generation_id: string;
        project: string;
        published_at: string;
        action: string;
        previous_active_generation_id: string | null;
        cas_revision: number;
      }>;
      return rows.map((row) => ({
        historyId: row.history_id,
        generationId: row.generation_id,
        project: row.project,
        publishedAt: row.published_at,
        action: row.action as CasPublicationHistoryEntry["action"],
        previousActiveGenerationId: row.previous_active_generation_id,
        casRevision: row.cas_revision,
      }));
    },

    setCatalogStatus(generationId: string, status: "ACTIVE" | "DELETING" | "DELETED"): void {
      ensureTxn("setCatalogStatus");
      // R169B-STEP3 (CAS-R169B-A1-18): setCatalogStatus MUST verify
      // exactly one row was affected. Zero rows means the generation
      // is unknown to the catalog — the caller is operating on a
      // stale plan. Two or more rows is impossible (generation_id is
      // PRIMARY KEY) but we assert defensively.
      // Validate the status transition: ACTIVE -> DELETING -> DELETED
      // is the only allowed path.
      const currentRow = db.prepare(
        "SELECT status AS s FROM generation_catalog WHERE generation_id = ?",
      ).get(generationId) as { s: string } | undefined;
      if (currentRow === undefined) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `setCatalogStatus: generation ${generationId} not in catalog`,
          generationId,
        );
      }
      const allowedTransitions: Record<string, Set<string>> = {
        ACTIVE: new Set(["DELETING"]),
        DELETING: new Set(["DELETED"]),
        DELETED: new Set<string>(),
      };
      const allowed = allowedTransitions[currentRow.s] ?? new Set<string>();
      if (!allowed.has(status)) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `setCatalogStatus: invalid transition ${currentRow.s} -> ${status} for ${generationId}`,
          generationId,
        );
      }
      const info = db.prepare(
        "UPDATE generation_catalog SET status = ? WHERE generation_id = ?",
      ).run(status, generationId);
      if (info.changes !== 1) {
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `setCatalogStatus: expected exactly 1 row affected, got ${info.changes} (generationId=${generationId})`,
          generationId,
        );
      }
    },

    setCatalogPinned(generationId: string, pinned: boolean): void {
      ensureTxn("setCatalogPinned");
      db.prepare(
        "UPDATE generation_catalog SET pinned = ? WHERE generation_id = ?",
      ).run(pinned ? 1 : 0, generationId);
    },

    reconcileFromManifest(manifest: GenerationManifestV1 | null): CasReconcileResult {
      // Safe to call inside or outside a transaction. If outside, we
      // wrap the reconcile in its own BEGIN IMMEDIATE so it is atomic.
      const ownsTxn = !db.inTransaction;
      if (ownsTxn) {
        try { db.exec("BEGIN IMMEDIATE"); } catch (e) {
          throw new GenerationStoreError(
            "PUBLICATION_CAS_BUSY",
            phase,
            project,
            `reconcileFromManifest: BEGIN IMMEDIATE failed: ${(e as Error).message}`,
          );
        }
      }
      try {
        const row = db
          .prepare("SELECT active_generation_id AS a, revision AS r FROM publication_state WHERE id = 1")
          .get() as { a: string | null; r: number };
        const casActive = row.a;
        const manifestActive = manifest?.generationId ?? null;

        if (casActive === manifestActive) {
          // No reconciliation needed. Read the revision (do not bump).
          return {
            activeGenerationId: casActive,
            revision: row.r,
            reconciled: false,
          };
        }

        // Reconcile: update the active ID to match the manifest, bump
        // the revision, and append a history row recording the
        // reconciliation (action=UNPUBLISH if manifest is null,
        // action=PUBLISH if manifest is non-null — this is a CAS-only
        // reconcile, the on-disk files are NOT touched).
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE publication_state SET active_generation_id = ?, revision = revision + 1, last_updated_at = ? WHERE id = 1",
        ).run(manifestActive, now);
        const newRev = (db
          .prepare("SELECT revision AS r FROM publication_state WHERE id = 1")
          .get() as { r: number }).r;
        // R169B-STEP3 (CAS-R169B-A1-18): do NOT write an empty
        // generation_id. For UNPUBLISH (manifest is null), the
        // history row's generation_id is the generation that WAS
        // active (casActive). If casActive is also null, we don't
        // write a history row at all (there's nothing to reconcile
        // from).
        const action = manifestActive === null ? "UNPUBLISH" : "PUBLISH";
        const historyGenerationId = manifestActive ?? casActive;
        if (historyGenerationId !== null) {
          db.prepare(`
            INSERT INTO publication_history (
              generation_id, project, published_at, action,
              previous_active_generation_id, cas_revision
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            historyGenerationId,
            project,
            now,
            action,
            casActive,
            newRev,
          );
        }

        if (ownsTxn) {
          try { db.exec("COMMIT"); } catch (e) {
            try { db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw new GenerationStoreError(
              "PUBLICATION_CAS_STATE_CORRUPT",
              phase,
              project,
              `reconcileFromManifest: COMMIT failed: ${(e as Error).message}`,
            );
          }
        }
        return {
          activeGenerationId: manifestActive,
          revision: newRev,
          reconciled: true,
        };
      } catch (e) {
        if (ownsTxn) {
          try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        }
        if (e instanceof GenerationStoreError) throw e;
        throw new GenerationStoreError(
          "PUBLICATION_CAS_STATE_CORRUPT",
          phase,
          project,
          `reconcileFromManifest failed: ${(e as Error).message}`,
        );
      }
    },

    close(): void {
      try { db.close(); } catch { /* best effort */ }
    },
  };
}

// Re-export the path helpers the publisher / GC need for joining the
// generations/ subdirectory. They are re-exported here so the publisher
// has a single import surface for "all things CAS-related".
export {
  projectStoreDir,
  GENERATIONS_SUBDIR,
  resolve,
  dirname,
};
