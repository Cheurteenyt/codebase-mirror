import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInside } from '../utils/safe-path.js';

/** Canonicalize an explicit allowlist and ignore roots that no longer exist. */
export function canonicalAllowedRoots(roots: string[]): string[] {
  const canonical = new Set<string>();
  for (const root of roots) {
    try { canonical.add(realpathSync(resolve(root))); }
    catch { /* unavailable roots grant no access */ }
  }
  return [...canonical];
}

export function isAllowedFilesystemPath(target: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => isPathInside(root, target));
}
