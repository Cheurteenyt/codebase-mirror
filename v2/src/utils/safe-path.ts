// v2/src/utils/safe-path.ts
// Shared symlink-safe path resolution utility.
// R53 (Part C): introduced to de-duplicate security-sensitive realpath logic.
// R55 (Part A): actually wired up — used by vault.ts (assertPathInsideVault
// replaced by assertPathInsideRoot) and server.ts (routeBrowse via safeRealpath,
// routeIndex via safeRealpathStrict). Before R55 this file existed but was
// never imported, leaving the two call sites with their own inline copies —
// the exact duplication risk Round 8 warned about.
// R139: Unified Path Containment — nearestExistingAncestor walk.
// R140: Fail-closed hotfix — removed depth cap, no lexical fallback,
// ENOENT-only catch, path.relative for cross-platform containment.
// R141: Unify isPathInside as single source of truth (QUAL-R141-01) —
// export it so wasm-extractor.ts uses the same containment predicate.
// R141: Safe root discovery validation API (assertDiscoveryRoot) used by
// indexer.ts BEFORE clearProjectData to prevent silent graph wipe.

import { realpathSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, basename, sep, relative, isAbsolute } from 'node:path';

/**
 * R140: Check if an error is an ENOENT (file not found) error.
 * Only ENOENT should trigger the ancestor walk — other errors (EACCES,
 * ELOOP, ENOTDIR, ENAMETOOLONG, EIO) must fail-closed.
 */
function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code: string }).code === 'ENOENT';
}

/**
 * R140/R141: Check if a candidate path is inside a root path, cross-platform.
 * Uses path.relative instead of manual startsWith to handle Windows
 * separators, drives, and case sensitivity correctly.
 *
 * R141 (QUAL-R141-01): Exported as the single source of truth for path
 * containment. Previously wasm-extractor.ts had its own `isInside` with a
 * slightly different implementation (manual '..' + '/' and '..' + '\\'
 * checks vs path.sep). The two could drift — a future fix applied to one
 * might not be applied to the other, breaking "Unified Path Containment".
 * Now both call sites use this function.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * R140: Find the nearest existing ancestor of a path and resolve it.
 *
 * Walks up the path tree until it finds a component that exists on disk,
 * then resolves that ancestor with realpathSync (following symlinks).
 *
 * R140: Removed the depth cap (100). The `parent === current` check
 * already guarantees termination — the path converges to the filesystem
 * root. The cap created a fail-open bypass: after 100 iterations, the
 * function returned null, and safeRealpath fell back to lexical resolve,
 * which is vulnerable to symlink escapes. Now: no cap, no lexical fallback.
 *
 * R140: Only ENOENT errors trigger the ancestor walk. EACCES, ELOOP,
 * ENOTDIR, etc. propagate as exceptions (fail-closed).
 *
 * Throws if no existing ancestor is found (e.g., non-existent drive).
 */
function nearestExistingAncestor(absPath: string): { realAncestor: string; remainingParts: string[] } {
  const parts: string[] = [];
  let current = absPath;
  // R140: No depth cap — parent === current guarantees termination.
  while (true) {
    try {
      const real = realpathSync(current);
      return { realAncestor: real, remainingParts: parts.reverse() };
    } catch (error) {
      // R140: Only ENOENT means "path doesn't exist yet" — continue walking up.
      // All other errors (EACCES, ELOOP, ENOTDIR, ENAMETOOLONG, EIO) must throw.
      if (!isENOENT(error)) throw error;
      parts.push(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing path.
        // R140: Fail-closed — throw instead of returning null (which caused
        // the lexical fallback vulnerability).
        throw new Error(`Cannot resolve path: no existing ancestor found for "${absPath}"`);
      }
      current = parent;
    }
  }
}

/**
 * Resolve a path to its real (symlink-followed) location, with a fallback
 * for paths that don't exist yet (e.g., a file being created).
 *
 * R140: Fail-closed. If no existing ancestor is found, throws instead of
 * returning a lexical resolve. A security helper must NEVER return an
 * unresolvable path — it must reject.
 *
 * Used by routeBrowse (path may not exist yet) and assertPathInsideRoot
 * (writes to not-yet-existing files must still be containment-checked).
 */
export function safeRealpath(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch (error) {
    // R140: Only ENOENT triggers the ancestor walk. Other errors throw.
    if (!isENOENT(error)) throw error;
    // R140: Walk up to nearest existing ancestor, resolve it, reattach.
    // Throws if no ancestor exists — no lexical fallback.
    const { realAncestor, remainingParts } = nearestExistingAncestor(absPath);
    if (remainingParts.length > 0) {
      return join(realAncestor, ...remainingParts);
    }
    return realAncestor;
  }
}

/**
 * Resolve a path to its real (symlink-followed) location, throwing if the
 * path doesn't exist on disk.
 */
export function safeRealpathStrict(absPath: string): string {
  return realpathSync(absPath);
}

/**
 * Check if a relative path stays inside a root directory, following symlinks.
 * Rejects ".." traversal and backslashes.
 *
 * R140: Uses path.relative for containment check instead of manual
 * startsWith — fixes Windows separator issue (R139 used '/' which
 * doesn't match '\' on Windows).
 *
 * Returns the resolved real path.
 */
export function assertPathInsideRoot(rootPath: string, relPath: string): string {
  if (relPath.includes('..')) {
    throw new Error(`Path traversal rejected: "${relPath}" contains "..".`);
  }
  if (/[\\]/.test(relPath)) {
    throw new Error(`Path traversal rejected: "${relPath}" contains backslashes.`);
  }
  let absRoot: string;
  try {
    absRoot = realpathSync(rootPath);
  } catch {
    absRoot = resolve(rootPath);
  }
  const absPath = resolve(join(absRoot, relPath));
  const realPath = safeRealpath(absPath);
  // R140: Use path.relative for cross-platform containment check.
  if (!isPathInside(absRoot, realPath)) {
    throw new Error(
      `Path traversal rejected: "${relPath}" resolves outside the root "${absRoot}".`
    );
  }
  return realPath;
}

/**
 * R141 (DATA-R141-01): Error class for discovery root failures.
 *
 * Thrown by assertDiscoveryRoot when the root path is not a readable
 * directory. The indexer catches this BEFORE clearProjectData() to
 * prevent silent graph wipe.
 *
 * Discriminator: `error.code === 'DISCOVERY_ROOT'` — lets callers
 * distinguish discovery failures from other filesystem errors without
 * relying on message string parsing.
 */
export class DiscoveryRootError extends Error {
  readonly code = 'DISCOVERY_ROOT' as const;
  readonly rootPath: string;
  readonly reason: 'not_found' | 'not_directory' | 'not_readable';

  constructor(rootPath: string, reason: 'not_found' | 'not_directory' | 'not_readable', cause?: unknown) {
    const reasonText = {
      not_found: 'does not exist',
      not_directory: 'is not a directory',
      not_readable: 'is not readable',
    }[reason];
    super(`Discovery root "${rootPath}" ${reasonText}.`, cause !== undefined ? { cause } : undefined);
    this.name = 'DiscoveryRootError';
    this.rootPath = rootPath;
    this.reason = reason;
  }
}

/**
 * R141/R142 (DATA-R142-01): Validate a discovery root BEFORE any DB mutation.
 *
 * The full indexer previously did:
 *   1. open DB
 *   2. clearProjectData()  ← wipes the existing graph
 *   3. discoverSourceFilesWasm()  ← may return [] if root is unreachable
 *   4. publish CURRENT_EXTRACTOR_SEMANTICS_VERSION with stale=false
 *
 * This meant a network drive unmount or temporary EACCES would silently
 * destroy the valid graph and certify an empty DB as fresh.
 *
 * R141 added stat + realpath validation. R142 adds readdir validation:
 * on POSIX, a directory can be stat-able and realpath-able but NOT
 * readdir-able (mode 000 without read permission). The R141 preflight
 * accepted such a root, then `discoverSourceFilesWasm` swallowed the
 * EACCES from `readdirSync(root)` and returned `[]`, which still
 * triggered the silent graph wipe. R142 closes this by actually
 * attempting to read the root directory during preflight.
 *
 * Returns the realpath-resolved canonical root. The caller MUST use this
 * return value (not the original `rootPath`) for all downstream operations
 * (discovery, extraction, relative path computation, project stats) —
 * see PATH-R142-01.
 *
 * Throws DiscoveryRootError on any failure. The caller MUST propagate
 * the error to IndexResult.errors and persist stale=true in the DB
 * (see STATE-R142-01).
 */
export function assertDiscoveryRoot(rootPath: string): string {
  let rootStat;
  try {
    // R141: statSync (not lstatSync) follows symlinks at the root itself,
    // matching discoverSourceFilesWasm's realpathSync(rootPath) behavior.
    rootStat = statSync(rootPath);
  } catch (error) {
    if (isENOENT(error)) {
      throw new DiscoveryRootError(rootPath, 'not_found', error);
    }
    // EACCES, ELOOP, ENOTDIR, etc. → not_readable. ENOTDIR specifically
    // means a path component is a file, not a directory — but statSync
    // on a file path returns the file stat, so we'll fall through to
    // !isDirectory below. This catch handles access errors on parent dirs.
    throw new DiscoveryRootError(rootPath, 'not_readable', error);
  }

  if (!rootStat.isDirectory()) {
    throw new DiscoveryRootError(rootPath, 'not_directory');
  }

  // R141: realpathSync to detect symlinked roots and match the discovery
  // behavior. If realpath fails on a stat'd directory (race condition),
  // treat it as not_readable.
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch (error) {
    throw new DiscoveryRootError(rootPath, 'not_readable', error);
  }

  // R142 (DATA-R142-01): Actually attempt to read the directory contents.
  // On POSIX, stat + realpath can succeed even when readdir would fail
  // (mode 000, ACL deny, NFS export restrictions). Without this check,
  // the root passes preflight, then discoverSourceFilesWasm swallows
  // the EACCES from readdirSync(root) and returns [] — re-introducing
  // the silent graph wipe that R141 was supposed to close.
  //
  // We don't need the entries — we just need to prove the directory is
  // readable. readdirSync is the cheapest cross-platform way to do this
  // (opendirSync + closeSync is equivalent but more verbose).
  try {
    // R142: discard the result — we only care that the call succeeds.
    // A small allocation is acceptable; the root directory typically has
    // O(10-1000) entries.
    readdirSync(realRoot);
  } catch (error) {
    // EACCES, EIO, ENOMEM, etc. — the root exists but we can't traverse it.
    throw new DiscoveryRootError(rootPath, 'not_readable', error);
  }

  return realRoot;
}
