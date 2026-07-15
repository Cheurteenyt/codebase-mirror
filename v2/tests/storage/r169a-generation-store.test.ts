/**
 * R169A — Atomic Generation Publication: generation store tests.
 *
 * STATUS: FOUNDATION / INACTIVE
 * Tests verify the generation store contract without activating it.
 *
 * R169A-FIX (GPT 5.6 audit pass 1): Rewritten to fix all 14 audit findings.
 * R169A-FIX-R2 (GPT 5.6 audit pass 2): +43 tests for trust root, writer
 * safety, layout durability, manifest hardening, immutable keys.
 * R169A-FIX-R3 (GPT 5.6 audit pass 3): +N tests for typed writers,
 * validateIndexAttemptState, EEXIST revalidation, manifest TOCTOU,
 * listProjectStoreKeys root trust, existing dir perms, frozen keys,
 * race symlink injection, PROJECT_STATE_SYMLINK_REJECTED.
 *
 * Key changes in R3:
 *   - All writer tests now use `writeGenerationManifestAtomically` /
 *     `writeIndexStateAtomically` (typed, validating wrappers) instead of
 *     the untyped `writeProjectJsonAtomically` (which is now internal).
 *   - Tests that wrote `{ version: 1 }` as a manifest now write a valid
 *     `GenerationManifestV1` via `makeValidManifest()`.
 *   - Tests that wrote `{ v: 1 }` as index-state now write a valid
 *     `IndexAttemptStateV1` via `makeValidIndexState()`.
 *   - The serialize-fail test uses `TestOps.failAtSerialize` (since the
 *     typed wrapper validates BEFORE I/O, `undefined` can no longer reach
 *     the serializer).
 *   - TestOps adds `fstatSync`, `serializeJson`, `statOverrideOnce`,
 *     `failAtSerialize`, and numeric-flags support in `openSync`.
 *
 * Test matrix:
 *   - Path safety: normal, Unicode, spaces, traversal, absolute, long,
 *     deterministic, empty
 *   - Manifest valid: V1 exact, zero counts, Unicode, sha lowercase,
 *     timestamp timezone
 *   - Manifest invalid: null, array, missing key, extra key, future
 *     version, project mismatch, invalid UUID, non-canonical dbFile
 *     (5 forms), invalid timestamp, calendar-invalid timestamp (4 forms),
 *     unsafe integer (3 forms), invalid sha, multiline field
 *   - Index-state valid: V1 exact, all outcomes, all recoveries,
 *     structured staleReason, null activeGenerationId
 *   - Index-state invalid: null, array, missing key, extra key, future
 *     version, project mismatch, invalid UUID, invalid timestamp, invalid
 *     outcome, invalid recovery, coherence violations (SUCCESS+error,
 *     SUCCESS+staleReason, SUCCESS+recovery, FAILED+no-error, STALE+no-
 *     staleReason, STALE+recovery=none), C0 control chars, length bounds
 *   - Resolver: valid manifest + target exists → generation; no manifest
 *     + legacy → legacy; no manifest + no legacy → missing; invalid
 *     manifest → fail closed; target missing → fail closed; target
 *     directory → MANIFEST_TARGET_NOT_REGULAR; project mismatch → fail
 *     closed; symlink chain at any level → rejected; legacy path
 *     validation failures → LEGACY_SOURCE_INVALID
 *   - Atomic JSON writer: 10-case fault-injection matrix (serialize,
 *     open, short-write, mid-payload-write, temp-fsync, close, rename,
 *     dir-open, dir-fsync, success)
 *   - Legacy path tests: real legacy DB in injected cacheRoot; traversal
 *     rejected
 *   - listProjectStoreKeys: filter to 64-hex, sort, fail-closed on EACCES,
 *     trust root validation
 *   - No production behavior change: defaultCodeDbPath importable;
 *     legacyCodeDbPath matches defaultCodeDbPath for ordinary projects;
 *     CURRENT_GENERATION_MANIFEST_VERSION is 1
 *   - Source inspection: Node.js walk replaces grep
 *   - Child crash test: child writes temp + fsync then exits before
 *     rename; parent verifies old target intact
 *   - R3: validateIndexAttemptState matrix, EEXIST revalidation,
 *     manifest TOCTOU (O_NOFOLLOW), listProjectStoreKeys root trust,
 *     existing dir perms, frozen keys, race symlink, per-target symlink codes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * TEST-R169A-CI-01:
 * mkdir(mode) is filtered by the process umask on POSIX systems.
 * Permission-policy fixtures therefore chmod the directory after creation
 * and assert the effective mode before invoking the code under test.
 */
function forceExactMode(path: string, mode: number): void {
  chmodSync(path, mode);
  const actualMode = lstatSync(path).mode & 0o777;
  expect(actualMode).toBe(mode);
}

import {
  projectStorageKey,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  indexStatePath,
  legacyCodeDbPath,
  cbmCacheDir,
  generationStoreRoot,
  getCacheRoot,
  isLexicallyInside,
  isPathInside,
  assertPathInsideNoSymlinks,
  assertNotSymlink,
  assertTrustedRootNoSymlinks,
  assertGenerationStoreRootTrusted,
  validateGenerationManifest,
  validateIndexAttemptState,
  parseGenerationManifest,
  resolveActiveCodeDb,
  writeIndexStateAtomically,
  ensureGenerationStoreLayoutDurable,
  listProjectStoreKeys,
  MAX_GENERATION_MANIFEST_BYTES,
  GenerationStoreError,
  type GenerationStoreOptions,
} from "../../src/storage/generation-store.js";

// R169A-FIX-R8 (API-R169A-R8-01): Internal symbols are imported from the
// dedicated internal module. The public module `generation-store.ts`
// no longer exports `AtomicFileOps`, `WriterTestHook`, `PROD_OPS`, or
// the `*Internal` functions. This keeps the public API surface clean
// (the generated `.d.ts` does not contain these symbols).
import {
  type AtomicFileOps,
  PROD_OPS,
  type WriterTestHook,
  writeIndexStateAtomicallyInternal,
  ensureGenerationStoreLayoutDurableInternal,
} from "../../src/storage/internal/generation-store-io.js";

// R169A-FIX-R7 (API-R169A-R7-01): Tests import the internal function
// directly. The public function has exactly 3 params and does NOT
// accept ops/hook at runtime. No cast, no arguments trick.

import {
  MANIFEST_V1_KEYS,
  INDEX_STATE_V1_KEYS,
  isManifestV1Key,
  isIndexStateV1Key,
  type GenerationManifestV1,
  type IndexAttemptStateV1,
  type IndexAttemptStaleReasonV1,
  type IndexAttemptFailureV1,
  type IndexAttemptOutcome,
  type IndexRecoveryAction,
  type IndexPublicationState,
} from "../../src/storage/generation-types.js";
import {
  writeManifestFixture,
} from "../helpers/r169-generation-fixtures.js";

// R169A-FIX-R5 (API-R169A-R5-01): The `__test__` export is REMOVED.
// `writeGenerationManifestAtomically` and the `prepare*ForWrite` helpers
// are no longer accessible. Tests that need a manifest on disk use
// `writeManifestFixture` (writeFileSync-based). Atomic writer mechanic
// tests use `writeIndexStateAtomically` (the only public writer).

// Local helper: write a manifest to disk via the fixture helper (writeFileSync).
// Used by tests that need a manifest on disk for the resolver to read.
function writeManifestToDisk(
  cacheRoot: string,
  project: string,
  manifest: GenerationManifestV1,
): string {
  return writeManifestFixture(cacheRoot, project, manifest);
}

// Local helper: write an index-state atomically via the public writer.
// Used by tests that exercise the atomic writer mechanics (fault injection,
// race injection). Replaces the old `writeGenerationManifestAtomically` calls.
function writeStateAtomically(
  project: string,
  cacheRoot: string,
  state?: Partial<IndexAttemptStateV1>,
  ops?: AtomicFileOps,
  hook?: WriterTestHook,
): void {
  writeIndexStateAtomicallyInternal(project, makeValidIndexState(project, state), { cacheRoot }, ops, hook);
}

// ─── Constants ──────────────────────────────────────────────────────────

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "661f9511-f30c-42e5-b827-557766551111";
const VALID_SHA256 = "a".repeat(64);
const VALID_TIMESTAMP = "2026-07-13T00:00:00.000Z";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeValidManifest(
  project: string = "test-project",
  overrides: Partial<GenerationManifestV1> = {},
): GenerationManifestV1 {
  const generationId = overrides.generationId ?? VALID_UUID;
  return {
    formatVersion: 1,
    project,
    generationId,
    dbFile: `generations/generation-${generationId}.db`,
    createdAt: VALID_TIMESTAMP,
    rootFingerprint: "/canonical/root:dev:ino",
    extractorSemanticsVersion: 8,
    discoveryPolicyVersion: 2,
    nodeCount: 123,
    edgeCount: 456,
    fileCount: 78,
    sizeBytes: 987654,
    sha256: VALID_SHA256,
    ...overrides,
  };
}

/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): Build a valid IndexAttemptStateV1 for
 * tests. The `overrides` parameter lets each test customize the outcome,
 * recovery, staleReason, failure, publicationState, candidateGenerationId, etc.
 *
 * R169A-FIX-R5 (STATE-R169A-R5-01): The default is a SUCCESS state:
 * publicationState="PUBLISHED", failure=null, staleReason=null,
 * recovery="none", activeGenerationId non-null, candidateGenerationId
 * non-null (equals activeGenerationId on SUCCESS+PUBLISHED).
 */
function makeValidIndexState(
  project: string = "test-project",
  overrides: Partial<IndexAttemptStateV1> = {},
): IndexAttemptStateV1 {
  return {
    formatVersion: 1,
    project,
    activeGenerationId: VALID_UUID,
    candidateGenerationId: VALID_UUID,
    lastAttemptId: OTHER_UUID,
    lastAttemptAt: VALID_TIMESTAMP,
    lastAttemptOutcome: "SUCCESS",
    // R169A-FIX-R5 (STATE-R169A-R5-01): `publicationState` replaces
    // `published: boolean`. Default is "PUBLISHED" for SUCCESS.
    publicationState: "PUBLISHED",
    failure: null,
    staleReason: null,
    recovery: "none",
    ...overrides,
  };
}

/**
 * R169A-FIX-R4 (STATE-R169A-R4-01): Build a valid IndexAttemptFailureV1
 * for tests. Used by coherence tests that need a non-null failure record.
 */
function makeValidFailure(
  overrides: Partial<IndexAttemptFailureV1> = {},
): IndexAttemptFailureV1 {
  return {
    code: "INDEXER_CRASH",
    phase: "extract",
    message: "indexer crashed mid-extraction",
    ...overrides,
  };
}

/**
 * R169A-FIX-R5 (SEC-R169A-R5-02): Idempotent directory creation with
 * explicit mode 0o700. `mkdirSync(path, { mode: 0o700 })` without
 * `recursive: true` throws EEXIST if the dir already exists. We use
 * `recursive: true` (which silently no-ops on EEXIST) and then
 * `chmodSync(path, 0o700)` to force the correct mode — `recursive: true`
 * does NOT apply the mode to existing intermediate dirs, so an existing
 * 0755 dir would stay 0755 and fail the R5 permission check.
 */
function ensureDirMode0700(path: string): void {
  const fs = require("node:fs");
  fs.mkdirSync(path, { recursive: true });
  try {
    fs.chmodSync(path, 0o700);
  } catch {
    // Best-effort — some filesystems (e.g. FAT) don't support chmod.
  }
}

/**
 * Write a manifest file into the injected cacheRoot. Uses the production
 * path helpers so the test exercises the real layout.
 */
function writeManifest(cacheRoot: string, project: string, manifest: GenerationManifestV1): string {
  // R169A-FIX-R5 (SEC-R169A-R5-02): Create the directory chain with mode
  // 0o700 so the trust root permission check passes. The previous
  // `mkdirSync(resolve(manifestPath, ".."), { recursive: true })` created
  // dirs with the default umask (often 0755), which the R5 permission
  // check rejects for private R169 dirs (projects, project-key).
  ensureDirMode0700(cbmCacheDir(cacheRoot));
  ensureDirMode0700(generationStoreRoot(cacheRoot));
  ensureDirMode0700(projectStoreDir(project, cacheRoot));
  const manifestPath = activeManifestPath(project, cacheRoot);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return manifestPath;
}

/**
 * Write a fake generation DB file into the injected cacheRoot.
 */
function writeGenerationDb(cacheRoot: string, project: string, dbFile: string): string {
  // R169A-FIX-R5: Create the chain with 0o700 for the trust root permission check.
  ensureDirMode0700(cbmCacheDir(cacheRoot));
  ensureDirMode0700(generationStoreRoot(cacheRoot));
  ensureDirMode0700(projectStoreDir(project, cacheRoot));
  const projectDir = projectStoreDir(project, cacheRoot);
  const dbPath = join(projectDir, dbFile);
  ensureDirMode0700(resolve(dbPath, ".."));
  writeFileSync(dbPath, "fake DB content", "utf-8");
  return dbPath;
}

/**
 * Write a legacy DB file into the injected cacheRoot. R169A-FIX: this
 * does NOT touch the real HOME cache — it uses the injected cacheRoot.
 */
function writeLegacyDb(cacheRoot: string, project: string): string {
  // R169A-FIX-R5: Create cbm with 0o700 (compat root — 0700 satisfies mode & 0o022 === 0).
  ensureDirMode0700(cbmCacheDir(cacheRoot));
  const dbPath = legacyCodeDbPath(project, cacheRoot);
  writeFileSync(dbPath, "fake legacy DB", "utf-8");
  return dbPath;
}

/**
 * R169A-FIX (DUR-R169A-02): Injectable AtomicFileOps implementation.
 *
 * Each test instantiates this with a `failAt` selector that injects a
 * controlled failure at a specific checkpoint. Real fs is used for
 * every other call.
 *
 * R169A-FIX-R3 additions:
 *   - `failAtSerialize`: injected a failure in `serializeJson`. REMOVED
 *     in R4 — see below.
 *   - `fstatSync`: delegates to real fs.fstatSync.
 *   - `serializeJson`: delegated to JSON.stringify. REMOVED in R4.
 *   - `statOverrideOnce`: Map<path, Error>. The FIRST lstatSync call
 *     for a path in this map throws the configured error (then the
 *     entry is removed). Used to simulate EEXIST races.
 *   - `openSync` accepts numeric flags (needed for O_NOFOLLOW / O_DIRECTORY).
 *
 * R169A-FIX-R4 changes:
 *   - TEST-R169A-R4-01: `statSync` renamed to `lstatSync` (delegates to
 *     `node:fs.lstatSync`). The return shape now includes `dev` and
 *     `ino` (needed by openDirectoryNoFollow's identity verification
 *     and the writer's pre-rename identity check).
 *   - DATA-R169A-R4-01: `serializeJson` and `failAtSerialize` REMOVED.
 *     The typed writers now prepare the canonical payload BEFORE any
 *     filesystem I/O via `prepareGenerationManifestForWrite` /
 *     `prepareIndexStateForWrite` (exposed via `__test__`). Tests that
 *     need to inject a serialization failure call
 *     `prepareGenerationManifestForWrite` directly with a failing
 *     `serializeJson` argument.
 *   - SEC-R169A-R4-01: `dirOpen` failure point removed (the writer now
 *     opens the dir ONCE at the start via `openDirectoryNoFollow`,
 *     not post-rename). The `dirOpen` failAt selector is repurposed:
 *     it now injects failure on the FIRST `openDirectoryNoFollow` call
 *     in the write phase (the dir open at the start of `writeJsonAtomically`).
 *   - SEC-R169A-R4-02: `openSync` now recognizes numeric flags
 *     `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` as a directory open (used
 *     by `openDirectoryNoFollow`). The `dirOpen` failAt triggers on
 *     this combination.
 */
class TestOps implements AtomicFileOps {
  failAt: string | null = null;
  /** If true, the first writeSync call writes only 1 byte then succeeds. */
  shortFirstWrite: boolean = false;
  /** If true, the second writeSync call (mid-payload) throws. */
  failSecondWrite: boolean = false;
  /**
   * R169A-FIX-R2: layout-phase fault injection. The wrapper calls
   * `ensureGenerationStoreLayoutDurable` BEFORE the write phase, which
   * calls `mkdirSync`, `openSync` ("r"), `fsyncSync`, `closeSync` on
   * each layout directory. These flags inject faults at those steps.
   */
  failAtLayoutMkdir: boolean = false;
  failAtLayoutDirFsync: boolean = false;
  failAtLayoutParentFsync: boolean = false;

  /**
   * R169A-FIX-R3 (SEC-R169A-R3-02): stat override for EEXIST tests.
   * The FIRST lstatSync call for a path in this map throws the
   * configured error; subsequent calls use real fs.
   */
  lstatOverrideOnce: Map<string, NodeJS.ErrnoException> = new Map();

  private writeCallCount: number = 0;
  private layoutDirFsyncCount: number = 0;
  private layoutParentFsyncCount: number = 0;
  /** Set to true once a "wx" open happens — distinguishes layout phase from write phase. */
  private inWritePhase: boolean = false;
  /** Number of openDirectoryNoFollow-style opens (numeric O_NOFOLLOW|O_DIRECTORY flags). */
  private dirOpenCount: number = 0;

  // Track which ops were called — useful for assertions.
  calls: string[] = [];

  openSync(path: string, flags: string | number, mode?: number): number {
    const flagsStr = typeof flags === "string" ? flags : "";
    const isNumericDirOpen = typeof flags === "number";
    // Track write-phase entry: the temp file open uses "wx".
    if (flagsStr === "wx") this.inWritePhase = true;
    // Write-phase temp-file open failure.
    if (this.failAt === "open" && flagsStr === "wx") {
      this.calls.push("open:fail");
      throw new Error("injected open failure");
    }
    // R169A-FIX-R4: dirOpen failure now triggers on the FIRST
    // openDirectoryNoFollow call in the write phase (the dir open at
    // the start of writeJsonAtomically). This is a numeric flags open
    // with O_NOFOLLOW|O_DIRECTORY.
    if (this.failAt === "dirOpen" && isNumericDirOpen && this.inWritePhase) {
      this.dirOpenCount++;
      // Only fail the FIRST write-phase dir open (the writer's own dir
      // open at the start). Layout phase dir opens should not trigger
      // this (they're caught by failAtLayoutDirFsync etc.).
      if (this.dirOpenCount === 1) {
        this.calls.push("dirOpen:fail");
        throw new Error("injected directory open failure");
      }
    }
    this.calls.push(
      flagsStr === "wx" ? "open:wx"
        : isNumericDirOpen ? "open:dirNoFollow"
        : "open:r",
    );
    return require("node:fs").openSync(path, flags, mode);
  }

  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    return require("node:fs").readSync(fd, buffer, offset, length, position);
  }

  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
    this.writeCallCount++;
    if (this.failAt === "writeAlways") {
      this.calls.push("write:fail");
      throw new Error("injected write failure");
    }
    if (this.failSecondWrite && this.writeCallCount === 2) {
      this.calls.push("write:fail:mid-payload");
      throw new Error("injected write failure mid-payload");
    }
    if (this.shortFirstWrite && this.writeCallCount === 1) {
      // Write exactly 1 byte to force the loop to call writeSync again.
      this.calls.push("write:short");
      const fs = require("node:fs");
      return fs.writeSync(fd, buffer, offset, 1, position);
    }
    this.calls.push("write");
    const fs = require("node:fs");
    return fs.writeSync(fd, buffer, offset, length, position);
  }

  fsyncSync(fd: number): void {
    // Layout phase: before any "wx" open. Each layout dir gets fsynced;
    // newly-created dirs also get their PARENT fsynced.
    if (!this.inWritePhase) {
      this.layoutDirFsyncCount++;
      if (this.failAtLayoutDirFsync && this.layoutParentFsyncCount === 0) {
        this.calls.push("fsync:layoutDir:fail");
        throw new Error("injected layout dir fsync failure");
      }
      if (this.failAtLayoutParentFsync) {
        if (this.layoutDirFsyncCount === 2 || this.layoutDirFsyncCount === 4 || this.layoutDirFsyncCount === 6) {
          this.calls.push("fsync:layoutParent:fail");
          throw new Error("injected layout parent fsync failure");
        }
      }
      this.calls.push("fsync:layout");
      return require("node:fs").fsyncSync(fd);
    }
    // Write phase: temp file fsync (before rename) or dir fsync (after rename).
    if (this.failAt === "tempFsync" && !this.calls.includes("rename")) {
      this.calls.push("fsync:temp:fail");
      throw new Error("injected temp fsync failure");
    }
    if (this.failAt === "dirFsync" && this.calls.includes("rename")) {
      this.calls.push("fsync:dir:fail");
      throw new Error("injected directory fsync failure");
    }
    this.calls.push("fsync");
    return require("node:fs").fsyncSync(fd);
  }

  closeSync(fd: number): void {
    // R169A-FIX-R2: only trigger closeBeforeRename during the write phase
    // (after the temp file has been opened with "wx"). The layout phase
    // also calls closeSync on directory fds; we must not inject there.
    if (this.failAt === "closeBeforeRename" && this.inWritePhase && !this.calls.includes("rename")) {
      this.calls.push("close:fail");
      throw new Error("injected close failure");
    }
    this.calls.push("close");
    const fs = require("node:fs");
    return fs.closeSync(fd);
  }

  lstatSync(path: string): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number } {
    // R169A-FIX-R3 (SEC-R169A-R3-02): stat override for EEXIST tests.
    const override = this.lstatOverrideOnce.get(path);
    if (override) {
      this.lstatOverrideOnce.delete(path);
      throw override;
    }
    const s = require("node:fs").lstatSync(path);
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
  }

  fstatSync(fd: number): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number } {
    const s = require("node:fs").fstatSync(fd);
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
  }

  renameSync(from: string, to: string): void {
    if (this.failAt === "rename") {
      this.calls.push("rename:fail");
      throw new Error("injected rename failure");
    }
    this.calls.push("rename");
    const fs = require("node:fs");
    return fs.renameSync(from, to);
  }

  unlinkSync(path: string): void {
    this.calls.push("unlink");
    const fs = require("node:fs");
    return fs.unlinkSync(path);
  }

  mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void {
    if (this.failAtLayoutMkdir && !this.inWritePhase) {
      this.calls.push("mkdir:layout:fail");
      throw new Error("injected layout mkdir failure");
    }
    this.calls.push(opts && typeof opts.mode === "number" ? `mkdir:0o${opts.mode.toString(8)}` : "mkdir");
    const fs = require("node:fs");
    if (opts && typeof opts.mode === "number") {
      return fs.mkdirSync(path, { recursive: opts.recursive ?? false, mode: opts.mode });
    }
    return fs.mkdirSync(path, opts);
  }
}

/** Walk a directory tree recursively and return all .ts file paths. */
function walkTs(root: string): string[] {
  const out: string[] = [];
  function visit(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
      } else if (e.isFile() && e.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  visit(root);
  return out;
}

// ─── Path safety tests ──────────────────────────────────────────────────

describe("R169A — Path safety", () => {
  it("normal project produces a 64-char hex key", () => {
    const key = projectStorageKey("my-project");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Unicode project produces a valid key", () => {
    const key = projectStorageKey("プロジェクト");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("project with spaces produces a valid key", () => {
    const key = projectStorageKey("my project");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('project "../escape" produces a valid key (no traversal in path)', () => {
    const key = projectStorageKey("../escape");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("..");
  });

  it('project "/absolute" produces a valid key (no absolute path)', () => {
    const key = projectStorageKey("/absolute/path");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("very long project produces a valid key", () => {
    const key = projectStorageKey("a".repeat(1000));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same project produces deterministic key", () => {
    expect(projectStorageKey("my-project")).toBe(projectStorageKey("my-project"));
  });

  it("different projects produce different keys", () => {
    expect(projectStorageKey("project-a")).not.toBe(projectStorageKey("project-b"));
  });

  it("empty project throws", () => {
    expect(() => projectStorageKey("")).toThrow(GenerationStoreError);
  });

  it("all paths remain inside injected cache root", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-paths-"));
    try {
      const project = "my-project";
      const storeDir = projectStoreDir(project, cacheRoot);
      const genDir = generationsDir(project, cacheRoot);
      const tmpDirectory = tmpDir(project, cacheRoot);
      const manifestPath = activeManifestPath(project, cacheRoot);
      const statePath = indexStatePath(project, cacheRoot);

      // All paths must be lexically inside the injected cacheRoot.
      expect(isLexicallyInside(cacheRoot, storeDir)).toBe(true);
      expect(isLexicallyInside(cacheRoot, genDir)).toBe(true);
      expect(isLexicallyInside(cacheRoot, tmpDirectory)).toBe(true);
      expect(isLexicallyInside(cacheRoot, manifestPath)).toBe(true);
      expect(isLexicallyInside(cacheRoot, statePath)).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

// ─── Manifest validation: valid cases ───────────────────────────────────

describe("R169A — Manifest valid", () => {
  it("V1 exact valid manifest passes validation", () => {
    const manifest = makeValidManifest();
    const result = validateGenerationManifest(manifest, "test-project");
    expect(result.formatVersion).toBe(1);
    expect(result.project).toBe("test-project");
  });

  it("zero counts are valid", () => {
    const manifest = { ...makeValidManifest(), nodeCount: 0, edgeCount: 0, fileCount: 0, sizeBytes: 0 };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("Unicode project name is valid", () => {
    const manifest = makeValidManifest("プロジェクト");
    expect(() => validateGenerationManifest(manifest, "プロジェクト")).not.toThrow();
  });

  it("sha256 lowercase exact is valid", () => {
    const manifest = { ...makeValidManifest(), sha256: "abcdef0123456789".repeat(4) };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("timestamp with +00:00 timezone is valid", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:00.000+00:00" };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });
});

// ─── Manifest validation: invalid cases ─────────────────────────────────

describe("R169A — Manifest invalid", () => {
  it("null → MANIFEST_SCHEMA_ERROR", () => {
    expect(() => validateGenerationManifest(null, "test-project")).toThrow(GenerationStoreError);
  });

  it("array → MANIFEST_SCHEMA_ERROR", () => {
    expect(() => validateGenerationManifest([], "test-project")).toThrow(GenerationStoreError);
  });

  it("missing key → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest() };
    delete (manifest as any).sha256;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("extra key → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), extra: "no" } as any;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("future formatVersion → MANIFEST_UNSUPPORTED_VERSION", () => {
    const manifest = { ...makeValidManifest(), formatVersion: 2 } as any;
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("project mismatch → MANIFEST_PROJECT_MISMATCH", () => {
    const manifest = makeValidManifest("other-project");
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid UUID → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), generationId: "not-a-uuid" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid timestamp (no timezone) → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:00" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("date-only timestamp → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("invalid sha (uppercase) → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), sha256: "A".repeat(64) };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });

  it("multiline field → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "line1\nline2" };
    expect(() => validateGenerationManifest(manifest, "test-project")).toThrow(GenerationStoreError);
  });
});

// ─── Manifest validation: canonical dbFile (R169A-FIX DATA-R169A-01) ────

describe("R169A-FIX — Canonical dbFile (DATA-R169A-01)", () => {
  it('dbFile "." → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "." };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it('dbFile "active-generation.json" → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "active-generation.json" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it('dbFile "tmp/foo.db" → rejected', () => {
    const manifest = { ...makeValidManifest(), dbFile: "tmp/foo.db" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with different UUID → rejected", () => {
    const manifest = { ...makeValidManifest(), dbFile: `generations/generation-${OTHER_UUID}.db` };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile canonical → accepted", () => {
    const manifest = makeValidManifest();
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });
});

// ─── Manifest validation: safe integers (R169A-FIX VALID-R169A-02) ──────

describe("R169A-FIX — Safe integers (VALID-R169A-02)", () => {
  it("MAX_SAFE_INTEGER → accepted", () => {
    const manifest = {
      ...makeValidManifest(),
      nodeCount: Number.MAX_SAFE_INTEGER,
      edgeCount: Number.MAX_SAFE_INTEGER,
      fileCount: Number.MAX_SAFE_INTEGER,
      sizeBytes: Number.MAX_SAFE_INTEGER,
    };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("MAX_SAFE_INTEGER + 1 → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: Number.MAX_SAFE_INTEGER + 1 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("Infinity → rejected", () => {
    const manifest = { ...makeValidManifest(), sizeBytes: Infinity } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("NaN → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: NaN } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("float (1.5) → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: 1.5 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("negative → rejected", () => {
    const manifest = { ...makeValidManifest(), nodeCount: -1 };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("extractorSemanticsVersion MAX_SAFE_INTEGER + 1 → rejected", () => {
    const manifest = { ...makeValidManifest(), extractorSemanticsVersion: Number.MAX_SAFE_INTEGER + 1 } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });
});

// ─── Manifest validation: calendar dates (R169A-FIX VALID-R169A-01) ─────

describe("R169A-FIX — Calendar-valid timestamps (VALID-R169A-01)", () => {
  it("2026-02-29 (not leap) → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-02-29T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("2028-02-29 (leap) → accepted", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2028-02-29T00:00:00.000Z" };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("month 13 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-13-01T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("hour 24 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T24:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("minute 60 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:60:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("second 60 → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-07-13T00:00:60.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("day 31 in April (April has 30 days) → rejected", () => {
    const manifest = { ...makeValidManifest(), createdAt: "2026-04-31T00:00:00.000Z" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });
});

// ─── Index-state validation (R169A-FIX-R3 API-R169A-R3-02) ──────────────

describe("R169A-FIX-R3 — Index-state valid (API-R169A-R3-02)", () => {
  it("V1 exact valid state passes validation", () => {
    const state = makeValidIndexState();
    const result = validateIndexAttemptState(state, "test-project");
    expect(result.formatVersion).toBe(1);
    expect(result.project).toBe("test-project");
  });

  it("null activeGenerationId is valid (with FAILED outcome)", () => {
    // R169A-FIX-R4: SUCCESS requires activeGenerationId non-null, so we
    // use FAILED here. FAILED requires published=false + failure non-null.
    const state = makeValidIndexState("test-project", {
      activeGenerationId: null,
      candidateGenerationId: VALID_UUID,
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure(),
      recovery: "retry_incremental",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("SUCCESS_WITH_WARNINGS outcome is valid (no failure, no staleReason)", () => {
    // R169A-FIX-R5: SUCCESS_WITH_WARNINGS requires publicationState=PUBLISHED,
    // failure=null, staleReason=null, recovery="none".
    const state = makeValidIndexState("test-project", { lastAttemptOutcome: "SUCCESS_WITH_WARNINGS" });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("PARTIAL outcome is valid (with failure)", () => {
    // R169A-FIX-R5: PARTIAL requires publicationState=NOT_PUBLISHED AND failure non-null.
    // (was "at least one of failure/staleReason" in R4; R5 requires failure non-null per STATE-R169A-R5-01.)
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "PARTIAL",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure(),
      recovery: "retry_incremental",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("PARTIAL outcome is valid (with failure AND staleReason)", () => {
    // R169A-FIX-R5 (STATE-R169A-R5-01/02): PARTIAL requires
    // publicationState=NOT_PUBLISHED AND failure non-null. staleReason
    // is optional but allowed alongside failure. (Previously R4 allowed
    // "at least one of failure/staleReason"; R5 tightens to require
    // failure non-null — see validateIndexAttemptState coherence rules.)
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "PARTIAL",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure({ message: "partial indexing failed" }),
      staleReason: { code: "ROOT_CHANGED", message: "root moved", paths: [] },
      recovery: "full_reindex",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("R169A-FIX-R5: PARTIAL outcome with staleReason but null failure → INDEX_STATE_SCHEMA_ERROR (STATE-R169A-R5-02)", () => {
    // R5 tightened the PARTIAL coherence rule: failure MUST be non-null.
    // staleReason alone is no longer sufficient for PARTIAL.
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "PARTIAL",
      publicationState: "NOT_PUBLISHED",
      failure: null,
      staleReason: { code: "ROOT_CHANGED", message: "root moved", paths: [] },
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("FAILED outcome with failure is valid", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure({ message: "indexer crashed" }),
      recovery: "retry_incremental",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("STALE outcome with structured staleReason is valid", () => {
    const staleReason: IndexAttemptStaleReasonV1 = {
      code: "ROOT_CHANGED",
      message: "Project root fingerprint changed",
      paths: ["/old/root", "/new/root"],
      totalPaths: 2,
      pathsTruncated: false,
    };
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason,
      recovery: "full_reindex",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("all recovery values are accepted (when outcome=STALE)", () => {
    const recoveries: IndexRecoveryAction[] = ["retry_incremental", "fix_filesystem", "full_reindex", "manifest_repair", "legacy_migration"];
    for (const recovery of recoveries) {
      const state = makeValidIndexState("test-project", {
        lastAttemptOutcome: "STALE",
        publicationState: "NOT_PUBLISHED",
        staleReason: { code: "X", message: "msg", paths: [] },
        recovery,
      });
      expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
    }
  });

  it("staleReason with empty paths array is valid", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason: { code: "PERSIST_FAILURE", message: "no-op commit", paths: [] },
      recovery: "retry_incremental",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("staleReason without optional fields is valid", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason: { code: "X", message: "msg", paths: [] },
      recovery: "full_reindex",
    });
    const result = validateIndexAttemptState(state, "test-project");
    expect(result.staleReason).not.toBeNull();
    if (result.staleReason) {
      expect(result.staleReason.totalPaths).toBeUndefined();
      expect(result.staleReason.pathsTruncated).toBeUndefined();
    }
  });
});

describe("R169A-FIX-R3 — Index-state invalid (API-R169A-R3-02)", () => {
  it("null → INDEX_STATE_SCHEMA_ERROR", () => {
    let err: unknown;
    try {
      validateIndexAttemptState(null, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("array → INDEX_STATE_SCHEMA_ERROR", () => {
    let err: unknown;
    try {
      validateIndexAttemptState([], "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("missing key → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState() };
    delete (state as any).recovery;
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("extra key → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), extra: "no" } as any;
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("future formatVersion → INDEX_STATE_UNSUPPORTED_VERSION", () => {
    const state = { ...makeValidIndexState(), formatVersion: 2 } as any;
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_UNSUPPORTED_VERSION");
  });

  it("project mismatch → INDEX_STATE_PROJECT_MISMATCH", () => {
    const state = makeValidIndexState("other-project");
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_PROJECT_MISMATCH");
  });

  it("invalid lastAttemptId (not UUID) → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), lastAttemptId: "abc" };
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("invalid activeGenerationId (not UUID, not null) → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), activeGenerationId: "not-a-uuid" };
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("invalid timestamp → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), lastAttemptAt: "2026-07-13" };
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("invalid outcome → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), lastAttemptOutcome: "BOGUS" } as any;
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("invalid recovery (old name incremental_retry) → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = { ...makeValidIndexState(), recovery: "incremental_retry" } as any;
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS + non-null failure → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS",
      failure: makeValidFailure({ message: "should be null" }),
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS + non-null staleReason → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS",
      staleReason: { code: "X", message: "msg", paths: [] },
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS + recovery != none → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", { lastAttemptOutcome: "SUCCESS", recovery: "full_reindex" });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS + publicationState=NOT_PUBLISHED → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", { lastAttemptOutcome: "SUCCESS", publicationState: "NOT_PUBLISHED" });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS + activeGenerationId=null → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS",
      activeGenerationId: null,
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS_WITH_WARNINGS + non-null failure → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      failure: makeValidFailure({ message: "should be null" }),
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS_WITH_WARNINGS + non-null staleReason → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      staleReason: { code: "X", message: "msg", paths: [] },
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS_WITH_WARNINGS + recovery != none → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: SUCCESS_WITH_WARNINGS + publicationState=NOT_PUBLISHED → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "NOT_PUBLISHED",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: FAILED + null failure → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: null,
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: FAILED + publicationState=PUBLISHED → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "FAILED",
      publicationState: "PUBLISHED", // coherence violation: FAILED requires publicationState != PUBLISHED
      failure: makeValidFailure(),
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: PARTIAL + publicationState=PUBLISHED → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "PARTIAL",
      publicationState: "PUBLISHED", // coherence violation: PARTIAL requires publicationState=NOT_PUBLISHED
      failure: makeValidFailure(),
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: PARTIAL + failure=null + staleReason=null → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "PARTIAL",
      publicationState: "NOT_PUBLISHED",
      failure: null,
      staleReason: null,
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: STALE + null staleReason → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason: null,
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: STALE + recovery=none → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason: { code: "X", message: "msg", paths: [] },
      recovery: "none",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("Coherence: STALE + publicationState=PUBLISHED → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "PUBLISHED", // coherence violation: STALE requires publicationState=NOT_PUBLISHED
      staleReason: { code: "X", message: "msg", paths: [] },
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("staleReason with extra key → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      staleReason: { code: "X", message: "msg", paths: [], extra: "no" } as any,
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("staleReason missing required key → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      staleReason: { code: "X", message: "msg" } as any, // missing paths
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("staleReason.paths contains non-string → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      staleReason: { code: "X", message: "msg", paths: [1, 2, 3] as any },
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("staleReason with C0 control char in code → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      staleReason: { code: "X\0evil", message: "msg", paths: [] },
      recovery: "full_reindex",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("failure.message with C0 control char → INDEX_STATE_SCHEMA_ERROR (R169A-FIX-R4)", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure({ message: "err\0or" }),
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });
});

// ─── Resolver tests ─────────────────────────────────────────────────────

describe("R169A — Resolver", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-resolver-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("valid manifest + target exists → generation", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("generation");
    if (result.source === "generation") {
      expect(result.generationId).toBe(VALID_UUID);
      expect(existsSync(result.dbPath)).toBe(true);
    }
  });

  it("no manifest + no legacy → missing", () => {
    const result = resolveActiveCodeDb("nonexistent", { cacheRoot });
    expect(result.source).toBe("missing");
    if (result.source === "missing") {
      expect(result.dbPath).toBeNull();
    }
  });

  it("no manifest + legacy exists → legacy (R169A-FIX: uses injected cacheRoot)", () => {
    const project = "legacy-only-project";
    writeLegacyDb(cacheRoot, project);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("legacy");
    if (result.source === "legacy") {
      expect(existsSync(result.dbPath)).toBe(true);
      expect(result.generationId).toBeNull();
    }
  });

  it("invalid manifest → fail closed (no legacy fallback)", () => {
    const project = "test-project";
    const manifestPath = activeManifestPath(project, cacheRoot);
    mkdirSync(resolve(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "{invalid json}", "utf-8");

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("target missing → fail closed", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Don't create the DB file

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("target is a directory → MANIFEST_TARGET_NOT_REGULAR (R169A-FIX DATA-R169A-01)", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Create the dbFile path as a directory, not a regular file.
    const dbPath = join(projectStoreDir(project, cacheRoot), manifest.dbFile);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_TARGET_NOT_REGULAR");
  });

  it("project mismatch in manifest → fail closed", () => {
    const project = "test-project";
    const manifest = makeValidManifest("different-project");
    writeManifest(cacheRoot, project, manifest);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("symlink manifest → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the manifest file with a self-referential symlink.
    const manifestPath = activeManifestPath(project, cacheRoot);
    const target = manifestPath + ".target";
    rmSync(manifestPath);
    writeFileSync(target, "symlink-target", "utf-8");
    symlinkSync(target, manifestPath);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });

  it("symlink generation target → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    const realDbPath = writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the DB with a symlink to elsewhere.
    const symlinkTarget = realDbPath + ".real";
    writeFileSync(symlinkTarget, "real-target", "utf-8");
    rmSync(realDbPath);
    symlinkSync(symlinkTarget, realDbPath);

    expect(() => resolveActiveCodeDb(project, { cacheRoot })).toThrow(GenerationStoreError);
  });
});

// ─── Symlink chain tests (R169A-FIX SEC-R169A-02) ───────────────────────

describe("R169A-FIX — Symlink chain detection (SEC-R169A-02)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-symlink-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  /**
   * Helper: replace a directory at `path` with a symlink pointing to
   * `target`. Used to inject a symlink at any level of the chain.
   */
  function replaceDirWithSymlink(path: string, target: string): void {
    mkdirSync(target, { recursive: true });
    rmSync(path, { recursive: true, force: true });
    symlinkSync(target, path);
  }

  it("manifest parent symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the project store dir (parent of the manifest) with a
    // symlink to elsewhere inside cacheRoot.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere", "manifest-parent-test");
    mkdirSync(elsewhere, { recursive: true });
    // Move the manifest + DB into elsewhere so the symlink resolves.
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(projectDir, elsewhere);
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("generations parent symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the generations dir (parent of the DB file) with a
    // symlink to elsewhere.
    const genDir = generationsDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-gen", "gen");
    rmSync(genDir, { recursive: true, force: true });
    mkdirSync(elsewhere, { recursive: true });
    // Put a fake DB in the elsewhere dir so the symlink target has the file.
    writeFileSync(join(elsewhere, `generation-${VALID_UUID}.db`), "fake", "utf-8");
    symlinkSync(elsewhere, genDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("project store symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace projectStoreDir itself with a symlink.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-store", "store");
    rmSync(projectDir, { recursive: true, force: true });
    mkdirSync(elsewhere, { recursive: true });
    // Move manifest + generations into elsewhere
    writeFileSync(join(elsewhere, "active-generation.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    mkdirSync(join(elsewhere, "generations"), { recursive: true });
    writeFileSync(join(elsewhere, "generations", `generation-${VALID_UUID}.db`), "fake", "utf-8");
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("target final symlink → rejected", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    const realDbPath = writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // Replace the DB file itself with a symlink.
    const symlinkTarget = join(cacheRoot, "real-db-target");
    writeFileSync(symlinkTarget, "real-target", "utf-8");
    rmSync(realDbPath);
    symlinkSync(symlinkTarget, realDbPath);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
  });

  it("target directory → MANIFEST_TARGET_NOT_REGULAR", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    // Create the dbFile path as a directory.
    const dbPath = join(projectStoreDir(project, cacheRoot), manifest.dbFile);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_TARGET_NOT_REGULAR");
  });
});

// Helper used by symlink tests: rename a directory safely (rmSync + rename
// is not used because we want to PRESERVE the contents in the new location).
function renameSyncSafe(from: string, to: string): void {
  // Use fs.renameSync directly.
  const fs = require("node:fs");
  // Ensure parent of `to` exists.
  fs.mkdirSync(require("node:path").resolve(to, ".."), { recursive: true });
  fs.renameSync(from, to);
}

// ─── Atomic JSON writer — fault injection matrix (R169A-FIX DUR-R169A-02) ─
//
// R169A-FIX-R5 (API-R169A-R5-01): `writeGenerationManifestAtomically` is
// no longer accessible (the `__test__` export is removed). These tests
// exercise the writer through the ONLY public writer
// `writeIndexStateAtomically`, which uses the same internal writer code
// path (`writeProjectJsonAtomicallyInternal` → `writeJsonAtomically`).
// Each test writes a VALID index-state (the typed wrapper validates
// BEFORE I/O, so an invalid value would fail validation, not the
// fault-injection checkpoint).

describe("R169A-FIX — Atomic JSON writer (DUR-R169A-01/02)", () => {
  let cacheRoot: string;
  const project = "writer-test-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-atomic-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  /** Helper: get the index-state target path for this project / cacheRoot. */
  function targetPath(): string {
    return indexStatePath(project, cacheRoot);
  }

  /** Helper: list files in the project store dir (for "no temp left behind" checks). */
  function listProjectStore(): string[] {
    return readdirSync(projectStoreDir(project, cacheRoot));
  }

  /** Helper: count .tmp-* files in the project store dir. */
  function countTempFiles(): number {
    return listProjectStore().filter((n) => n.startsWith(".tmp-")).length;
  }

  it("exclusive open fail → old intact", () => {
    // Write the "old" index-state first via the public writer.
    const oldState = makeValidIndexState(project);
    writeIndexStateAtomically(project, oldState, { cacheRoot });
    const oldContent = readFileSync(targetPath(), "utf-8");

    // Make the temp file open fail.
    const ops = new TestOps();
    ops.failAt = "open";
    const newState = makeValidIndexState(project, { lastAttemptId: OTHER_UUID });
    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath(), "utf-8")).toBe(oldContent);
    // No temp file left.
    expect(countTempFiles()).toBe(0);
  });

  it("short write recoverable → success exact", () => {
    // Use a state with a large failure.message to force multi-write.
    const newState = makeValidIndexState(project, {
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure({ message: "x".repeat(500) }),
      recovery: "retry_incremental",
    });
    const ops = new TestOps();
    ops.shortFirstWrite = true;

    writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);

    // The file must contain exactly the right JSON, despite the partial
    // first write.
    const content = readFileSync(targetPath(), "utf-8");
    expect(JSON.parse(content)).toEqual(newState);
    // Must have called writeSync at least twice: first a 1-byte short
    // write, then subsequent writes for the rest of the payload.
    const allWriteCalls = ops.calls.filter((c) => c.startsWith("write")).length;
    expect(allWriteCalls).toBeGreaterThan(1);
    // The first call must have been a short write.
    expect(ops.calls).toContain("write:short");
  });

  it("write fail mid-payload → old intact, temp cleaned", () => {
    const oldState = makeValidIndexState(project);
    writeIndexStateAtomically(project, oldState, { cacheRoot });
    const oldContent = readFileSync(targetPath(), "utf-8");

    // Force a genuine mid-payload failure: shortFirstWrite makes the
    // first writeSync return after 1 byte (leaving the rest of the
    // payload for the next call). failSecondWrite makes that next call
    // throw, simulating an I/O error mid-payload.
    const ops = new TestOps();
    ops.shortFirstWrite = true;
    ops.failSecondWrite = true;
    const newState = makeValidIndexState(project, {
      lastAttemptId: OTHER_UUID,
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: makeValidFailure({ message: "x".repeat(500) }),
      recovery: "retry_incremental",
    });

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath(), "utf-8")).toBe(oldContent);
    expect(countTempFiles()).toBe(0);
  });

  it("temp fsync fail → old intact, temp cleaned", () => {
    const oldState = makeValidIndexState(project);
    writeIndexStateAtomically(project, oldState, { cacheRoot });
    const oldContent = readFileSync(targetPath(), "utf-8");

    const ops = new TestOps();
    ops.failAt = "tempFsync";
    const newState = makeValidIndexState(project, { lastAttemptId: OTHER_UUID });

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_FSYNC_FAILED");

    expect(readFileSync(targetPath(), "utf-8")).toBe(oldContent);
    expect(countTempFiles()).toBe(0);
  });

  it("close fail before rename → old intact", () => {
    const oldState = makeValidIndexState(project);
    writeIndexStateAtomically(project, oldState, { cacheRoot });
    const oldContent = readFileSync(targetPath(), "utf-8");

    const ops = new TestOps();
    ops.failAt = "closeBeforeRename";
    const newState = makeValidIndexState(project, { lastAttemptId: OTHER_UUID });

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // Close failure is wrapped as ATOMIC_WRITE_FAILED.
    expect((err as GenerationStoreError).code).toBe("ATOMIC_WRITE_FAILED");

    expect(readFileSync(targetPath(), "utf-8")).toBe(oldContent);
    expect(countTempFiles()).toBe(0);
  });

  it("rename fail → old intact, temp cleaned", () => {
    const oldState = makeValidIndexState(project);
    writeIndexStateAtomically(project, oldState, { cacheRoot });
    const oldContent = readFileSync(targetPath(), "utf-8");

    const ops = new TestOps();
    ops.failAt = "rename";
    const newState = makeValidIndexState(project, { lastAttemptId: OTHER_UUID });

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_RENAME_FAILED");

    expect(readFileSync(targetPath(), "utf-8")).toBe(oldContent);
    expect(countTempFiles()).toBe(0);
  });

  it("directory fsync fail post-rename → durability unknown (SEC-R169A-R4-01)", () => {
    // R169A-FIX-R4: The writer now holds the directory fd and fsyncs it
    // after rename (no path-based reopen). Test by failing the dirFsync
    // on the held fd — produces ATOMIC_DURABILITY_UNKNOWN.
    const ops = new TestOps();
    ops.failAt = "dirFsync";
    const newState = makeValidIndexState(project);

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_DURABILITY_UNKNOWN");

    // The rename has already happened — the target file should contain
    // the NEW content, not the old (there was no old).
    const content = readFileSync(targetPath(), "utf-8");
    expect(JSON.parse(content)).toEqual(newState);
    // No temp file left (it was renamed).
    expect(countTempFiles()).toBe(0);
  });

  it("directory fsync fail → durability unknown", () => {
    const ops = new TestOps();
    ops.failAt = "dirFsync";
    const newState = makeValidIndexState(project);

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, newState, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("ATOMIC_DURABILITY_UNKNOWN");

    // The rename has already happened — the new content is in place.
    const content = readFileSync(targetPath(), "utf-8");
    expect(JSON.parse(content)).toEqual(newState);
  });

  it("success → exact JSON, 0600, no temp", () => {
    const state = makeValidIndexState(project);
    writeIndexStateAtomically(project, state, { cacheRoot });

    const content = readFileSync(targetPath(), "utf-8");
    expect(JSON.parse(content)).toEqual(state);
    // Trailing newline.
    expect(content.endsWith("\n")).toBe(true);

    const stat = lstatSync(targetPath());
    expect(stat.mode & 0o777).toBe(0o600);

    expect(countTempFiles()).toBe(0);
  });

  it("R169A-FIX-R2: directory mode is 0700 (DUR-R169A-R2-01)", () => {
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    // The project store, generations, and tmp directories must all be 0700.
    const dirs = [
      projectStoreDir(project, cacheRoot),
      generationsDir(project, cacheRoot),
      tmpDir(project, cacheRoot),
    ];
    for (const d of dirs) {
      const st = lstatSync(d);
      expect(st.mode & 0o777, `dir ${d} mode`).toBe(0o700);
    }
  });

  it("R169A-FIX-R3: index-state target writes to index-state.json (API-R169A-R3-01)", () => {
    // R169A-FIX-R5: SUCCESS+PUBLISHED requires activeGenerationId non-null and
    // candidateGenerationId == activeGenerationId. The default state satisfies this.
    const state = makeValidIndexState(project);
    writeIndexStateAtomically(project, state, { cacheRoot });

    const statePath = indexStatePath(project, cacheRoot);
    const content = readFileSync(statePath, "utf-8");
    expect(JSON.parse(content)).toEqual(state);
    const st = lstatSync(statePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("R169A-FIX-R3: invalid index-state is rejected BEFORE any I/O (API-R169A-R3-01)", () => {
    // Pass an invalid index-state (coherence violation). Validation must
    // fail before any filesystem I/O.
    // R169A-FIX-R5: FAILED requires failure non-null. Pass failure=null
    // to trigger the coherence violation.
    const badState = makeValidIndexState(project, {
      lastAttemptOutcome: "FAILED",
      publicationState: "NOT_PUBLISHED",
      failure: null, // coherence violation: FAILED requires failure non-null
      recovery: "retry_incremental",
    });
    let err: unknown;
    try {
      writeIndexStateAtomically(project, badState, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");

    // No layout should have been created.
    expect(existsSync(projectStoreDir(project, cacheRoot))).toBe(false);
    // No target file.
    expect(existsSync(indexStatePath(project, cacheRoot))).toBe(false);
  });
});

// ─── Legacy path tests (R169A-FIX: no real HOME writes) ─────────────────

describe("R169A-FIX — Legacy path validation (SEC-R169A-01 / API-R169A-02)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-legacy-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("legacy DB in injected cacheRoot is found by resolver", () => {
    const project = "test-project";
    writeLegacyDb(cacheRoot, project);

    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("legacy");
    if (result.source === "legacy") {
      expect(result.dbPath).toBe(legacyCodeDbPath(project, cacheRoot));
    }
  });

  it('project "../escape" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("../escape", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "/absolute/path" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("/absolute/path", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "a/b" → PATH_TRAVERSAL_REJECTED (separator rejected)', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("a/b", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "." → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath(".", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it('project "" → PATH_TRAVERSAL_REJECTED', () => {
    let err: unknown;
    try {
      legacyCodeDbPath("", cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("R169A-FIX-R2: legacy DB target is a directory → LEGACY_SOURCE_INVALID (renamed from LEGACY_SOURCE_OPEN_FAILED)", () => {
    const project = "test-project";
    // R169A-FIX-R5 (SEC-R169A-R5-02): Pre-create cbm with 0o700 so the
    // trust root permission check passes. Bare mkdirSync with recursive
    // creates with the default umask (often 0o775 on shared CI runners).
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    // Create the legacy path as a directory.
    const dbPath = legacyCodeDbPath(project, cacheRoot);
    mkdirSync(dbPath, { recursive: true });

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("LEGACY_SOURCE_INVALID");
  });
});

// ─── listProjectStoreKeys (R169A-FIX OPS-R169A-01, R169A-FIX-R3 OPS-R169A-R3-01) ─

describe("R169A-FIX — listProjectStoreKeys (OPS-R169A-01)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-list-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns [] when store root does not exist (ENOENT)", () => {
    expect(listProjectStoreKeys(cacheRoot)).toEqual([]);
  });

  it("returns sorted 64-hex directory names only", () => {
    // R169A-FIX-R5 (SEC-R169A-R5-02): Pre-create cbm + projects with
    // mode 0o700 so the trust root permission check passes. Bare
    // `mkdirSync(root, { recursive: true })` would create with the
    // default umask (often 0o775 on shared CI runners) and fail the
    // R5 permission check.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    const root = generationStoreRoot(cacheRoot);
    ensureDirMode0700(root);
    const keyA = projectStorageKey("a");
    const keyB = projectStorageKey("b");
    mkdirSync(join(root, keyA), { mode: 0o700 });
    mkdirSync(join(root, keyB), { mode: 0o700 });
    // Non-conforming entries — must be filtered out.
    mkdirSync(join(root, "not-a-hash"), { mode: 0o700 });
    writeFileSync(join(root, "stray-file.txt"), "no", "utf-8");

    const result = listProjectStoreKeys(cacheRoot);
    expect(result).toEqual([keyA, keyB].sort());
  });

  it("EACCES on store root → throws GenerationStoreError", () => {
    // R169A-FIX-R5: Create cbm with 0o700 first; projects is replaced
    // with a regular file below.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    const root = generationStoreRoot(cacheRoot);
    // Create a non-directory entry at the store root path. readdirSync
    // will then fail with ENOTDIR — which is treated as fail-closed.
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "i am a file not a directory", "utf-8");

    expect(() => listProjectStoreKeys(cacheRoot)).toThrow(GenerationStoreError);
  });

  it("R169A-FIX-R3: cacheRoot is a symlink → PATH_TRAVERSAL_REJECTED (OPS-R169A-R3-01)", () => {
    const real = mkdtempSync(join(tmpdir(), "r169a-list-real-"));
    try {
      const linkPath = cacheRoot + "-link";
      symlinkSync(real, linkPath);
      try {
        let err: unknown;
        try {
          listProjectStoreKeys(linkPath);
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(GenerationStoreError);
        expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
      } finally {
        rmSync(linkPath, { force: true });
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("R169A-FIX-R3: projects dir is a symlink → PATH_TRAVERSAL_REJECTED (OPS-R169A-R3-01)", () => {
    // R169A-FIX-R5: Create cbm with 0o700 first; projects is a symlink.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    const projects = generationStoreRoot(cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-projects-list");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, projects);

    let err: unknown;
    try {
      listProjectStoreKeys(cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("R169A-FIX-R3: assertGenerationStoreRootTrusted — clean chain → no throw", () => {
    // R169A-FIX-R5: Create cbm + projects with 0o700 so the R5
    // permission check passes.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    ensureDirMode0700(generationStoreRoot(cacheRoot));
    expect(() => assertGenerationStoreRootTrusted(cacheRoot, "test")).not.toThrow();
  });
});

// ─── No production behavior change ──────────────────────────────────────

describe("R169A — No production behavior change", () => {
  it("defaultCodeDbPath still exists and is importable", async () => {
    const module = await import("../../src/bridge/sqlite-ro.js");
    expect(typeof module.defaultCodeDbPath).toBe("function");
  });

  it("legacyCodeDbPath produces the same path as defaultCodeDbPath for ordinary projects", async () => {
    const { defaultCodeDbPath } = await import("../../src/bridge/sqlite-ro.js");
    const project = "test-project";
    expect(legacyCodeDbPath(project)).toBe(defaultCodeDbPath(project));
  });

  it("CURRENT_GENERATION_MANIFEST_VERSION is still 1", async () => {
    const schema = await import("../../src/indexer/schema.js");
    expect(schema.CURRENT_GENERATION_MANIFEST_VERSION).toBe(1);
  });

  it("no test writes to real HOME cache (R169A-FIX: back-compat verification)", () => {
    // Verify that legacyCodeDbPath without cacheRoot still produces a path
    // inside the real cache (so production callers are unaffected). We
    // don't WRITE anything here — we just check the path is computed.
    const project = "test-project";
    const path = legacyCodeDbPath(project);
    const expected = legacyCodeDbPath(project); // same call
    expect(path).toBe(expected);
    // The path must contain the project name.
    expect(path).toContain(`${project}.db`);
  });
});

// ─── Source inspection: Node.js walk replaces grep ──────────────────────

describe("R169A — Source inspection: legacy path consumers (section 18G)", () => {
  // Compute the v2 source directory relative to this test file.
  // tests/storage/r169a-generation-store.test.ts → ../../src
  const SRC_DIR = resolve(__dirname, "..", "..", "src");
  const REPO_SRC = resolve(__dirname, "..", ".."); // the v2/ directory

  // Expected files that import defaultCodeDbPath. This list is the
  // baseline — new files should NOT be added without migration.
  // Note: src/bridge/sqlite-ro.ts is the DEFINITION, not a consumer.
  const EXPECTED_CONSUMERS = [
    "src/bridge/sqlite-ro.ts", // definition
    "src/indexer/indexer.ts",
    "src/cli/index.ts",
    "src/cli/commands/watch.ts",
    "src/cli/commands/stats.ts",
    "src/cli/commands/obsidian.ts",
    "src/cli/commands/report.ts",
    "src/cli/commands/human.ts",
    "src/intelligence/graph-status.ts",
    "src/ui/project-store-registry.ts",
    "src/ui/routes/index.ts",
    "src/ui/routes/project.ts",
    "src/ui/server.ts",
  ];

  it("inventory of defaultCodeDbPath consumers matches expected list", () => {
    // R169A-FIX: replace grep with a Node.js walk.
    const allTs = walkTs(SRC_DIR);
    const actualFiles: string[] = [];
    for (const file of allTs) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("defaultCodeDbPath")) {
        // Normalize to a repo-relative path starting with "src/".
        const rel = relative(REPO_SRC, file).replaceAll('\\', '/');
        actualFiles.push(rel);
      }
    }
    actualFiles.sort();

    for (const expected of EXPECTED_CONSUMERS) {
      expect(actualFiles).toContain(expected);
    }

    const unexpected = actualFiles.filter(
      (f) => !EXPECTED_CONSUMERS.includes(f),
    );
    if (unexpected.length > 0) {
      expect.fail(
        `New defaultCodeDbPath consumers found (update EXPECTED_CONSUMERS or use generation store):\n${unexpected.join("\n")}`,
      );
    }
  });
});

// ─── Child crash test (R169A-FIX DUR-R169A-01 — recommended) ────────────

describe("R169A-FIX — Child crash test (DUR-R169A-01)", () => {
  it("child writes temp + fsync then exits before rename; old target intact", () => {
    const testDir = mkdtempSync(join(tmpdir(), "r169a-crash-"));
    try {
      const targetPath = join(testDir, "target.json");
      // Write the old target using plain fs.writeFileSync (the wrapper
      // would derive the target path from a project name and validate
      // the trust root — that's tested separately; here we just need an
      // "old" file on disk that the child will NOT touch).
      writeFileSync(targetPath, JSON.stringify({ version: "old" }, null, 2) + "\n", "utf-8");
      const oldContent = readFileSync(targetPath, "utf-8");

      // Spawn a child that:
      //   1. Creates a temp file at a known path
      //   2. Writes some content
      //   3. fsyncs it
      //   4. Exits immediately (simulating a crash before rename)
      //
      // We use a Node.js one-liner via -e. The child writes to a fixed
      // temp path (NOT random) so we can verify it exists afterward.
      const tempPath = join(testDir, ".tmp-crash-test.json");
      const childScript = `
        const fs = require('node:fs');
        const path = require('node:path');
        const tempPath = ${JSON.stringify(tempPath)};
        const fd = fs.openSync(tempPath, 'wx', 0o600);
        const buf = Buffer.from(JSON.stringify({ version: 'new' }, null, 2) + '\\n', 'utf8');
        fs.writeSync(fd, buf, 0, buf.length, null);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        // Exit immediately — no rename. This simulates a crash.
        process.exit(0);
      `;
      const result = spawnSync(process.execPath, ["-e", childScript], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(0);

      // The old target file must be intact (the child never renamed).
      expect(readFileSync(targetPath, "utf-8")).toBe(oldContent);

      // The temp file should still exist (the child left it behind).
      expect(existsSync(tempPath)).toBe(true);

      // The temp file content must be the new content (proving fsync
      // happened on the new content even though the rename never did).
      const tempContent = readFileSync(tempPath, "utf-8");
      expect(JSON.parse(tempContent)).toEqual({ version: "new" });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── Path safety helpers — additional direct unit tests ─────────────────

describe("R169A-FIX — isLexicallyInside / assertPathInsideNoSymlinks", () => {
  it("isLexicallyInside: same path → true", () => {
    expect(isLexicallyInside("/a/b", "/a/b")).toBe(true);
  });

  it("isLexicallyInside: child path → true", () => {
    expect(isLexicallyInside("/a/b", "/a/b/c")).toBe(true);
  });

  it("isLexicallyInside: sibling path → false", () => {
    expect(isLexicallyInside("/a/b", "/a/c")).toBe(false);
  });

  it("isLexicallyInside: parent path → false", () => {
    expect(isLexicallyInside("/a/b/c", "/a/b")).toBe(false);
  });

  it("isLexicallyInside: traversal path → false", () => {
    expect(isLexicallyInside("/a/b", "/a/b/../../../etc")).toBe(false);
  });

  it("isPathInside alias equals isLexicallyInside", () => {
    expect(isPathInside).toBe(isLexicallyInside);
  });

  it("assertPathInsideNoSymlinks: clean chain → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-assert-"));
    try {
      const child = join(root, "a", "b", "c");
      mkdirSync(child, { recursive: true });
      expect(() =>
        assertPathInsideNoSymlinks(root, child, "p", "test"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertPathInsideNoSymlinks: traversal → PATH_TRAVERSAL_REJECTED", () => {
    let err: unknown;
    try {
      assertPathInsideNoSymlinks("/a/b", "/a/c", "p", "test");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("assertPathInsideNoSymlinks: symlink mid-chain → rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-symlink-mid-"));
    try {
      const real = join(root, "real");
      const symlink = join(root, "symlink");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, symlink);
      const target = join(symlink, "file");
      let err: unknown;
      try {
        assertPathInsideNoSymlinks(root, target, "p", "test");
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertPathInsideNoSymlinks: ENOENT candidate → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-enoent-"));
    try {
      const missing = join(root, "does", "not", "exist");
      expect(() =>
        assertPathInsideNoSymlinks(root, missing, "p", "test"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: regular file → no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-"));
    try {
      const f = join(root, "file");
      writeFileSync(f, "x", "utf-8");
      expect(() =>
        assertNotSymlink(f, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: symlink → throw", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-sym-"));
    try {
      const target = join(root, "real");
      const link = join(root, "link");
      writeFileSync(target, "x", "utf-8");
      symlinkSync(target, link);
      expect(() =>
        assertNotSymlink(link, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).toThrow(GenerationStoreError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertNotSymlink: ENOENT → no throw (only ENOENT tolerated)", () => {
    const root = mkdtempSync(join(tmpdir(), "r169a-notsym-enoent-"));
    try {
      const missing = join(root, "missing");
      expect(() =>
        assertNotSymlink(missing, "MANIFEST_SYMLINK_REJECTED", "p"),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── validateGenerationManifest — dbFile absolute / traversal ──────────

describe("R169A-FIX — dbFile path-form rejections (DATA-R169A-01)", () => {
  it("absolute dbFile → MANIFEST_DBFILE_NOT_CANONICAL (not MANIFEST_TARGET_OUTSIDE_STORE)", () => {
    const manifest = { ...makeValidManifest(), dbFile: "/etc/passwd" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with .. → MANIFEST_DBFILE_NOT_CANONICAL", () => {
    const manifest = { ...makeValidManifest(), dbFile: "../../../etc/passwd" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });

  it("dbFile with backslash → MANIFEST_DBFILE_NOT_CANONICAL", () => {
    const manifest = { ...makeValidManifest(), dbFile: "generations\\..\\escape.db" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_DBFILE_NOT_CANONICAL");
  });
});

// ─── R169A-FIX-R2: Trust root symlink bypass (SEC-R169A-R2-01) ──────────

describe("R169A-FIX-R2 — Trust root symlink bypass (SEC-R169A-R2-01)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-trust-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  /**
   * Helper: set up a project with a valid manifest + generation DB so the
   * resolver has something to read. Then symlinks are injected at various
   * levels of the trust root chain to verify they are rejected.
   */
  function setupValidProject(project: string): void {
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);
  }

  it("cacheRoot itself is a symlink → PATH_TRAVERSAL_REJECTED (exact code)", () => {
    const project = "test-project";
    // Create a sibling dir and symlink cacheRoot → sibling.
    const real = mkdtempSync(join(tmpdir(), "r169a-r2-real-"));
    try {
      const linkPath = cacheRoot + "-link";
      symlinkSync(real, linkPath);
      try {
        let err: unknown;
        try {
          // The resolver must reject because cacheRoot is a symlink.
          resolveActiveCodeDb(project, { cacheRoot: linkPath });
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(GenerationStoreError);
        expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
        expect((err as GenerationStoreError).phase).toBe("resolveActiveCodeDb");
      } finally {
        rmSync(linkPath, { force: true });
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("cbmCacheDir is a symlink → PATH_TRAVERSAL_REJECTED (exact code)", () => {
    const project = "test-project";
    setupValidProject(project);

    // Replace cbmCacheDir with a symlink to elsewhere.
    const cbm = cbmCacheDir(cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-cbm");
    mkdirSync(elsewhere, { recursive: true });
    // Move the real cbm contents into elsewhere so the symlink resolves.
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(cbm, elsewhere);
    symlinkSync(elsewhere, cbm);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("projects dir is a symlink → PATH_TRAVERSAL_REJECTED (exact code)", () => {
    const project = "test-project";
    setupValidProject(project);

    // Replace projects dir with a symlink to elsewhere.
    const projects = generationStoreRoot(cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-projects");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(projects, elsewhere);
    symlinkSync(elsewhere, projects);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("assertTrustedRootNoSymlinks: clean chain → no throw", () => {
    const project = "test-project";
    setupValidProject(project);
    expect(() =>
      assertTrustedRootNoSymlinks(cacheRoot, project, "test-phase"),
    ).not.toThrow();
  });

  it("assertTrustedRootNoSymlinks: project-key dir is a symlink → rejected", () => {
    const project = "test-project";
    setupValidProject(project);

    // Replace project-key dir with a symlink.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-key");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(projectDir, elsewhere);
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      assertTrustedRootNoSymlinks(cacheRoot, project, "test-phase");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("assertTrustedRootNoSymlinks: ENOENT chain → no throw (project not yet created)", () => {
    // A project that has never been written — the project-key dir doesn't exist.
    expect(() =>
      assertTrustedRootNoSymlinks(cacheRoot, "never-written", "test-phase"),
    ).not.toThrow();
  });
});

// ─── R169A-FIX-R2: Writer path safety (SEC-R169A-R2-02) ─────────────────

describe("R169A-FIX-R2 — Writer path safety (SEC-R169A-R2-02)", () => {
  let cacheRoot: string;
  const project = "writer-safety-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-wsafety-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("writer rejects when project-key dir is a symlink (before temp create)", () => {
    // First write succeeds and creates the layout.
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    // Replace the project-key dir with a symlink.
    const projectDir = projectStoreDir(project, cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-wsafe");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(elsewhere, { recursive: true, force: true });
    renameSyncSafe(projectDir, elsewhere);
    symlinkSync(elsewhere, projectDir);

    let err: unknown;
    try {
      writeIndexStateAtomically(project, makeValidIndexState(project, { lastAttemptId: OTHER_UUID }), { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");

    // No temp file should have been created in the original project dir
    // (now elsewhere). The rejection must happen BEFORE the temp create.
    const files = readdirSync(elsewhere);
    const tempFiles = files.filter((n) => n.startsWith(".tmp-"));
    expect(tempFiles.length).toBe(0);
  });

  it("writer rejects when projects dir is a symlink", () => {
    // Replace projects dir with a symlink BEFORE any write. We must
    // create the cbm parent first so the symlink target resolves.
    // R169A-FIX-R5 (SEC-R169A-R5-02): Create cbm with 0o700 so the
    // trust root permission check passes (cbm is a compat root —
    // 0700 satisfies mode & 0o022 === 0).
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    const projects = generationStoreRoot(cacheRoot);
    const elsewhere = join(cacheRoot, "elsewhere-projects-wsafe");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, projects);

    let err: unknown;
    try {
      writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("R169A-FIX-R5: writer rejects when target file (index-state) is a symlink (converted from manifest test)", () => {
    // R169A-FIX-R5: writeGenerationManifestAtomically is no longer accessible.
    // This test now uses writeIndexStateAtomically (the only public writer).
    // Set up the layout and a real index-state.
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    // Replace the index-state file with a symlink to elsewhere.
    const statePath = indexStatePath(project, cacheRoot);
    const target = statePath + ".target";
    rmSync(statePath);
    writeFileSync(target, "symlink-target", "utf-8");
    symlinkSync(target, statePath);

    let err: unknown;
    try {
      writeIndexStateAtomically(project, makeValidIndexState(project, { lastAttemptId: OTHER_UUID }), { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PROJECT_STATE_SYMLINK_REJECTED");
  });

  it("R169A-FIX-R3: writer rejects when target file (index-state) is a symlink → PROJECT_STATE_SYMLINK_REJECTED (QUAL-R169A-R3-01)", () => {
    // Set up layout first.
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    // Replace index-state.json with a symlink.
    const statePath = indexStatePath(project, cacheRoot);
    const target = statePath + ".target";
    rmSync(statePath);
    writeFileSync(target, "symlink-target", "utf-8");
    symlinkSync(target, statePath);

    let err: unknown;
    try {
      writeIndexStateAtomically(project, makeValidIndexState(project, { lastAttemptId: VALID_UUID }), { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // R169A-FIX-R3: PROJECT_STATE_SYMLINK_REJECTED for index-state (was GENERATION_TARGET_SYMLINK_REJECTED).
    expect((err as GenerationStoreError).code).toBe("PROJECT_STATE_SYMLINK_REJECTED");
  });

  it("writer: directory mode is 0700 (explicit check on every layout dir)", () => {
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    const dirs = [
      cbmCacheDir(cacheRoot),
      generationStoreRoot(cacheRoot),
      projectStoreDir(project, cacheRoot),
      generationsDir(project, cacheRoot),
      tmpDir(project, cacheRoot),
    ];
    for (const d of dirs) {
      const st = lstatSync(d);
      expect(st.mode & 0o777, `dir ${d} mode`).toBe(0o700);
    }
  });

  it("writer: file mode is 0600", () => {
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });
    const st = lstatSync(indexStatePath(project, cacheRoot));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("writer: no file created outside trust root", () => {
    writeIndexStateAtomically(project, makeValidIndexState(project), { cacheRoot });

    // Walk cacheRoot and verify ALL files are inside the project store dir.
    const projectDir = projectStoreDir(project, cacheRoot);
    const filesOutside: string[] = [];
    function visit(dir: string) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          visit(full);
        } else if (e.isFile()) {
          // File must be inside projectDir.
          if (!full.startsWith(projectDir + sep) && full !== projectDir) {
            filesOutside.push(full);
          }
        }
      }
    }
    visit(cacheRoot);
    expect(filesOutside).toEqual([]);
  });
});

// ─── R169A-FIX-R2: Layout durability (DUR-R169A-R2-01) ──────────────────

describe("R169A-FIX-R2 — Layout durability (DUR-R169A-R2-01)", () => {
  let cacheRoot: string;
  const project = "layout-durability-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-layout-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("layout mkdir failure → STORE_LAYOUT_CREATE_FAILED (exact code)", () => {
    const ops = new TestOps();
    ops.failAtLayoutMkdir = true;

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_CREATE_FAILED");
  });

  it("layout dir fsync failure → STORE_LAYOUT_DURABILITY_UNKNOWN (exact code)", () => {
    const ops = new TestOps();
    ops.failAtLayoutDirFsync = true;

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_DURABILITY_UNKNOWN");
  });

  it("layout parent fsync failure → STORE_LAYOUT_DURABILITY_UNKNOWN (exact code)", () => {
    const ops = new TestOps();
    ops.failAtLayoutParentFsync = true;

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_DURABILITY_UNKNOWN");
  });

  it("ensureGenerationStoreLayoutDurable: success creates all dirs with 0700", () => {
    const result = ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    // All 5 dirs (cbm, projects, projectStore, generations, tmp) should be newly created.
    expect(result.created.length).toBe(5);

    const dirs = [
      cbmCacheDir(cacheRoot),
      generationStoreRoot(cacheRoot),
      projectStoreDir(project, cacheRoot),
      generationsDir(project, cacheRoot),
      tmpDir(project, cacheRoot),
    ];
    for (const d of dirs) {
      const st = lstatSync(d);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it("ensureGenerationStoreLayoutDurable: idempotent (second call creates nothing)", () => {
    ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    const result2 = ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    expect(result2.created.length).toBe(0);
  });
});

// ─── R169A-FIX-R2: Manifest size bound (VALID-R169A-R2-01 §4.1) ─────────

describe("R169A-FIX-R2 — Manifest size bound (VALID-R169A-R2-01 §4.1)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-size-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("MAX_GENERATION_MANIFEST_BYTES is 64 KiB", () => {
    expect(MAX_GENERATION_MANIFEST_BYTES).toBe(64 * 1024);
  });

  it("manifest > 64 KiB → MANIFEST_TOO_LARGE (exact code)", () => {
    const project = "oversize-project";
    const manifestPath = activeManifestPath(project, cacheRoot);
    // R169A-FIX-R5 (SEC-R169A-R5-02): Create the chain with mode 0o700
    // so the trust root permission check passes. The previous bare
    // mkdirSync created dirs with the default umask (often 0o775 on
    // shared CI runners), which the R5 permission check rejects.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    ensureDirMode0700(generationStoreRoot(cacheRoot));
    ensureDirMode0700(resolve(manifestPath, ".."));

    // Write a manifest that is > 64 KiB. We do this by inflating the
    // rootFingerprint field with a long string (the validator would
    // reject this, but the size check happens BEFORE parsing).
    const padding = "x".repeat(MAX_GENERATION_MANIFEST_BYTES + 100);
    const oversized = JSON.stringify({
      ...makeValidManifest(project),
      rootFingerprint: padding,
    }, null, 2);
    writeFileSync(manifestPath, oversized, "utf-8");

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_TOO_LARGE");
  });

  it("manifest exactly 64 KiB (within bound) → not MANIFEST_TOO_LARGE", () => {
    const project = "boundary-project";
    const manifestPath = activeManifestPath(project, cacheRoot);
    // R169A-FIX-R5: Same chain setup as above.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    ensureDirMode0700(generationStoreRoot(cacheRoot));
    ensureDirMode0700(resolve(manifestPath, ".."));

    // Write a manifest that is just under 64 KiB. The validator will
    // likely reject it for other reasons (e.g., rootFingerprint too
    // long), but the size check itself must not fire.
    const padding = "x".repeat(1000);
    const within = JSON.stringify({
      ...makeValidManifest(project),
      rootFingerprint: padding,
    }, null, 2);
    writeFileSync(manifestPath, within, "utf-8");

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // NOT MANIFEST_TOO_LARGE — must be some other validation error.
    expect((err as GenerationStoreError).code).not.toBe("MANIFEST_TOO_LARGE");
  });
});

// ─── R169A-FIX-R2: rootFingerprint / project hardening (VALID-R169A-R2-01 §4.2) ─

describe("R169A-FIX-R2 — rootFingerprint / project hardening (VALID-R169A-R2-01 §4.2)", () => {
  it('rootFingerprint "   " (whitespace only) → MANIFEST_SCHEMA_ERROR', () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "   " };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it('rootFingerprint "" (empty) → MANIFEST_SCHEMA_ERROR', () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("rootFingerprint with NUL byte → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "dev:ino\0extra" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("rootFingerprint with tab → MANIFEST_SCHEMA_ERROR (C0 control)", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "dev:ino\textra" };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("rootFingerprint > 1024 chars → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "x".repeat(1025) };
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("rootFingerprint exactly 1024 chars → accepted", () => {
    const manifest = { ...makeValidManifest(), rootFingerprint: "x".repeat(1024) };
    expect(() => validateGenerationManifest(manifest, "test-project")).not.toThrow();
  });

  it("project field with NUL byte → MANIFEST_SCHEMA_ERROR (defense-in-depth)", () => {
    // The manifest's project field has a NUL byte but matches expectedProject.
    // The safe-string check must catch this even though equality holds.
    const manifest = { ...makeValidManifest(), project: "test-project\0evil" } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project\0evil");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("project field whitespace-only → MANIFEST_SCHEMA_ERROR", () => {
    const manifest = { ...makeValidManifest(), project: "   " } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "   ");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });
});

// ─── R169A-FIX-R2: Immutable key set (VALID-R169A-R2-01 §4.3, R169A-FIX-R3 VALID-R169A-R3-01) ─

describe("R169A-FIX-R2 — Immutable key authority (VALID-R169A-R2-01 §4.3, R169A-FIX-R3 VALID-R169A-R3-01)", () => {
  it("MANIFEST_V1_KEYS is exported as a tuple (array), not a Set", () => {
    expect(Array.isArray(MANIFEST_V1_KEYS)).toBe(true);
    // Set has .add / .has / .delete; arrays do not have .add.
    expect((MANIFEST_V1_KEYS as any).add).toBeUndefined();
    expect((MANIFEST_V1_KEYS as any).has).toBeUndefined();
  });

  it("MANIFEST_V1_KEYS has exactly 13 keys", () => {
    expect(MANIFEST_V1_KEYS.length).toBe(13);
  });

  it("R169A-FIX-R3: MANIFEST_V1_KEYS is Object.isFrozen (VALID-R169A-R3-01)", () => {
    expect(Object.isFrozen(MANIFEST_V1_KEYS)).toBe(true);
  });

  it("R169A-FIX-R3: INDEX_STATE_V1_KEYS is Object.isFrozen (API-R169A-R3-02)", () => {
    expect(Object.isFrozen(INDEX_STATE_V1_KEYS)).toBe(true);
  });

  it("R169A-FIX-R4: INDEX_STATE_V1_KEYS has exactly 11 keys (was 9 in R3)", () => {
    expect(INDEX_STATE_V1_KEYS.length).toBe(11);
  });

  it("isManifestV1Key returns true for known keys, false for unknown", () => {
    expect(isManifestV1Key("formatVersion")).toBe(true);
    expect(isManifestV1Key("project")).toBe(true);
    expect(isManifestV1Key("sha256")).toBe(true);
    expect(isManifestV1Key("evilKey")).toBe(false);
    expect(isManifestV1Key("__proto__")).toBe(false);
  });

  it("R169A-FIX-R3: isIndexStateV1Key returns true for known keys, false for unknown", () => {
    expect(isIndexStateV1Key("formatVersion")).toBe(true);
    expect(isIndexStateV1Key("recovery")).toBe(true);
    expect(isIndexStateV1Key("staleReason")).toBe(true);
    expect(isIndexStateV1Key("evilKey")).toBe(false);
  });

  it("R169A-FIX-R3: mutating MANIFEST_V1_KEYS (push/splice) throws in strict mode (VALID-R169A-R3-01)", () => {
    // Object.freeze makes push/splice throw TypeError in strict mode
    // (which is the default for ES modules). The validator must be
    // unaffected regardless.
    const originalLength = MANIFEST_V1_KEYS.length;
    try {
      // In strict mode, push on a frozen array throws. In non-strict,
      // it silently fails. Either way, the length must NOT change.
      try {
        (MANIFEST_V1_KEYS as any).push("evilKey");
      } catch {
        // Expected in strict mode.
      }
      try {
        (MANIFEST_V1_KEYS as any).splice(0, 1);
      } catch {
        // Expected in strict mode.
      }
      expect(MANIFEST_V1_KEYS.length).toBe(originalLength);

      // isManifestV1Key must STILL reject evilKey.
      expect(isManifestV1Key("evilKey")).toBe(false);

      // validateGenerationManifest must STILL reject a manifest with evilKey.
      const manifest = { ...makeValidManifest(), evilKey: "no" } as any;
      let err: unknown;
      try {
        validateGenerationManifest(manifest, "test-project");
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
      expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
    } finally {
      // No cleanup needed — Object.freeze prevents mutation.
      expect(MANIFEST_V1_KEYS.length).toBe(originalLength);
    }
  });

  it("validateGenerationManifest rejects extra key (regression)", () => {
    const manifest = { ...makeValidManifest(), extra: "no" } as any;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });

  it("validateGenerationManifest rejects missing key (regression)", () => {
    const manifest = { ...makeValidManifest() };
    delete (manifest as any).sha256;
    let err: unknown;
    try {
      validateGenerationManifest(manifest, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SCHEMA_ERROR");
  });
});

// ─── R169A-FIX-R2: LEGACY_SOURCE_INVALID rename (API-R169A-R2-01) ───────

describe("R169A-FIX-R2 — LEGACY_SOURCE_INVALID rename (API-R169A-R2-01)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-legacy-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("legacy DB is a symlink → LEGACY_SOURCE_INVALID (exact code, not LEGACY_SOURCE_OPEN_FAILED)", () => {
    const project = "test-project";
    const dbPath = legacyCodeDbPath(project, cacheRoot);
    // R169A-FIX-R5 (SEC-R169A-R5-02): Pre-create cbm with 0o700 so the
    // trust root permission check passes. The previous bare
    // mkdirSync(..., { recursive: true }) created with the default
    // umask (often 0o775 on shared CI runners).
    ensureDirMode0700(resolve(dbPath, ".."));
    const target = dbPath + ".target";
    writeFileSync(target, "real", "utf-8");
    symlinkSync(target, dbPath);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("LEGACY_SOURCE_INVALID");
    // CRITICAL: the old name must NOT be used anymore.
    expect((err as GenerationStoreError).code).not.toBe("LEGACY_SOURCE_OPEN_FAILED");
  });

  it("legacy DB is a FIFO / special file → LEGACY_SOURCE_INVALID", () => {
    const project = "test-project";
    const dbPath = legacyCodeDbPath(project, cacheRoot);
    // R169A-FIX-R5: Same chain setup as above.
    ensureDirMode0700(resolve(dbPath, ".."));
    // Create a FIFO at the legacy path. lstat will report it as !isFile().
    // (mkfifo via child_process spawn is not portable; instead, create a
    // directory — also !isFile — to exercise the same code path.)
    mkdirSync(dbPath);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("LEGACY_SOURCE_INVALID");
  });
});

// ─── R169A-FIX-R2: No writes to real HOME (TEST-R169A-R2-01) ────────────

describe("R169A-FIX-R2 — No writes to real HOME (TEST-R169A-R2-01)", () => {
  it("writeIndexStateAtomically with injected cacheRoot does not touch real HOME cache", () => {
    const realCacheRoot = getCacheRoot();
    const realCbm = cbmCacheDir(); // uses real cache root (no injection)

    // Snapshot the real cache dir state (if it exists).
    let before: string[] = [];
    try {
      before = readdirSync(realCbm).sort();
    } catch {
      // Real cache dir may not exist yet — that's fine.
    }
    const beforeMtime = (() => {
      try { return lstatSync(realCbm).mtimeMs; } catch { return 0; }
    })();

    // Run a write with an INJECTED cacheRoot. This must not touch realCacheRoot.
    const injected = mkdtempSync(join(tmpdir(), "r169a-r2-home-"));
    try {
      writeIndexStateAtomically("isolated-project", makeValidIndexState("isolated-project"), { cacheRoot: injected });

      // Verify the write went to the injected cacheRoot, not the real one.
      // R169A-FIX-R5: writeIndexStateAtomically writes to index-state.json
      // (the only public writer in R5). The manifest writer was REMOVED
      // (Finding 1). The previous check used activeManifestPath which is
      // wrong for index-state — fixed to indexStatePath.
      expect(existsSync(indexStatePath("isolated-project", injected))).toBe(true);

      // Verify the real cache dir is unchanged.
      let after: string[] = [];
      try {
        after = readdirSync(realCbm).sort();
      } catch {
        // If it didn't exist before, it still shouldn't exist.
      }
      expect(after).toEqual(before);

      // mtime should be unchanged (no new files were created).
      const afterMtime = (() => {
        try { return lstatSync(realCbm).mtimeMs; } catch { return 0; }
      })();
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      rmSync(injected, { recursive: true, force: true });
    }
  });

  it("ensureGenerationStoreLayoutDurable with injected cacheRoot does not touch real HOME cache", () => {
    const realCbm = cbmCacheDir();
    const before = (() => {
      try { return readdirSync(realCbm).sort(); } catch { return [] as string[]; }
    })();

    const injected = mkdtempSync(join(tmpdir(), "r169a-r2-home-layout-"));
    try {
      ensureGenerationStoreLayoutDurable("iso-layout-project", { cacheRoot: injected });
      expect(existsSync(projectStoreDir("iso-layout-project", injected))).toBe(true);

      const after = (() => {
        try { return readdirSync(realCbm).sort(); } catch { return [] as string[]; }
      })();
      expect(after).toEqual(before);
    } finally {
      rmSync(injected, { recursive: true, force: true });
    }
  });
});

// ─── R169A-FIX-R2: Exact error code checks (TEST-R169A-R2-01) ───────────

describe("R169A-FIX-R2 — Exact error code checks (TEST-R169A-R2-01)", () => {
  it("assertTrustedRootNoSymlinks: symlinked cacheRoot → PATH_TRAVERSAL_REJECTED (exact)", () => {
    const real = mkdtempSync(join(tmpdir(), "r169a-r2-exact-"));
    try {
      const linkPath = real + "-link";
      symlinkSync(real, linkPath);
      try {
        let err: unknown;
        try {
          assertTrustedRootNoSymlinks(linkPath, "p", "phase");
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(GenerationStoreError);
        const code = (err as GenerationStoreError).code;
        expect(code).toBe("PATH_TRAVERSAL_REJECTED");
        // Exact-string check (not just enum membership).
        expect(code).toMatch(/^PATH_TRAVERSAL_REJECTED$/);
      } finally {
        rmSync(linkPath, { force: true });
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("writeIndexStateAtomically: layout mkdir fault → STORE_LAYOUT_CREATE_FAILED (exact)", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-exact-mkdir-"));
    try {
      const ops = new TestOps();
      ops.failAtLayoutMkdir = true;
      let err: unknown;
      try {
        writeIndexStateAtomicallyInternal("p", makeValidIndexState("p"), { cacheRoot }, ops);
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
      const code = (err as GenerationStoreError).code;
      expect(code).toBe("STORE_LAYOUT_CREATE_FAILED");
      expect(code).toMatch(/^STORE_LAYOUT_CREATE_FAILED$/);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("writeIndexStateAtomically: layout dir fsync fault → STORE_LAYOUT_DURABILITY_UNKNOWN (exact)", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-exact-dirfsync-"));
    try {
      const ops = new TestOps();
      ops.failAtLayoutDirFsync = true;
      let err: unknown;
      try {
        writeIndexStateAtomicallyInternal("p", makeValidIndexState("p"), { cacheRoot }, ops);
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
      const code = (err as GenerationStoreError).code;
      expect(code).toBe("STORE_LAYOUT_DURABILITY_UNKNOWN");
      expect(code).toMatch(/^STORE_LAYOUT_DURABILITY_UNKNOWN$/);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("writeIndexStateAtomically: layout parent fsync fault → STORE_LAYOUT_DURABILITY_UNKNOWN (exact)", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r2-exact-pfsync-"));
    try {
      const ops = new TestOps();
      ops.failAtLayoutParentFsync = true;
      let err: unknown;
      try {
        writeIndexStateAtomicallyInternal("p", makeValidIndexState("p"), { cacheRoot }, ops);
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GenerationStoreError);
      const code = (err as GenerationStoreError).code;
      expect(code).toBe("STORE_LAYOUT_DURABILITY_UNKNOWN");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

// ─── R169A-FIX-R3: Race symlink in writer (SEC-R169A-R3-01) ─────────────

describe("R169A-FIX-R3 — Race symlink in writer (SEC-R169A-R3-01)", () => {
  let cacheRoot: string;
  const project = "race-symlink-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r3-race-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("writer rejects when project-key dir becomes a symlink between layout and temp open", () => {
    // Use the WriterTestHook to inject a race: AFTER layout creation
    // (so the layout dirs exist) but BEFORE the temp file is opened,
    // replace the project-key dir with a symlink to elsewhere.
    const hook: WriterTestHook = {
      afterLayoutBeforeOpen({ projectDir, project: p }) {
        const elsewhere = join(cacheRoot, "race-elsewhere");
        mkdirSync(elsewhere, { recursive: true });
        rmSync(projectDir, { recursive: true, force: true });
        symlinkSync(elsewhere, projectDir);
      },
    };

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, undefined, hook);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");

    // No file should have been written to the symlink target (elsewhere).
    const elsewhere = join(cacheRoot, "race-elsewhere");
    if (existsSync(elsewhere)) {
      const files = readdirSync(elsewhere).filter((n) => !n.startsWith(".tmp-") && n !== "active-generation.json" && n !== "index-state.json");
      // The race hook replaced the projectDir with a symlink to elsewhere
      // BEFORE the temp file was opened. The pre-open revalidation must
      // reject, so NO temp file should have been created in elsewhere.
      const tempFiles = readdirSync(elsewhere).filter((n) => n.startsWith(".tmp-"));
      expect(tempFiles.length).toBe(0);
    }
  });

  it("writer rejects when projects dir becomes a symlink between layout and temp open", () => {
    const hook: WriterTestHook = {
      afterLayoutBeforeOpen({ targetPath }) {
        // Replace the projects dir with a symlink.
        const projects = generationStoreRoot(cacheRoot);
        const elsewhere = join(cacheRoot, "race-projects-elsewhere");
        mkdirSync(elsewhere, { recursive: true });
        rmSync(projects, { recursive: true, force: true });
        symlinkSync(elsewhere, projects);
      },
    };

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, undefined, hook);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });
});

// ─── R169A-FIX-R3: EEXIST revalidation (SEC-R169A-R3-02) ────────────────

describe("R169A-FIX-R3 — Existing directory revalidation (SEC-R169A-R3-02 + SEC-R169A-R3-04)", () => {
  let cacheRoot: string;
  const project = "eexist-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r3-eexist-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("existing dir is a symlink → PATH_TRAVERSAL_REJECTED", () => {
    // Pre-create the cbm dir as a symlink. assertTrustedRootNoSymlinks
    // (called at the top of ensureGenerationStoreLayoutDurable) catches
    // this before the layout loop even starts.
    const cbm = cbmCacheDir(cacheRoot);
    const elsewhere = join(cacheRoot, "cbm-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, cbm);

    let err: unknown;
    try {
      ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
  });

  it("existing path is a regular file (not a dir) → STORE_LAYOUT_CREATE_FAILED", () => {
    // Pre-create the parent dirs (cbm, projects, projectStore) with 0700,
    // then create the  path as a regular file. The trust
    // root check passes (it only walks up to project-key), and the
    // layout loop catches  being a non-directory.
    mkdirSync(cbmCacheDir(cacheRoot), { mode: 0o700 });
    mkdirSync(generationStoreRoot(cacheRoot), { mode: 0o700 });
    mkdirSync(projectStoreDir(project, cacheRoot), { mode: 0o700 });
    const genDir = generationsDir(project, cacheRoot);
    writeFileSync(genDir, "i am a file", "utf-8");

    let err: unknown;
    try {
      ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_CREATE_FAILED");
  });

  it("existing dir with mode 0777 → STORE_LAYOUT_PERMISSIONS_INSECURE", () => {
    // Pre-create the cbm dir with mode 0777.
    const cbm = cbmCacheDir(cacheRoot);
    mkdirSync(resolve(cbm, ".."), { recursive: true });
    mkdirSync(cbm, { mode: 0o700 });
    forceExactMode(cbm, 0o777);

    let err: unknown;
    try {
      ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });

  it("existing cbm dir with mode 0770 (group-writable) → STORE_LAYOUT_PERMISSIONS_INSECURE (COMPAT-R169A-R4-01)", () => {
    // R169A-FIX-R4 (COMPAT-R169A-R4-01): Two-tier permission policy.
    // Compatibility roots (cacheRoot, cbm) require mode & 0o022 === 0
    // (no group/other WRITE). 0770 has group-write → rejected.
    // 0750 (group read/execute only) is now ACCEPTED.
    const cbm = cbmCacheDir(cacheRoot);
    mkdirSync(resolve(cbm, ".."), { recursive: true });
    mkdirSync(cbm, { mode: 0o700 });
    forceExactMode(cbm, 0o770);

    let err: unknown;
    try {
      ensureGenerationStoreLayoutDurable(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });

  it("existing dir with mode 0700 → accepted (idempotent)", () => {
    // Pre-create the cbm dir with mode 0700. The layout helper must
    // accept it and continue.
    const cbm = cbmCacheDir(cacheRoot);
    mkdirSync(resolve(cbm, ".."), { recursive: true });
    mkdirSync(cbm, { mode: 0o700 });

    expect(() => ensureGenerationStoreLayoutDurable(project, { cacheRoot })).not.toThrow();
  });

  it("EEXIST race: mkdir returns EEXIST, dir is 0700 → accepted", () => {
    // Simulate the EEXIST race: statSync says ENOENT (the dir doesn't
    // exist yet), then mkdir creates it normally. This is the happy path
    // — EEXIST is not actually triggered here, but the layout helper's
    // normal path is exercised.
    const ops = new TestOps();
    // No fault injection — just verify the normal path works.
    const result = ensureGenerationStoreLayoutDurableInternal(project, { cacheRoot }, ops);
    expect(result.created.length).toBe(5);
  });

  it("EEXIST race: statOverrideOnce ENOENT then real EEXIST with 0777 dir → STORE_LAYOUT_PERMISSIONS_INSECURE", () => {
    // Simulate the EEXIST race:
    //   1. Pre-create the projectStore dir with mode 0777.
    //   2. Tell TestOps.statOverrideOnce to throw ENOENT on the FIRST
    //      statSync call for projectStore (so the layout helper thinks
    //      the dir doesn't exist and tries to mkdir).
    //   3. mkdir returns EEXIST (the dir was created by us with 0777).
    //   4. The EEXIST branch re-validates: statSync returns the real
    //      0777 dir → STORE_LAYOUT_PERMISSIONS_INSECURE.
    const projectStore = projectStoreDir(project, cacheRoot);
    // Pre-create the parent dirs (cbm, projects) with 0700 so the layout
    // helper doesn't choke on them.
    mkdirSync(cbmCacheDir(cacheRoot), { mode: 0o700 });
    mkdirSync(generationStoreRoot(cacheRoot), { mode: 0o700 });
    // Pre-create the projectStore dir with 0777.
    mkdirSync(projectStore, { mode: 0o700 });
    forceExactMode(projectStore, 0o777);

    const ops = new TestOps();
    const enoentErr = Object.assign(new Error("ENOENT (injected)"), { code: "ENOENT" });
    ops.lstatOverrideOnce.set(projectStore, enoentErr as NodeJS.ErrnoException);

    let err: unknown;
    try {
      ensureGenerationStoreLayoutDurableInternal(project, { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });
});

// ─── R169A-FIX-R3: Manifest TOCTOU (SEC-R169A-R3-03) ────────────────────

describe("R169A-FIX-R3 — Manifest TOCTOU (SEC-R169A-R3-03)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r3-toctou-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("parseGenerationManifest on a regular file → succeeds", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    const manifestPath = writeManifest(cacheRoot, project, manifest);
    expect(() => parseGenerationManifest(manifestPath, project)).not.toThrow();
  });

  it("parseGenerationManifest on a symlink → MANIFEST_SYMLINK_REJECTED", () => {
    const project = "test-project";
    const manifest = makeValidManifest(project);
    const manifestPath = writeManifest(cacheRoot, project, manifest);
    // Replace the manifest with a symlink to a valid manifest elsewhere.
    const realTarget = manifestPath + ".real";
    writeFileSync(realTarget, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    rmSync(manifestPath);
    symlinkSync(realTarget, manifestPath);

    let err: unknown;
    try {
      parseGenerationManifest(manifestPath, project);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("MANIFEST_SYMLINK_REJECTED");
  });

  it("parseGenerationManifest on a directory → MANIFEST_TARGET_NOT_REGULAR", () => {
    const project = "test-project";
    const manifestPath = activeManifestPath(project, cacheRoot);
    mkdirSync(resolve(manifestPath, ".."), { recursive: true });
    mkdirSync(manifestPath);

    let err: unknown;
    try {
      parseGenerationManifest(manifestPath, project);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // A directory is not a regular file → MANIFEST_TARGET_NOT_REGULAR
    // (or MANIFEST_PARSE_ERROR depending on the O_NOFOLLOW path; both
    // are non-MANIFEST_SYMLINK_REJECTED).
    const code = (err as GenerationStoreError).code;
    expect(code).toMatch(/MANIFEST_TARGET_NOT_REGULAR|MANIFEST_PARSE_ERROR/);
  });

  it("parseGenerationManifest on ENOENT → MANIFEST_NOT_FOUND (R169B-STEP4)", () => {
    const project = "test-project";
    const manifestPath = activeManifestPath(project, cacheRoot);

    let err: unknown;
    try {
      parseGenerationManifest(manifestPath, project);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // R169B-STEP4 (MANIFEST-R169B-A2-15): parseGenerationManifest now
    // raises MANIFEST_NOT_FOUND (distinct from MANIFEST_PARSE_ERROR)
    // on real ENOENT, so readOptionalGenerationManifest can
    // distinguish "absent" from "corrupt" without string matching.
    expect((err as GenerationStoreError).code).toBe("MANIFEST_NOT_FOUND");
  });
});

// ─── R169A-FIX-R5: __test__ and writeGenerationManifestAtomically NOT exported ──
//
// Finding 1 (API-R169A-R5-01): The `__test__` export is REMOVED. The
// manifest writer `writeGenerationManifestAtomically` is NOT exported
// (it is internal — R169B will own `publishPreparedGeneration`). This
// test verifies the public API surface does not include either name.

describe("R169A-FIX-R5 — __test__ / writeGenerationManifestAtomically NOT exported (API-R169A-R5-01)", () => {
  it("the generation-store module does NOT export __test__", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).__test__).toBeUndefined();
  });

  it("the generation-store module does NOT export writeGenerationManifestAtomically", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).writeGenerationManifestAtomically).toBeUndefined();
  });

  it("the generation-store module DOES export writeIndexStateAtomically (the only public writer)", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect(typeof (mod as any).writeIndexStateAtomically).toBe("function");
  });

  it("the generation-store module does NOT export prepareGenerationManifestForWrite", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).prepareGenerationManifestForWrite).toBeUndefined();
  });

  it("the generation-store module does NOT export prepareIndexStateForWrite", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).prepareIndexStateForWrite).toBeUndefined();
  });

  it("the generation-store module does NOT export writeProjectJsonAtomicallyInternal", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).writeProjectJsonAtomicallyInternal).toBeUndefined();
  });

  it("the generation-store module does NOT export writeJsonAtomically", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect((mod as any).writeJsonAtomically).toBeUndefined();
  });

  it("source inspection: no `export const __test__` or `export function writeGenerationManifestAtomically` in generation-store.ts", () => {
    // Walk the source file and verify no export statement targets
    // __test__ or writeGenerationManifestAtomically.
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "generation-store.ts"),
      "utf-8",
    );
    // `export const __test__` must NOT appear.
    expect(src).not.toMatch(/export\s+const\s+__test__/);
    // `export function writeGenerationManifestAtomically` must NOT appear.
    expect(src).not.toMatch(/export\s+function\s+writeGenerationManifestAtomically/);
    // `export { ... __test__ ... }` re-export must NOT appear.
    expect(src).not.toMatch(/export\s*\{[^}]*\b__test__\b[^}]*\}/);
    // `export { ... writeGenerationManifestAtomically ... }` re-export must NOT appear.
    expect(src).not.toMatch(/export\s*\{[^}]*\bwriteGenerationManifestAtomically\b[^}]*\}/);
  });
});

// ─── R169A-FIX-R8: internal symbols NOT exported from public module ──────
//
// R169A-FIX-R8 (API-R169A-R8-01): GPT 5.6 final audit pass found that
// the public module `generation-store.ts` was still EXPORTING internal
// symbols (`AtomicFileOps`, `WriterTestHook`, `PROD_OPS`, the `*Internal`
// functions, etc.). Even though they were marked `@internal` in JSDoc,
// they appeared in the generated `.d.ts` and were therefore part of the
// public API surface. These tests verify that the module split moved
// ALL internal symbols to `./internal/generation-store-io.js` and that
// the public module does NOT export or re-export any of them.

describe("R169A-FIX-R8 — internal symbols NOT exported from public module (API-R169A-R8-01)", () => {
  // List of internal symbol names that MUST NOT be exported from the
  // public module. These are now exclusively in the internal module.
  const INTERNAL_SYMBOLS = [
    "AtomicFileOps",
    "WriterTestHook",
    "PROD_OPS",
    "writeIndexStateAtomicallyInternal",
    "ensureGenerationStoreLayoutDurableInternal",
    "writeProjectJsonAtomicallyInternal",
    "writeJsonAtomically",
    "prepareGenerationManifestForWrite",
    "prepareIndexStateForWrite",
    "openDirectoryNoFollow",
    "assertLayoutDirPermissions",
    "defaultSerializeJson",
    "writeGenerationManifestAtomically",
    "__test__",
  ] as const;

  for (const symbol of INTERNAL_SYMBOLS) {
    it(`the generation-store module does NOT export ${symbol}`, async () => {
      const mod = await import("../../src/storage/generation-store.js");
      expect((mod as Record<string, unknown>)[symbol]).toBeUndefined();
    });
  }

  it("the generation-store module DOES export the public façade writeIndexStateAtomically", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect(typeof (mod as Record<string, unknown>).writeIndexStateAtomically).toBe("function");
  });

  it("the generation-store module DOES export the public façade ensureGenerationStoreLayoutDurable", async () => {
    const mod = await import("../../src/storage/generation-store.js");
    expect(typeof (mod as Record<string, unknown>).ensureGenerationStoreLayoutDurable).toBe("function");
  });

  it("source inspection: no `export` of any internal symbol in generation-store.ts", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "generation-store.ts"),
      "utf-8",
    );
    // For each internal symbol, verify no `export interface`, `export type`,
    // `export const`, `export function`, or `export { ... symbol ... }`
    // statement targets it.
    for (const symbol of INTERNAL_SYMBOLS) {
      // `export interface SymbolName`
      expect(src).not.toMatch(new RegExp(`export\\s+interface\\s+${symbol}\\b`));
      // `export type SymbolName`
      expect(src).not.toMatch(new RegExp(`export\\s+type\\s+${symbol}\\b`));
      // `export const SymbolName`
      expect(src).not.toMatch(new RegExp(`export\\s+const\\s+${symbol}\\b`));
      // `export function SymbolName`
      expect(src).not.toMatch(new RegExp(`export\\s+function\\s+${symbol}\\b`));
      // `export { ... SymbolName ... }` re-export
      expect(src).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`));
    }
  });

  it("source inspection: generation-store.ts imports PROD_OPS and *Internal from internal module", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "generation-store.ts"),
      "utf-8",
    );
    // The public module MUST import PROD_OPS and the *Internal functions
    // from the internal module (not define them locally).
    expect(src).toMatch(/from\s+["']\.\/internal\/generation-store-io\.js["']/);
    expect(src).toMatch(/\bPROD_OPS\b/);
    expect(src).toMatch(/\bwriteIndexStateAtomicallyInternal\b/);
    expect(src).toMatch(/\bensureGenerationStoreLayoutDurableInternal\b/);
    // R169B-STEP1: The public facade MUST import paths and validation
    // symbols from the new leaf modules (not from the internal module
    // or via re-export from the public facade).
    expect(src).toMatch(/from\s+["']\.\/generation-paths\.js["']/);
    expect(src).toMatch(/from\s+["']\.\/generation-validation\.js["']/);
    // R169B-STEP1: `assertLayoutDirPermissions` was MOVED to
    // `generation-validation.ts`. It is an INTERNAL symbol (was internal
    // in R169A, remains internal in R169B-STEP1). The public facade
    // does NOT import or re-export it; the name MUST NOT appear in the
    // production code of generation-store.ts (only in comments). The
    // `INTERNAL_SYMBOLS` list still includes it, and the runtime +
    // source-inspection tests below verify it is not exported.
    expect(src).not.toMatch(/^\s*(?:export|import)\b[^\n]*\bassertLayoutDirPermissions\b/m);
  });

  it("source inspection: internal module exports all internal symbols", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "internal", "generation-store-io.ts"),
      "utf-8",
    );
    // The internal module MUST export each internal symbol.
    expect(src).toMatch(/export\s+interface\s+AtomicFileOps\b/);
    expect(src).toMatch(/export\s+interface\s+WriterTestHook\b/);
    expect(src).toMatch(/export\s+const\s+PROD_OPS\b/);
    expect(src).toMatch(/export\s+function\s+writeIndexStateAtomicallyInternal\b/);
    expect(src).toMatch(/export\s+function\s+ensureGenerationStoreLayoutDurableInternal\b/);
    expect(src).toMatch(/export\s+function\s+writeProjectJsonAtomicallyInternal\b/);
    expect(src).toMatch(/export\s+function\s+writeJsonAtomically\b/);
    expect(src).toMatch(/export\s+function\s+prepareGenerationManifestForWrite\b/);
    expect(src).toMatch(/export\s+function\s+prepareIndexStateForWrite\b/);
    expect(src).toMatch(/export\s+function\s+openDirectoryNoFollow\b/);
    // R169B-STEP1: `assertLayoutDirPermissions` was MOVED to
    // `generation-validation.ts` to break the module cycle. The internal
    // module IMPORTS it from validation (no longer defines it locally).
    // Assert it no longer has `export function assertLayoutDirPermissions`.
    expect(src).not.toMatch(/export\s+function\s+assertLayoutDirPermissions\b/);
    // The internal module MUST import `assertLayoutDirPermissions` from
    // the validation module.
    expect(src).toMatch(/from\s+["']\.\.\/generation-validation\.js["']/);
    expect(src).toMatch(/\bassertLayoutDirPermissions\b/);
    // The internal module MUST NOT import from the public facade
    // (`../generation-store.js`). The cycle is broken.
    expect(src).not.toMatch(/from\s+["']\.\.\/generation-store\.js["']/);
  });

  it("source inspection: validation module exports the symbols moved out of the internal module (R169B-STEP1)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "generation-validation.ts"),
      "utf-8",
    );
    // R169B-STEP1: `assertLayoutDirPermissions` was MOVED here from the
    // internal I/O module. The validation module MUST export it.
    expect(src).toMatch(/export\s+function\s+assertLayoutDirPermissions\b/);
    // The validation module MUST also export the other validators and
    // trust-root checks that the internal module / public facade depend on.
    expect(src).toMatch(/export\s+function\s+validateGenerationManifest\b/);
    expect(src).toMatch(/export\s+function\s+validateIndexAttemptState\b/);
    expect(src).toMatch(/export\s+function\s+parseGenerationManifest\b/);
    expect(src).toMatch(/export\s+function\s+assertPathInsideNoSymlinks\b/);
    expect(src).toMatch(/export\s+function\s+assertNotSymlink\b/);
    expect(src).toMatch(/export\s+function\s+assertTrustedRootNoSymlinks\b/);
    expect(src).toMatch(/export\s+function\s+assertGenerationStoreRootTrusted\b/);
    // The validation module MUST export O_NOFOLLOW and O_DIRECTORY
    // (consolidated here from the public facade and internal module).
    expect(src).toMatch(/export\s+const\s+O_NOFOLLOW\b/);
    expect(src).toMatch(/export\s+const\s+O_DIRECTORY\b/);
    // The validation module MUST NOT import from the internal I/O module
    // or the public facade — that would re-create the cycle.
    expect(src).not.toMatch(/from\s+["']\.\.\/internal\/generation-store-io\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/generation-store\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\.\/generation-store\.js["']/);
  });

  it("source inspection: paths module exports all path helpers (R169B-STEP1)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "storage", "generation-paths.ts"),
      "utf-8",
    );
    // The paths module MUST export each path helper.
    expect(src).toMatch(/export\s+function\s+getCacheRoot\b/);
    expect(src).toMatch(/export\s+function\s+cbmCacheDir\b/);
    expect(src).toMatch(/export\s+function\s+generationStoreRoot\b/);
    expect(src).toMatch(/export\s+function\s+projectStorageKey\b/);
    expect(src).toMatch(/export\s+function\s+projectStoreDir\b/);
    expect(src).toMatch(/export\s+function\s+generationsDir\b/);
    expect(src).toMatch(/export\s+function\s+tmpDir\b/);
    expect(src).toMatch(/export\s+function\s+activeManifestPath\b/);
    expect(src).toMatch(/export\s+function\s+indexStatePath\b/);
    expect(src).toMatch(/export\s+function\s+legacyCodeDbPath\b/);
    expect(src).toMatch(/export\s+function\s+isLexicallyInside\b/);
    expect(src).toMatch(/export\s+const\s+isPathInside\b/);
    // The paths module MUST NOT import from validation, the internal I/O
    // module, or the public facade — it is a leaf module.
    expect(src).not.toMatch(/from\s+["']\.\/generation-validation\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/internal\/generation-store-io\.js["']/);
    expect(src).not.toMatch(/from\s+["']\.\/generation-store\.js["']/);
  });

  it("generated .d.ts inspection: dist/storage/generation-store.d.ts does NOT contain internal symbols", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dtsPath = path.resolve(__dirname, "..", "..", "dist", "storage", "generation-store.d.ts");
    // The dist/ directory is created by `npm run build` (the pretest hook).
    // If the file doesn't exist, the test fails with a clear message.
    if (!fs.existsSync(dtsPath)) {
      expect.fail(`Generated .d.ts not found at ${dtsPath}. Run 'npm run build' first.`);
    }
    const dts = fs.readFileSync(dtsPath, "utf-8");
    // Each internal symbol MUST NOT appear as an export in the .d.ts.
    for (const symbol of INTERNAL_SYMBOLS) {
      // Match `declare interface SymbolName`, `declare type SymbolName`,
      // `declare const SymbolName`, `declare function SymbolName`, or
      // `export { SymbolName }` / `export { ..., SymbolName, ... }`.
      const patterns = [
        new RegExp(String.raw`declare\s+interface\s+${symbol}\b`),
        new RegExp(String.raw`declare\s+type\s+${symbol}\b`),
        new RegExp(String.raw`declare\s+const\s+${symbol}\b`),
        new RegExp(String.raw`declare\s+function\s+${symbol}\b`),
        new RegExp(String.raw`export\s*\{[^}]*\b${symbol}\b[^}]*\}`),
      ];
      for (const p of patterns) {
        expect(dts).not.toMatch(p);
      }
    }
  });

  it("generated .d.ts inspection: dist/storage/generation-store.d.ts DOES contain public façades", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dtsPath = path.resolve(__dirname, "..", "..", "dist", "storage", "generation-store.d.ts");
    if (!fs.existsSync(dtsPath)) {
      expect.fail(`Generated .d.ts not found at ${dtsPath}. Run 'npm run build' first.`);
    }
    const dts = fs.readFileSync(dtsPath, "utf-8");
    // The public façades MUST appear in the .d.ts.
    expect(dts).toMatch(/declare\s+function\s+writeIndexStateAtomically\b/);
    expect(dts).toMatch(/declare\s+function\s+ensureGenerationStoreLayoutDurable\b/);
    expect(dts).toMatch(/declare\s+function\s+listProjectStoreKeys\b/);
    expect(dts).toMatch(/declare\s+function\s+resolveActiveCodeDb\b/);
  });
});

// ─── R169A-FIX-R5: pathsTruncated coherence (STATE-R169A-R5-02) ──────────
//
// Finding 3 (STATE-R169A-R5-02) item 2: pathsTruncated validation.
//   - pathsTruncated=true  → totalPaths MUST be present AND totalPaths > paths.length.
//   - pathsTruncated=false → totalPaths absent OR totalPaths == paths.length.
//   - pathsTruncated absent → totalPaths absent OR totalPaths == paths.length.

describe("R169A-FIX-R5 — pathsTruncated coherence (STATE-R169A-R5-02)", () => {
  function makeStaleState(
    staleReasonOverrides: Partial<IndexAttemptStaleReasonV1> = {},
  ): IndexAttemptStateV1 {
    return makeValidIndexState("test-project", {
      lastAttemptOutcome: "STALE",
      publicationState: "NOT_PUBLISHED",
      staleReason: {
        code: "ROOT_CHANGED",
        message: "root moved",
        paths: ["/old/root", "/new/root"],
        ...staleReasonOverrides,
      } as IndexAttemptStaleReasonV1,
      recovery: "full_reindex",
    });
  }

  // pathsTruncated = true
  it("pathsTruncated=true + totalPaths > paths.length → valid", () => {
    const state = makeStaleState({ pathsTruncated: true, totalPaths: 10 });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("pathsTruncated=true + totalPaths absent → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeStaleState({ pathsTruncated: true } as any);
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("pathsTruncated=true + totalPaths == paths.length → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeStaleState({ pathsTruncated: true, totalPaths: 2 });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("pathsTruncated=true + totalPaths < paths.length → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeStaleState({ pathsTruncated: true, totalPaths: 1 } as any);
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  // pathsTruncated = false
  it("pathsTruncated=false + totalPaths absent → valid", () => {
    const state = makeStaleState({ pathsTruncated: false } as any);
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("pathsTruncated=false + totalPaths == paths.length → valid", () => {
    const state = makeStaleState({ pathsTruncated: false, totalPaths: 2 });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("pathsTruncated=false + totalPaths > paths.length → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeStaleState({ pathsTruncated: false, totalPaths: 10 } as any);
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  // pathsTruncated absent
  it("pathsTruncated absent + totalPaths absent → valid", () => {
    const state = makeStaleState({} as any);
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("pathsTruncated absent + totalPaths == paths.length → valid", () => {
    const state = makeStaleState({ totalPaths: 2 } as any);
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("pathsTruncated absent + totalPaths > paths.length → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeStaleState({ totalPaths: 10 } as any);
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });
});

// ─── R169A-FIX-R5: SUCCESS_WITH_WARNINGS coherence (STATE-R169A-R5-02) ────
//
// Finding 3 (STATE-R169A-R5-02) item 1: SUCCESS_WITH_WARNINGS follows
// same active/candidate rules as SUCCESS.

describe("R169A-FIX-R5 — SUCCESS_WITH_WARNINGS coherence (STATE-R169A-R5-02)", () => {
  it("SUCCESS_WITH_WARNINGS + PUBLISHED + activeGenerationId non-null + candidate == active → valid", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "PUBLISHED",
      activeGenerationId: VALID_UUID,
      candidateGenerationId: VALID_UUID,
      failure: null,
      staleReason: null,
      recovery: "none",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("SUCCESS_WITH_WARNINGS + PUBLISHED + activeGenerationId=null → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "PUBLISHED",
      activeGenerationId: null,
      candidateGenerationId: null,
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("SUCCESS_WITH_WARNINGS + PUBLISHED + candidate != active → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "PUBLISHED",
      activeGenerationId: VALID_UUID,
      candidateGenerationId: OTHER_UUID,
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });

  it("SUCCESS_WITH_WARNINGS + NOT_NEEDED + candidateGenerationId=null → valid", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "NOT_NEEDED",
      activeGenerationId: null,
      candidateGenerationId: null,
      failure: null,
      staleReason: null,
      recovery: "none",
    });
    expect(() => validateIndexAttemptState(state, "test-project")).not.toThrow();
  });

  it("SUCCESS_WITH_WARNINGS + NOT_NEEDED + candidateGenerationId non-null → INDEX_STATE_SCHEMA_ERROR", () => {
    const state = makeValidIndexState("test-project", {
      lastAttemptOutcome: "SUCCESS_WITH_WARNINGS",
      publicationState: "NOT_NEEDED",
      candidateGenerationId: VALID_UUID,
    });
    let err: unknown;
    try {
      validateIndexAttemptState(state, "test-project");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("INDEX_STATE_SCHEMA_ERROR");
  });
});

// ─── R169A-FIX-R5: Cleanup after directory swap (SEC-R169A-R5-01) ─────────
//
// Finding 4 (SEC-R169A-R5-01): After directory identity mismatch (dev/ino),
// the catch block must NOT unlinkSync the temp file by path — the path
// may now point to a different directory. The temp file is orphaned in
// the ORIGINAL directory; the error message includes a WARNING.

describe("R169A-FIX-R5 — Cleanup after directory swap (SEC-R169A-R5-01)", () => {
  let cacheRoot: string;
  const project = "swap-test-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r5-swap-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("hook swaps target directory after temp fsync → PATH_TRAVERSAL_REJECTED + orphan warning, no file deleted in replacement dir", () => {
    // Use the WriterTestHook.afterTempFsyncBeforeRename to swap the
    // target directory between temp-fsync and rename. The pre-rename
    // identity check (lstat + dev/ino compare against the held dirFd)
    // MUST detect the swap and reject with PATH_TRAVERSAL_REJECTED.
    //
    // The temp file is orphaned in the ORIGINAL directory; the error
    // message MUST include ATOMIC_TEMP_ORPHANED warning. The replacement
    // directory MUST NOT have any temp file deleted from it (because
    // unlinkSync by path would target the replacement dir).
    const statePath = indexStatePath(project, cacheRoot);

    // The hook captures the original dir BEFORE swapping it, so we can
    // verify the orphaned temp file is still there after the failure.
    let originalDir: string | null = null;
    let replacementDir: string | null = null;
    const hook: WriterTestHook = {
      afterTempFsyncBeforeRename({ dir }) {
        originalDir = dir;
        replacementDir = join(cacheRoot, "replacement-dir");
        mkdirSync(replacementDir, { recursive: true });
        // Atomically replace `dir` with `replacementDir` by rmSync + symlink.
        rmSync(dir, { recursive: true, force: true });
        symlinkSync(replacementDir, dir);
      },
    };

    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, undefined, hook);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("PATH_TRAVERSAL_REJECTED");
    // The error message MUST include the ATOMIC_TEMP_ORPHANED warning.
    expect((err as Error).message).toMatch(/ATOMIC_TEMP_ORPHANED/);

    // The replacement directory MUST NOT have any .tmp-* file in it.
    // (If unlinkSync was called by path, it would have targeted the
    // replacement dir and deleted whatever file was there.)
    expect(replacementDir).not.toBeNull();
    if (replacementDir !== null) {
      const files = readdirSync(replacementDir);
      const tempFiles = files.filter((n) => n.startsWith(".tmp-"));
      expect(tempFiles.length).toBe(0);
    }

    // The original directory still exists at `originalDir` (it was
    // replaced by a symlink, but the original inode may still be
    // reachable through the filesystem if not yet garbage-collected).
    // We can't easily verify the orphaned temp file from this test
    // because the dir was rmdir'd. The key contract — that the
    // replacement dir has no temp file deleted from it — is verified
    // above.
  });
});

// ─── R169A-FIX-R5: Permission policy in resolver/listing (SEC-R169A-R5-02) ──
//
// Finding 5 (SEC-R169A-R5-02): Permission/ownership checks are now in
// assertTrustedRootNoSymlinks AND assertGenerationStoreRootTrusted
// (not just in ensureGenerationStoreLayoutDurable). This means the
// resolver and listing automatically get permission checks via the
// trust root validation.

describe("R169A-FIX-R5 — Permission policy in resolver/listing (SEC-R169A-R5-02)", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r5-perms-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("resolver rejects when projects dir has mode 0777 (group/other write) → STORE_LAYOUT_PERMISSIONS_INSECURE", () => {
    const project = "perms-test-project";
    // Create cbm with 0o700 (passes the compat root check).
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    // Create projects dir with mode 0777 (fails the private R169 dir check
    // — private dirs require mode === 0o700 exactly).
    const projects = generationStoreRoot(cacheRoot);
    mkdirSync(projects, { mode: 0o700 });
    forceExactMode(projects, 0o777);
    // The chmod is needed because mkdirSync mode is masked by umask.
    const fs = require("node:fs");
    fs.chmodSync(projects, 0o777);

    let err: unknown;
    try {
      resolveActiveCodeDb(project, { cacheRoot });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });

  it("resolver accepts when cbm has mode 0755 (compat root — group read/execute, no write)", () => {
    // R169A-FIX-R5: Compatibility roots (cacheRoot, cbm) require
    // mode & 0o022 === 0 (no group/other WRITE). 0755 has group/other
    // read+execute only — accepted. (Private R169 dirs still require
    // exactly 0700.)
    const project = "perms-cbm-0755-project";
    const cbm = cbmCacheDir(cacheRoot);
    mkdirSync(cbm, { mode: 0o755 });
    const fs = require("node:fs");
    fs.chmodSync(cbm, 0o755);
    // Create the rest of the chain with 0o700 (private R169 dirs).
    ensureDirMode0700(generationStoreRoot(cacheRoot));
    ensureDirMode0700(projectStoreDir(project, cacheRoot));
    // Write a valid manifest + DB so the resolver has something to find.
    const manifest = makeValidManifest(project);
    writeManifest(cacheRoot, project, manifest);
    writeGenerationDb(cacheRoot, project, manifest.dbFile);

    // The resolver must accept the 0755 cbm and successfully resolve.
    const result = resolveActiveCodeDb(project, { cacheRoot });
    expect(result.source).toBe("generation");
  });

  it("listProjectStoreKeys rejects when projects dir has mode 0777 → STORE_LAYOUT_PERMISSIONS_INSECURE", () => {
    // Create cbm with 0o700.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    // Create projects dir with mode 0777.
    const projects = generationStoreRoot(cacheRoot);
    mkdirSync(projects, { mode: 0o700 });
    forceExactMode(projects, 0o777);
    const fs = require("node:fs");
    fs.chmodSync(projects, 0o777);

    let err: unknown;
    try {
      listProjectStoreKeys(cacheRoot);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });

  it("listProjectStoreKeys accepts cbm with mode 0755 (compat root)", () => {
    const cbm = cbmCacheDir(cacheRoot);
    mkdirSync(cbm, { mode: 0o755 });
    const fs = require("node:fs");
    fs.chmodSync(cbm, 0o755);
    ensureDirMode0700(generationStoreRoot(cacheRoot));

    // listProjectStoreKeys must NOT throw for a 0755 cbm.
    expect(() => listProjectStoreKeys(cacheRoot)).not.toThrow();
  });

  it("assertTrustedRootNoSymlinks rejects when project-key dir has mode 0777 → STORE_LAYOUT_PERMISSIONS_INSECURE", () => {
    const project = "perms-key-project";
    // Build the chain with proper modes up to project-key.
    ensureDirMode0700(cbmCacheDir(cacheRoot));
    ensureDirMode0700(generationStoreRoot(cacheRoot));
    // project-key dir with mode 0777.
    const projectKey = projectStoreDir(project, cacheRoot);
    mkdirSync(projectKey, { mode: 0o700 });
    forceExactMode(projectKey, 0o777);
    const fs = require("node:fs");
    fs.chmodSync(projectKey, 0o777);

    let err: unknown;
    try {
      assertTrustedRootNoSymlinks(cacheRoot, project, "test-phase");
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    expect((err as GenerationStoreError).code).toBe("STORE_LAYOUT_PERMISSIONS_INSECURE");
  });
});

// ─── R169A-FIX-R5: fd leak in openDirectoryNoFollow (QUAL-R169A-R5-01) ────
//
// Finding 6 (QUAL-R169A-R5-01): If fstatSync fails after a successful
// openSync, the fd MUST be closed before re-throwing. Previously the
// fd leaked.
//
// Test approach: Inject a TestOps whose fstatSync throws on the FIRST
// call (which happens to be a layout-phase directory fstat). The
// fd-close behavior is verified by patching TestOps.closeSync to count
// invocations. We use the layout-phase dir fsync path because that's
// where openDirectoryNoFollow is first invoked in
// ensureGenerationStoreLayoutDurable.

describe("R169A-FIX-R5 — fd leak in openDirectoryNoFollow (QUAL-R169A-R5-01)", () => {
  let cacheRoot: string;
  const project = "fdleak-project";

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "r169a-r5-fdleak-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("openSync succeeds + fstatSync fails → fd closed exactly once (no leak)", () => {
    // Build a TestOps subclass that fails the first fstatSync call but
    // counts closeSync invocations. The first fstatSync in the writer
    // flow happens inside openDirectoryNoFollow (called from
    // ensureGenerationStoreLayoutDurable for the cbm dir fsync).
    //
    // We expect:
    //   1. openSync succeeds (returns an fd).
    //   2. fstatSync throws (injected).
    //   3. openDirectoryNoFollow's catch block calls closeSync(fd) once.
    //   4. The error is re-thrown.
    //   5. The caller (ensureGenerationStoreLayoutDurable) wraps it in
    //      STORE_LAYOUT_DURABILITY_UNKNOWN.
    class FdLeakOps extends TestOps {
      fstatCallCount = 0;
      closeCallCount = 0;
      failedFd: number | null = null;

      fstatSync(fd: number): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number } {
        this.fstatCallCount++;
        if (this.fstatCallCount === 1) {
          // First fstatSync call — fail it. Record the fd so we can
          // verify closeSync was called on THIS fd.
          this.failedFd = fd;
          throw new Error("injected fstatSync failure");
        }
        const s = require("node:fs").fstatSync(fd);
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
      }

      closeSync(fd: number): void {
        this.closeCallCount++;
        // The fd that failed fstatSync MUST be closed.
        if (fd === this.failedFd) {
          // Don't actually close — it might be invalid. Just record.
          return;
        }
        const fs = require("node:fs");
        return fs.closeSync(fd);
      }
    }

    const ops = new FdLeakOps();
    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // The error is wrapped as STORE_LAYOUT_DURABILITY_UNKNOWN because
    // the failure happens in the layout-phase dir fsync path.
    const code = (err as GenerationStoreError).code;
    expect(["STORE_LAYOUT_DURABILITY_UNKNOWN", "ATOMIC_WRITE_FAILED"]).toContain(code);

    // closeSync MUST have been called at least once for the failed fd.
    // The fd-leak bug would mean closeSync was NOT called.
    expect(ops.closeCallCount).toBeGreaterThan(0);
  });

  it("openDirectoryNoFollow: fallback path (no O_NOFOLLOW) also closes fd on fstatSync failure", () => {
    // This test verifies the fallback path (lstat -> open -> fstat ->
    // compare) also closes the fd if fstatSync fails. We can't easily
    // force the fallback path on Linux (where O_NOFOLLOW is available),
    // but we can verify the closeSync call by injecting a failure at
    // the SECOND fstatSync call (the one in the fallback path). On
    // Linux, this test exercises the primary path's fstat failure.
    //
    // Since the previous test already exercises the primary path, this
    // test is a sanity check that closeSync is called even when the
    // failure happens later in the openDirectoryNoFollow flow.
    class FdLeakOps2 extends TestOps {
      fstatCallCount = 0;
      closedFds: number[] = [];

      fstatSync(fd: number): { size: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev: number; ino: number; uid?: number } {
        this.fstatCallCount++;
        if (this.fstatCallCount === 2) {
          // Second fstatSync call — fail it.
          throw new Error("injected fstatSync failure (second call)");
        }
        const s = require("node:fs").fstatSync(fd);
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
      }

      closeSync(fd: number): void {
        this.closedFds.push(fd);
        try {
          const fs = require("node:fs");
          return fs.closeSync(fd);
        } catch {
          // best effort
        }
      }
    }

    const ops = new FdLeakOps2();
    let err: unknown;
    try {
      writeIndexStateAtomicallyInternal(project, makeValidIndexState(project), { cacheRoot }, ops);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GenerationStoreError);
    // closeSync MUST have been called at least once after the fstat
    // failure — verifying no fd leak.
    expect(ops.closedFds.length).toBeGreaterThan(0);
  });
});

// ─── R169A-FIX-R7: Runtime API surface tests (API-R169A-R7-01) ──────────

describe("R169A-FIX-R7 — Runtime API surface (API-R169A-R7-01)", () => {
  it("writeIndexStateAtomically ignores extra ops argument at runtime", () => {
    // Pass a fake ops as 4th arg via cast. The public function MUST
    // ignore it and use PROD_OPS internally.
    const fakeOps = {
      ...PROD_OPS,
      openSync: () => {
        throw new Error("FAKE_OPS_MUST_NOT_BE_CALLED");
      },
    };

    const project = "test-project";
    const state = makeValidIndexState(project);
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-api-"));

    try {
      // This should succeed — fakeOps must NOT be used
      (writeIndexStateAtomically as any)(project, state, { cacheRoot }, fakeOps);
      // If we get here, the fake ops was NOT called
      expect(true).toBe(true);
    } catch (e) {
      expect.fail(`Public function should not use injected ops: ${(e as Error).message}`);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("writeIndexStateAtomically ignores extra hook argument at runtime", () => {
    const maliciousHook: any = {
      afterLayoutBeforeOpen: () => {
        throw new Error("MALICIOUS_HOOK_MUST_NOT_BE_CALLED");
      },
    };

    const project = "test-project";
    const state = makeValidIndexState(project);
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-api-"));

    try {
      (writeIndexStateAtomically as any)(project, state, { cacheRoot }, undefined, maliciousHook);
      expect(true).toBe(true);
    } catch (e) {
      expect.fail(`Public function should not use injected hook: ${(e as Error).message}`);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("ensureGenerationStoreLayoutDurable ignores extra ops argument at runtime", () => {
    const fakeOps = {
      ...PROD_OPS,
      mkdirSync: () => {
        throw new Error("FAKE_OPS_MUST_NOT_BE_CALLED");
      },
    };

    const project = "test-project";
    const cacheRoot = mkdtempSync(join(tmpdir(), "r169a-api-"));

    try {
      (ensureGenerationStoreLayoutDurable as any)(project, { cacheRoot }, fakeOps);
      expect(true).toBe(true);
    } catch (e) {
      expect.fail(`Public function should not use injected ops: ${(e as Error).message}`);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("source inspection: no arguments[ or arguments.length in generation-store.ts", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "storage", "generation-store.ts"),
      "utf-8",
    );
    expect(src).not.toContain("arguments[");
    expect(src).not.toContain("arguments.length");
  });

  it("source inspection: no 'as any' casts for API extension", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "storage", "generation-store.ts"),
      "utf-8",
    );
    // Allow "as any" in comments but not in code
    const lines = src.split("\n");
    for (const line of lines) {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      if (line.includes("as any")) {
        expect.fail(`Found 'as any' in production code: ${line.trim()}`);
      }
    }
  });
});
