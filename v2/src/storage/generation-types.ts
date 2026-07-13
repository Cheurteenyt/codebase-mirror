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
// ─── R169B warning taxonomy (§10 of the R169B report) ───────────────────
//
// R169B-STEP1 introduces a WARNING taxonomy distinct from the ERROR
// taxonomy. Warnings describe non-fatal anomalies that the publisher /
// GC / reader may surface in diagnostics (sidecar `warnings` array,
// logs, or returned metadata) WITHOUT aborting the operation. Errors
// always raise; warnings always carry on.
//
// The split is necessary because R169A conflated the two: the
// `ATOMIC_TEMP_ORPHANED` "code" is documented as a WARNING that is
// surfacing in an error message, not as a separate thrown error. R169B
// formalizes that pattern by giving warnings their own type and code
// set. The R169A `ATOMIC_TEMP_ORPHANED` is kept in the ERROR taxonomy
// for backward compatibility (existing tests assert its presence in
// error messages); the new `GenerationStoreWarningCode` is the
// forward-looking taxonomy that R169B+ publishers SHOULD use when
// surfacing non-fatal anomalies as structured warnings.

/**
 * R169B-STEP1: Structured warning codes for the generation store.
 *
 * Warnings describe non-fatal anomalies that do NOT abort the
 * operation but MUST be surfaced to the operator / caller. They are
 * distinct from `GenerationStoreErrorCode` (errors always raise).
 *
 *   - `ATOMIC_TEMP_ORPHANED` — the atomic writer detected that the
 *     target directory was swapped between temp-create and rename. The
 *     temp file may be orphaned in the ORIGINAL directory and MUST NOT
 *     be unlinked by path. The publisher surfaces this as a structured
 *     warning (in addition to the R169A error-message warning) so the
 *     caller can schedule a `tmp/` sweep.
 *   - `STAGING_ALIAS_CLEANUP_DEFERRED` — a staging alias (symlink,
 *     hardlink, or bind-mount) was detected during staging-create and
 *     could not be cleaned up synchronously (e.g. because the alias
 *     points to a path owned by another process). The cleanup is
 *     deferred to the next GC pass.
 *   - `GC_DELETE_FAILED` — a GC pass attempted to delete a stale
 *     generation or temp file and the deletion failed (e.g. EBUSY on
 *     Windows, EPERM on a read-only filesystem). GC is best-effort;
 *     the failure is surfaced as a warning and the next GC pass will
 *     retry.
 */
export type GenerationStoreWarningCode =
  | "ATOMIC_TEMP_ORPHANED"
  | "STAGING_ALIAS_CLEANUP_DEFERRED"
  | "GC_DELETE_FAILED"
  // R169B-STEP3: GC safety-refusal (missing/corrupt metadata, etc.).
  | "GC_SAFETY_REFUSAL"
  // R169B-STEP3: GC deletion incomplete (DB/metadata/fsync/commit
  // failure mid-deletion). Status stays DELETING; next GC re-attempts.
  | "GC_DELETE_INCOMPLETE";

/**
 * R169B-STEP1: A structured warning record. Carried alongside a
 * successful operation (or in the `warnings` array of a
 * `PreparedGeneration` / `PublicationResult`) to surface non-fatal
 * anomalies. The `message` is human-readable; the `code` is
 * machine-readable.
 */
export interface GenerationStoreWarning {
  readonly code: GenerationStoreWarningCode;
  readonly message: string;
}

// ─── R169B error codes (§10 of the R169B report) ────────────────────────
//
// R169B-STEP1 introduces a forward-looking set of error codes that the
// R169B publisher primitives (staging, validation, CAS, GC) will raise
// as they are implemented in subsequent R169B steps. The codes are
// added to the union NOW so that subsequent steps can throw them
// without further changes to the type. No R169A code path raises any
// of these yet — R169B remains FOUNDATION / INACTIVE.
//
// Grouping (informal — the union is a flat list, the grouping here is
// only to aid review):
//
//   Staging (create / open / integrity):
//     STAGING_CREATE_FAILED, STAGING_TARGET_INVALID, STAGING_DB_BUSY,
//     STAGING_DB_INTEGRITY_FAILED, STAGING_DB_SCHEMA_INVALID,
//     STAGING_DB_PROJECT_MISMATCH, STAGING_DB_STATE_INVALID,
//     STAGING_DB_WAL_DIRTY
//
//   Generation (hash / promote / durability):
//     GENERATION_HASH_FAILED, GENERATION_PROMOTION_CONFLICT,
//     GENERATION_PROMOTION_FAILED, GENERATION_PROMOTION_DURABILITY_UNKNOWN,
//     GENERATION_METADATA_INVALID
//
//   Publication (token + CAS + verify):
//     PUBLICATION_TOKEN_INVALID, PUBLICATION_TOKEN_CONSUMED,
//     PUBLICATION_CAS_BUSY, PUBLICATION_CAS_MISMATCH,
//     PUBLICATION_CAS_STATE_CORRUPT, PUBLICATION_VERIFY_FAILED
//
//   GC (plan + safety):
//     GC_PLAN_STALE, GC_SAFETY_REFUSAL

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
  | "ATOMIC_TEMP_ORPHANED"
  // R169B-STEP1 (§10): staging-create / open / integrity codes.
  | "STAGING_CREATE_FAILED"
  | "STAGING_TARGET_INVALID"
  | "STAGING_DB_BUSY"
  | "STAGING_DB_INTEGRITY_FAILED"
  | "STAGING_DB_SCHEMA_INVALID"
  | "STAGING_DB_PROJECT_MISMATCH"
  | "STAGING_DB_STATE_INVALID"
  | "STAGING_DB_WAL_DIRTY"
  // R169B-STEP1 (§10): generation hash / promote / durability codes.
  | "GENERATION_HASH_FAILED"
  | "GENERATION_PROMOTION_CONFLICT"
  | "GENERATION_PROMOTION_FAILED"
  | "GENERATION_PROMOTION_DURABILITY_UNKNOWN"
  | "GENERATION_METADATA_INVALID"
  // R169B-STEP1 (§10): publication token + CAS + verify codes.
  | "PUBLICATION_TOKEN_INVALID"
  | "PUBLICATION_TOKEN_CONSUMED"
  | "PUBLICATION_CAS_BUSY"
  | "PUBLICATION_CAS_MISMATCH"
  | "PUBLICATION_CAS_STATE_CORRUPT"
  | "PUBLICATION_VERIFY_FAILED"
  // R169B-STEP1 (§10): GC plan + safety codes.
  | "GC_PLAN_STALE"
  | "GC_SAFETY_REFUSAL"
  // R169B-STEP3 (GPT 5.6 Pass 1 audit): correctness closure codes.
  // MANIFEST_NOT_FOUND is distinct from MANIFEST_PARSE_ERROR: only a
  // real ENOENT on the manifest path returns null from
  // readOptionalGenerationManifest. Any other read/parse/validation
  // failure raises MANIFEST_PARSE_ERROR (fail-closed).
  | "MANIFEST_NOT_FOUND"
  // GC_DELETE_INCOMPLETE: the GC marked a generation DELETING but
  // could not certify the full delete (metadata unlink, DB unlink,
  // fsync, CAS commit). The status stays DELETING; the next GC pass
  // re-attempts. Never marked DELETED on incomplete deletion.
  | "GC_DELETE_INCOMPLETE"
  // PUBLICATION_STAGING_MUTATED: re-validation at publish time
  // detected that the staging file's content/identity changed between
  // prepare and publish (re-hash mismatch or dev/ino/size mismatch).
  | "PUBLICATION_STAGING_MUTATED"
  // PUBLICATION_CACHE_ROOT_MISMATCH: the cacheRoot passed to publish
  // via storeOptions differs from the cacheRoot baked into the
  // PreparedGeneration handle. The cacheRoot is part of the
  // generation's identity and cannot be overridden.
  | "PUBLICATION_CACHE_ROOT_MISMATCH"
  // PUBLICATION_RESERVATION_INVALID: the reservation token is not
  // authentic (not in the private WeakMap) or its derived path does
  // not match the canonical tmp/generation-<uuid>.db path.
  | "PUBLICATION_RESERVATION_INVALID"
  // GC_PLAN_UNAUTHENTICATED: the plan passed to applyGenerationGcPlan
  // is not authentic (not in the private WeakMap). Plans must be
  // produced by planGenerationGc in the same process.
  | "GC_PLAN_UNAUTHENTICATED";

export class GenerationStoreError extends Error {
  readonly code: GenerationStoreErrorCode;
  readonly phase: string;
  readonly project: string;
  /**
   * R169B-STEP1 (§10): Optional generation UUID carried by errors that
   * are scoped to a specific generation (staging, promotion,
   * publication, GC). R169A errors do not set this field (it defaults
   * to `undefined`); the R169B publisher primitives set it when the
   * error originates from a context that already has a `generationId`
   * (e.g. a `PreparedGeneration` mid-promotion). Downstream tooling can
   * read `err.generationId` to route the failure to the right
   * generation's diagnostics sidecar.
   */
  readonly generationId?: string;

  constructor(
    code: GenerationStoreErrorCode,
    phase: string,
    project: string,
    message: string,
    generationId?: string,
  ) {
    super(
      generationId !== undefined
        ? `[${code}] ${phase}: ${message} (project=${project}, generationId=${generationId})`
        : `[${code}] ${phase}: ${message} (project=${project})`,
    );
    this.name = "GenerationStoreError";
    this.code = code;
    this.phase = phase;
    this.project = project;
    this.generationId = generationId;
  }
}

// ─── R169B-STEP2 — Publisher / CAS / GC public types (§7-18) ──────────────
//
// R169B-STEP2 introduces the publisher primitives that turn the R169A
// generation-store foundation into a usable staging → validation →
// promotion → GC pipeline. These types live in the types leaf module so
// the publisher (public facade), the CAS store (internal), and the GC
// module (public facade) can all import them without forming a cycle.
//
// STATUS: FOUNDATION / INACTIVE
// The publisher primitives exist and are tested, but no production code
// calls them yet — the indexer still writes to the legacy DB path. R169B
// remains FOUNDATION / INACTIVE until a later step wires the publisher
// into the indexer's success path.

/**
 * R169B-STEP2: Reservation returned by `reserveGenerationStaging`.
 *
 * The reservation is a thin record describing where the staging DB
 * should be written and what generation UUID it will represent. The
 * caller (typically the indexer) is responsible for opening the SQLite
 * DB at `stagingPath`, initializing its schema, and writing graph data
 * into it. After the staging DB is fully populated, the caller invokes
 * `prepareGenerationForPublication` to validate + finalize + hash it.
 *
 * The reservation is NOT a publication act — no manifest is written,
 * no CAS state is mutated, and the active generation is unchanged. The
 * staging DB lives in `tmp/` and is invisible to readers until a
 * successful `publishPreparedGeneration` promotion.
 */
export interface GenerationStagingReservation {
  readonly project: string;
  readonly generationId: string;
  readonly stagingPath: string;
  readonly cacheRoot: string;
  readonly createdAt: string;
}

/**
 * R169B-STEP2: Input for `prepareGenerationForPublication`.
 *
 * The publisher derives the manifest values from the staging DB itself
 * (counts, versions, root fingerprint, sha256, sizeBytes). The caller
 * only provides the expected `rootFingerprint` so the publisher can
 * cross-check it against the value stored in the `projects` table.
 */
export interface PreparedGenerationInput {
  readonly rootFingerprint?: string;
}

/**
 * R169B-STEP2: Opaque, single-use prepared-generation handle.
 *
 * Returned by `prepareGenerationForPublication`. The handle is OPAQUE:
 * callers MUST treat it as a black box and pass it unchanged to
 * `publishPreparedGeneration` or `discardPreparedGeneration`. The
 * handle is SINGLE-USE: `publishPreparedGeneration` consumes the
 * underlying token, and a second call with the same handle raises
 * `PUBLICATION_TOKEN_CONSUMED`.
 *
 * The handle is FORGE-RESISTANT: the token is held in a private
 * module-scope WeakMap keyed by the actual object reference. A spread
 * (`{ ...prepared }`), JSON clone, or cast from an arbitrary object
 * produces a NEW reference that is NOT in the WeakMap —
 * `publishPreparedGeneration` raises `PUBLICATION_TOKEN_INVALID`.
 *
 * The handle is FROZEN: `Object.isFrozen(prepared)` returns `true`.
 */
export interface PreparedGeneration {
  readonly project: string;
  readonly generationId: string;
  readonly stagingPath: string;
  readonly cacheRoot: string;
  readonly manifest: GenerationManifestV1;
  readonly preparedAt: string;
  readonly warnings: readonly GenerationStoreWarning[];
}

/**
 * R169B-STEP2: Options for `publishPreparedGeneration`.
 *
 * R169B-STEP3 (GPT 5.6 Pass 1 audit, CAS-R169B-A1-09): the
 * `expectedActiveGenerationId` field is REQUIRED. There is no
 * overload without it. `BEGIN IMMEDIATE` serializes concurrent
 * writers but does NOT replace the optimistic-locking contract —
 * two writers can publish sequentially and the last one wins
 * without ever knowing its expected active was stale. Forcing the
 * caller to pass `null` (first publication) or a generation ID
 * makes every publication explicit about its precondition.
 *
 *   - `expectedActiveGenerationId`: optimistic-locking guard. The
 *     publisher verifies that the CAS-recorded active generation ID
 *     (after reconciling from the active manifest) equals this value.
 *     A mismatch raises `PUBLICATION_CAS_MISMATCH`. Pass `null` to
 *     assert that no generation is currently active (first
 *     publication).
 *   - `pin`: if true, mark the newly published generation as pinned
 *     in the CAS catalog so it is never deleted by GC.
 */
export interface PublishPreparedGenerationOptions {
  readonly expectedActiveGenerationId: string | null;
  readonly pin?: boolean;
}

/**
 * R169B-STEP2: Result of a successful `publishPreparedGeneration`.
 *
 *   - `publicationState`: "PUBLISHED" if the post-promotion fsync of
 *     the generations/ directory succeeded; "DURABILITY_UNKNOWN" if
 *     the promotion (link + manifest swap) succeeded but the final
 *     directory fsync failed. In the latter case the new manifest is
 *     on disk and visible to readers but may not survive a crash —
 *     the caller MUST surface this as a warning.
 *   - `cas`: CAS-state snapshot after the COMMIT. `revision` is the
 *     new CAS revision (incremented from the pre-publish value).
 *     `deduped` is true if the publisher detected that an identical
 *     generation (same sha256+size+fingerprint+versions) was already
 *     in the catalog and reused it. `previousActiveGenerationId`
 *     is the active ID before this publication (null if first).
 */
export interface PublicationResult {
  readonly project: string;
  readonly generationId: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly metadataPath: string;
  readonly manifest: GenerationManifestV1;
  readonly publicationState: "PUBLISHED" | "DURABILITY_UNKNOWN";
  readonly warnings: readonly GenerationStoreWarning[];
  readonly cas: {
    readonly revision: number;
    readonly deduped: boolean;
    readonly previousActiveGenerationId: string | null;
  };
}

/**
 * R169B-STEP2: Result of `discardPreparedGeneration`.
 *
 *   - `deleted`: true if the staging DB was successfully unlinked.
 *     false if the publisher could not prove the directory identity
 *     (the staging path was swapped between prepare and discard) —
 *     in that case the staging artifact is LEFT IN PLACE and a
 *     `STAGING_ALIAS_CLEANUP_DEFERRED` warning is surfaced so the
 *     operator / next GC pass can clean it up safely.
 */
export interface DiscardResult {
  readonly project: string;
  readonly generationId: string;
  readonly stagingPath: string;
  readonly deleted: boolean;
  readonly warnings: readonly GenerationStoreWarning[];
}

/**
 * R169B-STEP2: Options for `planGenerationGc` and `applyGenerationGcPlan`.
 *
 *   - `retainCount`: number of previous distinct generations to
 *     retain in addition to the active generation and pinned
 *     generations. Defaults to 2.
 *   - `tmpMaxAgeMs`: maximum age (in milliseconds) for canonical
 *     staging artifacts in `tmp/`. Artifacts older than this are
 *     swept by the GC (with directory-identity verification).
 *     Defaults to 24 hours.
 *   - `pin`: set of generation IDs to treat as pinned for this plan
 *     (in addition to the CAS-recorded pinned set).
 */
export interface GenerationGcOptions {
  readonly cacheRoot?: string;
  readonly retainCount?: number;
  readonly tmpMaxAgeMs?: number;
  readonly pin?: readonly string[];
}

/**
 * R169B-STEP2: A single entry in the GC plan's retain/delete list.
 */
export interface GenerationGcPlanEntry {
  readonly generationId: string;
  readonly dbPath: string;
  readonly metadataPath: string | null;
  readonly reason: string;
  readonly pinned: boolean;
}

/**
 * R169B-STEP2: A tmp/ artifact to sweep in the GC plan.
 */
export interface GenerationGcTmpEntry {
  readonly path: string;
  readonly reason: string;
}

/**
 * R169B-STEP2: Plan returned by `planGenerationGc`.
 *
 * The plan is computed from the active manifest + CAS catalog +
 * publication_history. It NEVER uses mtime or readdir order for the
 * retain/delete decision — only the publication_history ordering
 * (most-recent-first) is used.
 */
export interface GenerationGcPlan {
  readonly project: string;
  readonly cacheRoot: string;
  readonly activeGenerationId: string | null;
  readonly casRevision: number;
  readonly retain: readonly GenerationGcPlanEntry[];
  readonly delete: readonly GenerationGcPlanEntry[];
  readonly sweepTmp: readonly GenerationGcTmpEntry[];
  readonly reasons: Readonly<Record<string, string>>;
}

/**
 * R169B-STEP2: Result of `applyGenerationGcPlan`.
 *
 *   - `applied`: true if the plan was applied (CAS revision
 *     unchanged). false if the plan was stale (CAS revision changed
 *     between plan and apply) — in that case `deletedGenerations` and
 *     `deletedTmp` are both empty and `reason` is `"GC_PLAN_STALE"`.
 *   - `deletedGenerations`: generation IDs that were actually
 *     deleted (metadata + DB + CAS catalog entry).
 *   - `deletedTmp`: tmp/ paths that were unlinked.
 *   - `warnings`: non-fatal anomalies (e.g. GC_DELETE_FAILED for a
 *     generation whose DB was busy — the next GC pass will retry).
 */
export interface GenerationGcResult {
  readonly applied: boolean;
  readonly reason: string | null;
  readonly deletedGenerations: readonly string[];
  readonly deletedTmp: readonly string[];
  readonly warnings: readonly GenerationStoreWarning[];
}

// ─── R169B-STEP2 — CAS store types (internal) ────────────────────────────

/**
 * R169B-STEP2: A row in the CAS `generation_catalog` table.
 */
export interface CasGenerationCatalogEntry {
  readonly generationId: string;
  readonly project: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly rootFingerprint: string;
  readonly extractorSemanticsVersion: number;
  readonly discoveryPolicyVersion: number;
  readonly firstPublishedAt: string;
  readonly lastSeenAt: string;
  readonly pinned: boolean;
  readonly status: "ACTIVE" | "DELETING" | "DELETED";
}

/**
 * R169B-STEP2: A row in the CAS `publication_history` table.
 *
 * The history is an append-only log of publication acts. The GC uses
 * it to determine the order of previous generations (most-recent-first)
 * without relying on mtime or readdir order.
 */
export interface CasPublicationHistoryEntry {
  readonly historyId: number;
  readonly generationId: string;
  readonly project: string;
  readonly publishedAt: string;
  readonly action: "PUBLISH" | "UNPUBLISH" | "DELETE" | "PIN" | "UNPIN" | "MARK_DELETING";
  readonly previousActiveGenerationId: string | null;
  readonly casRevision: number;
}

/**
 * R169B-STEP2: CAS-state snapshot returned by
 * `CasStore.reconcileFromManifest`.
 */
export interface CasReconcileResult {
  readonly activeGenerationId: string | null;
  readonly revision: number;
  readonly reconciled: boolean;
}

/**
 * R169B-STEP2: Dedup candidate returned by `CasStore.findDedupCandidate`.
 *
 * A dedup candidate is an existing catalog entry whose sha256 +
 * sizeBytes + rootFingerprint + extractorSemanticsVersion +
 * discoveryPolicyVersion all match the prepared generation. If found,
 * the publisher can skip the link + metadata write and instead reuse
 * the existing generation-<uuid>.db (the staging DB is unlinked).
 */
export interface CasDedupCandidate {
  readonly generationId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly rootFingerprint: string;
  readonly extractorSemanticsVersion: number;
  readonly discoveryPolicyVersion: number;
}

// ─── R169B-STEP3 — Metadata V1 schema (META-R169B-A1-17) ────────────────

/**
 * R169B-STEP3: The metadata sidecar schema (V1).
 *
 * The sidecar is the immutable publication record. It is written
 * ONCE per generation UUID and is NEVER overwritten. The schema is
 * strict: every field is required, no extra fields are allowed, and
 * the nested `manifest` is a fully validated `GenerationManifestV1`.
 *
 * The exact key set is exported as `GENERATION_METADATA_V1_KEYS` so
 * the validator can enforce "no extra keys, no missing keys".
 */
export interface GenerationMetadataV1 {
  readonly formatVersion: 1;
  readonly manifest: GenerationManifestV1;
  readonly publishedAt: string;
  readonly deduped: boolean;
  readonly dedupSourceGenerationId: string | null;
  readonly previousActiveGenerationId: string | null;
  readonly pinned: boolean;
}

export const GENERATION_METADATA_V1_KEYS = Object.freeze([
  "formatVersion",
  "manifest",
  "publishedAt",
  "deduped",
  "dedupSourceGenerationId",
  "previousActiveGenerationId",
  "pinned",
] as const);

export type GenerationMetadataV1Key = (typeof GENERATION_METADATA_V1_KEYS)[number];

export function isGenerationMetadataV1Key(k: string): k is GenerationMetadataV1Key {
  return (GENERATION_METADATA_V1_KEYS as readonly string[]).indexOf(k) !== -1;
}

// ─── R169B-STEP3 — PublisherOps interface (fault injection harness) ──────

/**
 * R169B-STEP3 (GPT 5.6 Pass 1 audit, §5): The publisher ops harness.
 *
 * The publisher originally called `linkSync`, `unlinkSync`,
 * `fsyncSync`, `openSync`, `lstatSync`, `existsSync`, and
 * `new Database()` directly, which made precise fault injection
 * (crash at exact point, fsync failure, link EEXIST) impossible.
 *
 * This interface wraps every external side-effect the publisher
 * performs. The public `publishPreparedGeneration` uses
 * `PROD_PUBLISHER_OPS`. Tests import an internal fault-injection
 * factory that returns ops wrapping these primitives and injecting
 * failures at configurable points.
 *
 * The interface is INTERNAL — it is exported from
 * `internal/generation-publisher-ops.ts`, NOT from the public
 * facade. A `.d.ts` test asserts it does not appear in the public
 * surface.
 */
export interface PublisherOps {
  openSync(path: string, flags: number, mode?: number): number;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): import("node:fs").Stats;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(src: string, dst: string): void;
  unlinkSync(path: string): void;
  lstatSync(path: string): import("node:fs").Stats;
  existsSync(path: string): boolean;
  openDatabase(path: string, options: { readonly?: boolean; fileMustExist?: boolean }): import("better-sqlite3").Database;
  now(): string;
  randomUUID(): string;
}

/**
 * R169B-STEP3: Hooks the publisher invokes at well-defined points.
 *
 * Used by crash-matrix tests to terminate the process at exact
 * points (after reserve, after WAL, after checkpoint, after hash,
 * after link, after fsync, after metadata, after manifest, before
 * CAS commit, after CAS commit, ...). Each hook receives enough
 * context to identify the crash point.
 *
 * The hooks are INTERNAL — they are not part of the public API.
 */
export interface PublisherHooks {
  readonly onAfterReserve?: (ctx: PublisherHookContext) => void;
  readonly onAfterWalCheckpoint?: (ctx: PublisherHookContext) => void;
  readonly onAfterHash?: (ctx: PublisherHookContext) => void;
  readonly onAfterLink?: (ctx: PublisherHookContext) => void;
  readonly onAfterFsyncGenerations?: (ctx: PublisherHookContext) => void;
  readonly onAfterMetadata?: (ctx: PublisherHookContext) => void;
  readonly onAfterManifest?: (ctx: PublisherHookContext) => void;
  readonly onBeforeCasCommit?: (ctx: PublisherHookContext) => void;
  readonly onAfterCasCommit?: (ctx: PublisherHookContext) => void;
}

export interface PublisherHookContext {
  readonly phase: string;
  readonly project: string;
  readonly generationId: string;
  readonly stagingPath: string;
  readonly finalPath?: string;
  readonly metadataPath?: string;
  readonly manifestPath?: string;
}

/**
 * R169B-STEP3: The result of a publication attempt that failed
 * BEFORE any visible mutation (CAS mismatch, CAS busy, staging
 * mutated, trust-root error). The token remains usable: the caller
 * can retry or discard.
 *
 * If the publication failed AFTER a visible mutation (link
 * succeeded, manifest written, etc.), the publisher raises a
 * `GenerationStoreError` instead — the token is consumed and the
 * caller must run recovery.
 */
export type PublicationPreFailure =
  | { readonly kind: "CAS_MISMATCH"; readonly expected: string | null; readonly actual: string | null }
  | { readonly kind: "CAS_BUSY" }
  | { readonly kind: "STAGING_MUTATED"; readonly reason: string };
