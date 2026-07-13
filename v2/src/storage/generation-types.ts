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
 *
 * R169A-FIX-R3 (GPT 5.6 pass 3 audit) changes:
 *   - `IndexRecoveryAction` aligned with the existing indexer contract:
 *     `retry_incremental` and `fix_filesystem` (was `incremental_retry`).
 *     Added `manifest_repair` and `legacy_migration`. Removed
 *     `incremental_retry`.
 *   - New structured `IndexAttemptStaleReasonV1` interface (matches the
 *     indexer's existing IndexResult.staleReason shape):
 *     `{ code, message, paths, totalPaths?, pathsTruncated? }`.
 *     `IndexAttemptStateV1.staleReason` is now
 *     `IndexAttemptStaleReasonV1 | null` (was `string | null`).
 *   - `INDEX_STATE_V1_KEYS` exported as `Object.freeze([...]) as const`.
 *     Used by `validateIndexAttemptState` for exact-key-set enforcement.
 *   - `MANIFEST_V1_KEYS` is now wrapped with `Object.freeze` so consumers
 *     cannot `.push()` / `.splice()` to add keys at runtime. The private
 *     `MANIFEST_V1_KEY_SET` is unchanged.
 *   - New error codes:
 *       `STORE_LAYOUT_PERMISSIONS_INSECURE` — existing layout dir has
 *         group/other permissions (mode & 0o077 !== 0).
 *       `PROJECT_STATE_SYMLINK_REJECTED`   — index-state.json is or
 *         contains a symlink (distinct from `MANIFEST_SYMLINK_REJECTED`
 *         for `active-generation.json` and `GENERATION_TARGET_SYMLINK_REJECTED`
 *         for the generation DB file).
 *       `INDEX_STATE_SCHEMA_ERROR`         — index-state.json failed
 *         structural / type / coherence validation.
 *       `INDEX_STATE_PROJECT_MISMATCH`     — index-state.json `project`
 *         field does not match the expected project.
 *       `INDEX_STATE_UNSUPPORTED_VERSION`  — index-state.json
 *         `formatVersion` is not 1.
 *   - Dead placeholder code in the manifest validator (the
 *     `missingKeys = actualKeys.filter((k) => !isManifestV1Key(k) ? false : false)`
 *     line that always returned `[]`) is removed.
 *
 * R169A-FIX-R4 (GPT 5.6 pass 4 audit) changes:
 *   - STATE-R169A-R4-01: `IndexAttemptStateV1` schema completed. The free-
 *     form `lastAttemptError: string | null` field is REPLACED by a
 *     structured `failure: IndexAttemptFailureV1 | null` carrying
 *     `{ code, phase, message }`. Two new fields are added:
 *     `published: boolean` (was the manifest swap durable?) and
 *     `candidateGenerationId: string | null` (the generation being
 *     staged, distinct from `activeGenerationId` which is the live one).
 *     Coherence rules are tightened per the indexer contract.
 *   - STATE-R169A-R4-01: `MAX_STALE_PATHS` reduced from 1000 to 100 to
 *     match the indexer's actual cap (R158 PERF-R158-01). Validator
 *     enforces `paths.length <= 100`, `totalPaths >= paths.length`, and
 *     the `pathsTruncated` <-> `totalPaths > paths.length` invariant.
 *   - TEST-R169A-R4-01: `AtomicFileOps.statSync` renamed to
 *     `AtomicFileOps.lstatSync` (it always should have been lstat -
 *     `statSync` follows symlinks so `isSymbolicLink()` was always false
 *     on the target). PROD_OPS now delegates to `node:fs.lstatSync`.
 *   - DATA-R169A-R4-01: `AtomicFileOps.serializeJson` is REMOVED. The
 *     typed writers now prepare a canonical payload Buffer BEFORE any
 *     filesystem I/O (see `prepareGenerationManifestForWrite` and
 *     `prepareIndexStateForWrite` in `generation-store.ts`). The
 *     filesystem writer receives ONLY the Buffer - it never calls
 *     `JSON.stringify`. This closes the canonical-payload gap where a
 *     `toJSON` getter / Proxy / prototype pollution could make the
 *     written bytes differ from the validated object.
 *
 * R169A-FIX-R5 (GPT 5.6 pass 5 audit) changes:
 *   - STATE-R169A-R5-01 (publicationState enum): The free-form
 *     `published: boolean` field is REPLACED by a structured
 *     `publicationState: IndexPublicationState` enum with four values:
 *       * "PUBLISHED"           - manifest swap was durable.
 *       * "NOT_NEEDED"          - indexer no-op (no candidate to publish).
 *       * "NOT_PUBLISHED"       - publication did not complete.
 *       * "DURABILITY_UNKNOWN"  - rename succeeded but dir fsync failed
 *                                 (residual TOCTOU window; FAILED only).
 *     `boolean` could not represent no-op SUCCESS or DURABILITY_UNKNOWN.
 *     `INDEX_STATE_V1_KEYS` updated: "published" -> "publicationState"
 *     (still 11 keys).
 *   - SEC-R169A-R5-01 (ATOMIC_TEMP_ORPHANED): New error code added to
 *     the taxonomy. Raised as a WARNING in the error message (not as a
 *     separate thrown error) when the writer detects the target
 *     directory was swapped between temp-create and rename - the temp
 *     file may be orphaned in the ORIGINAL directory and must NOT be
 *     unlinked by path (the path now points elsewhere).
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
 * R169A-FIX-R3 (VALID-R169A-R3-01): The tuple is now wrapped with
 * `Object.freeze`, so even direct `.push()` / `.splice()` calls on the
 * exported array fail silently (non-strict mode) or throw (strict mode).
 * The TypeScript `as const` keeps the literal-type narrow; `Object.freeze`
 * enforces runtime immutability. Use `Object.isFrozen(MANIFEST_V1_KEYS)`
 * to verify.
 *
 * Use `MANIFEST_V1_KEYS` for diagnostics / inspection only. Validation
 * lives in `validateGenerationManifest` and uses the private set.
 */
const MANIFEST_V1_KEYS_INTERNAL = [
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

export const MANIFEST_V1_KEYS: readonly string[] = Object.freeze<string[]>([...MANIFEST_V1_KEYS_INTERNAL]);

/**
 * Private, non-exported set used by the validator. A consumer cannot
 * reach into this set to add a key (the symbol is module-scoped).
 */
const MANIFEST_V1_KEY_SET: ReadonlySet<string> = new Set<string>(MANIFEST_V1_KEYS_INTERNAL);

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
 * R169A-FIX-R3 (API-R169A-R3-02): Structured stale reason for the index
 * state sidecar. Mirrors the existing `IndexResult.staleReason` shape in
 * `v2/src/indexer/indexer.ts` so the two contracts stay aligned.
 *
 *   - `code`: a fixed enum string (e.g. `"ROOT_CHANGED"`,
 *     `"HISTORICAL_ALIAS_BROKEN"`). Non-empty.
 *   - `message`: human-readable diagnostic. Non-empty.
 *   - `paths`: list of file paths implicated in the staleness (may be
 *     empty for codes that aren't path-specific). Capped at 100 entries
 *     by the indexer (R158 PERF-R158-01).
 *   - `totalPaths`: when `paths` is capped, the uncapped total. Optional.
 *   - `pathsTruncated`: true iff `paths.length < totalPaths`. Optional.
 */
export interface IndexAttemptStaleReasonV1 {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
  readonly totalPaths?: number;
  readonly pathsTruncated?: boolean;
}

/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): Structured failure object carried by
 * the index-state sidecar when an indexing attempt did not fully succeed.
 * Mirrors the structured shape already used by the indexer's
 * `IndexResult.failure` so the two contracts stay aligned.
 *
 *   - `code`: a fixed enum string (e.g. `"EXTRACTOR_CRASH"`,
 *     `"DISCOVERY_FAILED"`, `"SQLITE_LOCKED"`). Non-empty.
 *   - `phase`: the indexer phase that produced the failure (e.g.
 *     `"extract"`, `"resolve"`, `"finalize"`, `"publish"`). Non-empty.
 *   - `message`: human-readable diagnostic. Non-empty.
 */
export interface IndexAttemptFailureV1 {
  readonly code: string;
  readonly phase: string;
  readonly message: string;
}

/**
 * R169A-FIX-R5 (STATE-R169A-R5-01): Publication state of an indexing
 * attempt. Replaces the R4 `published: boolean` field.
 *
 * The boolean could not represent two important states:
 *   - no-op SUCCESS (the indexer determined no work was needed; no
 *     candidate was staged; nothing was published) - now "NOT_NEEDED".
 *   - DURABILITY_UNKNOWN (the rename succeeded but the post-rename
 *     directory fsync failed; the new manifest is in place but may not
 *     survive a crash) - now "DURABILITY_UNKNOWN", allowed only for
 *     FAILED.
 *
 * Coherence with `lastAttemptOutcome`:
 *   - SUCCESS / SUCCESS_WITH_WARNINGS: "PUBLISHED" or "NOT_NEEDED".
 *   - PARTIAL: "NOT_PUBLISHED".
 *   - FAILED: "NOT_PUBLISHED" or "DURABILITY_UNKNOWN".
 *   - STALE: "NOT_PUBLISHED".
 *   - "PUBLISHED" is forbidden for PARTIAL / FAILED / STALE.
 */
export type IndexPublicationState =
  | "PUBLISHED"
  | "NOT_NEEDED"
  | "NOT_PUBLISHED"
  | "DURABILITY_UNKNOWN";

/**
 * Operational state for the indexing process, stored as a sidecar
 * `index-state.json`. This file contains diagnostics, NOT graph data.
 * The generation DB and active-generation.json remain unchanged on
 * indexing failure.
 *
 * R169A-FIX-R3 (API-R169A-R3-02): `staleReason` is now a structured
 * `IndexAttemptStaleReasonV1 | null` (was `string | null`). The
 * `recovery` field enum is aligned with the indexer's
 * `IndexResult.recovery`: `retry_incremental`, `fix_filesystem`,
 * `full_reindex`, `manifest_repair`, `legacy_migration`, `none`.
 *
 * R169A-FIX-R4 (STATE-R169A-R4-01): Schema completed.
 *   - `lastAttemptError: string | null` REMOVED. Replaced by the
 *     structured `failure: IndexAttemptFailureV1 | null` so the
 *     sidecar carries `code`, `phase`, and `message` for any non-
 *     success outcome. The free-form string carried no machine-readable
 *     signal; the structured object lets downstream tooling route
 *     failures by `code` and `phase`.
 *   - `published: boolean` ADDED. True iff the manifest swap was
 *     durable (post-rename directory fsync succeeded). Distinguishes
 *     "FAILED before publication" from "FAILED during / after
 *     publication" - the latter is the residual TOCTOU window.
 *   - `candidateGenerationId: string | null` ADDED. UUID of the
 *     generation that was being staged during this attempt. Distinct
 *     from `activeGenerationId` (which is the LIVE generation). On
 *     SUCCESS the candidate becomes the active; on FAILED / STALE the
 *     candidate is GC'd.
 *
 * R169A-FIX-R5 (STATE-R169A-R5-01): `published: boolean` REPLACED by
 *   `publicationState: IndexPublicationState` (4-value enum). The
 *   boolean could not represent no-op SUCCESS ("NOT_NEEDED") or
 *   DURABILITY_UNKNOWN (rename succeeded but dir fsync failed; FAILED
 *   only). Coherence rules tightened per the four-value enum.
 */
export interface IndexAttemptStateV1 {
  readonly formatVersion: 1;
  readonly project: string;
  /** UUID of the currently active generation, or null if none. */
  readonly activeGenerationId: string | null;
  /**
   * R169A-FIX-R4: UUID of the generation being staged during the last
   * attempt, or null if no staging was attempted. On SUCCESS this
   * equals `activeGenerationId`; on FAILED / STALE / PARTIAL it may
   * differ (the candidate is GC'd).
   */
  readonly candidateGenerationId: string | null;
  /** UUID of the last indexing attempt. */
  readonly lastAttemptId: string;
  /** ISO-8601 timestamp of the last attempt. */
  readonly lastAttemptAt: string;
  /** Outcome of the last attempt. */
  readonly lastAttemptOutcome: IndexAttemptOutcome;
  /**
   * R169A-FIX-R5 (STATE-R169A-R5-01): Publication state of the last
   * attempt. Replaces the R4 `published: boolean` field.
   *
   *   - "PUBLISHED": the manifest swap was durable (post-rename
   *     directory fsync succeeded). Used for SUCCESS /
   *     SUCCESS_WITH_WARNINGS when a generation was actually published.
   *   - "NOT_NEEDED": the indexer was a no-op (no candidate to
   *     publish). Used for SUCCESS / SUCCESS_WITH_WARNINGS when the
   *     indexer determined no work was needed. `candidateGenerationId`
   *     MUST be null.
   *   - "NOT_PUBLISHED": publication did not complete. Used for
   *     PARTIAL / FAILED / STALE.
   *   - "DURABILITY_UNKNOWN": rename succeeded but the post-rename
   *     directory fsync failed. Used for FAILED only (the residual
   *     TOCTOU window where the new manifest is in place but may not
   *     survive a crash).
   *
   * Coherence rules (enforced by `validateIndexAttemptState`):
   *   - SUCCESS / SUCCESS_WITH_WARNINGS: PUBLISHED or NOT_NEEDED only.
   *     PUBLISHED requires `activeGenerationId` non-null and
   *     `candidateGenerationId == activeGenerationId`. NOT_NEEDED
   *     requires `candidateGenerationId == null`.
   *   - PARTIAL: NOT_PUBLISHED only. PUBLISHED is forbidden.
   *   - FAILED: NOT_PUBLISHED or DURABILITY_UNKNOWN. PUBLISHED is
   *     forbidden.
   *   - STALE: NOT_PUBLISHED only. PUBLISHED is forbidden.
   */
  readonly publicationState: IndexPublicationState;
  /**
   * R169A-FIX-R4: Structured failure record, or null on full success.
   * Replaces the previous `lastAttemptError: string | null` field.
   */
  readonly failure: IndexAttemptFailureV1 | null;
  /** Why the active generation is stale, if applicable. */
  readonly staleReason: IndexAttemptStaleReasonV1 | null;
  /** Recovery action recommended. */
  readonly recovery: IndexRecoveryAction;
}

export type IndexAttemptOutcome =
  | "SUCCESS"
  | "SUCCESS_WITH_WARNINGS"
  | "PARTIAL"
  | "FAILED"
  | "STALE";

/**
 * R169A-FIX-R3 (API-R169A-R3-02): Recovery action enum aligned with
 * `IndexResult.recovery` in `v2/src/indexer/indexer.ts`. The pass 2
 * value `incremental_retry` is renamed to `retry_incremental` so the
 * same string round-trips through both contracts. `fix_filesystem` is
 * added (was missing). `manifest_repair` and `legacy_migration` are
 * retained for forward use by R169C/R169D.
 */
export type IndexRecoveryAction =
  | "none"
  | "retry_incremental"
  | "fix_filesystem"
  | "full_reindex"
  | "manifest_repair"
  | "legacy_migration";

/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): The exact set of keys allowed in a V1
 * index-state sidecar, exported as a frozen readonly tuple. 11 keys:
 *   formatVersion, project, activeGenerationId, candidateGenerationId,
 *   lastAttemptId, lastAttemptAt, lastAttemptOutcome, publicationState,
 *   failure, staleReason, recovery.
 *
 * R3 had 9 keys (no `candidateGenerationId`, no `published`, and
 * `lastAttemptError` instead of `failure`). R4 replaces `lastAttemptError`
 * with the structured `failure` and adds `candidateGenerationId` and
 * `published`. R5 (STATE-R169A-R5-01) renames `published` to
 * `publicationState` (an enum with four values instead of a boolean).
 * Key count is unchanged at 11.
 */
const INDEX_STATE_V1_KEYS_INTERNAL = [
  "formatVersion",
  "project",
  "activeGenerationId",
  "candidateGenerationId",
  "lastAttemptId",
  "lastAttemptAt",
  "lastAttemptOutcome",
  "publicationState",
  "failure",
  "staleReason",
  "recovery",
] as const;

export const INDEX_STATE_V1_KEYS: readonly string[] = Object.freeze<string[]>([...INDEX_STATE_V1_KEYS_INTERNAL]);

/**
 * Private, non-exported set used by `validateIndexAttemptState`. A
 * consumer cannot reach into this set to add a key.
 */
const INDEX_STATE_V1_KEY_SET: ReadonlySet<string> = new Set<string>(INDEX_STATE_V1_KEYS_INTERNAL);

/**
 * R169A-FIX-R3 (API-R169A-R3-02): Exported helper for tests and
 * diagnostics. Returns true iff `key` is one of the V1 index-state keys.
 */
export function isIndexStateV1Key(key: string): boolean {
  return INDEX_STATE_V1_KEY_SET.has(key);
}

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
 *
 * R169A-FIX-R3 (GPT 5.6 audit, pass 3) changes:
 *   - Added STORE_LAYOUT_PERMISSIONS_INSECURE (SEC-R169A-R3-04: existing
 *     layout dir has group/other permissions — mode & 0o077 !== 0).
 *   - Added PROJECT_STATE_SYMLINK_REJECTED (QUAL-R169A-R3-01: index-state
 *     path is or contains a symlink — distinct from
 *     MANIFEST_SYMLINK_REJECTED for active-generation.json and
 *     GENERATION_TARGET_SYMLINK_REJECTED for the generation DB).
 *   - Added INDEX_STATE_SCHEMA_ERROR (API-R169A-R3-02: index-state.json
 *     failed structural / type / coherence validation).
 *   - Added INDEX_STATE_PROJECT_MISMATCH (API-R169A-R3-02: index-state
 *     `project` field does not match expected project).
 *   - Added INDEX_STATE_UNSUPPORTED_VERSION (API-R169A-R3-02: index-state
 *     `formatVersion` is not 1).
 *
 * R169A-FIX-R4 (GPT 5.6 audit, pass 4) changes:
 *   - COMPAT-R169A-R4-01: STORE_LAYOUT_PERMISSIONS_INSECURE now uses a
 *     two-tier policy. Compatibility roots (cacheRoot, codebase-memory-mcp)
 *     require `mode & 0o022 === 0` (no group/other WRITE) — 0755, 0750,
 *     0700 all accepted. Private R169 dirs (projects, projectStore,
 *     generations, tmp) require `mode === 0o700` exactly. The previous
 *     `mode & 0o077 !== 0` rule rejected 0755 (group read/execute) and
 *     would have broken existing legacy caches.
 *
 * R169A-FIX-R5 (GPT 5.6 audit, pass 5) changes:
 *   - SEC-R169A-R5-01: Added `ATOMIC_TEMP_ORPHANED`. Raised as a WARNING
 *     in the error message (not a separate thrown error) when the
 *     writer detects the target directory was swapped between
 *     temp-create and rename. The temp file may be orphaned in the
 *     ORIGINAL directory and must NOT be unlinked by path (the path
 *     now points elsewhere). The primary error code remains
 *     PATH_TRAVERSAL_REJECTED (the swap was detected); the warning
 *     explains that the temp file is intentionally NOT cleaned up.
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
  | "PROJECT_STATE_SYMLINK_REJECTED"
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
  | "STORE_LAYOUT_PERMISSIONS_INSECURE"
  | "INDEX_STATE_SCHEMA_ERROR"
  | "INDEX_STATE_PROJECT_MISMATCH"
  | "INDEX_STATE_UNSUPPORTED_VERSION"
  | "PATH_TRAVERSAL_REJECTED"
  | "PROJECT_KEY_INVALID"
  | "ATOMIC_TEMP_ORPHANED";

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
