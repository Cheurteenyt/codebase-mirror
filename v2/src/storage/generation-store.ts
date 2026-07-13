/**
 * R169A — Atomic Generation Publication: generation store core.
 *
 * STATUS: FOUNDATION / INACTIVE
 * This module provides path helpers, manifest validation, a read-only
 * resolver, and an atomic JSON writer. No production code calls these
 * functions yet — the indexer and readers still use the legacy DB path.
 *
 * Section references are to the R169A specification (GPT 5.6 report).
 *
 * Security:
 *   - Project names are NEVER used directly as paths. A deterministic
 *     SHA-256 key is used instead (section 6.1).
 *   - All paths are containment-checked against the injected cache root
 *     (R169A-FIX SEC-R169A-01: unified cacheRoot parameter).
 *   - Symlinks in manifests and generation targets are rejected, and
 *     symlink CHAINS in any path component are also rejected
 *     (R169A-FIX SEC-R169A-02: assertPathInsideNoSymlinks walks every
 *     component with lstatSync).
 *   - R169A-FIX-R2 (SEC-R169A-R2-01): The trust root itself is validated
 *     by assertTrustedRootNoSymlinks. It lstat's cacheRoot itself and
 *     walks `codebase-memory-mcp`, `projects`, `<project-key>` — ANY
 *     symlink in this chain is rejected. This closes the bypass where
 *     cacheRoot (or any of its CBM subdirectories) is itself a symlink:
 *     realpath on both endpoints would follow the same symlink and the
 *     containment check would pass.
 *   - Path traversal (`..`) and absolute paths in dbFile are rejected.
 *   - dbFile MUST be the canonical form `generations/generation-<uuid>.db`
 *     (R169A-FIX DATA-R169A-01: no aliasing).
 *   - Legacy DB path is containment-checked against cacheRoot
 *     (R169A-FIX SEC-R169A-01: legacyCodeDbPath rejects ../escape, absolute).
 *
 * R169A-FIX-R2 (GPT 5.6 pass 2 audit) changes:
 *   - SEC-R169A-R2-01: assertTrustedRootNoSymlinks validates the root.
 *   - SEC-R169A-R2-02: writeProjectJsonAtomically wrapper — the public
 *     writer derives target paths from project + target type, validates
 *     the trust root, rejects symlinked targets, and creates files /
 *     directories with mode 0600 / 0700. writeJsonAtomically is now
 *     internal (non-exported).
 *   - DUR-R169A-R2-01: ensureGenerationStoreLayoutDurable fsyncs every
 *     directory in the chain (and the parent of any newly created dir).
 *     Failure modes: STORE_LAYOUT_CREATE_FAILED (mkdir fault) and
 *     STORE_LAYOUT_DURABILITY_UNKNOWN (dir or parent fsync fault).
 *   - VALID-R169A-R2-01: manifest hardening — 64 KiB size bound
 *     (MANIFEST_TOO_LARGE), rootFingerprint / project field validation
 *     (trim, max length, no C0 control chars), and an immutable key
 *     authority (MANIFEST_V1_KEYS as a readonly tuple).
 *   - API-R169A-R2-01: LEGACY_SOURCE_OPEN_FAILED renamed to
 *     LEGACY_SOURCE_INVALID. R169A validates path + regular-file identity
 *     only; actual SQLite open validation occurs in R169D reader cutover.
 *   - QUAL-R169A-R2-01: every filesystem operation is wrapped in try/catch
 *     that produces a GenerationStoreError with the project name.
 *
 * R169A-FIX-R3 (GPT 5.6 pass 3 audit) changes:
 *   - API-R169A-R3-01: writeProjectJsonAtomically is now INTERNAL
 *     (renamed to writeProjectJsonAtomicallyInternal; not exported). The
 *     public writers are typed, validating wrappers:
 *       `writeGenerationManifestAtomically(project, manifest, options?, ops?, hook?)`
 *       `writeIndexStateAtomically(project, state, options?, ops?, hook?)`
 *     Both call their respective validator BEFORE any filesystem I/O.
 *     If validation fails, NO temp / layout / target is created.
 *   - API-R169A-R3-02: validateIndexAttemptState implemented with exact
 *     key set, formatVersion, project equality, UUID validation, ISO-8601
 *     timestamp validation, outcome + recovery enum checks, coherence
 *     rules (SUCCESS / SUCCESS_WITH_WARNINGS / FAILED / STALE), structured
 *     staleReason validation (code/message/paths/totalPaths/pathsTruncated),
 *     safe-integer checks, no C0 control chars, string length bounds.
 *     IndexAttemptStaleReasonV1 + INDEX_STATE_V1_KEYS added to types.
 *   - SEC-R169A-R3-01: writeProjectJsonAtomicallyInternal no longer
 *     calls mkdirSync — the parent must already exist (created by
 *     ensureGenerationStoreLayoutDurable). Immediately before
 *     openSync(tmpPath, "wx", 0o600), the writer re-runs
 *     assertTrustedRootNoSymlinks + assertPathInsideNoSymlinks so a
 *     symlink race between layout and temp-open is rejected. A
 *     WriterTestHook (afterLayoutBeforeOpen) lets tests inject the race.
 *   - SEC-R169A-R3-02: ensureGenerationStoreLayoutDurable no longer
 *     accepts EEXIST silently. On EEXIST it lstat's the dir, rejects
 *     symlinks, rejects non-directories (STORE_LAYOUT_CREATE_FAILED),
 *     re-runs assertTrustedRootNoSymlinks + assertPathInsideNoSymlinks,
 *     and checks permissions (mode & 0o077 !== 0 →
 *     STORE_LAYOUT_PERMISSIONS_INSECURE). When O_DIRECTORY | O_NOFOLLOW
 *     are available, the dir is opened with those flags.
 *   - SEC-R169A-R3-03: parseGenerationManifest no longer does
 *     statSync(path) → openSync(path, "r") (TOCTOU). It opens with
 *     O_RDONLY | O_NOFOLLOW (when available) and fstat's the SAME fd.
 *     Fallback (no O_NOFOLLOW): lstatSync → openSync → fstatSync →
 *     compare dev+ino.
 *   - OPS-R169A-R3-01: listProjectStoreKeys validates the trust root
 *     (cacheRoot → cbm → projects) before readdirSync. New helper
 *     `assertGenerationStoreRootTrusted(cacheRoot, phase)` validates
 *     the chain WITHOUT a specific project key (used by listProjectStoreKeys).
 *   - SEC-R169A-R3-04: ensureGenerationStoreLayoutDurable checks
 *     existing dirs' permissions — mode & 0o077 must be 0. Failure →
 *     STORE_LAYOUT_PERMISSIONS_INSECURE. POSIX uid check is best-effort.
 *   - VALID-R169A-R3-01: MANIFEST_V1_KEYS is now Object.freeze'd at
 *     module load (in generation-types.ts). The dead placeholder code
 *     in validateGenerationManifest (the `missingKeys = actualKeys.filter(...)`
 *     line that always returned `[]`) is removed.
 *   - QUAL-R169A-R3-01: writeProjectJsonAtomicallyInternal validates
 *     the `target` parameter at runtime (must be "manifest" or
 *     "index-state"; else GENERATION_STORE_CONFIG_ERROR). Symlink codes
 *     are now per-target: MANIFEST_SYMLINK_REJECTED for active-generation.json,
 *     PROJECT_STATE_SYMLINK_REJECTED for index-state.json,
 *     GENERATION_TARGET_SYMLINK_REJECTED for the generation DB file.
 *
 * R169A-FIX-R4 (GPT 5.6 pass 4 audit) changes:
 *   - DATA-R169A-R4-01 (canonical payload): Two new preparation helpers
 *     `prepareGenerationManifestForWrite(input, project)` and
 *     `prepareIndexStateForWrite(input, project)` build a plain (null-
 *     prototype) object from the 13 manifest fields (resp. 11 index-state
 *     fields), validate it, serialize to JSON, PARSE the serialized
 *     bytes back, revalidate the parsed value, and return
 *     `{ value, payload: Buffer }`. The filesystem writer receives ONLY
 *     the Buffer; it does NOT call JSON.stringify. This closes the gap
 *     where a `toJSON` getter, a Proxy, or prototype pollution could
 *     make the written bytes differ from the validated object.
 *     `AtomicFileOps.serializeJson` is REMOVED; `writeJsonAtomically`
 *     now takes a `payload: Buffer` instead of `value: unknown`.
 *   - DATA-R169A-R4-02 (manifest writer is NOT a publication API):
 *     `writeGenerationManifestAtomically` is now INTERNAL (non-exported)
 *     — it is a low-level file writer, not a publication authorization.
 *     Only `writeIndexStateAtomically` is exported (index-state is
 *     diagnostics, not publication). R169B will own the first public
 *     publication API: `publishPreparedGeneration(PreparedGeneration)`
 *     which requires DB validation, hash, size, CAS before manifest write.
 *   - SEC-R169A-R4-01 (residual TOCTOU on rename): The writer now opens
 *     the target directory with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`,
 *     records `dev + ino` from `fstatSync(dirFd)`, and BEFORE rename
 *     `lstat`s the target path and checks the parent dir's `dev + ino`
 *     matches the held `dirFd`. After rename the SAME `dirFd` is
 *     fsynced (no path-based reopen). A new test hook
 *     `afterTempFsyncBeforeRename` lets tests inject a race. Residual
 *     path-based rename TOCTOU (SEC-CARRY-01) is documented: Node.js
 *     does not provide portable `renameat(dirfd, ...)`, so the rename
 *     itself remains path-based. The window is minimized by holding
 *     the directory fd.
 *   - SEC-R169A-R4-02 (parent fsync follows symlinks): New
 *     `openDirectoryNoFollow(path, ops)` helper opens a directory with
 *     `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (or falls back to
 *     `lstatSync -> openSync -> fstatSync -> compare dev+ino`). Used
 *     for ALL directory opens: parent fsync in layout, child fsync in
 *     layout, writer final fsync, listing.
 *   - COMPAT-R169A-R4-01 (two-tier permission policy): Compatibility
 *     roots (cacheRoot, codebase-memory-mcp) require `mode & 0o022 === 0`
 *     (no group/other WRITE) — 0755, 0750, 0700 all accepted. Private
 *     R169 dirs (projects, projectStore, generations, tmp) require
 *     `mode === 0o700` exactly. On POSIX the directory's uid is best-
 *     effort checked against `process.getuid()`.
 *   - TEST-R169A-R4-01 (statSync vs lstatSync): `AtomicFileOps.statSync`
 *     renamed to `AtomicFileOps.lstatSync`. PROD_OPS now delegates to
 *     `node:fs.lstatSync` (was `statSync`, which follows symlinks and
 *     made `isSymbolicLink()` always false on the target).
 *   - STATE-R169A-R4-01 (IndexAttemptState schema): `validateIndexAttemptState`
 *     updated to validate the new schema (candidateGenerationId, published,
 *     failure). Coherence rules tightened per spec. `MAX_STALE_PATHS`
 *     reduced from 1000 to 100 to match the indexer's actual cap.
 *   - READ-R169A-R4-01 (manifest read growth + UTF-8): `parseGenerationManifest`
 *     re-`fstat`s the fd after reading and compares size/dev/ino; reads
 *     one extra byte (must return 0 = EOF); decodes with
 *     `new TextDecoder("utf-8", { fatal: true })` so invalid UTF-8 ->
 *     MANIFEST_PARSE_ERROR.
 *
 * R169A-FIX-R5 (GPT 5.6 pass 5 audit) changes:
 *   - API-R169A-R5-01 (remove __test__ export): The `__test__` export
 *     is REMOVED. The manifest writer
 *     `writeGenerationManifestAtomically` and the prepare*ForWrite
 *     helpers are no longer accessible to production code (they were
 *     already non-exported functions; only the __test__ namespace
 *     exposed them). Tests that need a manifest on disk use the test
 *     helper `v2/tests/helpers/r169-generation-fixtures.ts` which
 *     writes via `writeFileSync`. Atomic writer mechanic tests use
 *     `writeIndexStateAtomically` (the only public writer) which
 *     exercises the same internal writer code path. A source
 *     inspection test verifies `__test__` and
 *     `writeGenerationManifestAtomically` are NOT exported.
 *   - STATE-R169A-R5-01 (publicationState enum): `validateIndexAttemptState`
 *     updated to validate `publicationState: IndexPublicationState`
 *     (4-value enum) instead of `published: boolean`. Coherence rules
 *     tightened per the four-value enum:
 *       * SUCCESS / SUCCESS_WITH_WARNINGS + PUBLISHED: activeGenerationId
 *         non-null, candidateGenerationId == activeGenerationId.
 *       * SUCCESS / SUCCESS_WITH_WARNINGS + NOT_NEEDED:
 *         candidateGenerationId == null.
 *       * PARTIAL: NOT_PUBLISHED only; failure non-null.
 *       * FAILED: NOT_PUBLISHED or DURABILITY_UNKNOWN; failure non-null.
 *       * STALE: NOT_PUBLISHED only; staleReason non-null; recovery != "none".
 *       * PUBLISHED forbidden for PARTIAL / FAILED / STALE.
 *   - STATE-R169A-R5-02 (coherence fixes): SUCCESS_WITH_WARNINGS now
 *     follows the same rules as SUCCESS for active/candidate. The
 *     `pathsTruncated` <-> `totalPaths` invariant is tightened:
 *       * pathsTruncated=true  -> totalPaths MUST be present AND
 *         totalPaths > paths.length.
 *       * pathsTruncated=false -> totalPaths absent OR totalPaths == paths.length.
 *       * pathsTruncated absent -> totalPaths absent OR totalPaths == paths.length.
 *   - SEC-R169A-R5-01 (cleanup after directory swap): When the
 *     pre-rename dev/ino check fails, the catch block NO LONGER unlinks
 *     the temp file by path. The temp file may be in the ORIGINAL
 *     directory (which was swapped out); unlinking by path would
 *     operate on the NEW directory. A `directoryIdentityStillValid`
 *     flag gates the cleanup. The error message includes a
 *     `[WARNING: ATOMIC_TEMP_ORPHANED ...]` note so the operator knows
 *     a temp file may be orphaned. New error code `ATOMIC_TEMP_ORPHANED`
 *     added to the taxonomy (as a warning, not a separate thrown error).
 *   - SEC-R169A-R5-02 (permission policy in resolver/listing): The
 *     two-tier permission policy (compat roots: mode & 0o022 === 0;
 *     private R169 dirs: mode === 0o700) is now enforced in
 *     `assertTrustedRootNoSymlinks` and `assertGenerationStoreRootTrusted`
 *     for each EXISTING directory component. Previously the policy was
 *     only in `ensureGenerationStoreLayoutDurable`; the resolver and
 *     listing did not check permissions. Now the resolver, listing, AND
 *     writer all use the same trust root validation. POSIX uid check
 *     (stat.uid === process.getuid()) is best-effort (try/catch on
 *     Windows where getuid is unavailable).
 *   - QUAL-R169A-R5-01 (fd leak in openDirectoryNoFollow): If
 *     `fstatSync(fd)` fails after a successful `openSync` in the
 *     O_NOFOLLOW|O_DIRECTORY path, the fd is now closed before
 *     re-throwing. Previously the fd leaked. (The fallback path
 *     already had this fix.)
 *   - API-R169A-R5-02 (ops/hook marked @internal): The `ops` and
 *     `hook` parameters on `writeIndexStateAtomically` are marked
 *     `@internal` in the JSDoc. They remain as optional parameters
 *     (TypeScript types them) so tests can inject faults, but they
 *     are NOT part of the public API contract. Production callers
 *     MUST omit them.
 *   - PORT-R169A-R5-01 (macOS support): Documentation updated to
 *     reflect that Linux is certified for atomic generation
 *     publication; macOS is planned (verified in R169E with CI
 *     matrix); Windows remains legacy/inactive. No macOS CI job added
 *     in R5 (R169E scope).
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  readdirSync,
  realpathSync,
  constants as fsConstants,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { homedir } from "node:os";

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
  ResolvedCodeDb,
  GenerationStoreError,
  GenerationStoreErrorCode,
  isManifestV1Key,
  isIndexStateV1Key,
} from "./generation-types.js";

// R169A-FIX-R8 (GPT 5.6 final audit pass): Internal I/O harness.
// The following symbols are imported from the internal module and are
// NOT re-exported. They are used only by the public facade functions
// (`writeIndexStateAtomically`, `ensureGenerationStoreLayoutDurable`)
// and by the trust-root validators (`assertTrustedRootNoSymlinks`,
// `assertGenerationStoreRootTrusted`). Tests that need direct access
// to `AtomicFileOps`, `WriterTestHook`, `PROD_OPS`, or the `*Internal`
// functions import them from `./internal/generation-store-io.js`.
import {
  PROD_OPS,
  assertLayoutDirPermissions,
  ensureGenerationStoreLayoutDurableInternal,
  writeIndexStateAtomicallyInternal,
} from "./internal/generation-store-io.js";

// Re-export types for convenience
export type {
  GenerationManifestV1,
  IndexAttemptStateV1,
  IndexAttemptStaleReasonV1,
  IndexAttemptFailureV1,
  IndexAttemptOutcome,
  IndexRecoveryAction,
  IndexPublicationState,
  ResolvedCodeDb,
} from "./generation-types.js";
export {
  GenerationStoreError,
  MANIFEST_V1_KEYS,
  INDEX_STATE_V1_KEYS,
  isManifestV1Key,
  isIndexStateV1Key,
} from "./generation-types.js";

// ─── Constants ──────────────────────────────────────────────────────────

/** The subdirectory under the cache root for all CBM data. */
export const CBM_CACHE_SUBDIR = "codebase-memory-mcp";

/** The subdirectory under CBM_CACHE_SUBDIR for per-project generation stores. */
export const PROJECTS_SUBDIR = "projects";

/** The manifest filename in each project store directory. */
export const MANIFEST_FILENAME = "active-generation.json";

/** The index-state sidecar filename. */
export const INDEX_STATE_FILENAME = "index-state.json";

/** The generations subdirectory name. */
export const GENERATIONS_SUBDIR = "generations";

/** The tmp subdirectory name for staging DBs. */
export const TMP_SUBDIR = "tmp";

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
 * The R3 `MAX_INDEX_STATE_ERROR_LENGTH` constant (for the removed
 * `lastAttemptError` field) is deleted; `failure.message` reuses
 * `MAX_INDEX_STATE_MESSAGE_LENGTH`.
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
 * O_NOFOLLOW. Present on Linux and macOS but NOT on Windows. We
 * gracefully degrade when it is absent. Used by `parseGenerationManifest`
 * to open the manifest with O_NOFOLLOW (rejects symlinks at the kernel
 * level). The O_DIRECTORY flag and the `openDirectoryNoFollow` helper
 * live in the internal module (`./internal/generation-store-io.js`).
 */
const O_NOFOLLOW: number = typeof (fsConstants as Record<string, unknown>).O_NOFOLLOW === "number"
  ? (fsConstants as { O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

// ─── Options ────────────────────────────────────────────────────────────

/**
 * R169A-FIX (SEC-R169A-01): Unified cacheRoot injection.
 * All path-resolving functions accept an optional cacheRoot. When omitted,
 * the real cache root (XDG_CACHE_HOME or ~/.cache) is used. When provided,
 * all derived paths (cbm cache dir, generation store root, project store,
 * generations, tmp, manifest, index-state, legacy DB) MUST stay inside the
 * injected cacheRoot.
 */
export interface GenerationStoreOptions {
  readonly cacheRoot?: string;
}

// ─── Path helpers (section 18A) ─────────────────────────────────────────

/**
 * Resolve the cache root directory.
 * Uses XDG_CACHE_HOME if set, otherwise ~/.cache.
 * This is the single source of truth — no other code should duplicate
 * the XDG_CACHE_HOME fallback.
 */
export function getCacheRoot(): string {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/**
 * The CBM cache directory: <cacheRoot>/codebase-memory-mcp/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function cbmCacheDir(cacheRoot?: string): string {
  return join(cacheRoot ?? getCacheRoot(), CBM_CACHE_SUBDIR);
}

/**
 * The generation store root: <cacheRoot>/codebase-memory-mcp/projects/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function generationStoreRoot(cacheRoot?: string): string {
  return join(cbmCacheDir(cacheRoot), PROJECTS_SUBDIR);
}

/**
 * Compute a deterministic, path-safe project storage key.
 * Uses SHA-256 of the UTF-8 project name.
 * This prevents path traversal, separator injection, and collisions.
 */
export function projectStorageKey(project: string): string {
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PROJECT_KEY_INVALID",
      "projectStorageKey",
      String(project),
      "Project name must be a non-empty string",
    );
  }
  return createHash("sha256").update(project, "utf8").digest("hex");
}

/**
 * The per-project store directory.
 * Path: <cacheRoot>/codebase-memory-mcp/projects/<sha256(project)>/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot (NOT storeRoot).
 */
export function projectStoreDir(project: string, cacheRoot?: string): string {
  const key = projectStorageKey(project);
  return join(generationStoreRoot(cacheRoot), key);
}

/**
 * The generations directory for a project.
 * Path: <projectStore>/generations/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function generationsDir(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), GENERATIONS_SUBDIR);
}

/**
 * The tmp directory for a project (staging DBs).
 * Path: <projectStore>/tmp/
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function tmpDir(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), TMP_SUBDIR);
}

/**
 * The active manifest path for a project.
 * Path: <projectStore>/active-generation.json
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function activeManifestPath(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), MANIFEST_FILENAME);
}

/**
 * The index-state sidecar path for a project.
 * Path: <projectStore>/index-state.json
 *
 * R169A-FIX (SEC-R169A-01): accepts an optional injected cacheRoot.
 */
export function indexStatePath(project: string, cacheRoot?: string): string {
  return join(projectStoreDir(project, cacheRoot), INDEX_STATE_FILENAME);
}

/**
 * The legacy code DB path (existing behavior, kept for compatibility).
 * Path: <cacheRoot>/codebase-memory-mcp/<project>.db
 *
 * R169A-FIX (SEC-R169A-01): containment-checks the resolved path against
 * the cache root. Rejects:
 *   - empty project
 *   - absolute project (e.g. "/etc/passwd")
 *   - "../escape" project (path traversal)
 *   - any project whose resolved path escapes cbmCacheDir
 *
 * R169A-FIX (API-R169A-02): accepts an optional injected cacheRoot so
 * the resolver uses the same cacheRoot for BOTH generation and legacy
 * paths. The injected cacheRoot is also used by the resolver's legacy
 * containment check.
 *
 * For ordinary project names ("test-project", "プロジェクト") with the
 * real cacheRoot, this produces the same path as the sqlite-ro legacy DB path in
 * sqlite-ro.ts — back-compat is preserved.
 */
export function legacyCodeDbPath(project: string, cacheRoot?: string): string {
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      String(project),
      "Project name must be a non-empty string",
    );
  }
  if (isAbsolute(project)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not be absolute: ${project}`,
    );
  }
  // Reject any path separator (forward or backward slash). A valid project
  // name is a single path component.
  if (project.includes("/") || project.includes("\\")) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not contain path separators: ${project}`,
    );
  }
  if (project === "." || project === "..") {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Project name must not be "." or ".."`,
    );
  }

  const base = cbmCacheDir(cacheRoot);
  const candidate = resolve(base, `${project}.db`);

  // Defense-in-depth: lexical containment on the resolved candidate.
  // For valid project names this always passes; for a maliciously
  // crafted name that survives the checks above (none currently known),
  // this would still reject.
  if (!isLexicallyInside(base, candidate)) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      "legacyCodeDbPath",
      project,
      `Resolved legacy path escapes cache root: ${candidate}`,
    );
  }
  return candidate;
}

// ─── Path safety (R169A-FIX SEC-R169A-02) ───────────────────────────────

/**
 * R169A-FIX (SEC-R169A-02): Lexical containment check.
 *
 * Returns true iff `candidate` is lexically inside `root` (i.e. the
 * relative path from root to candidate does not start with ".." and is
 * not absolute). This is the same logic as the original isPathInside.
 *
 * This function does NOT touch the filesystem and does NOT detect
 * symlinks. Use assertPathInsideNoSymlinks for security-sensitive paths.
 */
export function isLexicallyInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}

/**
 * Back-compat alias: isPathInside = isLexicallyInside.
 * Tests and external callers may continue to use the old name.
 */
export const isPathInside = isLexicallyInside;

/**
 * R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check.
 *
 * Walks every path component from `root` to `candidate` with lstatSync.
 * Rejects if ANY component in the chain is a symbolic link. After the
 * walk, uses realpathSync.native on both endpoints for a final
 * containment check.
 *
 * Error policy (fail-closed):
 *   - ENOENT  → treat as "absent"; return without throwing. The caller
 *               is responsible for distinguishing "missing target" from
 *               "present target" via lstatSync of the final component.
 *   - EACCES  → fail closed with PATH_TRAVERSAL_REJECTED
 *   - EIO     → fail closed with PATH_TRAVERSAL_REJECTED
 *   - ENOTDIR → fail closed with PATH_TRAVERSAL_REJECTED
 *   - ELOOP   → fail closed with PATH_TRAVERSAL_REJECTED
 *   - any other error → fail closed with PATH_TRAVERSAL_REJECTED
 *
 * The `symlinkCode` argument controls which error code is thrown when a
 * symlink is detected — typically MANIFEST_SYMLINK_REJECTED for the
 * manifest path, GENERATION_TARGET_SYMLINK_REJECTED for the target DB,
 * or PROJECT_STATE_SYMLINK_REJECTED for the index-state sidecar
 * (R169A-FIX-R3 QUAL-R169A-R3-01). Traversal errors always use
 * PATH_TRAVERSAL_REJECTED.
 *
 * R169A-FIX-R2 (SEC-R169A-R2-01): This function still does NOT lstat
 * `root` itself — that is the responsibility of `assertTrustedRootNoSymlinks`.
 * Callers protecting a manifest / generation DB MUST call
 * `assertTrustedRootNoSymlinks` first to validate the trust root,
 * then `assertPathInsideNoSymlinks` for the target.
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

  // If rel is "" the candidate IS the root, which is trivially inside.
  // If rel starts with ".." or is absolute, the candidate is outside
  // the root lexically — reject before touching the filesystem.
  if (rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
    throw new GenerationStoreError(
      "PATH_TRAVERSAL_REJECTED",
      phase,
      project,
      `Path escapes root lexically: root=${resolvedRoot}, candidate=${resolvedCandidate}`,
    );
  }

  // Walk each component from root to candidate. The candidate itself is
  // included as the final component (rel.split gives all non-empty parts).
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
          // This component (and everything below it) does not exist.
          // The caller will separately check existence; we just exit
          // the walk without error.
          return;
        }
        // EACCES, EIO, ENOTDIR, ELOOP, etc. — fail closed.
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

  // Final realpath containment check. If the candidate does not exist
  // on disk, realpathSync will throw ENOENT — treat as "absent" and
  // return without error. Any other error → fail closed.
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
 *
 * Error policy (fail-closed):
 *   - ENOENT  → return silently (path does not exist)
 *   - EACCES, EIO, ENOTDIR, ELOOP, etc. → throw (fail closed)
 *   - isSymbolicLink → throw with the supplied `code`
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
    // R169A-FIX (SEC-R169A-02): do NOT swallow EACCES/EIO/ENOTDIR/ELOOP.
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

// ─── Trust root validation (R169A-FIX-R2 SEC-R169A-R2-01) ───────────────

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
 * symlink in this chain is rejected. Only ENOENT is tolerated (the
 * component does not exist yet — common during the first write for a
 * project); EACCES / EIO / ENOTDIR / ELOOP fail closed.
 *
 * After the chain walk, the function calls `assertPathInsideNoSymlinks`
 * from `generationStoreRoot` down to `projectStoreDir` — this gives us
 * the final `realpath` containment check on the validated root.
 *
 * Callers protecting a manifest / generation DB path MUST call this
 * first, then `assertPathInsideNoSymlinks(generationStoreRoot, target, ...)`
 * for the specific target.
 */
export function assertTrustedRootNoSymlinks(
  cacheRoot: string,
  project: string,
  phase: string,
): void {
  // The trust root chain — every component MUST exist as a real directory
  // (or be absent). A symlink at ANY level is rejected.
  // R169A-FIX-R5 (SEC-R169A-R5-02): Each EXISTING directory component is
  // also permission-checked via assertLayoutDirPermissions (two-tier
  // policy: compat roots cacheRoot/cbm require mode & 0o022 === 0;
  // private R169 dirs projects/project-key require mode === 0o700).
  // This closes the gap where the resolver and listing did not check
  // permissions — now the resolver, listing, AND writer all use the
  // same trust root validation.
  const key = projectStorageKey(project); // validates project is non-empty
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
        // Component doesn't exist yet — that's OK. The next component
        // walk will also ENOENT (since the parent doesn't exist). The
        // caller is responsible for distinguishing "missing target"
        // from "present target".
        continue;
      }
      // EACCES, EIO, ENOTDIR, ELOOP, etc. — fail closed.
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
    // R169A-FIX-R5 (SEC-R169A-R5-02): Permission check for existing
    // directories. Non-directory entries (regular files, etc.) are
    // skipped here — the caller will fail later when it tries to use
    // the path as a directory (e.g. readdirSync throws ENOTDIR).
    if (stat.isDirectory()) {
      assertLayoutDirPermissions(stat, path, isCompatRoot, project, phase);
    }
  }

  // Final defense-in-depth: assertPathInsideNoSymlinks from
  // generationStoreRoot to projectStoreDir. This applies the realpath
  // containment check on the validated root.
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
 * specific project key. Used by `listProjectStoreKeys`, which enumerates
 * ALL project keys under `<cacheRoot>/codebase-memory-mcp/projects/`.
 *
 * Walks the chain `<cacheRoot>`, `<cacheRoot>/codebase-memory-mcp`,
 * `<cacheRoot>/codebase-memory-mcp/projects`. Any symlink in this chain
 * is rejected. Only ENOENT is tolerated (the projects dir doesn't exist
 * yet — `listProjectStoreKeys` returns `[]` in that case).
 */
export function assertGenerationStoreRootTrusted(
  cacheRoot: string,
  phase: string,
): void {
  // R169A-FIX-R5 (SEC-R169A-R5-02): Same two-tier permission policy as
  // assertTrustedRootNoSymlinks. Compatibility roots (cacheRoot, cbm)
  // require mode & 0o022 === 0; private R169 dirs (projects) require
  // mode === 0o700. This closes the gap where listProjectStoreKeys did
  // not check permissions.
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
    // R169A-FIX-R5 (SEC-R169A-R5-02): Permission check for existing directories.
    if (stat.isDirectory()) {
      assertLayoutDirPermissions(stat, path, isCompatRoot, "", phase);
    }
  }
}

// ─── Manifest parser and validator (section 18C) ────────────────────────

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
  // by rolling them over (e.g. 2026-13-01 → 2027-01-01). Verify each
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
  // new Date(Date.UTC(year, month, 0)).getUTCDate() gives the last day
  // of `month` (1-indexed) for `year`. This correctly handles Feb 29
  // in leap years (2028) and rejects it in non-leap years (2026).
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
  // (non-whitespace, max 1024 chars, no C0 control chars). Previously
  // this only checked `length > 0`, which accepted "   ".
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

// ─── Index state validator (R169A-FIX-R3 API-R169A-R3-02) ───────────────

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
 *   - failure: null OR a structured object with:
 *       * code: non-empty safe string (max 256 chars)
 *       * phase: non-empty safe string (max 256 chars)
 *       * message: non-empty safe string (max 8 KiB)
 *   - staleReason: null OR a structured object with:
 *       * code: non-empty safe string (max 256 chars)
 *       * message: non-empty safe string (max 8 KiB)
 *       * paths: array of safe strings (each max 32 KiB, up to 100 entries)
 *       * totalPaths: optional safe non-negative int >= paths.length
 *       * pathsTruncated: optional boolean; if true then totalPaths MUST
 *         be present AND totalPaths > paths.length (R169A-FIX-R5 tightening)
 *   - Coherence rules (R169A-FIX-R5 STATE-R169A-R5-01/02):
 *       * SUCCESS / SUCCESS_WITH_WARNINGS + PUBLISHED: activeGenerationId
 *         non-null, candidateGenerationId == activeGenerationId,
 *         failure=null, staleReason=null, recovery="none".
 *       * SUCCESS / SUCCESS_WITH_WARNINGS + NOT_NEEDED:
 *         candidateGenerationId=null, failure=null, staleReason=null,
 *         recovery="none".
 *       * SUCCESS / SUCCESS_WITH_WARNINGS + NOT_PUBLISHED or
 *         DURABILITY_UNKNOWN: REJECTED.
 *       * PARTIAL: publicationState="NOT_PUBLISHED", failure non-null.
 *         PUBLISHED / NOT_NEEDED / DURABILITY_UNKNOWN REJECTED.
 *       * FAILED: publicationState="NOT_PUBLISHED" or "DURABILITY_UNKNOWN",
 *         failure non-null. PUBLISHED / NOT_NEEDED REJECTED.
 *       * STALE: publicationState="NOT_PUBLISHED", staleReason non-null,
 *         recovery != "none". PUBLISHED / NOT_NEEDED / DURABILITY_UNKNOWN
 *         REJECTED.
 *       * pathsTruncated coherence (R169A-FIX-R5 STATE-R169A-R5-02):
 *         - pathsTruncated=true  -> totalPaths MUST be present AND
 *           totalPaths > paths.length.
 *         - pathsTruncated=false -> totalPaths absent OR totalPaths == paths.length.
 *         - pathsTruncated absent -> totalPaths absent OR totalPaths == paths.length.
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
  // This is the generation being STAGED; distinct from activeGenerationId
  // (the LIVE generation). On SUCCESS candidate == active; on FAILED / STALE
  // / PARTIAL the candidate may differ (and is GC'd).
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
  // object { code, phase, message }. Replaces the previous free-form
  // `lastAttemptError: string | null`.
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
    // Exact key set for the failure object: code, phase, message.
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
    // code: non-empty safe string (max 256)
    assertSafeStringField(fl.code, "failure.code", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    // phase: non-empty safe string (max 256)
    assertSafeStringField(fl.phase, "failure.phase", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    // message: non-empty safe string (max 8 KiB)
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
    // Exact key set for the stale reason object: code, message, paths,
    // totalPaths?, pathsTruncated?. No extra keys allowed.
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
    // code: non-empty safe string (max 256)
    assertSafeStringField(sr.code, "staleReason.code", MAX_INDEX_STATE_CODE_LENGTH, expectedProject, phase, SCHEMA);
    // message: non-empty safe string (max 8 KiB)
    assertSafeStringField(sr.message, "staleReason.message", MAX_INDEX_STATE_MESSAGE_LENGTH, expectedProject, phase, SCHEMA);
    // paths: array of strings
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
    // totalPaths: optional safe non-negative int. R169A-FIX-R4: must be
    // >= paths.length when present.
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
    // pathsTruncated: optional boolean. R169A-FIX-R5 (STATE-R169A-R5-02):
    //   - pathsTruncated=true  -> totalPaths MUST be present AND
    //     totalPaths > paths.length.
    //   - pathsTruncated=false -> totalPaths absent OR totalPaths == paths.length.
    //   - pathsTruncated absent -> totalPaths absent OR totalPaths == paths.length.
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
  //
  // SUCCESS / SUCCESS_WITH_WARNINGS + PUBLISHED: activeGenerationId
  //   non-null, candidateGenerationId == activeGenerationId, failure=null,
  //   staleReason=null, recovery="none".
  // SUCCESS / SUCCESS_WITH_WARNINGS + NOT_NEEDED: candidateGenerationId=null,
  //   failure=null, staleReason=null, recovery="none".
  // SUCCESS / SUCCESS_WITH_WARNINGS + NOT_PUBLISHED or DURABILITY_UNKNOWN:
  //   REJECTED.
  // PARTIAL: publicationState="NOT_PUBLISHED", failure non-null.
  // FAILED: publicationState="NOT_PUBLISHED" or "DURABILITY_UNKNOWN",
  //   failure non-null.
  // STALE: publicationState="NOT_PUBLISHED", staleReason non-null,
  //   recovery != "none".
  // PUBLISHED forbidden for PARTIAL / FAILED / STALE.
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
      // publicationState is NOT_PUBLISHED or DURABILITY_UNKNOWN - forbidden for SUCCESS / SUCCESS_WITH_WARNINGS.
      throw new GenerationStoreError(
        SCHEMA,
        phase,
        expectedProject,
        `Coherence violation: outcome=${outcome} but publicationState="${publicationState}" (must be PUBLISHED or NOT_NEEDED)`,
      );
    }
  } else if (outcome === "PARTIAL") {
    // PARTIAL: publicationState="NOT_PUBLISHED", failure non-null.
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
    // FAILED: publicationState="NOT_PUBLISHED" or "DURABILITY_UNKNOWN", failure non-null.
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
    // STALE: publicationState="NOT_PUBLISHED", staleReason non-null, recovery != "none".
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
 * `MANIFEST_TOO_LARGE` — do NOT read the file into memory. Reading is
 * done via an fd (openSync + readSync + closeSync) so we control the
 * exact number of bytes consumed.
 *
 * R169A-FIX-R3 (SEC-R169A-R3-03): The previous `statSync(path)` then
 * `openSync(path, "r")` had a TOCTOU window — a symlink could be swapped
 * between the two calls. The parser now opens with `O_RDONLY | O_NOFOLLOW`
 * (when available) and fstat's the SAME fd. If `O_NOFOLLOW` is not
 * available (Windows), the parser falls back to `lstatSync → openSync →
 * fstatSync` and compares `dev` + `ino` between the lstat and fstat to
 * detect a swap.
 */
export function parseGenerationManifest(
  manifestPath: string,
  expectedProject: string,
): GenerationManifestV1 {
  const phase = "parseGenerationManifest";

  // R169A-FIX-R3 (SEC-R169A-R3-03): Open with O_NOFOLLOW when available
  // so a symlink at `manifestPath` is rejected by the kernel. Then fstat
  // the SAME fd to close the TOCTOU window.
  let fd: number | null = null;
  let sizeStat: { size: number; isFile(): boolean; isSymbolicLink(): boolean; dev: number; ino: number };

  if (O_NOFOLLOW) {
    // Preferred path: open with O_RDONLY | O_NOFOLLOW. If the path is a
    // symlink, the kernel rejects with ELOOP. We fstat the same fd to
    // get the size and verify it's a regular file.
    const flags = fsConstants.O_RDONLY | O_NOFOLLOW;
    try {
      fd = openSync(manifestPath, flags);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        throw new GenerationStoreError(
          "MANIFEST_PARSE_ERROR",
          phase,
          expectedProject,
          `Manifest file not found: ${manifestPath}`,
        );
      }
      if (errCode === "ELOOP") {
        // ELOOP from O_NOFOLLOW means the path is a symlink.
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
    // Fallback (no O_NOFOLLOW): lstatSync → openSync → fstatSync →
    // compare dev+ino between lstat and fstat. If different, a symlink
    // swap happened between lstat and open.
    let lstat;
    try {
      lstat = lstatSync(manifestPath);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        throw new GenerationStoreError(
          "MANIFEST_PARSE_ERROR",
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
        throw new GenerationStoreError(
          "MANIFEST_PARSE_ERROR",
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
    // Compare dev+ino between lstat and fstat. If different, a symlink
    // swap happened between lstat and open — reject.
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

  // Verify it's a regular file (rejects directories, FIFOs, sockets, etc).
  if (!sizeStat.isFile()) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "MANIFEST_TARGET_NOT_REGULAR",
      phase,
      expectedProject,
      `Manifest path is not a regular file: ${manifestPath}`,
    );
  }

  // Size bound check.
  if (sizeStat.size > MAX_GENERATION_MANIFEST_BYTES) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw new GenerationStoreError(
      "MANIFEST_TOO_LARGE",
      phase,
      expectedProject,
      `Manifest size ${sizeStat.size} exceeds maximum ${MAX_GENERATION_MANIFEST_BYTES} bytes: ${manifestPath}`,
    );
  }

  // Read via fd so we control the byte count. We allocate a buffer of
  // exactly `size` bytes (capped by the size check above) and read into
  // it. A short read is an error (file shrank between stat and read).
  //
  // R169A-FIX-R4 (READ-R169A-R4-01): After reading the full payload:
  //   1. Re-fstat the fd and compare size/dev/ino with the initial
  //      fstat. If they differ, the file was swapped between the
  //      initial fstat and now — reject with MANIFEST_PARSE_ERROR.
  //   2. Read ONE extra byte. It must return 0 (EOF). If it returns
  //      >0, the file GREW between the initial fstat and now (the
  //      payload we read may be a prefix of a larger, malicious
  //      manifest) — reject with MANIFEST_TOO_LARGE (the file is
  //      larger than we expected).
  //   3. Decode with `new TextDecoder("utf-8", { fatal: true })` so
  //      invalid UTF-8 -> MANIFEST_PARSE_ERROR. The previous
  //      `buf.toString("utf8")` silently replaced invalid byte
  //      sequences with U+FFFD, which could mask corruption.
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

    // R169A-FIX-R4 (READ-R169A-R4-01): Re-fstat the fd and compare
    // size/dev/ino with the initial fstat. A swap between the initial
    // fstat and now would leave us with bytes from the OLD file
    // (or a partial read of the NEW file).
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

    // R169A-FIX-R4 (READ-R169A-R4-01): Read ONE extra byte. It must
    // return 0 (EOF). If >0, the file grew between the initial fstat
    // and now — the bytes we read may be a prefix of a larger file.
    // Reject with MANIFEST_TOO_LARGE (the file is larger than expected).
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

    // R169A-FIX-R4 (READ-R169A-R4-01): Decode with fatal UTF-8. The
    // previous `buf.toString("utf8")` silently replaced invalid byte
    // sequences with U+FFFD, which could mask corruption. The fatal
    // decoder rejects invalid UTF-8 with a TypeError.
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

// ─── Resolver (section 18D) ─────────────────────────────────────────────

/**
 * Resolve the active code DB for a project.
 *
 * Contract:
 *   - manifest valid → generation
 *   - manifest absent + legacy exists → legacy
 *   - manifest absent + no legacy → missing
 *   - manifest invalid → FAIL CLOSED (never fall back to legacy)
 *   - manifest target missing → FAIL CLOSED
 *   - manifest target outside store → FAIL CLOSED
 *   - manifest target not a regular file → FAIL CLOSED
 *     (R169A-FIX DATA-R169A-01)
 *   - manifest project mismatch → FAIL CLOSED
 *   - symlink manifest or any parent → rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - symlink generation target or any parent → rejected
 *     (R169A-FIX SEC-R169A-02: full chain walk)
 *   - legacy path fails validation → LEGACY_SOURCE_INVALID
 *     (R169A-FIX-R2 API-R169A-R2-01: renamed from LEGACY_SOURCE_OPEN_FAILED;
 *      R169A validates path + regular-file identity only — actual SQLite
 *      open validation occurs in R169D reader cutover.)
 *
 * R169A-FIX (SEC-R169A-01): The `cacheRoot` option, when provided, is
 * used for BOTH the generation store paths AND the legacy DB path.
 * Tests pass an injected cacheRoot to avoid touching the real HOME.
 *
 * R169A-FIX-R2 (SEC-R169A-R2-01): The resolver validates the trust root
 * (cacheRoot → cbm → projects → project-key) BEFORE checking manifest
 * or legacy. This closes the bypass where a parent of the trust root
 * is a symlink.
 */
export function resolveActiveCodeDb(
  project: string,
  options?: GenerationStoreOptions,
): ResolvedCodeDb {
  const phase = "resolveActiveCodeDb";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();

  // R169A-FIX-R2 (SEC-R169A-R2-01): Validate the trust root BEFORE any
  // manifest / legacy check. This lstat's cacheRoot itself and walks
  // cbmCacheDir, projects, project-key. A symlink at any level is
  // rejected. ENOENT is OK (project store doesn't exist yet).
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const manifestPath = activeManifestPath(project, cacheRoot);
  const legacyPath = legacyCodeDbPath(project, cacheRoot);

  // R169A-FIX (SEC-R169A-02): Strict symlink-rejecting containment check
  // on the manifest path. Walk from generationStoreRoot (a higher trust
  // root) all the way to the manifest file. This catches symlinks at
  // every level: the project store dir, the CBM cache dir, etc.
  // Walking from projectDir would miss a symlink AT projectDir itself.
  const storeRoot = generationStoreRoot(cacheRoot);
  const projectDir = projectStoreDir(project, cacheRoot);
  assertPathInsideNoSymlinks(
    storeRoot,
    manifestPath,
    project,
    phase,
    "MANIFEST_SYMLINK_REJECTED",
  );

  // Check if manifest exists (using lstat to detect symlinks).
  let manifestExists = false;
  try {
    const stat = lstatSync(manifestPath);
    manifestExists = true;
    if (stat.isSymbolicLink()) {
      throw new GenerationStoreError(
        "MANIFEST_SYMLINK_REJECTED",
        phase,
        project,
        `Manifest path is a symlink: ${manifestPath}`,
      );
    }
  } catch (e) {
    if (e instanceof GenerationStoreError) throw e;
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Manifest doesn't exist — fall through to legacy check.
    } else {
      // EACCES, EIO, ENOTDIR, etc. → fail closed.
      throw new GenerationStoreError(
        "MANIFEST_PARSE_ERROR",
        phase,
        project,
        `Cannot stat manifest path "${manifestPath}": ${(e as Error).message}`,
      );
    }
  }

  if (manifestExists) {
    // Parse and validate the manifest — fail closed on any error.
    // R169A-FIX-R3 (SEC-R169A-R3-03): parseGenerationManifest opens with
    // O_NOFOLLOW + fstat to close the TOCTOU window.
    const manifest = parseGenerationManifest(manifestPath, project);

    // Resolve the generation DB path
    const dbPath = resolve(projectDir, manifest.dbFile);

    // Containment check: the resolved DB path must be inside the project store
    if (!isLexicallyInside(projectDir, dbPath)) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_OUTSIDE_STORE",
        phase,
        project,
        `Generation DB path escapes project store: ${dbPath}`,
      );
    }

    // R169A-FIX (SEC-R169A-02): Strict chain walk on dbPath from the
    // store root. Walking from projectDir would miss a symlink at the
    // project store dir or at the generations dir parent.
    assertPathInsideNoSymlinks(
      storeRoot,
      dbPath,
      project,
      phase,
      "GENERATION_TARGET_SYMLINK_REJECTED",
    );

    // R169A-FIX (DATA-R169A-01): Target must be a regular file.
    let dbStat;
    try {
      dbStat = lstatSync(dbPath);
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        throw new GenerationStoreError(
          "MANIFEST_TARGET_MISSING",
          phase,
          project,
          `Generation DB file not found: ${dbPath}`,
        );
      }
      throw new GenerationStoreError(
        "MANIFEST_TARGET_MISSING",
        phase,
        project,
        `Cannot stat generation DB "${dbPath}": ${(e as Error).message}`,
      );
    }

    if (dbStat.isSymbolicLink()) {
      // Should be caught by assertPathInsideNoSymlinks above, but defense
      // in depth.
      throw new GenerationStoreError(
        "GENERATION_TARGET_SYMLINK_REJECTED",
        phase,
        project,
        `Generation DB is a symlink: ${dbPath}`,
      );
    }
    if (!dbStat.isFile()) {
      throw new GenerationStoreError(
        "MANIFEST_TARGET_NOT_REGULAR",
        phase,
        project,
        `Generation DB target is not a regular file: ${dbPath} (mode=0o${dbStat.mode.toString(8)})`,
      );
    }

    return {
      source: "generation",
      project,
      dbPath,
      generationId: manifest.generationId,
      manifest,
    };
  }

  // No manifest — check for legacy DB.
  // R169A-FIX-R2 (API-R169A-R2-01): Validate the legacy path the same
  // way we validate generation paths. Any failure → LEGACY_SOURCE_INVALID
  // (renamed from LEGACY_SOURCE_OPEN_FAILED). R169A validates path +
  // regular-file identity only; actual SQLite open validation occurs in
  // R169D reader cutover.
  try {
    assertPathInsideNoSymlinks(
      cbmCacheDir(cacheRoot),
      legacyPath,
      project,
      phase,
      "LEGACY_SOURCE_INVALID",
    );
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      // Re-wrap as LEGACY_SOURCE_INVALID unless it already is.
      if (e.code !== "LEGACY_SOURCE_INVALID") {
        throw new GenerationStoreError(
          "LEGACY_SOURCE_INVALID",
          phase,
          project,
          `Legacy path failed validation: ${e.message}`,
        );
      }
      throw e;
    }
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy path validation error: ${(e as Error).message}`,
    );
  }

  let legacyStat;
  try {
    legacyStat = lstatSync(legacyPath);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Neither manifest nor legacy DB exists.
      return {
        source: "missing",
        project,
        dbPath: null,
        generationId: null,
      };
    }
    // EACCES, EIO, etc. → fail closed.
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Cannot stat legacy DB "${legacyPath}": ${(e as Error).message}`,
    );
  }

  if (legacyStat.isSymbolicLink()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy DB is a symlink: ${legacyPath}`,
    );
  }
  if (!legacyStat.isFile()) {
    throw new GenerationStoreError(
      "LEGACY_SOURCE_INVALID",
      phase,
      project,
      `Legacy DB target is not a regular file: ${legacyPath}`,
    );
  }

  return {
    source: "legacy",
    project,
    dbPath: legacyPath,
    generationId: null,
  };
}

// ─── Layout durability (R169A-FIX-R2 DUR-R169A-R2-01, R169A-FIX-R3) ──────

/**
 * R169A-FIX-R2 (DUR-R169A-R2-01): Ensure the per-project store layout
 * (project store, generations, tmp) exists AND is durable.
 *
 * For each directory in the chain:
 *   1. If it doesn't exist, mkdir with mode 0700.
 *      Failure → STORE_LAYOUT_CREATE_FAILED.
 *   2. If mkdir returned EEXIST (concurrent writer), revalidate:
 *      lstatSync, reject symlink, reject non-directory, re-run trust
 *      root + path-inside, check permissions (R169A-FIX-R3
 *      SEC-R169A-R3-02 + SEC-R169A-R3-04).
 *   3. For EXISTING directories (found via lstat before mkdir),
 *      revalidate the same way (R169A-FIX-R3 SEC-R169A-R3-02).
 *   4. fsync the directory.
 *      Failure → STORE_LAYOUT_DURABILITY_UNKNOWN.
 *   5. If the directory was newly created, fsync its PARENT directory.
 *      Failure → STORE_LAYOUT_DURABILITY_UNKNOWN.
 *
 * R169A-FIX-R3 (SEC-R169A-R3-04): Existing directories must satisfy
 * `mode & 0o077 === 0` (no group/other permissions). Otherwise →
 * STORE_LAYOUT_PERMISSIONS_INSECURE. On POSIX, the directory's uid
 * SHOULD match `process.getuid()` (best-effort — not enforced on
 * platforms where `getuid` is unavailable).
 *
 * Why fsync the parent? `mkdir` creates the directory ENTRY in the
 * parent. Without fsyncing the parent, a crash after mkdir may leave
 * the parent's directory entry for the new dir missing — even though
 * `mkdir -p` returned successfully. This is the same durability
 * concern that motivated ATOMIC_DURABILITY_UNKNOWN for the file-rename
 * case, applied to directory creation.
 *
 * The optional `ops` parameter allows tests to inject failures at the
 * mkdir / fsync checkpoints. Production callers omit `ops` to use the
 * real node:fs bindings.
 *
 * Returns the list of directories that were newly created (in creation
 * order). Tests use this to assert that the parent-fsync step only runs
 * for newly created directories.
 */
export function ensureGenerationStoreLayoutDurable(
  project: string,
  options?: GenerationStoreOptions,
): { created: string[] } {
  return ensureGenerationStoreLayoutDurableInternal(project, options, PROD_OPS);
}

/**
 * R169A-FIX-R3 (API-R169A-R3-01): Public typed writer for the index-state
 * sidecar.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-02): This is the ONLY public writer in
 * R169A. Index-state is diagnostics (not graph data, not publication) —
 * writing it does not constitute a publication act. The manifest writer
 * `writeGenerationManifestAtomically` is internal (NOT a publication
 * API); R169B will own `publishPreparedGeneration`.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-01): Calls
 * `prepareIndexStateForWrite(state, project)` BEFORE any filesystem I/O.
 * The preparation builds a plain (null-prototype) object from the 11
 * index-state fields, validates it, serializes to JSON, parses the bytes
 * back, revalidates, and returns the immutable payload Buffer. The
 * filesystem writer receives ONLY the Buffer.
 *
 * If preparation or validation fails, NO temp / layout / target is
 * created — the on-disk state is unchanged.
 *
 * On success, writes `state` to `<projectStore>/index-state.json`
 * atomically (temp-rename-fsync pattern, temp file mode 0600).
 *
 * R169A-FIX-R5 (API-R169A-R5-02): The `ops` and `hook` parameters are
 * `@internal` — they exist for test fault injection and race injection
 * only. Production callers MUST omit them. They are NOT part of the
 * public API contract and may be removed or restructured in future
 * revisions without a semver bump.
 *
 * @internal ops Optional injectable filesystem operations (tests only).
 * @internal hook Optional test hook for race injection (tests only).
 */
/**
 * R169A-FIX-R6 (API-R169A-R6-01): Public facade with EXACTLY 3 parameters.
 * The `ops` and `hook` parameters are NOT part of the public API.
 * They are only accessible via the internal (non-exported) function
 * `writeIndexStateAtomicallyInternal`, which tests access through
 * a local cast. The generated `.d.ts` will show only 3 parameters.
 */
export function writeIndexStateAtomically(
  project: string,
  state: IndexAttemptStateV1,
  options?: GenerationStoreOptions,
): void {
  writeIndexStateAtomicallyInternal(project, state, options, PROD_OPS, undefined);
}

// R169A-FIX-R5 (API-R169A-R5-01): The `__test__` export is REMOVED.
// The manifest writer `writeGenerationManifestAtomically` and the
// `prepare*ForWrite` helpers are no longer accessible to production
// code. Tests that need a manifest on disk use the test helper
// `v2/tests/helpers/r169-generation-fixtures.ts` (writeFileSync-based).
// Atomic writer mechanic tests use `writeIndexStateAtomically` (the
// only public writer) which exercises the same internal writer code.
// A source inspection test verifies `__test__` and
// `writeGenerationManifestAtomically` are NOT exported.

// ─── Project listing (section 9.4, future; R169A-FIX OPS-R169A-01) ──────

/**
 * List all projects that have a generation store.
 * Returns an array of project store directory names (SHA-256 hex keys),
 * filtered to the canonical 64-lowercase-hex form and sorted
 * lexicographically.
 *
 * R169A-FIX (OPS-R169A-01):
 *   - Filter to `^[0-9a-f]{64}$` only — non-conforming entries (e.g.
 *     stray files, manifest filenames in the wrong place) are ignored.
 *   - Sort lexicographically for deterministic output.
 *   - Only ENOENT (store root doesn't exist yet) returns []. EACCES,
 *     EIO, ENOTDIR → throw GenerationStoreError (fail closed).
 *   - The parameter is now `cacheRoot` (NOT storeRoot) — same as the
 *     other path helpers.
 *
 * R169A-FIX-R2 (QUAL-R169A-R2-01): readdirSync is wrapped in try/catch
 * that produces a GenerationStoreError.
 *
 * R169A-FIX-R3 (OPS-R169A-R3-01): The trust root (cacheRoot → cbm →
 * projects) is validated BEFORE readdirSync. If `projects/` (or any of
 * its parents) is a symlink → PATH_TRAVERSAL_REJECTED. Only ENOENT is
 * tolerated.
 */
export function listProjectStoreKeys(cacheRoot?: string): string[] {
  const phase = "listProjectStoreKeys";
  const root = cacheRoot ?? getCacheRoot();

  // R169A-FIX-R3 (OPS-R169A-R3-01): Validate the trust root BEFORE
  // readdirSync. This catches a symlinked cacheRoot / cbmCacheDir /
  // projects BEFORE we enumerate.
  assertGenerationStoreRootTrusted(root, phase);

  let entries;
  try {
    entries = readdirSync(generationStoreRoot(root), { withFileTypes: true });
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return [];
    throw new GenerationStoreError(
      "GENERATION_STORE_CONFIG_ERROR",
      phase,
      "",
      `Failed to read project store root "${generationStoreRoot(root)}": ${(e as Error).message}`,
    );
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort();
}
