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
 */

import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
  realpathSync,
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
  MANIFEST_V1_KEYS,
  ResolvedCodeDb,
  GenerationStoreError,
  GenerationStoreErrorCode,
  isManifestV1Key,
} from "./generation-types.js";

// Re-export types for convenience
export type { GenerationManifestV1, ResolvedCodeDb } from "./generation-types.js";
export { GenerationStoreError, MANIFEST_V1_KEYS, isManifestV1Key } from "./generation-types.js";

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

// ─── Injectable filesystem operations ───────────────────────────────────

/**
 * R169A-FIX (DUR-R169A-02): Injectable atomic file operations.
 *
 * Production code uses the real Node.js `fs` bindings (see PROD_OPS below).
 * Tests inject controlled failures at specific checkpoints (open, write,
 * fsync, close, rename, dir-fsync) to verify the atomic writer's durability
 * contract under fault.
 *
 * R169A-FIX-R2 (DUR-R169A-R2-01 / SEC-R169A-R2-02): `mkdirSync` now
 * accepts an optional `mode` so the writer and layout helpers can pin
 * directory permissions to 0700.
 */
export interface AtomicFileOps {
  openSync(path: string, flags: string, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  statSync(path: string): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number };
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void;
}

/**
 * Production filesystem operations: thin wrappers over node:fs.
 *
 * `statSync` returns a minimal shape — only the fields the generation
 * store reads. This keeps the injectable interface narrow and makes
 * fault injection simpler in tests.
 */
const PROD_OPS: AtomicFileOps = {
  openSync: (p, f, m) => openSync(p, f, m),
  readSync: (fd, b, o, l, p) => readSync(fd, b, o, l, p),
  writeSync: (fd, b, o, l, p) => writeSync(fd, b, o, l, p),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  statSync: (p) => {
    const s = statSync(p);
    return {
      size: s.size,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      isSymbolicLink: () => s.isSymbolicLink(),
      mode: s.mode,
    };
  },
  renameSync: (f, t) => renameSync(f, t),
  unlinkSync: (p) => unlinkSync(p),
  mkdirSync: (p, opts) => {
    if (opts && typeof opts.mode === "number") {
      // Node's mkdirSync accepts { recursive, mode } — but `mode` only
      // applies to the leaf when recursive=true. For the layout helpers
      // we walk the chain explicitly so each component gets the right
      // mode; here we still pass mode through for the leaf.
      mkdirSync(p, { recursive: opts.recursive ?? false, mode: opts.mode });
    } else {
      mkdirSync(p, opts);
    }
  },
};

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
 * manifest path or GENERATION_TARGET_SYMLINK_REJECTED for the target DB.
 * Traversal errors always use PATH_TRAVERSAL_REJECTED.
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
  const key = projectStorageKey(project); // validates project is non-empty
  const chain: Array<{ label: string; path: string }> = [
    { label: "cacheRoot", path: cacheRoot },
    { label: "codebase-memory-mcp", path: cbmCacheDir(cacheRoot) },
    { label: "projects", path: generationStoreRoot(cacheRoot) },
    { label: "project-key", path: join(generationStoreRoot(cacheRoot), key) },
  ];

  for (const { label, path } of chain) {
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
): void {
  if (typeof value !== "string") {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `${field} must be a string, got: ${JSON.stringify(value)}`,
    );
  }
  if (value.trim().length === 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `${field} must not be empty or whitespace-only`,
    );
  }
  if (value.length > maxLength) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `${field} length ${value.length} exceeds maximum ${maxLength}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const cc = value.charCodeAt(i);
    if (cc < 32) {
      throw new GenerationStoreError(
        "MANIFEST_SCHEMA_ERROR",
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
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
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
): void {
  const match = ISO8601_WITH_TZ_REGEX.exec(value);
  if (!match) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
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
      "MANIFEST_SCHEMA_ERROR",
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
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid day: ${day} for year ${year} month ${month} (value=${JSON.stringify(value)})`,
    );
  }
  if (hour < 0 || hour > 23) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid hour: ${hour} (value=${JSON.stringify(value)})`,
    );
  }
  if (minute < 0 || minute > 59) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid minute: ${minute} (value=${JSON.stringify(value)})`,
    );
  }
  if (second < 0 || second > 59) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
      phase,
      project,
      `createdAt has invalid second: ${second} (value=${JSON.stringify(value)})`,
    );
  }

  // Final belt-and-suspenders: Date must parse to a valid epoch.
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new GenerationStoreError(
      "MANIFEST_SCHEMA_ERROR",
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
  // PRIVATE, immutable set. `MANIFEST_V1_KEYS` is exported as a tuple
  // (no .has / .add), and the validator's set is module-scoped — a
  // consumer cannot mutate the authority.
  const actualKeys = Object.keys(obj);
  const missingKeys = actualKeys.filter((k) => !isManifestV1Key(k) ? false : false); // placeholder; replaced below
  void missingKeys; // unused; see real check below
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

/**
 * Read and parse a manifest from disk.
 * Throws on read error, JSON parse error, or validation error.
 *
 * R169A-FIX-R2 (VALID-R169A-R2-01): Before reading, stat the file. If
 * the size exceeds `MAX_GENERATION_MANIFEST_BYTES` (64 KiB), throw
 * `MANIFEST_TOO_LARGE` — do NOT read the file into memory. Reading is
 * done via an fd (openSync + readSync + closeSync) so we control the
 * exact number of bytes consumed.
 */
export function parseGenerationManifest(
  manifestPath: string,
  expectedProject: string,
): GenerationManifestV1 {
  const phase = "parseGenerationManifest";

  // R169A-FIX-R2: stat the file first to enforce the size bound.
  let sizeStat;
  try {
    sizeStat = statSync(manifestPath);
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      // Caller is responsible for distinguishing missing file from
      // parse error; here we just surface as MANIFEST_PARSE_ERROR.
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
      `Failed to stat manifest "${manifestPath}": ${(e as Error).message}`,
    );
  }
  if (sizeStat.size > MAX_GENERATION_MANIFEST_BYTES) {
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
  let fd: number | null = null;
  let raw: string;
  try {
    fd = openSync(manifestPath, "r");
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
    raw = buf.toString("utf8");
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
    // R169A-FIX-R2: parseGenerationManifest enforces the 64 KiB size
    // bound before reading.
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

// ─── Layout durability (R169A-FIX-R2 DUR-R169A-R2-01) ───────────────────

/**
 * R169A-FIX-R2 (DUR-R169A-R2-01): Ensure the per-project store layout
 * (project store, generations, tmp) exists AND is durable.
 *
 * For each directory in the chain:
 *   1. If it doesn't exist, mkdir with mode 0700.
 *      Failure → STORE_LAYOUT_CREATE_FAILED.
 *   2. fsync the directory.
 *      Failure → STORE_LAYOUT_DURABILITY_UNKNOWN.
 *   3. If the directory was newly created, fsync its PARENT directory.
 *      Failure → STORE_LAYOUT_DURABILITY_UNKNOWN.
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
  ops?: AtomicFileOps,
): { created: string[] } {
  const phase = "ensureGenerationStoreLayoutDurable";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();
  const opImpl = ops ?? PROD_OPS;

  // R169A-FIX-R2 (SEC-R169A-R2-01): Validate the trust root BEFORE
  // creating any directories. This catches a symlinked cacheRoot /
  // cbmCacheDir / projects BEFORE we mkdir into the wrong place.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  // R169A-FIX-R2: Walk the FULL chain from cbmCacheDir down to tmp/.
  // We create each component with mode 0700 explicitly (rather than
  // relying on mkdirSync recursive, which only applies mode to the leaf
  // and would let intermediate dirs inherit the umask). For each newly
  // created dir, we fsync the parent so the directory entry is durable.
  //
  // The chain does NOT include cacheRoot itself — that is the user's
  // HOME cache dir, created by the OS / XDG machinery, and we do not
  // fsync cacheRoot's parent (which may be /tmp or /home, owned by root).
  const cbm = cbmCacheDir(cacheRoot);
  const projects = generationStoreRoot(cacheRoot);
  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const tmp = tmpDir(project, cacheRoot);

  const dirs = [
    { path: cbm, parent: cacheRoot },
    { path: projects, parent: cbm },
    { path: projectStore, parent: projects },
    { path: generations, parent: projectStore },
    { path: tmp, parent: projectStore },
  ];

  const created: string[] = [];

  for (const { path: dirPath, parent } of dirs) {
    // Check existence with lstat first. We do NOT use recursive mkdir
    // here because we want to know whether THIS directory was newly
    // created (so we can fsync the parent).
    let existed = false;
    try {
      const st = lstatSync(dirPath);
      existed = true;
      if (st.isSymbolicLink()) {
        // Defense-in-depth: assertTrustedRootNoSymlinks should have
        // caught this already, but check again here.
        throw new GenerationStoreError(
          "PATH_TRAVERSAL_REJECTED",
          phase,
          project,
          `Layout directory is a symlink: ${dirPath}`,
        );
      }
      if (!st.isDirectory()) {
        throw new GenerationStoreError(
          "STORE_LAYOUT_CREATE_FAILED",
          phase,
          project,
          `Layout path exists but is not a directory: ${dirPath}`,
        );
      }
    } catch (e) {
      if (e instanceof GenerationStoreError) throw e;
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode !== "ENOENT") {
        throw new GenerationStoreError(
          "STORE_LAYOUT_CREATE_FAILED",
          phase,
          project,
          `Cannot stat layout directory "${dirPath}": ${(e as Error).message}`,
        );
      }
      // ENOENT — directory doesn't exist yet, fall through to mkdir.
    }

    if (!existed) {
      try {
        opImpl.mkdirSync(dirPath, { recursive: false, mode: 0o700 });
      } catch (e) {
        // If the dir was created by a concurrent writer between our
        // lstat and our mkdir, EEXIST is fine — treat as "existed".
        const errCode = (e as NodeJS.ErrnoException).code;
        if (errCode !== "EEXIST") {
          throw new GenerationStoreError(
            "STORE_LAYOUT_CREATE_FAILED",
            phase,
            project,
            `Failed to create layout directory "${dirPath}" with mode 0700: ${(e as Error).message}`,
          );
        }
        // EEXIST — someone else created it; treat as existed.
        existed = true;
      }
      if (!existed) {
        created.push(dirPath);
      }
    }

    // fsync the directory itself. This ensures its metadata (mtime,
    // etc.) is flushed — more importantly, it ensures that any PENDING
    // writes INSIDE the directory (e.g. a temp file we're about to
    // create) hit the directory entry's link count promptly. Even if
    // the directory already existed, fsyncing it is cheap and idempotent.
    let dirFd: number | null = null;
    try {
      dirFd = opImpl.openSync(dirPath, "r");
      opImpl.fsyncSync(dirFd);
      opImpl.closeSync(dirFd);
      dirFd = null;
    } catch (e) {
      if (dirFd !== null) {
        try { opImpl.closeSync(dirFd); } catch { /* best effort */ }
      }
      throw new GenerationStoreError(
        "STORE_LAYOUT_DURABILITY_UNKNOWN",
        phase,
        project,
        `Failed to fsync layout directory "${dirPath}": ${(e as Error).message}`,
      );
    }

    // If the directory was newly created, fsync the parent so the
    // directory ENTRY in the parent is durable.
    if (created.includes(dirPath)) {
      let parentFd: number | null = null;
      try {
        parentFd = opImpl.openSync(parent, "r");
        opImpl.fsyncSync(parentFd);
        opImpl.closeSync(parentFd);
        parentFd = null;
      } catch (e) {
        if (parentFd !== null) {
          try { opImpl.closeSync(parentFd); } catch { /* best effort */ }
        }
        throw new GenerationStoreError(
          "STORE_LAYOUT_DURABILITY_UNKNOWN",
          phase,
          project,
          `Failed to fsync PARENT directory "${parent}" for newly created "${dirPath}": ${(e as Error).message}`,
        );
      }
    }
  }

  return { created };
}

// ─── Atomic JSON writer (section 18E, R169A-FIX DUR-R169A-01/02, R2) ────

/**
 * Write a JSON file atomically using the temp-rename-fsync pattern.
 *
 * INTERNAL — not exported. Use `writeProjectJsonAtomically` for the
 * project-aware wrapper that derives the target path, validates the
 * trust root, and ensures layout durability.
 *
 * R169A-FIX-R2 (SEC-R169A-R2-02): This function still accepts an
 * arbitrary `targetPath`, but it is now ONLY called by
 * `writeProjectJsonAtomically` after the trust root and target path have
 * been validated. Direct callers from outside this module are not
 * permitted — there is no public API for writing JSON to an arbitrary
 * path under the cache root.
 *
 * R169A-FIX-R2 (DUR-R169A-R2-01): `ops.mkdirSync` is now called with
 * `mode: 0o700` so the temp directory is created with strict
 * permissions. The temp file is still 0o600.
 *
 * R169A-FIX (DUR-R169A-02) — Serialization safety:
 *   1. Serialize to JSON BEFORE any filesystem mutation. If
 *      JSON.stringify returns a non-string (e.g. for BigInt without
 *      a replacer), throw ATOMIC_SERIALIZATION_FAILED before opening
 *      any file.
 *   2. Encode as UTF-8 Buffer.
 *   3. Write in a loop with offset accounting. If writeSync returns
 *      <=0, throw ATOMIC_SHORT_WRITE (partial write detected).
 *
 * Steps:
 *   1. Serialize JSON to Buffer (fails → ATOMIC_SERIALIZATION_FAILED)
 *   2. Create a temp file in the SAME directory (exclusive create, 0600)
 *   3. Write the complete payload in a loop
 *      (write fails → ATOMIC_WRITE_FAILED; writeSync ≤0 → ATOMIC_SHORT_WRITE)
 *   4. fsync the temp file (fails → ATOMIC_FSYNC_FAILED, temp cleaned up)
 *   5. close the temp file
 *   6. rename temp → target (fails → ATOMIC_RENAME_FAILED, temp cleaned up)
 *   7. fsync the directory
 *      (fails → ATOMIC_DURABILITY_UNKNOWN — see note below)
 *
 * R169A-FIX (DUR-R169A-01) — Directory fsync:
 *   On POSIX, rename is atomic but NOT durable until the parent directory
 *   has been fsynced. If we cannot fsync the directory after a successful
 *   rename, we cannot guarantee the rename is durable: a crash may either
 *   leave the old target in place OR the new target. We throw
 *   ATOMIC_DURABILITY_UNKNOWN with a message instructing the caller to
 *   re-read the target and diagnose. We do NOT silently succeed.
 *
 * On any failure (except ATOMIC_DURABILITY_UNKNOWN, where the rename has
 * already happened), the temp file is cleaned up and the original file
 * (if any) remains unchanged.
 *
 * R169A-FIX-R2 (QUAL-R169A-R2-01): All errors are wrapped in
 * GenerationStoreError with the project name. The `project` and `phase`
 * parameters are threaded through from the public wrapper so diagnostics
 * are uniform.
 */
function writeJsonAtomically(
  targetPath: string,
  value: unknown,
  project: string,
  phase: string,
  ops: AtomicFileOps = PROD_OPS,
): void {
  const dir = resolve(targetPath, "..");
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);

  // R169A-FIX (DUR-R169A-02): Serialize BEFORE any filesystem mutation.
  // JSON.stringify can fail in two ways:
  //   1. It throws (e.g. for BigInt without a replacer, circular refs)
  //   2. It returns undefined (for undefined/functions/symbols as the
  //      top-level value)
  // Both cases must throw ATOMIC_SERIALIZATION_FAILED before any file
  // is opened — otherwise a partial temp file could be left behind.
  let serialized: string;
  try {
    const r = JSON.stringify(value, null, 2);
    if (typeof r !== "string") {
      throw new Error(`JSON.stringify returned non-string (typeof=${typeof r})`);
    }
    serialized = r;
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_SERIALIZATION_FAILED",
      phase,
      project,
      `JSON serialization failed: ${(e as Error).message}`,
    );
  }
  const payload = Buffer.from(serialized + "\n", "utf8");

  // R169A-FIX-R2 (DUR-R169A-R2-01): The directory must already exist by
  // the time we get here — writeProjectJsonAtomically calls
  // ensureGenerationStoreLayoutDurable first. We still mkdir as a
  // belt-and-suspenders step (mode 0700) in case the dir was deleted
  // between layout and write. Production callers will see this be a
  // no-op (dir exists).
  try {
    ops.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      project,
      `Failed to ensure temp directory "${dir}" with mode 0700: ${(e as Error).message}`,
    );
  }

  let fd: number | null = null;
  let renameSucceeded = false;
  try {
    // Exclusive create — fails if the file already exists
    try {
      fd = ops.openSync(tmpPath, "wx", 0o600);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_WRITE_FAILED",
        phase,
        project,
        `Failed to open temp file exclusively: ${(e as Error).message}`,
      );
    }

    // R169A-FIX (DUR-R169A-02): Loop write with offset accounting.
    let offset = 0;
    while (offset < payload.length) {
      let written: number;
      try {
        written = ops.writeSync(fd, payload, offset, payload.length - offset, null);
      } catch (e) {
        throw new GenerationStoreError(
          "ATOMIC_WRITE_FAILED",
          phase,
          project,
          `writeSync failed at offset ${offset}/${payload.length}: ${(e as Error).message}`,
        );
      }
      if (written <= 0) {
        throw new GenerationStoreError(
          "ATOMIC_SHORT_WRITE",
          phase,
          project,
          `writeSync returned ${written} at offset ${offset}/${payload.length}`,
        );
      }
      offset += written;
    }

    // fsync the temp file
    try {
      ops.fsyncSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_FSYNC_FAILED",
        phase,
        project,
        `Failed to fsync temp file: ${(e as Error).message}`,
      );
    }

    try {
      ops.closeSync(fd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_WRITE_FAILED",
        phase,
        project,
        `Failed to close temp file: ${(e as Error).message}`,
      );
    }
    fd = null;

    // rename temp → target
    try {
      ops.renameSync(tmpPath, targetPath);
      renameSucceeded = true;
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_RENAME_FAILED",
        phase,
        project,
        `Failed to rename temp to target: ${(e as Error).message}`,
      );
    }

    // R169A-FIX (DUR-R169A-01): fsync the directory.
    // If this fails, the rename has already happened — the target may
    // already be the new file. We cannot silently succeed because
    // durability is unknown. Throw ATOMIC_DURABILITY_UNKNOWN so the
    // caller knows to re-read and diagnose.
    let dirFd: number | null = null;
    try {
      dirFd = ops.openSync(dir, "r");
      ops.fsyncSync(dirFd);
      ops.closeSync(dirFd);
      dirFd = null;
    } catch (e) {
      // Rename succeeded but dir fsync failed. The target may already
      // be the new file. Caller MUST re-read and diagnose.
      throw new GenerationStoreError(
        "ATOMIC_DURABILITY_UNKNOWN",
        phase,
        project,
        `Directory fsync failed after rename — target may already be new, caller must re-read and diagnose: ${(e as Error).message}`,
      );
    } finally {
      if (dirFd !== null) {
        try { ops.closeSync(dirFd); } catch { /* best effort */ }
      }
    }
  } catch (e) {
    // Clean up temp file on any failure.
    // If rename succeeded, the temp file no longer exists at tmpPath
    // (it was renamed to the target). unlinkSync will throw ENOENT,
    // which we swallow.
    if (fd !== null) {
      try { ops.closeSync(fd); } catch { /* best effort */ }
    }
    if (!renameSucceeded) {
      try { ops.unlinkSync(tmpPath); } catch { /* best effort */ }
    }

    if (e instanceof GenerationStoreError) throw e;

    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      project,
      `Failed to write JSON atomically: ${(e as Error).message}`,
    );
  }
}

/**
 * R169A-FIX-R2 (SEC-R169A-R2-02): Project-aware atomic JSON writer.
 *
 * This is the PUBLIC writer. It derives the target path from `project`
 * and `target` (NOT from the caller), validates the trust root, rejects
 * symlinked targets, ensures the layout is durable, and then delegates
 * to the internal `writeJsonAtomically`.
 *
 * Wrapper contract:
 *   1. Derive target path: `manifest` → `activeManifestPath(project)`;
 *      `index-state` → `indexStatePath(project)`.
 *   2. `assertTrustedRootNoSymlinks(cacheRoot, project, phase)` —
 *      validates cacheRoot, cbmCacheDir, projects, project-key. Any
 *      symlink in this chain → PATH_TRAVERSAL_REJECTED.
 *   3. `assertPathInsideNoSymlinks(generationStoreRoot, targetPath, ...)`
 *      — full chain walk from the store root to the target file.
 *   4. Reject if target (if existing) is a symlink — `assertNotSymlink`.
 *   5. `ensureGenerationStoreLayoutDurable(project, options, ops)` —
 *      mkdir 0700 + fsync every directory in the chain + fsync parent
 *      of newly created dirs. Failures: STORE_LAYOUT_CREATE_FAILED,
 *      STORE_LAYOUT_DURABILITY_UNKNOWN.
 *   6. `writeJsonAtomically(targetPath, value, project, phase, ops)` —
 *      the temp-rename-fsync pattern. Temp file mode 0600, temp dir
 *      mode 0700.
 *
 * All errors are wrapped in `GenerationStoreError` with the project
 * name. The wrapper NEVER accepts an arbitrary target path — the path
 * is always derived from `project` + `target`.
 */
export function writeProjectJsonAtomically(
  project: string,
  target: "manifest" | "index-state",
  value: unknown,
  options?: GenerationStoreOptions,
  ops?: AtomicFileOps,
): void {
  const phase = "writeProjectJsonAtomically";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();

  // 1. Derive target path from project + target type.
  const targetPath = target === "manifest"
    ? activeManifestPath(project, cacheRoot)
    : indexStatePath(project, cacheRoot);

  // 2. Validate the trust root (cacheRoot → cbm → projects → project-key).
  //    This catches a symlinked cacheRoot or any of its CBM subdirectories
  //    BEFORE we touch the target.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  // 3. Strict chain walk from the store root to the target file.
  const storeRoot = generationStoreRoot(cacheRoot);
  const symlinkCode = target === "manifest"
    ? "MANIFEST_SYMLINK_REJECTED" as GenerationStoreErrorCode
    : "GENERATION_TARGET_SYMLINK_REJECTED" as GenerationStoreErrorCode;
  assertPathInsideNoSymlinks(storeRoot, targetPath, project, phase, symlinkCode);

  // 4. Defense-in-depth: if the target file already exists, reject it
  //    if it's a symlink. (assertPathInsideNoSymlinks already walked
  //    the chain; this is a final check on the target itself.)
  assertNotSymlink(targetPath, symlinkCode, project);

  // 5. Ensure layout is durable (mkdir 0700 + fsync chain). This must
  //    happen BEFORE the write so the directory entries are durable by
  //    the time the temp file is created.
  ensureGenerationStoreLayoutDurable(project, options, ops);

  // 6. Delegate to the internal atomic writer.
  writeJsonAtomically(targetPath, value, project, phase, ops);
}

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
 */
export function listProjectStoreKeys(cacheRoot?: string): string[] {
  const phase = "listProjectStoreKeys";
  const root = generationStoreRoot(cacheRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") return [];
    throw new GenerationStoreError(
      "GENERATION_STORE_CONFIG_ERROR",
      phase,
      "",
      `Failed to read project store root "${root}": ${(e as Error).message}`,
    );
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort();
}
