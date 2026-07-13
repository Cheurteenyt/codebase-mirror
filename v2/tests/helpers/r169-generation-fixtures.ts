/**
 * R169A-FIX-R5 (API-R169A-R5-01): Test-only fixtures for the generation
 * store.
 *
 * R169A does NOT export a publication API. The manifest writer
 * (`writeGenerationManifestAtomically`) and the `prepare*ForWrite`
 * helpers are internal (not exported). Tests that need a manifest on
 * disk use these helpers, which write via `node:fs.writeFileSync`
 * directly — NOT the atomic writer. This keeps the production code's
 * "no publication API" contract intact while letting tests set up
 * realistic on-disk state for the resolver and listing to read.
 *
 * For atomic writer mechanic tests (fault injection, race injection),
 * use `writeIndexStateAtomically` (the only public writer in R169A).
 * It exercises the same internal writer code path
 * (`writeProjectJsonAtomicallyInternal` → `writeJsonAtomically`) that
 * the manifest writer would use.
 *
 * R169A-FIX-R5 (STATE-R169A-R5-01/02): Also exports `makeValidManifest`
 * and `makeValidIndexState` so other test files can construct valid
 * fixtures without duplicating the canonical constants. These helpers
 * are NOT compiled with the package (the `tests/` directory is
 * excluded from the build).
 */

import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

import {
  activeManifestPath,
  indexStatePath,
  projectStoreDir,
  cbmCacheDir,
  generationStoreRoot,
} from "../../src/storage/generation-store.js";
import type {
  GenerationManifestV1,
  IndexAttemptStateV1,
} from "../../src/storage/generation-types.js";

// ─── Constants (canonical test values) ───────────────────────────────────

export const FIXTURE_VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
export const FIXTURE_OTHER_UUID = "661f9511-f30c-42e5-b827-557766551111";
export const FIXTURE_VALID_SHA256 = "a".repeat(64);
export const FIXTURE_VALID_TIMESTAMP = "2026-07-13T00:00:00.000Z";

// ─── Manifest / index-state fixtures ─────────────────────────────────────

/**
 * Build a valid `GenerationManifestV1` for tests. The `overrides`
 * parameter lets each test customize individual fields.
 */
export function makeValidManifest(
  project: string = "test-project",
  overrides: Partial<GenerationManifestV1> = {},
): GenerationManifestV1 {
  const generationId = overrides.generationId ?? FIXTURE_VALID_UUID;
  return {
    formatVersion: 1,
    project,
    generationId,
    dbFile: `generations/generation-${generationId}.db`,
    createdAt: FIXTURE_VALID_TIMESTAMP,
    rootFingerprint: "/canonical/root:dev:ino",
    extractorSemanticsVersion: 8,
    discoveryPolicyVersion: 2,
    nodeCount: 123,
    edgeCount: 456,
    fileCount: 78,
    sizeBytes: 987654,
    sha256: FIXTURE_VALID_SHA256,
    ...overrides,
  };
}

/**
 * R169A-FIX-R5 (STATE-R169A-R5-01): Build a valid `IndexAttemptStateV1`
 * for tests. The default is a SUCCESS state:
 *   publicationState="PUBLISHED", failure=null, staleReason=null,
 *   recovery="none", activeGenerationId non-null, candidateGenerationId
 *   non-null (equals activeGenerationId on SUCCESS+PUBLISHED).
 *
 * The `overrides` parameter lets each test customize the outcome,
 * recovery, staleReason, failure, publicationState,
 * candidateGenerationId, etc.
 */
export function makeValidIndexState(
  project: string = "test-project",
  overrides: Partial<IndexAttemptStateV1> = {},
): IndexAttemptStateV1 {
  return {
    formatVersion: 1,
    project,
    activeGenerationId: FIXTURE_VALID_UUID,
    candidateGenerationId: FIXTURE_VALID_UUID,
    lastAttemptId: FIXTURE_OTHER_UUID,
    lastAttemptAt: FIXTURE_VALID_TIMESTAMP,
    lastAttemptOutcome: "SUCCESS",
    publicationState: "PUBLISHED",
    failure: null,
    staleReason: null,
    recovery: "none",
    ...overrides,
  };
}

// ─── Directory layout helper ─────────────────────────────────────────────

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
  mkdirSync(path, { recursive: true });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort — some filesystems (e.g. FAT) don't support chmod.
  }
}

/**
 * Ensure the full directory chain (cacheRoot → cbm → projects →
 * projectStore) exists with mode 0o700 so the R169A-FIX-R5 trust root
 * permission check (SEC-R169A-R5-02) passes. The cacheRoot itself is
 * created by the caller (typically mkdtempSync, which uses 0700).
 */
function ensureLayoutDirs(cacheRoot: string, project: string): void {
  // cbm is a "compat root" — mode & 0o022 === 0 is required. 0700 satisfies this.
  ensureDirMode0700(cbmCacheDir(cacheRoot));
  // projects is a private R169 dir — mode === 0o700 is required.
  ensureDirMode0700(generationStoreRoot(cacheRoot));
  // projectStore is a private R169 dir — mode === 0o700 is required.
  ensureDirMode0700(projectStoreDir(project, cacheRoot));
}

// ─── File fixtures (writeFileSync-based — NOT the atomic writer) ─────────

/**
 * Write a manifest file directly to disk via `writeFileSync`. This is
 * NOT the atomic writer — it's a test fixture for setting up the
 * "old" manifest that the resolver reads back.
 *
 * The directory chain is created with mode 0o700 to satisfy the
 * R169A-FIX-R5 trust root permission check.
 *
 * Returns the manifest path.
 */
export function writeManifestFixture(
  cacheRoot: string,
  project: string,
  manifest: GenerationManifestV1,
): string {
  ensureLayoutDirs(cacheRoot, project);
  const manifestPath = activeManifestPath(project, cacheRoot);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return manifestPath;
}

/**
 * Write an index-state file directly to disk via `writeFileSync`. This
 * is NOT the atomic writer — it's a test fixture for setting up
 * sidecar state.
 *
 * The directory chain is created with mode 0o700.
 *
 * Returns the index-state path.
 */
export function writeIndexStateFixture(
  cacheRoot: string,
  project: string,
  state: IndexAttemptStateV1,
): string {
  ensureLayoutDirs(cacheRoot, project);
  const statePath = indexStatePath(project, cacheRoot);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

/**
 * Write a fake generation DB file directly to disk via `writeFileSync`.
 * The `dbFile` argument should be the manifest's `dbFile` field
 * (e.g. `generations/generation-<uuid>.db`).
 *
 * Returns the DB path.
 */
export function writeGenerationDbFixture(
  cacheRoot: string,
  project: string,
  dbFile: string,
): string {
  ensureLayoutDirs(cacheRoot, project);
  const projectDir = projectStoreDir(project, cacheRoot);
  const dbPath = resolve(projectDir, dbFile);
  // Create the generations/ subdir with mode 0o700.
  ensureDirMode0700(resolve(dbPath, ".."));
  writeFileSync(dbPath, "fake DB content", "utf-8");
  return dbPath;
}

/**
 * Write a legacy DB file directly to disk via `writeFileSync`. The
 * legacy DB lives at `<cbmCacheDir>/<project>.db` (NOT under
 * `projects/`).
 *
 * Returns the legacy DB path.
 */
export function writeLegacyDbFixture(cacheRoot: string, project: string): string {
  // Legacy DB is in cbmCacheDir, not under projects/. Create cbm with
  // mode 0o700 (compat root — 0700 satisfies mode & 0o022 === 0).
  ensureDirMode0700(cbmCacheDir(cacheRoot));
  // Use the production path helper to get the exact legacy path.
  // We import it lazily to avoid a circular dependency in the type
  // signatures above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { legacyCodeDbPath } = require("../../src/storage/generation-store.js") as {
    legacyCodeDbPath: (project: string, cacheRoot?: string) => string;
  };
  const dbPath = legacyCodeDbPath(project, cacheRoot);
  writeFileSync(dbPath, "fake legacy DB", "utf-8");
  return dbPath;
}
