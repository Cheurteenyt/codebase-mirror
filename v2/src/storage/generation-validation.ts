/**
 * R169B-STEP1 — Generation store validators (extracted from generation-store.ts).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This module is the SINGLE home for the generation store's validators,
 * path-safety checks, and trust-root validators. It was extracted from
 * `generation-store.ts` in R169B-STEP1 to break the module cycle that
 * existed between the public facade (`generation-store.ts`) and the
 * internal I/O harness (`internal/generation-store-io.ts`).
 *
 * DEPENDENCY DIRECTION (R169B-STEP1):
 *   types -> paths/validation -> internal I/O -> public facades
 *
 *   - This module imports types from `./generation-types.js`.
 *   - This module imports path helpers from `./generation-paths.js`.
 *   - This module imports `node:fs` (for lstatSync, openSync, closeSync,
 *     readSync, fstatSync, realpathSync, constants) and `node:path`.
 *   - The internal I/O module (`./internal/generation-store-io.js`)
 *     imports validators and trust-root checks from this module.
 *   - The public facade module (`./generation-store.js`) re-exports
 *     these validators for backward compatibility with R169A callers.
 *
 * CONTENTS:
 *   - `MAX_GENERATION_MANIFEST_BYTES` and other size/length bounds.
 *   - `O_NOFOLLOW` / `O_DIRECTORY` platform flags (used by
 *     `parseGenerationManifest` and re-exported for the internal module).
 *   - `assertSafeStringField`, `assertSafeNonNegativeInt`,
 *     `assertCalendarValidTimestamp` private helpers.
 *   - `validateGenerationManifest` — strict manifest V1 validator.
 *   - `validateIndexAttemptState` — strict index-state V1 validator.
 *   - `parseGenerationManifest` — read + parse + validate a manifest
 *     from disk (TOCTOU-safe O_NOFOLLOW open).
 *   - `assertPathInsideNoSymlinks` — strict symlink-rejecting containment
 *     check (walks every path component with lstatSync).
 *   - `assertNotSymlink` — final-component symlink check.
 *   - `assertTrustedRootNoSymlinks` — trust-root chain validator.
 *   - `assertGenerationStoreRootTrusted` — trust-root validator without
 *     a specific project key (used by `listProjectStoreKeys`).
 *   - `assertLayoutDirPermissions` — two-tier permission policy for
 *     layout directories (R169A-FIX-R4 COMPAT-R169A-R4-01).
 *
 * R169B-STEP1: This module is NEW. The validators were moved here
 * verbatim from `generation-store.ts` (no behavioral changes). The
 * public facade re-exports them so existing R169A callers and tests
 * continue to work without modification.
 */

import {
  lstatSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  realpathSync,
  constants as fsConstants,
} from "node:fs";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  sep,
} from "node:path";

import {
  GenerationManifestV1,
  IndexAttemptStateV1,
  IndexAttemptStaleReasonV1,
  IndexAttemptFailureV1,
  IndexAttemptOutcome,
  IndexRecoveryAction,
  IndexPublicationState,
  MANIFEST_V1_KEYS,
  INDEX_STATE_V1_KEYS,
  GenerationStoreError,
  GenerationStoreErrorCode,
  isManifestV1Key,
  isIndexStateV1Key,
  GENERATION_METADATA_V1_KEYS,
} from "./generation-types.js";

import {
  cbmCacheDir,
  generationStoreRoot,
  projectStorageKey,
  projectStoreDir,
} from "./generation-paths.js";

// --- Constants ---

/**
 * R169A-FIX-R2 (VALID-R169A-R2-01): Maximum size, in bytes, of a
 * generation manifest file. A manifest larger than this is rejected with
 * `MANIFEST_TOO_LARGE` BEFORE being read into memory. 64 KiB is generous
 * for the V1 schema (which serializes to <1 KiB) but bounded enough to
 * prevent a malicious / corrupted manifest from exhausting memory.
 */
export const MAX_GENERATION_MANIFEST_BYTES = 64 * 1024;

/**
 * R169A-FIX-R2 (VALID-R169A-R2-01): Maximum length of the `rootFingerprint`
 * and `project` string fields in a manifest. 1024 chars is generous for
 * any plausible dev:ino fingerprint or project name; longer values are
 * rejected with `MANIFEST_SCHEMA_ERROR`.
 */
const MAX_ROOT_FINGERPRINT_LENGTH = 1024;
const MAX_PROJECT_NAME_LENGTH = 1024;

/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): Maximum length of string fields in
 * an index-state sidecar. The `failure.message` and `staleReason.message`
 * fields are bounded to prevent a runaway indexer from producing a
 * multi-MB sidecar. 8 KiB is generous for any plausible error message.
 */
const MAX_INDEX_STATE_MESSAGE_LENGTH = 8 * 1024;
const MAX_INDEX_STATE_CODE_LENGTH = 256;
const MAX_INDEX_STATE_PATH_LENGTH = 32 * 1024;
/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): Reduced from 1000 to 100 to match
 * the indexer's actual cap (R158 PERF-R158-01). The validator enforces
 * `paths.length <= 100`, `totalPaths >= paths.length`, and the
 * `pathsTruncated` <-> `totalPaths > paths.length` invariant.
 */
const MAX_STALE_PATHS = 100;

/**
 * R169A-FIX-R3 (SEC-R169A-R3-02 / SEC-R169A-R3-03): Platform flag for
 * O_NOFOLLOW / O_DIRECTORY. Present on Linux and macOS but NOT on
 * Windows. We gracefully degrade when absent. Used by
 * `parseGenerationManifest` to open the manifest with O_NOFOLLOW
 * (rejects symlinks at the kernel level) and by `openDirectoryNoFollow`
 * in the internal I/O module.
 *
 * R169B-STEP1: This constant is now defined here (was duplicated in
 * `generation-store.ts` and `internal/generation-store-io.ts`). The
 * internal I/O module imports it from here.
 */
export const O_NOFOLLOW: number = typeof (fsConstants as Record<string, unknown>).O_NOFOLLOW === "number"
  ? (fsConstants as { O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;
export const O_DIRECTORY: number = typeof (fsConstants as Record<string, unknown>).O_DIRECTORY === "number"
  ? (fsConstants as { O_DIRECTORY: number }).O_DIRECTORY
  : 0;

// --- Regexes and enum sets ---

/** UUID v4 regex (canonical form, lowercase). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256 regex (64 lowercase hex). */
const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * ISO-8601 timestamp with timezone regex. Captures year/month/day and
 * hour/minute/second components for calendar validation.
 */
const ISO8601_WITH_TZ_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** R169A-FIX-R3 (API-R169A-R3-02): Index-state outcome enum. */
const INDEX_OUTCOMES: ReadonlySet<IndexAttemptOutcome> = new Set<IndexAttemptOutcome>([
  "SUCCESS",
  "SUCCESS_WITH_WARNINGS",
  "PARTIAL",
  "FAILED",
  "STALE",
]);

/** R169A-FIX-R3 (API-R169A-R3-02): Index-state recovery enum (aligned with indexer). */
const INDEX_RECOVERY_ACTIONS: ReadonlySet<IndexRecoveryAction> = new Set<IndexRecoveryAction>([
  "none",
  "retry_incremental",
  "fix_filesystem",
  "full_reindex",
  "manifest_repair",
  "legacy_migration",
]);

/**
 * R169A-FIX-R5 (STATE-R169A-R5-01): Index-state publication state enum.
 * Replaces the R4 `published: boolean`. Four values:
 *   - "PUBLISHED": manifest swap was durable.
 *   - "NOT_NEEDED": indexer no-op (no candidate).
 *   - "NOT_PUBLISHED": publication did not complete.
 *   - "DURABILITY_UNKNOWN": rename succeeded but dir fsync failed (FAILED only).
 */
const INDEX_PUBLICATION_STATES: ReadonlySet<IndexPublicationState> = new Set<IndexPublicationState>([
  "PUBLISHED",
  "NOT_NEEDED",
  "NOT_PUBLISHED",
  "DURABILITY_UNKNOWN",
]);

// --- Private helpers ---

/**
 * R169A-FIX-R2 (VALID-R169A-R2-01): Validate a "safe string" field — used
 * for `rootFingerprint` and `project`. Rejects:
 *   - non-string values
 *   - empty after `.trim()` (whitespace-only)
 *   - length > `maxLength`
 *   - any C0 control char (charCode 0-31) — note: tab (9), newline (10),
 *     carriage return (13) are rejected here too. The "no multiline"
 *     check below is a separate defense-in-depth; this helper is stricter
 *     and catches e.g. NUL bytes that the multiline check would miss.
 */
function assertSafeStringField(
  value: unknown,
  field: string,
  maxLength: number,
  project: string,
  phase: string,
  code: GenerationStoreErrorCode = "MANIFEST_SCHEMA_ERROR",
): void {
  if (typeof value !== "string") {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `${field} must be a string, got: ${JSON.stringify(value)}`,
    );
  }
  if (value.trim().length === 0) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `${field} must not be empty or whitespace-only`,
    );
  }
  if (value.length > maxLength) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `${field} length ${value.length} exceeds maximum ${maxLength}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const cc = value.charCodeAt(i);
    if (cc < 32) {
      throw new GenerationStoreError(
        code,
        phase,
        project,
        `${field} contains a C0 control character at offset ${i} (charCode=${cc})`,
      );
    }
  }
}

/**
 * R169A-FIX (VALID-R169A-02): Safe-integer check for numeric manifest fields.
 * Number.isSafeInteger rejects Infinity, NaN, and integers beyond
 * Number.MAX_SAFE_INTEGER (2^53 - 1). Number.isInteger accepts the latter.
 */
function assertSafeNonNegativeInt(
  value: unknown,
  field: string,
  project: string,
  phase: string,
  code: GenerationStoreErrorCode = "MANIFEST_SCHEMA_ERROR",
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `${field} must be a safe non-negative integer, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * R169A-FIX (VALID-R169A-01): Calendar-valid timestamp check.
 *
 * After the regex check, also verifies that:
 *   - Date.parse accepts the value (rejects malformed that slipped past)
 *   - month is 1-12
 *   - day is valid for the (year, month) pair (handles leap years)
 *   - hour is 0-23
 *   - minute is 0-59
 *   - second is 0-59 (no leap seconds — POSIX semantics)
 */
function assertCalendarValidTimestamp(
  value: string,
  project: string,
  phase: string,
  code: GenerationStoreErrorCode = "MANIFEST_SCHEMA_ERROR",
): void {
  const match = ISO8601_WITH_TZ_REGEX.exec(value);
  if (!match) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt must match ISO-8601 with timezone, got: ${JSON.stringify(value)}`,
    );
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  // Date.parse / new Date(value) will accept many invalid calendar dates
  // by rolling them over (e.g. 2026-13-01 -> 2027-01-01). Verify each
  // component explicitly.
  if (month < 1 || month > 12) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt has invalid month: ${month} (value=${JSON.stringify(value)})`,
    );
  }
  // Days in the given month, accounting for leap years.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt has invalid day: ${day} for year ${year} month ${month} (value=${JSON.stringify(value)})`,
    );
  }
  if (hour < 0 || hour > 23) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt has invalid hour: ${hour} (value=${JSON.stringify(value)})`,
    );
  }
  if (minute < 0 || minute > 59) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt has invalid minute: ${minute} (value=${JSON.stringify(value)})`,
    );
  }
  if (second < 0 || second > 59) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt has invalid second: ${second} (value=${JSON.stringify(value)})`,
    );
  }

  // Final belt-and-suspenders: Date must parse to a valid epoch.
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new GenerationStoreError(
      code,
      phase,
      project,
      `createdAt does not parse to a valid Date: ${JSON.stringify(value)}`,
    );
  }
}

// --- Layout permission policy (R169A-FIX-R4 COMPAT-R169A-R4-01) ---

/**
 * R169A-FIX-R4 (COMPAT-R169A-R4-01): Two-tier permission policy for
 * layout directories.
 *
 * Compatibility roots (cacheRoot, codebase-memory-mcp) require
 * `mode & 0o022 === 0` (no group/other WRITE). 0755, 0750, 0700 all
 * accepted — this preserves existing legacy caches that have 0755 on
 * the cbm directory.
 *
 * Private R169 dirs (projects, projectStore, generations, tmp) require
 * `mode === 0o700` exactly. These are created fresh by R169A and
 * contain potentially sensitive information (DB file paths, manifest
 * contents); they should not be readable by other users on the host.
 *
 * On POSIX (where `process.getuid` is available), the directory's uid
 * is best-effort checked against `process.getuid()`. On Windows this
 * check is skipped.
 *
 * R169B-STEP1: This function was moved here from
 * `internal/generation-store-io.ts` to break the module cycle. It is a
 * pure validator (takes a stat-shaped object, throws on bad
 * permissions) and has no I/O harness dependencies — it belongs in the
 * validation module. The internal I/O module imports it from here; the
 * trust-root validators in this module call it directly.
 */
export function assertLayoutDirPermissions(
  st: { mode: number; uid?: number },
  dirPath: string,
  isCompatRoot: boolean,
  project: string,
  phase: string,
): void {
  if (isCompatRoot) {
    // Compatibility root: no group/other WRITE bits set.
    // 0755, 0750, 0700 all accepted.
    if ((st.mode & 0o022) !== 0) {
      throw new GenerationStoreError(
        "STORE_LAYOUT_PERMISSIONS_INSECURE",
        phase,
        project,
        `Compatibility root "${dirPath}" has insecure permissions: mode=0o${(st.mode & 0o777).toString(8)} (group/other WRITE bits must be 0)`,
      );
    }
  } else {
    // Private R169 directory: must be exactly 0700.
    if ((st.mode & 0o777) !== 0o700) {
      throw new GenerationStoreError(
        "STORE_LAYOUT_PERMISSIONS_INSECURE",
        phase,
        project,
        `Private R169 directory "${dirPath}" has insecure permissions: mode=0o${(st.mode & 0o777).toString(8)} (must be exactly 0700)`,
      );
    }
  }
  // POSIX uid check (best-effort — skip on Windows where getuid is
  // unavailable).
  if (typeof st.uid === "number" && typeof process.getuid === "function") {
    const expectedUid = process.getuid();
    if (st.uid !== expectedUid) {
      throw new GenerationStoreError(
        "STORE_LAYOUT_PERMISSIONS_INSECURE",
        phase,
        project,
        `Layout directory "${dirPath}" is owned by uid ${st.uid}, expected ${expectedUid}`,
      );
    }
  }
}

// --- Manifest parser and validator (section 18C) ---

/**
 * Parse and strictly validate a generation manifest.
 *
 * Validation rules (section 6.3, updated by R169A-FIX and R169A-FIX-R2):
 *   - Must be a JSON object (not array/null)
 *   - formatVersion must be 1
 *   - Exact key set (no missing, no extra) — checked against a private,
 *     immutable `MANIFEST_V1_KEY_SET`. Consumers cannot mutate the
 *     authority (R169A-FIX-R2 VALID-R169A-R2-01).
 *   - project must match expectedProject AND be a safe string
 *     (non-whitespace, max 1024 chars, no C0 control chars)
 *     (R169A-FIX-R2 VALID-R169A-R2-01)
 *   - generationId must be a canonical UUID v4
 *   - dbFile MUST equal `generations/generation-<generationId>.db`
 *     (R169A-FIX DATA-R169A-01: canonical form, no aliasing)
 *   - createdAt must be ISO-8601 with timezone AND calendar-valid
 *     (R169A-FIX VALID-R169A-01)
 *   - rootFingerprint must be a safe string (non-whitespace, max 1024
 *     chars, no C0 control chars) (R169A-FIX-R2 VALID-R169A-R2-01)
 *   - semantics/discovery versions must be SAFE integers >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - counts must be SAFE integers >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - sizeBytes must be SAFE integer >= 0
 *     (R169A-FIX VALID-R169A-02)
 *   - sha256 must be 64 lowercase hex
 *   - No multiline values
 *
 * R169A-FIX-R3 (VALID-R169A-R3-01): The dead placeholder code that
 * computed `missingKeys = actualKeys.filter((k) => !isManifestV1Key(k) ? false : false)`
 * (always returning `[]`) is removed. The real missing/extra key check
 * below it is the authoritative one.
 *
 * Throws GenerationStoreError on any validation failure.
 */
export function validateGenerationManifest(
  value: unknown,
  expectedProject: string,
): GenerationManifestV1 {
  const phase = "validateGenerationManifest";

  // Must be an object
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "Manifest must be a JSON object",
    );
  }

  const obj = value as Record<string, unknown>;

  // R169A-FIX-R2 (VALID-R169A-R2-01): Exact key set, checked against a
  // PRIVATE, immutable set. `MANIFEST_V1_KEYS` is exported as a frozen
  // tuple (R169A-FIX-R3 VALID-R169A-R3-01: Object.freeze'd), and the
  // validator's set is module-scoped — a consumer cannot mutate the
  // authority.
  const actualKeys = Object.keys(obj);
  const actualKeySet = new Set(actualKeys);
  const missing: string[] = [];
  for (const k of MANIFEST_V1_KEYS) {
    if (!actualKeySet.has(k)) missing.push(k);
  }
  const extra: string[] = actualKeys.filter((k) => !isManifestV1Key(k));
  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`extra: ${extra.join(", ")}`);
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `Key set mismatch (${details.join("; ")})`,
    );
  }

  // formatVersion
  if (obj.formatVersion !== 1) {
    throw new GenerationStoreError(
      "MANIFEST_UNSUPPORTED_VERSION",
      phase,
      expectedProject,
      `formatVersion must be 1, got: ${JSON.stringify(obj.formatVersion)}`,
    );
  }

  // R169A-FIX-R2 (VALID-R169A-R2-01): project — safe-string validation,
  // THEN equality with expectedProject. The safe-string check defends
  // against a manifest that happens to match expectedProject but
  // contains control chars / NUL bytes (e.g. from a corrupt write).
  assertSafeStringField(obj.project, "project", MAX_PROJECT_NAME_LENGTH, expectedProject, phase);
  if (obj.project !== expectedProject) {
    throw new GenerationStoreError(
      "MANIFEST_PROJECT_MISMATCH",
      phase,
      expectedProject,
      `project must be "${expectedProject}", got: ${JSON.stringify(obj.project)}`,
    );
  }

  // generationId — UUID v4
  if (typeof obj.generationId !== "string" || !UUID_V4_REGEX.test(obj.generationId)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `generationId must be a canonical UUID v4, got: ${JSON.stringify(obj.generationId)}`,
    );
  }

  // dbFile — R169A-FIX (DATA-R169A-01): canonical form
  if (typeof obj.dbFile !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "dbFile must be a string",
    );
  }
  const expectedDbFile = `generations/generation-${obj.generationId}.db`;
  if (obj.dbFile !== expectedDbFile) {
    throw new GenerationStoreError(
      "MANIFEST_DBFILE_NOT_CANONICAL",
      phase,
      expectedProject,
      `dbFile must be canonical "${expectedDbFile}", got: ${JSON.stringify(obj.dbFile)}`,
    );
  }

  // createdAt — R169A-FIX (VALID-R169A-01): regex + calendar check
  if (typeof obj.createdAt !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      "createdAt must be a string",
    );
  }
  assertCalendarValidTimestamp(obj.createdAt, expectedProject, phase);

  // R169A-FIX-R2 (VALID-R169A-R2-01): rootFingerprint — safe-string
  assertSafeStringField(
    obj.rootFingerprint,
    "rootFingerprint",
    MAX_ROOT_FINGERPRINT_LENGTH,
    expectedProject,
    phase,
  );

  // R169A-FIX (VALID-R169A-02): Safe-integer checks
  assertSafeNonNegativeInt(obj.extractorSemanticsVersion, "extractorSemanticsVersion", expectedProject, phase);
  assertSafeNonNegativeInt(obj.discoveryPolicyVersion, "discoveryPolicyVersion", expectedProject, phase);
  assertSafeNonNegativeInt(obj.nodeCount, "nodeCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.edgeCount, "edgeCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.fileCount, "fileCount", expectedProject, phase);
  assertSafeNonNegativeInt(obj.sizeBytes, "sizeBytes", expectedProject, phase);

  // sha256 — 64 lowercase hex
  if (typeof obj.sha256 !== "string" || !SHA256_REGEX.test(obj.sha256)) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      expectedProject,
      `sha256 must be 64 lowercase hex chars, got: ${JSON.stringify(obj.sha256)}`,
    );
  }

  // No multiline values
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string" && (val.includes("\n") || val.includes("\r"))) {
      throw new GenerationStoreError(
        "MANIFEST_SCHEMA_ERROR",
        phase,
        expectedProject,
        `${key} must not contain newlines`,
      );
    }
  }

  // All checks passed — return the validated manifest
  return obj as unknown as GenerationManifestV1;
}

// --- Index state validator (R169A-FIX-R3 API-R169A-R3-02) ---

/**
 * R169A-FIX-R3 (API-R169A-R3-02): Validate an `IndexAttemptStateV1`
 * sidecar value.
 *
 * Validation rules:
 *   - Must be a JSON object (not array/null)
 *   - Exact key set (no missing, no extra) — checked against the private
 *     `INDEX_STATE_V1_KEY_SET`. `INDEX_STATE_V1_KEYS` is exported as a
 *     frozen readonly tuple; consumers cannot mutate the authority.
 *   - formatVersion must be 1
 *   - project must match expectedProject AND be a safe string (no
 *     whitespace-only, no C0 control chars, max 1024 chars)
 *   - activeGenerationId: null OR a canonical UUID v4
 *   - lastAttemptId: canonical UUID v4 (non-null)
 *   - lastAttemptAt: ISO-8601 with timezone AND calendar-valid
 *   - lastAttemptOutcome: must be in the INDEX_OUTCOMES set
 *   - recovery: must be in the INDEX_RECOVERY_ACTIONS set (aligned with
 *     the indexer's `IndexResult.recovery` enum)
 *   - candidateGenerationId: null OR a canonical UUID v4 (R169A-FIX-R4)
 *   - publicationState: one of "PUBLISHED" | "NOT_NEEDED" |
 *     "NOT_PUBLISHED" | "DURABILITY_UNKNOWN" (R169A-FIX-R5; was
 *     `published: boolean` in R4)
 *   - failure: null OR a structured object with code/phase/message
 *   - staleReason: null OR a structured object with code/message/paths
 *     (and optional totalPaths/pathsTruncated)
 *   - Coherence rules (R169A-FIX-R5 STATE-R169A-R5-01/02)
 *
 * Throws GenerationStoreError on any validation failure. The error code
 * is INDEX_STATE_SCHEMA_ERROR for structural / type / coherence faults,
 * INDEX_STATE_PROJECT_MISMATCH for project equality, and
 * INDEX_STATE_UNSUPPORTED_VERSION for formatVersion.
 */
export function validateIndexAttemptState(
  value: unknown,
  expectedProject: string,
): IndexAttemptStateV1 {
  const phase = "validateIndexAttemptState";
  const SCHEMA = "INDEX_STATE_SCHEMA_ERROR" as const;

  // Must be an object
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      "Index-state must be a JSON object",
    );
  }

  const obj = value as Record<string, unknown>;

  // Exact key set
  const actualKeys = Object.keys(obj);
  const actualKeySet = new Set(actualKeys);
  const missing: string[] = [];
  for (const k of INDEX_STATE_V1_KEYS) {
    if (!actualKeySet.has(k)) missing.push(k);
  }
  const extra: string[] = actualKeys.filter((k) => !isIndexStateV1Key(k));
  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`extra: ${extra.join(", ")}`);
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      `Key set mismatch (${details.join("; ")})`,
    );
  }

  // formatVersion
  if (obj.formatVersion !== 1) {
    throw new GenerationStoreError(
      "INDEX_STATE_UNSUPPORTED_VERSION",
      phase,
      expectedProject,
      `formatVersion must be 1, got: ${JSON.stringify(obj.formatVersion)}`,
    );
  }

  // project — safe-string + equality
  assertSafeStringField(obj.project, "project", MAX_PROJECT_NAME_LENGTH, expectedProject, phase, SCHEMA);
  if (obj.project !== expectedProject) {
    throw new GenerationStoreError(
      "INDEX_STATE_PROJECT_MISMATCH",
      phase,
      expectedProject,
      `project must be "${expectedProject}", got: ${JSON.stringify(obj.project)}`,
    );
  }

  // activeGenerationId: null OR UUID v4
  if (obj.activeGenerationId !== null) {
    if (typeof obj.activeGenerationId !== "string" || !UUID_V4_REGEX.test(obj.activeGenerationId)) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `activeGenerationId must be null or a canonical UUID v4, got: ${JSON.stringify(obj.activeGenerationId)}`,
      );
    }
  }

  // lastAttemptId: UUID v4 (non-null)
  if (typeof obj.lastAttemptId !== "string" || !UUID_V4_REGEX.test(obj.lastAttemptId)) {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      `lastAttemptId must be a canonical UUID v4, got: ${JSON.stringify(obj.lastAttemptId)}`,
    );
  }

  // lastAttemptAt: ISO-8601 with timezone + calendar-valid
  if (typeof obj.lastAttemptAt !== "string") {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      "lastAttemptAt must be a string",
    );
  }
  assertCalendarValidTimestamp(obj.lastAttemptAt, expectedProject, phase, SCHEMA);

  // lastAttemptOutcome: enum
  if (typeof obj.lastAttemptOutcome !== "string" || !INDEX_OUTCOMES.has(obj.lastAttemptOutcome as IndexAttemptOutcome)) {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      `lastAttemptOutcome must be one of ${[...INDEX_OUTCOMES].join("|")}, got: ${JSON.stringify(obj.lastAttemptOutcome)}`,
    );
  }
  const outcome = obj.lastAttemptOutcome as IndexAttemptOutcome;

  // recovery: enum
  if (typeof obj.recovery !== "string" || !INDEX_RECOVERY_ACTIONS.has(obj.recovery as IndexRecoveryAction)) {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      `recovery must be one of ${[...INDEX_RECOVERY_ACTIONS].join("|")}, got: ${JSON.stringify(obj.recovery)}`,
    );
  }
  const recovery = obj.recovery as IndexRecoveryAction;

  // R169A-FIX-R4 (STATE-R169A-R4-01): candidateGenerationId: null OR UUID v4.
  if (obj.candidateGenerationId !== null) {
    if (typeof obj.candidateGenerationId !== "string" || !UUID_V4_REGEX.test(obj.candidateGenerationId)) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `candidateGenerationId must be null or a canonical UUID v4, got: ${JSON.stringify(obj.candidateGenerationId)}`,
      );
    }
  }

  // R169A-FIX-R5 (STATE-R169A-R5-01): publicationState must be one of the
  // four enum values. Replaces the R4 `published: boolean` check.
  if (typeof obj.publicationState !== "string" || !INDEX_PUBLICATION_STATES.has(obj.publicationState as IndexPublicationState)) {
    throw new GenerationStoreError(
      SCHEMA,
      phase,
      expectedProject,
      `publicationState must be one of ${[...INDEX_PUBLICATION_STATES].join("|")}, got: ${JSON.stringify(obj.publicationState)}`,
    );
  }
  const publicationState = obj.publicationState as IndexPublicationState;

  // R169A-FIX-R4 (STATE-R169A-R4-01): failure is null OR a structured
  // object { code, phase, message }.
  let failure: IndexAttemptFailureV1 | null = null;
  if (obj.failure !== null) {
    if (obj.failure === undefined || typeof obj.failure !== "object" || Array.isArray(obj.failure)) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `failure must be null or an object, got: ${JSON.stringify(obj.failure)}`,
      );
    }
    const fl = obj.failure as Record<string, unknown>;
    const FL_REQUIRED: ReadonlySet<string> = new Set(["code", "phase", "message"]);
    const flKeys = Object.keys(fl);
    for (const k of FL_REQUIRED) {
      if (!(k in fl)) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `failure.${k} is required`,
        );
      }
    }
    for (const k of flKeys) {
      if (!FL_REQUIRED.has(k)) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `failure has unknown key "${k}"`,
        );
      }
    }
    assertSafeStringField(fl.code, "failure.code", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    assertSafeStringField(fl.phase, "failure.phase", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    assertSafeStringField(fl.message, "failure.message", MAX_INDEX_STATE_MESSAGE_LENGTH, expectedProject, phase, SCHEMA);
    failure = {
      code: fl.code as string,
      phase: fl.phase as string,
      message: fl.message as string,
    };
  }

  // staleReason: null OR structured object
  let staleReason: IndexAttemptStaleReasonV1 | null = null;
  if (obj.staleReason !== null) {
    if (obj.staleReason === undefined || typeof obj.staleReason !== "object" || Array.isArray(obj.staleReason)) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason must be null or an object, got: ${JSON.stringify(obj.staleReason)}`,
      );
    }
    const sr = obj.staleReason as Record<string, unknown>;
    const SR_REQUIRED: ReadonlySet<string> = new Set(["code", "message", "paths"]);
    const SR_OPTIONAL: ReadonlySet<string> = new Set(["totalPaths", "pathsTruncated"]);
    const srKeys = Object.keys(sr);
    for (const k of SR_REQUIRED) {
      if (!(k in sr)) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.${k} is required`,
        );
      }
    }
    for (const k of srKeys) {
      if (!SR_REQUIRED.has(k) && !SR_OPTIONAL.has(k)) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason has unknown key "${k}"`,
        );
      }
    }
    assertSafeStringField(sr.code, "staleReason.code", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    assertSafeStringField(sr.message, "staleReason.message", MAX_INDEX_STATE_MESSAGE_LENGTH, expectedProject, phase, SCHEMA);
    if (!Array.isArray(sr.paths)) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason.paths must be an array, got: ${JSON.stringify(sr.paths)}`,
      );
    }
    if (sr.paths.length > MAX_STALE_PATHS) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason.paths length ${sr.paths.length} exceeds maximum ${MAX_STALE_PATHS}`,
      );
    }
    for (let i = 0; i < sr.paths.length; i++) {
      const p = sr.paths[i];
      if (typeof p !== "string") {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.paths[${i}] must be a string, got: ${JSON.stringify(p)}`,
        );
      }
      if (p.length > MAX_INDEX_STATE_PATH_LENGTH) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.paths[${i}] length ${p.length} exceeds maximum ${MAX_INDEX_STATE_PATH_LENGTH}`,
        );
      }
      for (let j = 0; j < p.length; j++) {
        const cc = p.charCodeAt(j);
        if (cc < 32) {
          throw new GenerationStoreError(
            SCHEMA,
            phase,
            expectedProject,
            `staleReason.paths[${i}] contains a C0 control character at offset ${j} (charCode=${cc})`,
          );
        }
      }
    }
    if (sr.totalPaths !== undefined) {
      assertSafeNonNegativeInt(sr.totalPaths, "staleReason.totalPaths", expectedProject, phase, SCHEMA);
      if ((sr.totalPaths as number) < sr.paths.length) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.totalPaths (${sr.totalPaths}) must be >= paths.length (${sr.paths.length})`,
        );
      }
    }
    if (sr.pathsTruncated !== undefined && typeof sr.pathsTruncated !== "boolean") {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason.pathsTruncated must be a boolean, got: ${JSON.stringify(sr.pathsTruncated)}`,
      );
    }
    if (sr.pathsTruncated === true) {
      if (sr.totalPaths === undefined) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.pathsTruncated=true but totalPaths is absent (must be present and > paths.length=${sr.paths.length})`,
        );
      }
      if ((sr.totalPaths as number) <= sr.paths.length) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `staleReason.pathsTruncated=true but totalPaths (${sr.totalPaths}) <= paths.length (${sr.paths.length})`,
        );
      }
    }
    if (sr.pathsTruncated === false && sr.totalPaths !== undefined && (sr.totalPaths as number) !== sr.paths.length) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason.pathsTruncated=false but totalPaths (${sr.totalPaths}) != paths.length (${sr.paths.length})`,
      );
    }
    if (sr.pathsTruncated === undefined && sr.totalPaths !== undefined && (sr.totalPaths as number) !== sr.paths.length) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `staleReason.pathsTruncated absent but totalPaths (${sr.totalPaths}) != paths.length (${sr.paths.length})`,
      );
    }
    staleReason = {
      code: sr.code as string,
      message: sr.message as string,
      paths: sr.paths as readonly string[],
      totalPaths: typeof sr.totalPaths === "number" ? sr.totalPaths : undefined,
      pathsTruncated: typeof sr.pathsTruncated === "boolean" ? sr.pathsTruncated : undefined,
    };
  }

  // Coherence rules (R169A-FIX-R5 STATE-R169A-R5-01/02).
  if (outcome === "SUCCESS" || outcome === "SUCCESS_WITH_WARNINGS") {
    if (publicationState === "PUBLISHED") {
      if (obj.activeGenerationId === null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=PUBLISHED but activeGenerationId is null (must reference the live generation)`,
        );
      }
      if (obj.candidateGenerationId !== obj.activeGenerationId) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=PUBLISHED but candidateGenerationId (${JSON.stringify(obj.candidateGenerationId)}) != activeGenerationId (${JSON.stringify(obj.activeGenerationId)}) (on PUBLISHED the candidate becomes the active)`,
        );
      }
      if (failure !== null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=PUBLISHED but failure is non-null`,
        );
      }
      if (staleReason !== null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=PUBLISHED but staleReason is non-null`,
        );
      }
      if (recovery !== "none") {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=PUBLISHED but recovery="${recovery}" (must be "none")`,
        );
      }
    } else if (publicationState === "NOT_NEEDED") {
      if (obj.candidateGenerationId !== null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=NOT_NEEDED but candidateGenerationId is non-null (no-op must have no candidate)`,
        );
      }
      if (failure !== null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=NOT_NEEDED but failure is non-null`,
        );
      }
      if (staleReason !== null) {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=NOT_NEEDED but staleReason is non-null`,
        );
      }
      if (recovery !== "none") {
        throw new GenerationStoreError(
          SCHEMA,
          phase,
          expectedProject,
          `Coherence violation: outcome=${outcome} + publicationState=NOT_NEEDED but recovery="${recovery}" (must be "none")`,
        );
      }
    } else {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=${outcome} but publicationState="${publicationState}" (must be PUBLISHED or NOT_NEEDED)`,
      );
    }
  } else if (outcome === "PARTIAL") {
    if (publicationState !== "NOT_PUBLISHED") {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=PARTIAL but publicationState="${publicationState}" (must be NOT_PUBLISHED)`,
      );
    }
    if (failure === null) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=PARTIAL but failure is null (must carry the failure record)`,
      );
    }
  } else if (outcome === "FAILED") {
    if (publicationState !== "NOT_PUBLISHED" && publicationState !== "DURABILITY_UNKNOWN") {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=FAILED but publicationState="${publicationState}" (must be NOT_PUBLISHED or DURABILITY_UNKNOWN)`,
      );
    }
    if (failure === null) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=FAILED but failure is null (must carry the failure record)`,
      );
    }
  } else if (outcome === "STALE") {
    if (publicationState !== "NOT_PUBLISHED") {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=STALE but publicationState="${publicationState}" (must be NOT_PUBLISHED)`,
      );
    }
    if (staleReason === null) {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=STALE but staleReason is null`,
      );
    }
    if (recovery === "none") {
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=STALE but recovery="none" (must recommend an action)`,
      );
    }
  }

  return obj as unknown as IndexAttemptStateV1;
}

/**
 * Read and parse a manifest from disk.
 * Throws on read error, JSON parse error, or validation error.
 *
 * R169A-FIX-R2 (VALID-R169A-R2-01): Before reading, stat the file. If
 * the size exceeds `MAX_GENERATION_MANIFEST_BYTES` (64 KiB), throw
 * `MANIFEST_TOO_LARGE` — do NOT read the file into memory.
 *
 * R169A-FIX-R3 (SEC-R169A-R3-03): TOCTOU-safe O_NOFOLLOW open. The
 * parser opens with `O_RDONLY | O_NOFOLLOW` (when available) and fstat's
 * the SAME fd. Fallback: lstatSync -> openSync -> fstatSync -> compare
 * dev+ino.
 */
export function parseGenerationManifest(
  manifestPath: string,
  expectedProject: string,
): GenerationManifestV1 {
  const phase = "parseGenerationManifest";

  let fd: number | null = null;
  let sizeStat: { size: number; isFile(): boolean; isSymbolicLink(): boolean; dev: number; ino: number };

  if (O_NOFOLLOW) {
    const flags = fsConstants.O_RDONLY | O_NOFOLLOW;
    try {
      fd = openSync(manifestPath, flags);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        // R169B-STEP4 (MANIFEST-R169B-A2-15): raise MANIFEST_NOT_FOUND
        // (distinct from MANIFEST_PARSE_ERROR) so readOptionalGenerationManifest
        // can distinguish real ENOENT from corrupt manifest without string
        // matching.
        throw new GenerationStoreError(
          "MANIFEST_NOT_FOUND",
          phase,
          expectedProject,
          `Manifest file not found: ${manifestPath}`,
        );
      }
      if (errCode === "ELOOP") {
        throw new GenerationStoreError(
          "MANIFEST_SYMLINK_REJECTED",
          phase,
          expectedProject,
          `Manifest path is a symlink (rejected by O_NOFOLLOW): ${manifestPath}`,
        );
      }
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to open manifest with O_NOFOLLOW "${manifestPath}": ${(e as Error).message}`,
      );
    }
    try {
      const s = fstatSync(fd);
      sizeStat = {
        size: s.size,
        isFile: () => s.isFile(),
        isSymbolicLink: () => s.isSymbolicLink(),
        dev: s.dev,
        ino: s.ino,
      };
    } catch (e) {
      try { closeSync(fd); } catch { /* best effort */ }
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to fstat manifest fd: ${(e as Error).message}`,
      );
    }
  } else {
    let lstat;
    try {
      lstat = lstatSync(manifestPath);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        // R169B-STEP4 (MANIFEST-R169B-A2-15): raise MANIFEST_NOT_FOUND.
        throw new GenerationStoreError(
          "MANIFEST_NOT_FOUND",
          phase,
          expectedProject,
          `Manifest file not found: ${manifestPath}`,
        );
      }
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to lstat manifest "${manifestPath}": ${(e as Error).message}`,
      );
    }
    if (lstat.isSymbolicLink()) {
      throw new GenerationStoreError(
        "MANIFEST_SYMLINK_REJECTED",
        phase,
        expectedProject,
        `Manifest path is a symlink: ${manifestPath}`,
      );
    }
    try {
      fd = openSync(manifestPath, "r");
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        // R169B-STEP4 (MANIFEST-R169B-A2-15): raise MANIFEST_NOT_FOUND.
        throw new GenerationStoreError(
          "MANIFEST_NOT_FOUND",
          phase,
          expectedProject,
          `Manifest file not found (open): ${manifestPath}`,
        );
      }
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to open manifest "${manifestPath}": ${(e as Error).message}`,
      );
    }
    let fstat;
    try {
      fstat = fstatSync(fd);
    } catch (e) {
      try { closeSync(fd); } catch { /* best effort */ }
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to fstat manifest fd: ${(e as Error).message}`,
      );
    }
    if (lstat.dev !== fstat.dev || lstat.ino !== fstat.ino) {
      try { closeSync(fd); } catch { /* best effort */ }
      throw new GenerationStoreError(
        "MANIFEST_SYMLINK_REJECTED",
        phase,
        expectedProject,
        `Manifest path was swapped between lstat and open (dev/ino mismatch): ${manifestPath}`,
      );
    }
    sizeStat = {
      size: fstat.size,
      isFile: () => fstat.isFile(),
      isSymbolicLink: () => fstat.isSymbolicLink(),
      dev: fstat.dev,
      ino: fstat.ino,
    };
  }

  if (!sizeStat.isFile()) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "MANIFEST_TARGET_NOT_REGULAR",
      phase,
      expectedProject,
      `Manifest path is not a regular file: ${manifestPath}`,
    );
  }

  if (sizeStat.size > MAX_GENERATION_MANIFEST_BYTES) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "MANIFEST_TOO_LARGE",
      phase,
      expectedProject,
      `Manifest size ${sizeStat.size} exceeds maximum ${MAX_GENERATION_MANIFEST_BYTES} bytes: ${manifestPath}`,
    );
  }

  let raw: string;
  try {
    const buf = Buffer.alloc(sizeStat.size);
    let offset = 0;
    while (offset < buf.length) {
      let n: number;
      try {
        n = readSync(fd, buf, offset, buf.length - offset, null);
      } catch (e) {
        throw new GenerationStoreError(
          "MANIFEST_PARSE_ERROR",
          phase,
          expectedProject,
          `Failed to read manifest "${manifestPath}": ${(e as Error).message}`,
        );
      }
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== buf.length) {
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Short read of manifest "${manifestPath}": expected ${buf.length} bytes, got ${offset}`,
      );
    }

    let refstat;
    try {
      refstat = fstatSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to re-fstat manifest fd: ${(e as Error).message}`,
      );
    }
    if (refstat.size !== sizeStat.size || refstat.dev !== sizeStat.dev || refstat.ino !== sizeStat.ino) {
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Manifest file was swapped between initial fstat and re-fstat (size/dev/ino mismatch): ${manifestPath}`,
      );
    }

    const extra = Buffer.alloc(1);
    let extraN: number;
    try {
      extraN = readSync(fd, extra, 0, 1, null);
    } catch (e) {
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Failed to read EOF probe byte: ${(e as Error).message}`,
      );
    }
    if (extraN > 0) {
      throw new GenerationStoreError(
        "MANIFEST_TOO_LARGE",
        phase,
        expectedProject,
        `Manifest file grew between initial fstat (size=${sizeStat.size}) and EOF probe: ${manifestPath}`,
      );
    }

    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        expectedProject,
        `Manifest contains invalid UTF-8: ${(e as Error).message}`,
      );
    }
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GenerationStoreError(
      "MANIFEST_PARSE_ERROR",
      phase,
      expectedProject,
      `Failed to parse JSON: ${(e as Error).message}`,
    );
  }

  return validateGenerationManifest(parsed, expectedProject);
}

// --- R169B-STEP3: readOptionalGenerationManifest (MANIFEST-R169B-A1-04) ---

/**
 * R169B-STEP3 (GPT 5.6 Pass 1 audit, MANIFEST-R169B-A1-04): Read an
 * optional generation manifest. Returns `null` ONLY on a real ENOENT
 * (file does not exist). Every other failure (JSON malformed, invalid
 * UTF-8, EACCES, EIO, short read, growth during read, symlink,
 * non-regular file, byte-too-large, schema invalid, project mismatch)
 * raises a `GenerationStoreError` with the appropriate code.
 *
 * This closes the fail-closed gap where `parseGenerationManifest`
 * lumped ENOENT together with all other errors under
 * `MANIFEST_PARSE_ERROR`, allowing the publisher / GC to treat a
 * CORRUPT manifest as "absent" and proceed as if no generation was
 * active.
 *
 * The contract:
 *   - `null` => the manifest file is genuinely absent (ENOENT).
 *   - `GenerationManifestV1` => the manifest is present and valid.
 *   - throws => the manifest is present but corrupt / invalid /
 *     unreadable. The caller MUST fail-closed (treat as "manifest
 *     corrupt" and refuse to publish / GC).
 *
 * Implementation: we delegate to `parseGenerationManifest` and
 * translate a `MANIFEST_NOT_FOUND` error code (raised ONLY on real
 * ENOENT) into `null`. Every other error code is re-raised as-is.
 * R169B-STEP4 (MANIFEST-R169B-A2-15): no more string matching on
 * the error message — the code is the authority.
 */
export function readOptionalGenerationManifest(
  manifestPath: string,
  expectedProject: string,
): GenerationManifestV1 | null {
  try {
    return parseGenerationManifest(manifestPath, expectedProject);
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      // R169B-STEP4 (MANIFEST-R169B-A2-15): parseGenerationManifest now
      // raises MANIFEST_NOT_FOUND (distinct code) on real ENOENT. We
      // translate ONLY that code to null. Every other error (corrupt
      // JSON, invalid UTF-8, symlink, too large, schema invalid,
      // project mismatch, EACCES, EIO, short read, growth during read)
      // is re-raised as-is so the caller fails-closed.
      if (e.code === "MANIFEST_NOT_FOUND") {
        return null;
      }
      throw e;
    }
    throw e;
  }
}

// --- R169B-STEP3: validateGenerationMetadata (META-R169B-A1-17) ---

/**
 * R169B-STEP3 (GPT 5.6 Pass 1 audit, META-R169B-A1-17): Strict
 * metadata V1 validator. The metadata sidecar is the immutable
 * publication record. It must have the exact key set
 * `GENERATION_METADATA_V1_KEYS`, with `formatVersion === 1`, a
 * fully validated nested `manifest`, and string/null fields with
 * the correct types.
 *
 * Returns a `GenerationMetadataV1` (frozen) on success. Throws
 * `GenerationStoreError` with code `GENERATION_METADATA_INVALID`
 * on any failure.
 */
export function validateGenerationMetadata(
  value: unknown,
  expectedProject: string,
): import("./generation-types.js").GenerationMetadataV1 {
  const phase = "validateGenerationMetadata";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata payload is not an object (got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value})`,
    );
  }
  const obj = value as Record<string, unknown>;
  // Exact key set.
  const actualKeys = Object.keys(obj);
  const expectedSet = new Set<string>(
    GENERATION_METADATA_V1_KEYS as readonly string[],
  );
  for (const k of actualKeys) {
    if (!expectedSet.has(k)) {
      throw new GenerationStoreError(
        "GENERATION_METADATA_INVALID",
        phase,
        expectedProject,
        `Metadata has unexpected key "${k}" (allowed: ${[...expectedSet].join(", ")})`,
      );
    }
  }
  for (const k of expectedSet) {
    if (!(k in obj)) {
      throw new GenerationStoreError(
        "GENERATION_METADATA_INVALID",
        phase,
        expectedProject,
        `Metadata is missing required key "${k}"`,
      );
    }
  }
  // formatVersion
  if (obj.formatVersion !== 1) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata formatVersion must be 1 (got ${JSON.stringify(obj.formatVersion)})`,
    );
  }
  // manifest (nested)
  const manifest = validateGenerationManifest(obj.manifest, expectedProject);
  // publishedAt (non-empty string)
  if (typeof obj.publishedAt !== "string" || obj.publishedAt.length === 0) {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata publishedAt must be a non-empty string (got ${JSON.stringify(obj.publishedAt)})`,
    );
  }
  // deduped (boolean)
  if (typeof obj.deduped !== "boolean") {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata deduped must be a boolean (got ${JSON.stringify(obj.deduped)})`,
    );
  }
  // dedupSourceGenerationId (string | null)
  if (obj.dedupSourceGenerationId !== null && typeof obj.dedupSourceGenerationId !== "string") {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata dedupSourceGenerationId must be a string or null (got ${JSON.stringify(obj.dedupSourceGenerationId)})`,
    );
  }
  // previousActiveGenerationId (string | null)
  if (obj.previousActiveGenerationId !== null && typeof obj.previousActiveGenerationId !== "string") {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata previousActiveGenerationId must be a string or null (got ${JSON.stringify(obj.previousActiveGenerationId)})`,
    );
  }
  // pinned (boolean)
  if (typeof obj.pinned !== "boolean") {
    throw new GenerationStoreError(
      "GENERATION_METADATA_INVALID",
      phase,
      expectedProject,
      `Metadata pinned must be a boolean (got ${JSON.stringify(obj.pinned)})`,
    );
  }
  const result: import("./generation-types.js").GenerationMetadataV1 = {
    formatVersion: 1,
    manifest,
    publishedAt: obj.publishedAt,
    deduped: obj.deduped,
    dedupSourceGenerationId: obj.dedupSourceGenerationId as string | null,
    previousActiveGenerationId: obj.previousActiveGenerationId as string | null,
    pinned: obj.pinned,
  };
  Object.freeze(result);
  Object.freeze(result.manifest);
  return result;
}

// --- Path safety: symlink-rejecting containment (R169A-FIX SEC-R169A-02) ---

/**
 * R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check.
 *
 * Walks every path component from `root` to `candidate` with lstatSync.
 * Rejects if ANY component in the chain is a symbolic link. After the
 * walk, uses realpathSync.native on both endpoints for a final
 * containment check.
 *
 * Error policy (fail-closed):
 *   - ENOENT  -> treat as "absent"; return without throwing. The caller
 *               is responsible for distinguishing "missing target" from
 *               "present target" via lstatSync of the final component.
 *   - EACCES  -> fail closed with PATH_TRAVERSAL_REJECTED
 *   - EIO     -> fail closed with PATH_TRAVERSAL_REJECTED
 *   - ENOTDIR -> fail closed with PATH_TRAVERSAL_REJECTED
 *   - ELOOP   -> fail closed with PATH_TRAVERSAL_REJECTED
 *   - any other error -> fail closed with PATH_TRAVERSAL_REJECTED
 *
 * The `symlinkCode` argument controls which error code is thrown when a
 * symlink is detected — typically MANIFEST_SYMLINK_REJECTED for the
 * manifest path, GENERATION_TARGET_SYMLINK_REJECTED for the target DB,
 * or PROJECT_STATE_SYMLINK_REJECTED for the index-state sidecar
 * (R169A-FIX-R3 QUAL-R169A-R3-01). Traversal errors always use
 * PATH_TRAVERSAL_REJECTED.
 */
export function assertPathInsideNoSymlinks(
  root: string,
  candidate: string,
  project: string,
  phase: string,
  symlinkCode: GenerationStoreErrorCode = "MANIFEST_SYMLINK_REJECTED",
): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);

  if (rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `Path escapes root lexically: root=${resolvedRoot}, candidate=${resolvedCandidate}`,
    );
  }

  if (rel !== "") {
    const parts = rel.split(sep).filter(Boolean);
    let current = resolvedRoot;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (e) {
        const errCode = (e as NodeJS.ErrnoException).code;
        if (errCode === "ENOENT") {
          return;
        }
        throw new GenerationStoreError(
          "PATH_TRAVERSAL_REJECTED",
          phase,
          project,
          `Cannot stat path component "${current}": ${(e as Error).message}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new GenerationStoreError(
          symlinkCode,
          phase,
          project,
          `Symlink detected in path chain at "${current}"`,
        );
      }
    }
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync.native(resolvedCandidate);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `realpath failed for candidate "${resolvedCandidate}": ${(e as Error).message}`,
    );
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolvedRoot);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `realpath failed for root "${resolvedRoot}": ${(e as Error).message}`,
    );
  }
  const realRel = relative(realRoot, realCandidate);
  if (realRel === ".." || realRel.startsWith(".." + sep) || isAbsolute(realRel)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `Realpath escapes root: realRoot=${realRoot}, realCandidate=${realCandidate}`,
    );
  }
}

/**
 * R169A-FIX (SEC-R169A-02): Reject a path if it is a symlink.
 * Unlike assertPathInsideNoSymlinks, this only checks the final path
 * component (not the chain) and is intended for use after existence is
 * already confirmed.
 */
export function assertNotSymlink(
  path: string,
  code: GenerationStoreErrorCode,
  project: string,
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return;
    throw new GenerationStoreError(
      code,
      "assertNotSymlink",
      project,
      `Cannot stat "${path}": ${(e as Error).message}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new GenerationStoreError(
      code,
      "assertNotSymlink",
      project,
      `Symlink rejected: ${path}`,
    );
  }
}

// --- Trust root validation (R169A-FIX-R2 SEC-R169A-R2-01) ---

/**
 * R169A-FIX-R2 (SEC-R169A-R2-01): Validate the trust root for a project.
 *
 * `assertPathInsideNoSymlinks(root, candidate)` only walks components
 * UNDER `root`. It never lstat's `root` itself. If `projects/` (or any
 * of its parents) is a symlink to an attacker-controlled directory, both
 * `realpath(root)` and `realpath(candidate)` follow the same symlink,
 * and the containment check passes — bypassing the trust boundary.
 *
 * This function closes that bypass by lstat'ing the cache root itself,
 * then walking the chain `<cacheRoot>`, `<cacheRoot>/codebase-memory-mcp`,
 * `<cacheRoot>/codebase-memory-mcp/projects`,
 * `<cacheRoot>/codebase-memory-mcp/projects/<sha256(project)>`. Any
 * symlink in this chain is rejected. Only ENOENT is tolerated.
 */
export function assertTrustedRootNoSymlinks(
  cacheRoot: string,
  project: string,
  phase: string,
): void {
  const key = projectStorageKey(project);
  const chain: Array<{ label: string; path: string; isCompatRoot: boolean }> = [
    { label: "cacheRoot", path: cacheRoot, isCompatRoot: true },
    { label: "codebase-memory-mcp", path: cbmCacheDir(cacheRoot), isCompatRoot: true },
    { label: "projects", path: generationStoreRoot(cacheRoot), isCompatRoot: false },
    { label: "project-key", path: join(generationStoreRoot(cacheRoot), key), isCompatRoot: false },
  ];

  for (const { label, path, isCompatRoot } of chain) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        continue;
      }
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        project,
        `Cannot lstat trust-root component "${label}" at "${path}": ${(e as Error).message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        project,
        `Trust-root component "${label}" at "${path}" is a symlink — rejected`,
      );
    }
    if (stat.isDirectory()) {
      assertLayoutDirPermissions(stat, path, isCompatRoot, project, phase);
    }
  }

  const storeRoot = generationStoreRoot(cacheRoot);
  const projectDir = projectStoreDir(project, cacheRoot);
  assertPathInsideNoSymlinks(
    storeRoot,
    projectDir,
    project,
    phase,
    "PATH_TRAVERSAL_REJECTED",
  );
}

/**
 * R169A-FIX-R3 (OPS-R169A-R3-01): Validate the trust root WITHOUT a
 * specific project key. Used by `listProjectStoreKeys`.
 */
export function assertGenerationStoreRootTrusted(
  cacheRoot: string,
  phase: string,
): void {
  const chain: Array<{ label: string; path: string; isCompatRoot: boolean }> = [
    { label: "cacheRoot", path: cacheRoot, isCompatRoot: true },
    { label: "codebase-memory-mcp", path: cbmCacheDir(cacheRoot), isCompatRoot: true },
    { label: "projects", path: generationStoreRoot(cacheRoot), isCompatRoot: false },
  ];

  for (const { label, path, isCompatRoot } of chain) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        continue;
      }
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        "",
        `Cannot lstat trust-root component "${label}" at "${path}": ${(e as Error).message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        "",
        `Trust-root component "${label}" at "${path}" is a symlink — rejected`,
      );
    }
    if (stat.isDirectory()) {
      assertLayoutDirPermissions(stat, path, isCompatRoot, "", phase);
    }
  }
}
