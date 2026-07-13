/**
 * R169A-FIX-R8 (GPT 5.6 final audit pass): Internal I/O harness for the
 * generation store.
 *
 * STATUS: FOUNDATION / INACTIVE — internal test harness.
 *
 * This module is the SINGLE home for the generation store's internal
 * filesystem-writing machinery:
 *   - `AtomicFileOps` interface (injectable fs bindings for fault injection)
 *   - `WriterTestHook` interface (race injection points for tests)
 *   - `PROD_OPS` const (production fs bindings)
 *   - `ensureGenerationStoreLayoutDurableInternal` (mkdir + fsync chain)
 *   - `writeIndexStateAtomicallyInternal` (typed atomic writer, ops+hook)
 *   - All internal helpers they depend on: `assertLayoutDirPermissions`,
 *     `openDirectoryNoFollow`, `defaultSerializeJson`,
 *     `prepareGenerationManifestForWrite`, `prepareIndexStateForWrite`,
 *     `writeJsonAtomically`, `writeProjectJsonAtomicallyInternal`.
 *
 * WHY A SEPARATE MODULE:
 *   GPT 5.6 found that the public module `generation-store.ts` was still
 *   EXPORTING `AtomicFileOps`, `WriterTestHook`, `PROD_OPS`, and the
 *   `*Internal` functions. Even though they were marked `@internal` in
 *   JSDoc, they appeared in the generated `.d.ts` and were therefore part
 *   of the public API surface. A consumer could `import { PROD_OPS } from
 *   "codebase-memory-v2/storage/generation-store"` and inject a
 *   fault-inducing ops object into production code paths. This module
 *   split removes that surface area entirely: the public module re-exports
 *   ONLY path helpers, types (re-exported from generation-types),
 *   validators, the resolver, the two public façade writers, and
 *   `listProjectStoreKeys`. The internal harness lives here and is
 *   imported only by tests (which live outside the package build).
 *
 * DEPENDENCY DIRECTION:
 *   - This module imports types from `../generation-types.js`.
 *   - This module imports path helpers, validators, trust-root validators,
 *     `assertNotSymlink`, and `GenerationStoreOptions` from
 *     `../generation-store.js` (the public module).
 *   - The public module imports `PROD_OPS`, the two `*Internal` functions,
 *     `assertLayoutDirPermissions`, and `O_NOFOLLOW` from this module.
 *   - This circular dependency is safe because nothing at module-load
 *     time crosses the boundary — only function bodies reference the
 *     cross-module bindings, and those are only executed at call time.
 *
 * SECURITY:
 *   All filesystem writes go through `O_NOFOLLOW | O_DIRECTORY` opens
 *   (or the lstat/open/fstat dev+ino compare fallback on Windows), with
 *   mode 0700 directories and 0600 temp files. See the per-function
 *   docstrings for the threat model and TOCTOU analysis.
 *
 * R169A-FIX-R8 changes (this module):
 *   - Moved out of `generation-store.ts` into this dedicated internal
 *     module. No behavioral changes — the code is identical to what was
 *     previously inlined in `generation-store.ts` (R1 through R7 audit
 *     passes). The only change is the FILE location and the EXPORT
 *     boundary: these symbols are no longer reachable from
 *     `generation-store.ts`'s public surface.
 */

import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  fstatSync,
  renameSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import {
  join,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";

import {
  GenerationManifestV1,
  IndexAttemptStateV1,
  MANIFEST_V1_KEYS,
  INDEX_STATE_V1_KEYS,
  GenerationStoreError,
  GenerationStoreErrorCode,
} from "../generation-types.js";

// Path helpers, validators, trust-root validators, and the options
// interface live in the public module. We import them here so the
// internal harness can call them. The public module imports PROD_OPS and
// the *Internal functions back from this module — see the dependency
// direction note in the file header.
import {
  GenerationStoreOptions,
  getCacheRoot,
  cbmCacheDir,
  generationStoreRoot,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  indexStatePath,
  assertTrustedRootNoSymlinks,
  assertPathInsideNoSymlinks,
  assertNotSymlink,
  validateGenerationManifest,
  validateIndexAttemptState,
} from "../generation-store.js";

// ─── Platform constants (R169A-FIX-R3 SEC-R169A-R3-02 / SEC-R169A-R3-03) ──

/**
 * Platform flags for O_NOFOLLOW and O_DIRECTORY. These are present on
 * Linux and macOS but NOT on Windows. We gracefully degrade when they
 * are absent.
 *
 * R169A-FIX-R8: This constant was previously a non-exported module-scoped
 * const in `generation-store.ts`. It is moved here so that the public
 * module's `parseGenerationManifest` (which still needs `O_NOFOLLOW` for
 * its open-with-O_NOFOLLOW branch) imports it from this internal module
 * rather than defining it locally. This keeps the FS-specific constants
 * centralized.
 */
export const O_NOFOLLOW: number = typeof (fsConstants as Record<string, unknown>).O_NOFOLLOW === "number"
  ? (fsConstants as { O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;
export const O_DIRECTORY: number = typeof (fsConstants as Record<string, unknown>).O_DIRECTORY === "number"
  ? (fsConstants as { O_DIRECTORY: number }).O_DIRECTORY
  : 0;

// ─── Injectable filesystem operations (R169A-FIX DUR-R169A-02) ───────────

/**
 * R169A-FIX (DUR-R169A-02): Injectable atomic file operations.
 *
 * Production code uses the real Node.js `fs` bindings (see PROD_OPS below).
 * Tests inject controlled failures at specific checkpoints (open, write,
 * fsync, close, rename, dir-fsync) to verify the atomic writer's
 * durability contract under fault.
 *
 * R169A-FIX-R4 (TEST-R169A-R4-01): `statSync` renamed to `lstatSync`.
 * The previous `statSync` delegated to `node:fs.statSync`, which FOLLOWS
 * symlinks — so `isSymbolicLink()` on the returned stats was ALWAYS
 * false on the target. PROD_OPS now delegates to `node:fs.lstatSync`.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-01): `serializeJson` REMOVED. The typed
 * writers now prepare a canonical payload Buffer BEFORE any filesystem
 * I/O (see `prepareGenerationManifestForWrite` /
 * `prepareIndexStateForWrite`). The filesystem writer receives ONLY the
 * Buffer; it never calls JSON.stringify. This closes the canonical-
 * payload gap where a `toJSON` getter / Proxy / prototype pollution
 * could make the written bytes differ from the validated object.
 *
 * R169A-FIX-R8: This interface is EXPORTED FROM THE INTERNAL MODULE only.
 * The public module does NOT re-export it. Tests import it from here;
 * production code never references `AtomicFileOps` (it calls the public
 * façades `writeIndexStateAtomically` / `ensureGenerationStoreLayoutDurable`
 * which always use `PROD_OPS`).
 */
export interface AtomicFileOps {
  openSync(path: string, flags: string | number, mode?: number): number;
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
  lstatSync(path: string): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number };
  fstatSync(fd: number): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number };
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void;
}

/**
 * Production filesystem operations: thin wrappers over node:fs.
 *
 * R169A-FIX-R4 (TEST-R169A-R4-01): `lstatSync` (renamed from `statSync`)
 * delegates to `node:fs.lstatSync` so `isSymbolicLink()` correctly
 * reports symlinks.
 *
 * R169A-FIX-R4 (DATA-R169A-R4-01): `serializeJson` removed. The typed
 * writers prepare the canonical Buffer before any I/O; the filesystem
 * writer just writes the Buffer.
 *
 * `lstatSync` / `fstatSync` return a minimal shape — only the fields
 * the generation store reads. This keeps the injectable interface
 * narrow and makes fault injection simpler in tests.
 *
 * R169A-FIX-R8: This const is EXPORTED FROM THE INTERNAL MODULE only.
 * The public module imports it from here (for use by the public façade
 * `writeIndexStateAtomically` and `ensureGenerationStoreLayoutDurable`),
 * but does NOT re-export it. Tests import it from here.
 */
export const PROD_OPS: AtomicFileOps = {
  openSync: (p, f, m) => openSync(p, f as string, m),
  readSync: (fd, b, o, l, p) => readSync(fd, b, o, l, p),
  writeSync: (fd, b, o, l, p) => writeSync(fd, b, o, l, p),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  lstatSync: (p) => {
    const s = lstatSync(p);
    return {
      size: s.size,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      isSymbolicLink: () => s.isSymbolicLink(),
      mode: s.mode,
      dev: s.dev,
      ino: s.ino,
      uid: s.uid,
    };
  },
  fstatSync: (fd) => {
    const s = fstatSync(fd);
    return {
      size: s.size,
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      isSymbolicLink: () => s.isSymbolicLink(),
      mode: s.mode,
      dev: s.dev,
      ino: s.ino,
      uid: s.uid,
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

// ─── Layout permission policy (R169A-FIX-R4 COMPAT-R169A-R4-01) ──────────

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
 * R169A-FIX-R8: This helper is used by BOTH the public trust-root
 * validators (`assertTrustedRootNoSymlinks`,
 * `assertGenerationStoreRootTrusted`) AND by
 * `ensureGenerationStoreLayoutDurableInternal` (in this module). It is
 * exported from the internal module; the public module imports it from
 * here. It is NOT re-exported by the public module, so the public API
 * surface does not include it.
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

// ─── Layout durability (R169A-FIX-R2 DUR-R169A-R2-01, R169A-FIX-R3) ──────

/**
 * R169A-FIX-R2 (DUR-R169A-R2-01): Ensure the per-project store layout
 * (project store, generations, tmp) exists AND is durable. INTERNAL —
 * the public façade is `ensureGenerationStoreLayoutDurable` (in the
 * public module), which calls this with `PROD_OPS`.
 *
 * See the docstring in the original R2 implementation (now moved here)
 * for the full mkdir + fsync chain semantics, EEXIST revalidation,
 * permission policy, and parent-fsync rationale.
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 * The public module's `ensureGenerationStoreLayoutDurable` façade calls
 * it with `PROD_OPS`. Tests import it from here.
 */
export function ensureGenerationStoreLayoutDurableInternal(
  project: string,
  options: GenerationStoreOptions | undefined,
  ops: AtomicFileOps,
): { created: string[] } {
  const phase = "ensureGenerationStoreLayoutDurableInternal";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();
  const opImpl = ops ?? PROD_OPS;

  // R169A-FIX-R2 (SEC-R169A-R2-01): Validate the trust root BEFORE
  // creating any directories. This catches a symlinked cacheRoot /
  // cbmCacheDir / projects BEFORE we mkdir into the wrong place.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const cbm = cbmCacheDir(cacheRoot);
  const projects = generationStoreRoot(cacheRoot);
  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const tmp = tmpDir(project, cacheRoot);

  const dirs = [
    { path: cbm, parent: cacheRoot, isCompatRoot: true },
    { path: projects, parent: cbm, isCompatRoot: false },
    { path: projectStore, parent: projects, isCompatRoot: false },
    { path: generations, parent: projectStore, isCompatRoot: false },
    { path: tmp, parent: projectStore, isCompatRoot: false },
  ];

  const created: string[] = [];

  for (const { path: dirPath, parent, isCompatRoot } of dirs) {
    let existed = false;
    try {
      const st = opImpl.lstatSync(dirPath);
      existed = true;
      if (st.isSymbolicLink()) {
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
      assertLayoutDirPermissions(st, dirPath, isCompatRoot, project, phase);
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
    }

    if (!existed) {
      try {
        opImpl.mkdirSync(dirPath, { recursive: false, mode: 0o700 });
      } catch (e) {
        const errCode = (e as NodeJS.ErrnoException).code;
        if (errCode !== "EEXIST") {
          throw new GenerationStoreError(
            "STORE_LAYOUT_CREATE_FAILED",
            phase,
            project,
            `Failed to create layout directory "${dirPath}" with mode 0700: ${(e as Error).message}`,
          );
        }
        let existStat;
        try {
          existStat = opImpl.lstatSync(dirPath);
        } catch (e2) {
          throw new GenerationStoreError(
            "STORE_LAYOUT_CREATE_FAILED",
            phase,
            project,
            `EEXIST on mkdir but cannot stat "${dirPath}": ${(e2 as Error).message}`,
          );
        }
        if (existStat.isSymbolicLink()) {
          throw new GenerationStoreError(
            "PATH_TRAVERSAL_REJECTED",
            phase,
            project,
            `Layout directory became a symlink between lstat and mkdir: ${dirPath}`,
          );
        }
        if (!existStat.isDirectory()) {
          throw new GenerationStoreError(
            "STORE_LAYOUT_CREATE_FAILED",
            phase,
            project,
            `Layout path exists but is not a directory (EEXIST): ${dirPath}`,
          );
        }
        assertLayoutDirPermissions(existStat, dirPath, isCompatRoot, project, phase);
        assertTrustedRootNoSymlinks(cacheRoot, project, phase);
        assertPathInsideNoSymlinks(
          parent,
          dirPath,
          project,
          phase,
          "PATH_TRAVERSAL_REJECTED",
        );
        existed = true;
      }
      if (!existed) {
        created.push(dirPath);
      }
    } else {
      assertPathInsideNoSymlinks(
        parent,
        dirPath,
        project,
        phase,
        "PATH_TRAVERSAL_REJECTED",
      );
    }

    let dirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(dirPath, opImpl);
      dirFd = opened.fd;
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

    if (created.includes(dirPath)) {
      let parentFd: number | null = null;
      try {
        const opened = openDirectoryNoFollow(parent, opImpl);
        parentFd = opened.fd;
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

// ─── Atomic JSON writer (section 18E, R169A-FIX DUR-R169A-01/02, R2/R3) ─

/**
 * R169A-FIX-R4 (DATA-R169A-R4-02): Test hook for the internal writer.
 *
 * `afterLayoutBeforeOpen` is called AFTER `ensureGenerationStoreLayoutDurable`
 * has created the layout directories AND BEFORE the temp file is opened
 * with `openSync(tmpPath, "wx", 0o600)`. Tests use this to inject a race.
 *
 * R169A-FIX-R4 (SEC-R169A-R4-01): `afterTempFsyncBeforeRename` is called
 * AFTER the temp file is fsynced and closed AND BEFORE the pre-rename
 * identity check + rename.
 *
 * R169A-FIX-R8: This interface is EXPORTED FROM THE INTERNAL MODULE only.
 * Tests import it from here; production code never references it.
 */
export interface WriterTestHook {
  /** Called after layout creation, before temp file open. */
  afterLayoutBeforeOpen?(ctx: { targetPath: string; projectDir: string; project: string }): void;
  /**
   * R169A-FIX-R4: Called after temp file fsync+close, before the
   * pre-rename identity check.
   */
  afterTempFsyncBeforeRename?(ctx: { targetPath: string; tmpPath: string; dir: string; project: string }): void;
}

/**
 * R169A-FIX-R4 (SEC-R169A-R4-02): Open a directory with
 * `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (when available), or fall back
 * to `lstatSync -> openSync -> fstatSync -> compare dev+ino`.
 *
 * Returns `{ fd, dev, ino }` where `dev + ino` come from `fstatSync(fd)`.
 *
 * R169A-FIX-R8: This helper is EXPORTED FROM THE INTERNAL MODULE only.
 */
export function openDirectoryNoFollow(
  path: string,
  ops: AtomicFileOps,
): { fd: number; dev: number; ino: number } {
  if (O_DIRECTORY && O_NOFOLLOW) {
    const fd = ops.openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const st = ops.fstatSync(fd);
      return { fd, dev: st.dev, ino: st.ino };
    } catch (e) {
      try { ops.closeSync(fd); } catch { /* best effort */ }
      throw e;
    }
  }
  let lstat;
  try {
    lstat = ops.lstatSync(path);
  } catch (e) {
    throw new Error(`Cannot lstat directory "${path}": ${(e as Error).message}`);
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`Path is a symlink (rejected by openDirectoryNoFollow): ${path}`);
  }
  if (!lstat.isDirectory()) {
    throw new Error(`Path is not a directory: ${path}`);
  }
  const fd = ops.openSync(path, "r");
  let fstat;
  try {
    fstat = ops.fstatSync(fd);
  } catch (e) {
    try { ops.closeSync(fd); } catch { /* best effort */ }
    throw new Error(`Cannot fstat directory fd "${path}": ${(e as Error).message}`);
  }
  if (lstat.dev !== fstat.dev || lstat.ino !== fstat.ino) {
    try { ops.closeSync(fd); } catch { /* best effort */ }
    throw new Error(`Directory was swapped between lstat and open (dev/ino mismatch): ${path}`);
  }
  return { fd, dev: fstat.dev, ino: fstat.ino };
}

/**
 * R169A-FIX-R4 (DATA-R169A-R4-01): Default JSON serializer used by the
 * prepare*ForWrite helpers.
 *
 * R169A-FIX-R8: This helper is NOT exported — it is a private helper
 * used by `prepareGenerationManifestForWrite` and
 * `prepareIndexStateForWrite` in this module.
 */
const defaultSerializeJson = (value: unknown): string => {
  const r = JSON.stringify(value, null, 2);
  if (typeof r !== "string") {
    throw new Error(`JSON.stringify returned non-string (typeof=${typeof r})`);
  }
  return r;
};

/**
 * R169A-FIX-R4 (DATA-R169A-R4-01): Prepare a canonical manifest payload
 * for atomic write. Returns `{ value, payload }`.
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 */
export function prepareGenerationManifestForWrite(
  input: GenerationManifestV1,
  project: string,
  serializeJson: (value: unknown) => string = defaultSerializeJson,
): { value: GenerationManifestV1; payload: Buffer } {
  const phase = "prepareGenerationManifestForWrite";

  const plain = Object.create(null) as Record<string, unknown>;
  for (const key of MANIFEST_V1_KEYS) {
    plain[key] = (input as unknown as Record<string, unknown>)[key];
  }

  const validated = validateGenerationManifest(plain, project);

  let serialized: string;
  try {
    const r = serializeJson(validated);
    if (typeof r !== "string") {
      throw new Error(`serializeJson returned non-string (typeof=${typeof r})`);
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

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serialized);
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_SERIALIZATION_FAILED",
      phase,
      project,
      `JSON reparse failed: ${(e as Error).message}`,
    );
  }

  const validatedParsed = validateGenerationManifest(reparsed, project);

  return {
    value: validatedParsed,
    payload: Buffer.from(serialized + "\n", "utf8"),
  };
}

/**
 * R169A-FIX-R4 (DATA-R169A-R4-01): Prepare a canonical index-state
 * payload for atomic write. Mirrors `prepareGenerationManifestForWrite`.
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 */
export function prepareIndexStateForWrite(
  input: IndexAttemptStateV1,
  project: string,
  serializeJson: (value: unknown) => string = defaultSerializeJson,
): { value: IndexAttemptStateV1; payload: Buffer } {
  const phase = "prepareIndexStateForWrite";

  const plain = Object.create(null) as Record<string, unknown>;
  for (const key of INDEX_STATE_V1_KEYS) {
    plain[key] = (input as unknown as Record<string, unknown>)[key];
  }

  const validated = validateIndexAttemptState(plain, project);

  let serialized: string;
  try {
    const r = serializeJson(validated);
    if (typeof r !== "string") {
      throw new Error(`serializeJson returned non-string (typeof=${typeof r})`);
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

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serialized);
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_SERIALIZATION_FAILED",
      phase,
      project,
      `JSON reparse failed: ${(e as Error).message}`,
    );
  }

  const validatedParsed = validateIndexAttemptState(reparsed, project);

  return {
    value: validatedParsed,
    payload: Buffer.from(serialized + "\n", "utf8"),
  };
}

/**
 * Write a JSON file atomically using the temp-rename-fsync pattern.
 *
 * INTERNAL — not part of the public API. Use `writeIndexStateAtomically`
 * (the public façade in the public module) for the typed, validating
 * wrapper.
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 */
export function writeJsonAtomically(
  targetPath: string,
  payload: Buffer,
  project: string,
  phase: string,
  ops: AtomicFileOps = PROD_OPS,
  hook?: WriterTestHook,
): void {
  const dir = resolve(targetPath, "..");
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);

  let dirFd: number | null = null;
  let dirFdDev: number;
  let dirFdIno: number;
  try {
    const opened = openDirectoryNoFollow(dir, ops);
    dirFd = opened.fd;
    dirFdDev = opened.dev;
    dirFdIno = opened.ino;
  } catch (e) {
    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      project,
      `Failed to open target directory O_NOFOLLOW "${dir}": ${(e as Error).message}`,
    );
  }

  let fd: number | null = null;
  let renameSucceeded = false;
  let directoryIdentityStillValid = true;
  try {
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

    if (hook?.afterTempFsyncBeforeRename) {
      hook.afterTempFsyncBeforeRename({
        targetPath,
        tmpPath,
        dir,
        project,
      });
    }

    let dirLstat;
    try {
      dirLstat = ops.lstatSync(dir);
    } catch (e) {
      directoryIdentityStillValid = false;
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        project,
        `Cannot lstat target directory before rename "${dir}": ${(e as Error).message}`,
      );
    }
    if (dirLstat.isSymbolicLink()) {
      directoryIdentityStillValid = false;
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        project,
        `Target directory became a symlink between open and rename: ${dir}`,
      );
    }
    if (dirLstat.dev !== dirFdDev || dirLstat.ino !== dirFdIno) {
      directoryIdentityStillValid = false;
      throw new GenerationStoreError(
        "PATH_TRAVERSAL_REJECTED",
        phase,
        project,
        `Target directory was swapped between open and rename (dev/ino mismatch): ${dir}`,
      );
    }

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

    try {
      ops.fsyncSync(dirFd);
    } catch (e) {
      throw new GenerationStoreError(
        "ATOMIC_DURABILITY_UNKNOWN",
        phase,
        project,
        `Directory fsync failed after rename — target may already be new, caller must re-read and diagnose: ${(e as Error).message}`,
      );
    }
  } catch (e) {
    if (fd !== null) {
      try { ops.closeSync(fd); } catch { /* best effort */ }
    }
    let cleanupSafe = false;
    if (!renameSucceeded && directoryIdentityStillValid) {
      try {
        const currentLstat = ops.lstatSync(dir);
        cleanupSafe =
          !currentLstat.isSymbolicLink() &&
          currentLstat.isDirectory() &&
          currentLstat.dev === dirFdDev &&
          currentLstat.ino === dirFdIno;
      } catch {
        cleanupSafe = false;
      }
    }
    if (cleanupSafe) {
      try { ops.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
    const orphaned = !renameSucceeded && !cleanupSafe;

    if (e instanceof GenerationStoreError) {
      if (orphaned) {
        throw new GenerationStoreError(
          e.code,
          e.phase,
          e.project,
          `${e.message} [WARNING: ATOMIC_TEMP_ORPHANED — temp file ${tmpPath} may be orphaned in the original directory because the target directory was swapped; not unlinked by path to avoid operating on the wrong directory]`,
        );
      }
      throw e;
    }

    if (orphaned) {
      throw new GenerationStoreError(
        "ATOMIC_WRITE_FAILED",
        phase,
        project,
        `Failed to write JSON atomically: ${(e as Error).message} [WARNING: ATOMIC_TEMP_ORPHANED — temp file ${tmpPath} may be orphaned in the original directory because the target directory was swapped; not unlinked by path to avoid operating on the wrong directory]`,
      );
    }
    throw new GenerationStoreError(
      "ATOMIC_WRITE_FAILED",
      phase,
      project,
      `Failed to write JSON atomically: ${(e as Error).message}`,
    );
  } finally {
    if (dirFd !== null) {
      try { ops.closeSync(dirFd); } catch { /* best effort */ }
      dirFd = null;
    }
  }
}

/**
 * R169A-FIX-R3 (API-R169A-R3-01 + QUAL-R169A-R3-01): Internal
 * project-aware atomic JSON writer.
 *
 * INTERNAL — not part of the public API. The public API is
 * `writeIndexStateAtomically` (in the public module).
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 */
export function writeProjectJsonAtomicallyInternal(
  project: string,
  target: "manifest" | "index-state",
  value: unknown,
  options?: GenerationStoreOptions,
  ops?: AtomicFileOps,
  hook?: WriterTestHook,
): void {
  const phase = "writeProjectJsonAtomicallyInternal";
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();
  const opImpl = ops ?? PROD_OPS;

  if (target !== "manifest" && target !== "index-state") {
    throw new GenerationStoreError(
      "GENERATION_STORE_CONFIG_ERROR",
      phase,
      project,
      `target must be "manifest" or "index-state", got: ${JSON.stringify(target)}`,
    );
  }

  const prepared = target === "manifest"
    ? prepareGenerationManifestForWrite(value as GenerationManifestV1, project)
    : prepareIndexStateForWrite(value as IndexAttemptStateV1, project);

  const targetPath = target === "manifest"
    ? activeManifestPath(project, cacheRoot)
    : indexStatePath(project, cacheRoot);

  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const storeRoot = generationStoreRoot(cacheRoot);
  const symlinkCode: GenerationStoreErrorCode = target === "manifest"
    ? "MANIFEST_SYMLINK_REJECTED"
    : "PROJECT_STATE_SYMLINK_REJECTED";
  assertPathInsideNoSymlinks(storeRoot, targetPath, project, phase, symlinkCode);

  assertNotSymlink(targetPath, symlinkCode, project);

  ensureGenerationStoreLayoutDurableInternal(project, options, opImpl);

  if (hook?.afterLayoutBeforeOpen) {
    hook.afterLayoutBeforeOpen({
      targetPath,
      projectDir: projectStoreDir(project, cacheRoot),
      project,
    });
  }

  assertTrustedRootNoSymlinks(cacheRoot, project, phase);
  assertPathInsideNoSymlinks(storeRoot, targetPath, project, phase, symlinkCode);
  assertNotSymlink(targetPath, symlinkCode, project);

  writeJsonAtomically(targetPath, prepared.payload, project, phase, opImpl, hook);
}

/**
 * R169A-FIX-R7 (API-R169A-R7-01): Internal function with ops/hook for
 * test fault/race injection. Exported from the internal module but NOT
 * part of the public API contract. Tests import it directly.
 *
 * R169A-FIX-R8: This function is EXPORTED FROM THE INTERNAL MODULE only.
 * The public module's `writeIndexStateAtomically` façade calls it with
 * `PROD_OPS` and `undefined` hook. Tests import it from here.
 */
export function writeIndexStateAtomicallyInternal(
  project: string,
  state: IndexAttemptStateV1,
  options: GenerationStoreOptions | undefined,
  ops: AtomicFileOps,
  hook?: WriterTestHook,
): void {
  writeProjectJsonAtomicallyInternal(project, "index-state", state, options, ops, hook);
}
