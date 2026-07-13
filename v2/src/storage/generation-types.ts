/**
 * R169A — Atomic Generation Publication: strict type definitions.
 *
 * SIG-R169-Phase-B is CLOSED. This is the PRODUCT R169 — generation store
 * foundation. The types defined here are the contract for immutable SQLite
 * snapshots published via an atomic manifest.
 *
 * STATUS: FOUNDATION / INACTIVE
 * The types exist and are tested, but no production code uses them yet.
 * The indexer still writes to the legacy DB path. Readers still open the
 * legacy DB directly. No generation has ever been published.
 *
 * Invariants (section 4 of the R169A specification):
 *   - A published generation is immutable.
 *   - No writer modifies a DB already referenced by active-generation.json.
 *   - A reader always sees either the old complete snapshot or the new
 *     complete snapshot — never a partial snapshot.
 *
 * R169A-FIX-R2 (GPT 5.6 pass 2 audit) changes:
 *   - `MANIFEST_V1_KEYS` is now exported as a readonly tuple (`as const`),
 *     NOT a mutable `Set`. The validator uses a private
 *     `MANIFEST_V1_KEY_SET` that consumers cannot mutate. This prevents a
 *     consumer from `.add()`-ing a key to the authority and bypassing the
 *     "exact key set" check.
 *   - `LEGACY_SOURCE_OPEN_FAILED` renamed to `LEGACY_SOURCE_INVALID`.
 *     R169A validates path + regular-file identity only; the actual
 *     SQLite open validation occurs in R169D reader cutover.
 *   - New error codes:
 *       `MANIFEST_TOO_LARGE`              — manifest file exceeds the
 *                                            64 KiB size bound.
 *       `STORE_LAYOUT_CREATE_FAILED`      — `mkdir` of a layout directory
 *                                            failed.
 *       `STORE_LAYOUT_DURABILITY_UNKNOWN` — directory or parent fsync
 *                                            failed during layout setup.
 */

// ─── Manifest V1 ────────────────────────────────────────────────────────

/**
 * The on-disk manifest format for a published generation.
 *
 * Stored as `active-generation.json` in the project store directory.
 * The exact key set is enforced — no extra keys are allowed for V1.
 * A future incompatible change requires bumping formatVersion.
 */
export interface GenerationManifestV1 {
  /** Must be CURRENT_GENERATION_MANIFEST_VERSION (1). */
  readonly formatVersion: 1;

  /** The project name. Must match the requested project exactly. */
  readonly project: string;

  /** Canonical UUID v4 of this generation. */
  readonly generationId: string;

  /**
   * Relative path to the DB file, from the project store directory.
   * R169A-FIX (DATA-R169A-01): dbFile MUST be exactly
   *   `generations/generation-<generationId>.db`
   * No other form is accepted.
   */
  readonly dbFile: string;

  /** ISO-8601 timestamp WITH timezone. Example: `2026-07-13T00:00:00.000Z`. */
  readonly createdAt: string;

  /** Stable fingerprint of the project root (dev:ino or equivalent). */
  readonly rootFingerprint: string;

  /** Extractor semantics version at the time of generation. Must be >= 0. */
  readonly extractorSemanticsVersion: number;

  /** Discovery policy version at the time of generation. Must be >= 0. */
  readonly discoveryPolicyVersion: number;

  /** Number of nodes in the generation DB. Must be >= 0. */
  readonly nodeCount: number;

  /** Number of edges in the generation DB. Must be >= 0. */
  readonly edgeCount: number;

  /** Number of file_hashes rows in the generation DB. Must be >= 0. */
  readonly fileCount: number;

  /** Size of the DB file in bytes. Must be >= 0. */
  readonly sizeBytes: number;

  /** SHA-256 of the DB file content. Must be 64 lowercase hex chars. */
  readonly sha256: string;
}

/**
 * R169A-FIX-R2 (VALID-R169A-R2-01): The exact set of keys allowed in a V1
 * manifest, exported as a readonly tuple. Consumers CANNOT mutate this
 * list (no `.add()` / `.delete()` on a tuple). The validator uses a
 * private `MANIFEST_V1_KEY_SET` derived from this tuple; that set is
 * NOT exported, so a consumer cannot mutate the authority either.
 *
 * Use `MANIFEST_V1_KEYS` for diagnostics / inspection only. Validation
 * lives in `validateGenerationManifest` and uses the private set.
 */
export const MANIFEST_V1_KEYS = [
  "formatVersion",
  "project",
  "generationId",
  "dbFile",
  "createdAt",
  "rootFingerprint",
  "extractorSemanticsVersion",
  "discoveryPolicyVersion",
  "nodeCount",
  "edgeCount",
  "fileCount",
  "sizeBytes",
  "sha256",
] as const;

/**
 * Private, non-exported set used by the validator. A consumer cannot
 * reach into this set to add a key (the symbol is module-scoped).
 */
const MANIFEST_V1_KEY_SET: ReadonlySet<string> = new Set<string>(MANIFEST_V1_KEYS);

/**
 * R169A-FIX-R2 (VALID-R169A-R2-01): Exported helper for tests and
 * diagnostics. Returns true iff `key` is one of the V1 manifest keys.
 * The internal set is NOT exposed, so callers cannot mutate it.
 */
export function isManifestV1Key(key: string): boolean {
  return MANIFEST_V1_KEY_SET.has(key);
}

// ─── Index State V1 ─────────────────────────────────────────────────────

/**
 * Operational state for the indexing process, stored as a sidecar
 * `index-state.json`. This file contains diagnostics, NOT graph data.
 * The generation DB and active-generation.json remain unchanged on
 * indexing failure.
 */
export interface IndexAttemptStateV1 {
  readonly formatVersion: 1;
  readonly project: string;
  /** UUID of the currently active generation, or null if none. */
  readonly activeGenerationId: string | null;
  /** UUID of the last indexing attempt. */
  readonly lastAttemptId: string;
  /** ISO-8601 timestamp of the last attempt. */
  readonly lastAttemptAt: string;
  /** Outcome of the last attempt. */
  readonly lastAttemptOutcome: IndexAttemptOutcome;
  /** Error message if the attempt failed, null otherwise. */
  readonly lastAttemptError: string | null;
  /** Why the active generation is stale, if applicable. */
  readonly staleReason: string | null;
  /** Recovery action recommended. */
  readonly recovery: IndexRecoveryAction;
}

export type IndexAttemptOutcome =
  | "SUCCESS"
  | "SUCCESS_WITH_WARNINGS"
  | "PARTIAL"
  | "FAILED"
  | "STALE";

export type IndexRecoveryAction =
  | "none"
  | "full_reindex"
  | "incremental_retry"
  | "manifest_repair"
  | "legacy_migration";

// ─── Resolved DB ────────────────────────────────────────────────────────

/**
 * Result of resolving the active code DB for a project.
 * - `generation`: a published generation was found via manifest.
 * - `legacy`: no manifest, but a legacy DB exists at the old path.
 * - `missing`: neither manifest nor legacy DB exists.
 */
export type ResolvedCodeDb =
  | ResolvedGenerationDb
  | ResolvedLegacyDb
  | ResolvedMissingDb;

export interface ResolvedGenerationDb {
  readonly source: "generation";
  readonly project: string;
  readonly dbPath: string;
  readonly generationId: string;
  readonly manifest: GenerationManifestV1;
}

export interface ResolvedLegacyDb {
  readonly source: "legacy";
  readonly project: string;
  readonly dbPath: string;
  readonly generationId: null;
}

export interface ResolvedMissingDb {
  readonly source: "missing";
  readonly project: string;
  readonly dbPath: null;
  readonly generationId: null;
}

// ─── Error taxonomy ─────────────────────────────────────────────────────

/**
 * Structured error codes for the generation store.
 * Never group all errors under a single DB_ERROR.
 *
 * R169A-FIX (GPT 5.6 audit, pass 1): Added five new codes:
 *   - ATOMIC_DURABILITY_UNKNOWN     (DUR-R169A-01: rename succeeded but dir fsync failed)
 *   - ATOMIC_SERIALIZATION_FAILED   (DUR-R169A-02: JSON.stringify returned non-string)
 *   - ATOMIC_SHORT_WRITE            (DUR-R169A-02: writeSync returned <=0 mid-payload)
 *   - MANIFEST_TARGET_NOT_REGULAR   (DATA-R169A-01: resolved dbPath is not a regular file)
 *   - MANIFEST_DBFILE_NOT_CANONICAL (DATA-R169A-01: dbFile != generations/generation-<uuid>.db)
 *
 * R169A-FIX-R2 (GPT 5.6 audit, pass 2) changes:
 *   - Renamed LEGACY_SOURCE_OPEN_FAILED → LEGACY_SOURCE_INVALID.
 *     R169A validates path + regular-file identity only; the actual
 *     SQLite open validation occurs in R169D reader cutover.
 *   - Added MANIFEST_TOO_LARGE              (VALID-R169A-R2-01: manifest > 64 KiB).
 *   - Added STORE_LAYOUT_CREATE_FAILED      (DUR-R169A-R2-01: mkdir of layout dir failed).
 *   - Added STORE_LAYOUT_DURABILITY_UNKNOWN (DUR-R169A-R2-01: layout fsync failed).
 */
export type GenerationStoreErrorCode =
  | "GENERATION_STORE_CONFIG_ERROR"
  | "MANIFEST_PARSE_ERROR"
  | "MANIFEST_SCHEMA_ERROR"
  | "MANIFEST_TOO_LARGE"
  | "MANIFEST_TARGET_MISSING"
  | "MANIFEST_TARGET_OUTSIDE_STORE"
  | "MANIFEST_PROJECT_MISMATCH"
  | "MANIFEST_UNSUPPORTED_VERSION"
  | "MANIFEST_SYMLINK_REJECTED"
  | "GENERATION_TARGET_SYMLINK_REJECTED"
  | "MANIFEST_TARGET_NOT_REGULAR"
  | "MANIFEST_DBFILE_NOT_CANONICAL"
  | "LEGACY_SOURCE_INVALID"
  | "ATOMIC_WRITE_FAILED"
  | "ATOMIC_RENAME_FAILED"
  | "ATOMIC_FSYNC_FAILED"
  | "ATOMIC_DURABILITY_UNKNOWN"
  | "ATOMIC_SERIALIZATION_FAILED"
  | "ATOMIC_SHORT_WRITE"
  | "STORE_LAYOUT_CREATE_FAILED"
  | "STORE_LAYOUT_DURABILITY_UNKNOWN"
  | "PATH_TRAVERSAL_REJECTED"
  | "PROJECT_KEY_INVALID";

export class GenerationStoreError extends Error {
  readonly code: GenerationStoreErrorCode;
  readonly phase: string;
  readonly project: string;

  constructor(
    code: GenerationStoreErrorCode,
    phase: string,
    project: string,
    message: string,
  ) {
    super(`[${code}] ${phase}: ${message} (project=${project})`);
    this.name = "GenerationStoreError";
    this.code = code;
    this.phase = phase;
    this.project = project;
  }
}
