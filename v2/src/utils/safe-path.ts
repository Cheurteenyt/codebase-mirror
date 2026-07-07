// v2/src/utils/safe-path.ts
// Shared symlink-safe path resolution utility.
// R53 (Part C): introduced to de-duplicate security-sensitive realpath logic.
// R55 (Part A): actually wired up — used by vault.ts (assertPathInsideVault
// replaced by assertPathInsideRoot) and server.ts (routeBrowse via safeRealpath,
// routeIndex via safeRealpathStrict). Before R55 this file existed but was
// never imported, leaving the two call sites with their own inline copies —
// the exact duplication risk Round 8 warned about.

import { realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';

/**
 * Resolve a path to its real (symlink-followed) location, with a fallback
 * for paths that don't exist yet (e.g., a file being created).
 *
 * Used by routeBrowse (path may not exist yet — the handler returns 404
 * later via existsSync, not here) and assertPathInsideRoot (writes to
 * not-yet-existing files must still be containment-checked).
 */
export function safeRealpath(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    try {
      const realParent = realpathSync(dirname(absPath));
      return join(realParent, basename(absPath));
    } catch {
      return resolve(absPath);
    }
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
