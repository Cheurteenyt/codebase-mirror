/**
 * R169B-STEP10 — Bloc B dedicated tests (B1, B2, B3, B4).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This file provides dedicated coverage for the four Bloc B behaviors
 * that were added on top of the Bloc A foundation:
 *
 *   B1 — Orphan recovery (planGenerationOrphanRecovery +
 *        applyGenerationOrphanRecovery). Scans generations/ for
 *        orphans (PROMOTION_TEMP, NOT_IN_CATALOG, DB_ONLY,
 *        METADATA_ONLY, ACTIVE_NOT_IN_CATALOG) and applies recovery:
 *        promotion temps are deleted; non-temps are retained with a
 *        grace period; ACTIVE_NOT_IN_CATALOG triggers CAS recovery.
 *
 *   B2 — CAS recovery disk-aware (the ACTIVE_NOT_IN_CATALOG path in
 *        applyGenerationOrphanRecovery). Verifies DB + metadata +
 *        hash on disk BEFORE rebuilding the catalog entry. If any
 *        check fails, the orphan is retained (not recovered).
 *
 *   B3 — GC safety check + proof under lock. The safety check
 *        (verifyGenerationSafety, OUTSIDE the lock) catches most
 *        corruption. The B3 proof (UNDER the lock, inside
 *        deleteGenerationUnderCasLock) is defense-in-depth for the
 *        narrow TOCTOU window between the safety check and the lock
 *        acquisition. These tests validate the OUTER safety check
 *        (the layer reachable without fault injection); the B3 proof
 *        under lock is validated via the crash harness (C3).
 *
 *   B4 — CAS layout leaf module (ensureDirDurable in
 *        internal/generation-layout-io.ts). Creates directories with
 *        mode 0o700, chmod (force exact mode regardless of umask),
 *        and fsync. Pure leaf module with no imports from the storage
 *        module chain.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rmSync,
  existsSync,
  lstatSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readdirSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  reserveGenerationStaging,
  prepareGenerationForPublication,
  publishPreparedGeneration,
} from "../../src/storage/generation-publisher.js";
import {
  planGenerationGc,
  applyGenerationGcPlan,
  planGenerationOrphanRecovery,
  applyGenerationOrphanRecovery,
} from "../../src/storage/generation-gc.js";
import {
  activeManifestPath,
  generationsDir,
  projectStoreDir,
  tmpDir,
} from "../../src/storage/generation-paths.js";
import { openCasStore, CAS_DB_FILENAME } from "../../src/storage/internal/generation-cas-store.js";
import { ensureDirDurable } from "../../src/storage/internal/generation-layout-io.js";
import {
  freshCacheRoot,
  createValidStagingDb,
  FIXTURE_PROJECT_NAME,
} from "../helpers/r169b-publisher-fixtures.js";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = freshCacheRoot("r169b-blocb-");
});

afterEach(() => {
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Helper: publish N generations ────────────────────────────────────

function publishNGenerations(n: number): string[] {
  const ids: string[] = [];
  let expectedActive: string | null = null;
  for (let i = 0; i < n; i++) {
    const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
    const { close } = createValidStagingDb(r.stagingPath);
    close();
    const p = prepareGenerationForPublication(r);
    const result = publishPreparedGeneration(
      p,
      { expectedActiveGenerationId: expectedActive },
      { cacheRoot },
    );
    ids.push(result.generationId);
    expectedActive = result.generationId;
  }
  return ids;
}

/**
 * Delete a catalog entry directly via raw SQL (bypasses the state
 * machine). Used to simulate "active generation not in catalog"
 * without going through the GC's DELETING → DELETED flow.
 */
function deleteCatalogEntryRaw(generationId: string): void {
  const dbPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), CAS_DB_FILENAME);
  const db = new Database(dbPath);
  try {
    db.prepare("DELETE FROM generation_catalog WHERE generation_id = ?").run(generationId);
  } finally {
    db.close();
  }
}

// ─── B1: Orphan recovery — plan ───────────────────────────────────────

describe("R169B-STEP10 (B1) — planGenerationOrphanRecovery", () => {
  it("returns an empty orphan list on a clean cache root", () => {
    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.orphans.length).toBe(0);
    expect(plan.activeGenerationId).toBeNull();
    expect(plan.casRevision).toBe(0);
  });

  it("detects PROMOTION_TEMP orphans (.publish-<uuid>-<nonce>.db files in generations/)", () => {
    publishNGenerations(1);

    // Create a fake promotion temp with a valid hex UUID + nonce.
    const generations = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const tempPath = join(generations, ".publish-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-abcdef0123456789.db");
    writeFileSync(tempPath, "fake temp content");

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const tempOrphans = plan.orphans.filter((o) => o.kind === "PROMOTION_TEMP");
    expect(tempOrphans.length).toBe(1);
    expect(tempOrphans[0].path).toBe(tempPath);
    expect(tempOrphans[0].generationId).toBeNull();
  });

  it("detects NOT_IN_CATALOG orphans (DB file in generations/ with no catalog entry)", () => {
    publishNGenerations(1);

    const generations = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const fakeUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fakeDbPath = join(generations, `generation-${fakeUuid}.db`);
    writeFileSync(fakeDbPath, "fake db content");

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const notInCatalog = plan.orphans.filter((o) => o.kind === "NOT_IN_CATALOG");
    expect(notInCatalog.length).toBe(1);
    expect(notInCatalog[0].generationId).toBe(fakeUuid);
  });

  it("detects DB_ONLY orphans (DB exists, metadata missing, but UUID IS in catalog)", () => {
    const ids = publishNGenerations(2);

    const metaPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[0]}.json`,
    );
    if (existsSync(metaPath)) rmSync(metaPath);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const dbOnly = plan.orphans.filter((o) => o.kind === "DB_ONLY");
    expect(dbOnly.length).toBe(1);
    expect(dbOnly[0].generationId).toBe(ids[0]);
  });

  it("detects METADATA_ONLY orphans (metadata exists, DB missing, not protected)", () => {
    const ids = publishNGenerations(3);
    // Delete the DB for ids[1] (NOT the active, which is ids[2]).
    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[1]}.db`,
    );
    if (existsSync(dbPath)) rmSync(dbPath);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const metaOnly = plan.orphans.filter((o) => o.kind === "METADATA_ONLY");
    expect(metaOnly.length).toBe(1);
    expect(metaOnly[0].generationId).toBe(ids[1]);
  });

  it("detects ACTIVE_NOT_IN_CATALOG (active manifest points at a generation not in the CAS catalog)", () => {
    const ids = publishNGenerations(1);
    const activeId = ids[0];

    // Delete the catalog entry for the active generation via raw SQL.
    deleteCatalogEntryRaw(activeId);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const activeNotInCatalog = plan.orphans.filter((o) => o.kind === "ACTIVE_NOT_IN_CATALOG");
    expect(activeNotInCatalog.length).toBe(1);
    expect(activeNotInCatalog[0].generationId).toBe(activeId);
  });
});

// ─── B1: Orphan recovery — apply ──────────────────────────────────────

describe("R169B-STEP10 (B1) — applyGenerationOrphanRecovery", () => {
  it("deletes PROMOTION_TEMP orphans and fsyncs generations/", () => {
    publishNGenerations(1);
    const generations = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const tempPath = join(generations, ".publish-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-abcdef0123456789.db");
    writeFileSync(tempPath, "fake temp content");

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });

    expect(result.deletedTempPaths.length).toBe(1);
    expect(result.deletedTempPaths[0]).toBe(tempPath);
    expect(existsSync(tempPath)).toBe(false);
    expect(result.warnings.length).toBe(0);
  });

  it("retains NOT_IN_CATALOG orphans (grace period — not deleted immediately)", () => {
    publishNGenerations(1);
    const generations = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const fakeUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fakeDbPath = join(generations, `generation-${fakeUuid}.db`);
    writeFileSync(fakeDbPath, "fake db content");

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });

    expect(result.deletedTempPaths.length).toBe(0);
    expect(existsSync(fakeDbPath)).toBe(true);
    const retained = result.retainedOrphans.filter((o) => o.kind === "NOT_IN_CATALOG");
    expect(retained.length).toBe(1);
  });

  it("retains DB_ONLY and METADATA_ONLY orphans (grace period)", () => {
    const ids = publishNGenerations(3);
    // Delete metadata for ids[0] (DB_ONLY orphan).
    const metaPath0 = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[0]}.json`,
    );
    if (existsSync(metaPath0)) rmSync(metaPath0);
    // Delete DB for ids[1] (METADATA_ONLY orphan). ids[1] is NOT the active.
    const dbPath1 = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[1]}.db`,
    );
    if (existsSync(dbPath1)) rmSync(dbPath1);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });

    expect(result.deletedTempPaths.length).toBe(0);
    const retainedKinds = result.retainedOrphans.map((o) => o.kind);
    expect(retainedKinds).toContain("DB_ONLY");
    expect(retainedKinds).toContain("METADATA_ONLY");
  });
});

// ─── B2: CAS recovery disk-aware ──────────────────────────────────────

describe("R169B-STEP10 (B2) — CAS recovery disk-aware (ACTIVE_NOT_IN_CATALOG)", () => {
  it("recovers the CAS catalog when DB + metadata + hash are all valid", () => {
    const ids = publishNGenerations(1);
    const activeId = ids[0];

    // Delete the catalog entry for the active generation via raw SQL
    // (simulates a crash between manifest write and CAS commit).
    deleteCatalogEntryRaw(activeId);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.orphans.some((o) => o.kind === "ACTIVE_NOT_IN_CATALOG" && o.generationId === activeId)).toBe(true);

    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });
    expect(result.casRecovered).toBe(true);

    const cas2 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const entry = cas2.getGenerationCatalogEntry(activeId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("ACTIVE");
    expect(cas2.getActiveGenerationId()).toBe(activeId);
    cas2.close();
  });

  it("retains the orphan when the DB file is missing (disk check fails)", () => {
    const ids = publishNGenerations(2);
    const oldActive = ids[0];

    // Re-set the active to oldActive via CAS.
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId(oldActive);
    cas.appendPublicationHistory(oldActive, FIXTURE_PROJECT_NAME, "PUBLISH", ids[1]);
    cas.commit();
    cas.close();

    // Re-write the manifest to point at oldActive.
    const manifestPath = activeManifestPath(FIXTURE_PROJECT_NAME, cacheRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.generationId = oldActive;
    manifest.dbFile = `generations/generation-${oldActive}.db`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Delete oldActive's DB.
    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${oldActive}.db`,
    );
    if (existsSync(dbPath)) rmSync(dbPath);

    // Delete the catalog entry via raw SQL.
    deleteCatalogEntryRaw(oldActive);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });

    expect(result.casRecovered).toBe(false);
    const retained = result.retainedOrphans.filter((o) => o.kind === "ACTIVE_NOT_IN_CATALOG");
    expect(retained.length).toBe(1);
  });

  it("retains the orphan when the DB hash does not match the metadata", () => {
    const ids = publishNGenerations(1);
    const activeId = ids[0];

    // Corrupt the DB by appending bytes (changes the hash).
    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${activeId}.db`,
    );
    const fh = require("node:fs").openSync(dbPath, "r+");
    require("node:fs").writeSync(fh, Buffer.from("corruption appended"));
    require("node:fs").closeSync(fh);

    // Delete the catalog entry via raw SQL.
    deleteCatalogEntryRaw(activeId);

    const plan = planGenerationOrphanRecovery(FIXTURE_PROJECT_NAME, { cacheRoot });
    const result = applyGenerationOrphanRecovery(plan, { cacheRoot });

    expect(result.casRecovered).toBe(false);
    const retained = result.retainedOrphans.filter((o) => o.kind === "ACTIVE_NOT_IN_CATALOG");
    expect(retained.length).toBe(1);
    expect(result.warnings.some((w) => w.code === "GC_DELETE_FAILED" && w.message.includes("hash mismatch"))).toBe(true);
  });
});

// ─── B3: GC safety check + proof under lock ───────────────────────────

describe("R169B-STEP10 (B3) — GC safety check (outer layer) + proof under lock", () => {
  it("refuses to delete a generation whose DB hash was corrupted (safety check catches it)", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });
    expect(plan.delete.length).toBe(1);
    expect(plan.delete[0].generationId).toBe(ids[0]);

    // Corrupt ids[0]'s DB AFTER the plan but BEFORE apply.
    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[0]}.db`,
    );
    const fh = require("node:fs").openSync(dbPath, "r+");
    require("node:fs").writeSync(fh, Buffer.from("corruption appended to change hash"));
    require("node:fs").closeSync(fh);

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(0);
    // The safety check (outer layer) catches the hash mismatch and
    // refuses with GC_SAFETY_REFUSAL. The B3 proof under lock is
    // defense-in-depth for the narrow TOCTOU window between the safety
    // check and the lock — it's validated via the crash harness (C3).
    expect(result.warnings.some((w) => w.code === "GC_SAFETY_REFUSAL")).toBe(true);

    expect(existsSync(dbPath)).toBe(true);
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const entry = cas.getGenerationCatalogEntry(ids[0]);
    expect(entry!.status).toBe("ACTIVE");
    cas.close();
  });

  it("refuses to delete a generation whose DB became a symlink (safety check catches it)", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });

    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[0]}.db`,
    );
    const target = join(tmpdir(), "symlink-target-" + Date.now());
    writeFileSync(target, "symlink target content");
    rmSync(dbPath);
    symlinkSync(target, dbPath);

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(0);
    // The symlink is caught by EITHER the outer safety check
    // (GC_SAFETY_REFUSAL) OR the B3 proof under lock (GC_DELETE_FAILED).
    // Both layers refuse to delete a symlinked DB.
    expect(result.warnings.some((w) => w.code === "GC_SAFETY_REFUSAL" || w.code === "GC_DELETE_FAILED")).toBe(true);

    try { rmSync(target); } catch { /* best effort */ }
  });

  it("deletes successfully when the DB is untouched between plan and apply", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 2 });

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations.length).toBe(1);
    expect(result.deletedGenerations[0]).toBe(ids[0]);

    const dbPath = join(
      projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot),
      "generations",
      `generation-${ids[0]}.db`,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it("the B3 proof under lock is defense-in-depth (code path exists in deleteGenerationUnderCasLock)", () => {
    // This is a code-inspection assertion: the B3 proof under lock
    // re-lstats the DB and recomputes the hash INSIDE the CAS lock
    // (after BEGIN IMMEDIATE). It's only reachable if the safety check
    // (outside the lock) passed but the DB was corrupted in the narrow
    // window between the safety check and the lock acquisition.
    //
    // Testing this precisely requires fault injection between the
    // safety check and the lock — which is exactly what the C3 crash
    // harness provides (via the barrier hooks). See
    // tests/storage/r169b-crash-harness.test.ts for the child-process
    // crash tests that validate the B3 proof under lock.
    //
    // Here we just verify the code exists by importing the GC module
    // and checking the function is exported (it's internal but
    // reachable via the module's source).
    const gcSource = require("node:fs").readFileSync(
      join(__dirname, "../../src/storage/generation-gc.ts"),
      "utf-8",
    );
    expect(gcSource).toContain("B3");
    expect(gcSource).toContain("GC proof under lock");
    expect(gcSource).toContain("proofHash");
    expect(gcSource).toContain("computeGcSha256(dbPath)");
  });
});

// ─── B4: ensureDirDurable (CAS layout leaf module) ────────────────────

describe("R169B-STEP10 (B4) — ensureDirDurable (layout leaf module)", () => {
  it("creates a new directory with mode 0o700", () => {
    const dir = join(cacheRoot, "new-dir");
    expect(existsSync(dir)).toBe(false);

    ensureDirDurable(dir, cacheRoot);

    const st = lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("chmods an existing directory to 0o700 even if it was created with a different mode", () => {
    const dir = join(cacheRoot, "existing-dir");
    mkdirSync(dir, { mode: 0o755 });
    expect(lstatSync(dir).isDirectory()).toBe(true);

    ensureDirDurable(dir, cacheRoot);

    const st = lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("handles concurrent creation (another process creates the dir first)", () => {
    const dir = join(cacheRoot, "race-dir");
    mkdirSync(dir, { mode: 0o700 });

    expect(() => ensureDirDurable(dir, cacheRoot)).not.toThrow();
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws when the parent directory does not exist and recursive=false", () => {
    const dir = join(cacheRoot, "nonexistent-parent", "child");
    expect(() => ensureDirDurable(dir, cacheRoot)).toThrow();
  });

  it("is a pure leaf module (no imports from the storage module chain)", () => {
    // Verify the module source has no imports from generation-publisher,
    // generation-gc, generation-cas-store, or generation-types.
    const src = require("node:fs").readFileSync(
      join(__dirname, "../../src/storage/internal/generation-layout-io.ts"),
      "utf-8",
    );
    expect(src).not.toContain("generation-publisher");
    expect(src).not.toContain("generation-gc");
    expect(src).not.toContain("generation-cas-store");
    expect(src).not.toContain("generation-types");
    // Only imports from node:fs.
    expect(src).toContain('from "node:fs"');
  });
});
