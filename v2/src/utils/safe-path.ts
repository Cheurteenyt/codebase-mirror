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

import { realpathSync } from 'node:fs';
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
 * R140: Check if a candidate path is inside a root path, cross-platform.
 * Uses path.relative instead of manual startsWith to handle Windows
 * separators, drives, and case sensitivity correctly.
 */
function isPathInside(root: string, candidate: string): boolean {
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
