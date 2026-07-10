// v2/src/utils/safe-path.ts
// Shared symlink-safe path resolution utility.
// R53 (Part C): introduced to de-duplicate security-sensitive realpath logic.
// R55 (Part A): actually wired up — used by vault.ts (assertPathInsideVault
// replaced by assertPathInsideRoot) and server.ts (routeBrowse via safeRealpath,
// routeIndex via safeRealpathStrict). Before R55 this file existed but was
// never imported, leaving the two call sites with their own inline copies —
// the exact duplication risk Round 8 warned about.
// R139: Unified Path Containment — fixed the P0 vault write escape by walking
// up to the nearest existing ancestor instead of falling back to lexical
// resolve. This prevents symlink-based escapes when multiple path segments
// don't exist yet.

import { realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';

/**
 * R139: Find the nearest existing ancestor of a path and resolve it.
 *
 * Walks up the path tree until it finds a component that exists on disk,
 * then resolves that ancestor with realpathSync (following symlinks).
 * Returns `{ realAncestor, remainingParts }` where `remainingParts` are the
 * non-existent path segments to append to `realAncestor`.
 *
 * This replaces the old 2-level fallback (path → parent → lexical resolve)
 * which was vulnerable to symlink escapes when multiple descendants don't
 * exist. Now, a symlink anywhere in the existing ancestor chain is resolved
 * and checked for containment.
 *
 * Returns `{ realAncestor: null, remainingParts: [] }` if no ancestor exists
 * (e.g., the path is on a non-existent drive on Windows).
 */
function nearestExistingAncestor(absPath: string): { realAncestor: string | null; remainingParts: string[] } {
  const parts: string[] = [];
  let current = absPath;
  for (let i = 0; i < 100; i++) { // depth cap to prevent infinite loops
    try {
      const real = realpathSync(current);
      return { realAncestor: real, remainingParts: parts.reverse() };
    } catch {
      parts.push(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing path
        return { realAncestor: null, remainingParts: [] };
      }
      current = parent;
    }
  }
  return { realAncestor: null, remainingParts: [] };
}

/**
 * Resolve a path to its real (symlink-followed) location, with a fallback
 * for paths that don't exist yet (e.g., a file being created).
 *
 * R139: Replaced the old 3-level fallback (path → parent → lexical) with
 * nearestExistingAncestor walk. This closes the P0 vault write escape where
 * a symlink ancestor could redirect writes outside the vault when multiple
 * descendants don't exist.
 *
 * Used by routeBrowse (path may not exist yet) and assertPathInsideRoot
 * (writes to not-yet-existing files must still be containment-checked).
 */
export function safeRealpath(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    // R139: walk up to nearest existing ancestor, resolve it, reattach
    const { realAncestor, remainingParts } = nearestExistingAncestor(absPath);
    if (realAncestor !== null && remainingParts.length > 0) {
      return join(realAncestor, ...remainingParts);
    }
    if (realAncestor !== null) {
      return realAncestor;
    }
    // No ancestor exists at all — return lexical resolve (root filesystem itself)
    return resolve(absPath);
  }
}

/**
 * Resolve a path to its real (symlink-followed) location, throwing if the
 * path doesn't exist on disk. Use this when the caller needs to verify
 * the path exists AND get its real location in one step.
 *
 * Used by routeIndex which must 404 on a non-existent root_path before
 * attempting to spawn an indexing job.
 */
export function safeRealpathStrict(absPath: string): string {
  // realpathSync throws ENOENT (or EACCES, ELOOP, etc.) if the path doesn't
  // exist or is inaccessible. The caller is expected to catch and map to
  // the appropriate HTTP status.
  return realpathSync(absPath);
}

/**
 * Check if a relative path stays inside a root directory, following symlinks.
 * Rejects ".." traversal and backslashes (defensive — path.join would
 * normalise them, but failing early gives clearer error messages).
 *
 * Used by vault.ts's readNote/writeNote/deleteNote (formerly
 * assertPathInsideVault) to prevent symlinks inside the vault from escaping
 * to arbitrary filesystem locations.
 *
 * Returns the resolved real path so the caller can use it for subsequent
 * operations on the actual on-disk target rather than the possibly-symlinked
 * input path.
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
  if (realPath !== absRoot && !realPath.startsWith(absRoot + sep)) {
    throw new Error(
      `Path traversal rejected: "${relPath}" resolves outside the root "${absRoot}".`
    );
  }
  return realPath;
}
