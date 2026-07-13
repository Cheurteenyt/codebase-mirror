/**
 * R169B-STEP3 — Publisher ops harness (fault injection).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * (GPT 5.6 Pass 1 audit, §5 — "Architecture de testabilité requise")
 *
 * This module owns the `PublisherOps` interface implementation that
 * wraps every external side-effect the publisher performs. The
 * publisher was previously calling `linkSync`, `unlinkSync`,
 * `fsyncSync`, `openSync`, `lstatSync`, `existsSync`, and
 * `new Database()` directly, which made precise fault injection
 * (crash at exact point, fsync failure, link EEXIST, mid-read
 * corruption) impossible.
 *
 * Public API:
 *   - `PROD_PUBLISHER_OPS` — the production ops, used by
 *     `publishPreparedGeneration` and `prepareGenerationForPublication`.
 *
 * Internal API (exported but NOT re-exported from the public facade):
 *   - `createFaultablePublisherOps(config)` — wraps PROD_PUBLISHER_OPS
 *     and injects failures at configurable points. Used by the crash
 *     matrix and fault injection tests in
 *     `tests/storage/r169b-publication-crash.test.ts` and
 *     `tests/storage/r169b-publication-concurrency.test.ts`.
 *
 * DEPENDENCY DIRECTION (R169B-STEP3):
 *   types -> paths/validation -> internal I/O + CAS + publisher ops -> facades
 *
 *   - This module imports types from `../generation-types.js`.
 *   - This module imports `better-sqlite3`, `node:fs`, `node:crypto`.
 *   - The publisher module (`../generation-publisher.js`) imports
 *     `PROD_PUBLISHER_OPS` and `createFaultablePublisherOps` from
 *     this module.
 *   - This module does NOT import from the publisher or GC — it is a
 *     leaf internal module.
 */

import {
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  fstatSync,
  unlinkSync,
  linkSync,
  existsSync,
  readSync,
  constants as fsConstants,
} from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import type { PublisherOps } from "../generation-types.js";

// ─── PROD_PUBLISHER_OPS ──────────────────────────────────────────────────

/**
 * R169B-STEP3: The production PublisherOps. Wraps `node:fs` and
 * `better-sqlite3` directly. The publisher uses this by default.
 */
export const PROD_PUBLISHER_OPS: PublisherOps = {
  openSync(path: string, flags: number, mode?: number): number {
    if (mode !== undefined) {
      return openSync(path, flags, mode);
    }
    return openSync(path, flags);
  },
  fstatSync(fd: number) {
    // node:fs.fstatSync is imported lazily to avoid pulling it into
    // the type-only surface. The publisher only uses fstatSync on
    // fds it opened.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return fstatSync(fd);
  },
  readSync(fd, buffer, offset, length, position) {
    return readSync(fd, buffer, offset, length, position);
  },
  fsyncSync(fd) {
    fsyncSync(fd);
  },
  closeSync(fd) {
    closeSync(fd);
  },
  linkSync(src, dst) {
    linkSync(src, dst);
  },
  unlinkSync(path) {
    unlinkSync(path);
  },
  lstatSync(path) {
    return lstatSync(path);
  },
  existsSync(path) {
    return existsSync(path);
  },
  openDatabase(path, options) {
    return new Database(path, options) as DatabaseType;
  },
  now() {
    return new Date().toISOString();
  },
  randomUUID() {
    return randomUUID();
  },
};

// Re-export the O_NOFOLLOW / O_RDONLY / O_CREAT / O_EXCL / O_WRONLY
// constants the publisher needs. They live in node:fs and are
// platform-safe (Linux exposes all of them; the publisher is
// Linux-only per the audit contract).
export const PUB_O_NOFOLLOW: number = fsConstants.O_NOFOLLOW;
export const PUB_O_RDONLY: number = fsConstants.O_RDONLY;
export const PUB_O_CREAT: number = fsConstants.O_CREAT;
export const PUB_O_EXCL: number = fsConstants.O_EXCL;
export const PUB_O_WRONLY: number = fsConstants.O_WRONLY;

// ─── Fault-injection ops ─────────────────────────────────────────────────

/**
 * R169B-STEP3: Configuration for `createFaultablePublisherOps`.
 *
 * Each `fail*` field is a predicate that, given the call arguments,
 * decides whether to inject a failure (throw) at that point. The
 * fault is a string the test uses to identify which injection fired.
 *
 * The fault is raised as a plain `Error` (NOT a `GenerationStoreError`)
 * so the publisher's catch-all wraps it into a structured error. This
 * models real I/O failures (EIO, EDQUOT, ENOSPC) that the publisher
 * must handle.
 */
export interface FaultablePublisherOpsConfig {
  /**
   * If set, called before every `linkSync(src, dst)`. If it returns
   * a string, the link throws an `Error` with that message.
   */
  readonly failLink?: (src: string, dst: string) => string | null;
  /**
   * If set, called before every `unlinkSync(path)`. If it returns a
   * string, the unlink throws an `Error` with that message.
   */
  readonly failUnlink?: (path: string) => string | null;
  /**
   * If set, called before every `fsyncSync(fd)`. If it returns a
   * string, the fsync throws an `Error` with that message.
   */
  readonly failFsync?: (fd: number) => string | null;
  /**
   * If set, called before every `openSync(...)`. If it returns a
   * string, the open throws an `Error` with that message.
   */
  readonly failOpen?: (path: string, flags: number, mode?: number) => string | null;
  /**
   * If set, called before every `lstatSync(path)`. If it returns a
   * string, the lstat throws an `Error` with that message.
   */
  readonly failLstat?: (path: string) => string | null;
  /**
   * If set, called before every `openDatabase(...)`. If it returns
   * a string, the open throws an `Error` with that message.
   */
  readonly failOpenDatabase?: (path: string, options: { readonly?: boolean; fileMustExist?: boolean }) => string | null;
}

/**
 * R169B-STEP3: Wrap PROD_PUBLISHER_OPS with fault injection. Used by
 * crash matrix and fault injection tests.
 *
 * The returned ops object has the SAME type as `PublisherOps` so the
 * publisher can consume it without any code change.
 */
export function createFaultablePublisherOps(
  config: FaultablePublisherOpsConfig,
): PublisherOps {
  const failLink = config.failLink ?? (() => null);
  const failUnlink = config.failUnlink ?? (() => null);
  const failFsync = config.failFsync ?? (() => null);
  const failOpen = config.failOpen ?? (() => null);
  const failLstat = config.failLstat ?? (() => null);
  const failOpenDatabase = config.failOpenDatabase ?? (() => null);

  return {
    openSync(path: string, flags: number, mode?: number): number {
      const f = failOpen(path, flags, mode);
      if (f !== null) throw new Error(`[injected] openSync: ${f}`);
      if (mode !== undefined) return openSync(path, flags, mode);
      return openSync(path, flags);
    },
    fstatSync(fd: number) {
      // fstat is not currently fault-injected; if needed, add a
      // failFstat predicate.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return fstatSync(fd);
    },
    readSync(fd, buffer, offset, length, position) {
      return readSync(fd, buffer, offset, length, position);
    },
    fsyncSync(fd) {
      const f = failFsync(fd);
      if (f !== null) throw new Error(`[injected] fsyncSync: ${f}`);
      fsyncSync(fd);
    },
    closeSync(fd) {
      closeSync(fd);
    },
    linkSync(src, dst) {
      const f = failLink(src, dst);
      if (f !== null) throw new Error(`[injected] linkSync: ${f}`);
      linkSync(src, dst);
    },
    unlinkSync(path) {
      const f = failUnlink(path);
      if (f !== null) throw new Error(`[injected] unlinkSync: ${f}`);
      unlinkSync(path);
    },
    lstatSync(path) {
      const f = failLstat(path);
      if (f !== null) throw new Error(`[injected] lstatSync: ${f}`);
      return lstatSync(path);
    },
    existsSync(path) {
      return existsSync(path);
    },
    openDatabase(path, options) {
      const f = failOpenDatabase(path, options);
      if (f !== null) throw new Error(`[injected] openDatabase: ${f}`);
      return new Database(path, options) as DatabaseType;
    },
    now() {
      return new Date().toISOString();
    },
    randomUUID() {
      return randomUUID();
    },
  };
}
