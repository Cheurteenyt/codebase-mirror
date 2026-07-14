/**
 * R169B-STEP10 (B4): Shared layout I/O leaf module.
 *
 * This module provides the durable directory creation primitive used by
 * the generation store, publisher, CAS store, and GC. Extracting it
 * here avoids module cycles and ensures consistent mode/permissions/fsync
 * behavior across all callers.
 *
 * STATUS: FOUNDATION / INACTIVE
 */

import {
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from "node:fs";

/**
 * Ensure a directory exists with mode 0o700, and fsync it (and its parent
 * if newly created). This is the shared primitive for durable layout
 * creation.
 *
 * If the directory already exists, it is chmod'd to 0o700 (fixing any
 * insecure mode from a previous version) and fsync'd.
 */
export function ensureDirDurable(
  dirPath: string,
  parentDir: string | null,
): void {
  const isNew = !existsSync(dirPath);
  if (isNew) {
    try {
      mkdirSync(dirPath, { recursive: false, mode: 0o700 });
    } catch (e) {
      // Directory might have been created by another process.
      if (!existsSync(dirPath)) {
        throw new Error(`Failed to create directory "${dirPath}": ${(e as Error).message}`);
      }
    }
  }
  // Force mode 0o700 (mkdirSync mode is filtered by umask).
  try {
    chmodSync(dirPath, 0o700);
  } catch (e) {
    throw new Error(`Failed to chmod 0o700 on "${dirPath}": ${(e as Error).message}`);
  }
  // fsync the directory.
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    throw new Error(`Failed to fsync directory "${dirPath}": ${(e as Error).message}`);
  }
  // If newly created, also fsync the parent (so the new directory entry
  // is durable).
  if (isNew && parentDir) {
    let parentFd: number | null = null;
    try {
      parentFd = openSync(parentDir, "r");
      fsyncSync(parentFd);
      closeSync(parentFd);
      parentFd = null;
    } catch (e) {
      if (parentFd !== null) {
        try { closeSync(parentFd); } catch { /* best effort */ }
      }
      // Non-fatal — the directory itself is durable.
    }
  }
}
