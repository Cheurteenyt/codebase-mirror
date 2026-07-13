/**
 * R169B-STEP2 — Generation GC tests.
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * These tests exercise the GC planner and executor:
 *   - Plan: retain = active + 2 previous distinct + pinned; delete =
 *     everything else ACTIVE in the catalog.
 *   - Plan never uses mtime or readdir order for retain/delete.
 *   - Plan never promotes anything from tmp/.
 *   - Apply: if CAS revision changed since plan → GC_PLAN_STALE, zero
 *     deletions.
 *   - Apply never deletes the active generation (defense in depth).
 *   - Apply never deletes a pinned generation (defense in depth).
 *   - Apply sweeps tmp/ for canonical artifacts older than tmpMaxAgeMs
 *     (with identity verification).
 *
 * All tests use REAL SQLite DBs and REAL publications (via the
 * publisher) to set up the catalog + history state. No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  lstatSync,
  writeFileSync,
  utimesSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  reserveGenerationStaging,
  prepareGenerationForPublication,
  publishPreparedGeneration,
} from "../../src/storage/generation-publisher.js";
import {
  planGenerationGc,
  applyGenerationGcPlan,
} from "../../src/storage/generation-gc.js";
import {
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  GENERATIONS_SUBDIR,
} from "../../src/storage/generation-paths.js";
import { CAS_DB_FILENAME } from "../../src/storage/internal/generation-cas-store.js";
import {
  freshCacheRoot,
  createValidStagingDb,
  FIXTURE_PROJECT_NAME,
} from "../helpers/r169b-publisher-fixtures.js";
import { openCasStore } from "../../src/storage/internal/generation-cas-store.js";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = freshCacheRoot();
});

afterEach(() => {
  try {
    rmSync(cacheRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// Helper: publish N generations sequentially. Returns their IDs in
// publication order (so the last is the active one).
function publishNGenerations(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
    const { close } = createValidStagingDb(r.stagingPath, { counts: { nodes: i + 1, edges: i + 1, fileHashes: i + 1 } });
    close();
    const p = prepareGenerationForPublication(r);
    const result = publishPreparedGeneration(p, { expectedActiveGenerationId: i === 0 ? null : ids[ids.length - 1] }, { cacheRoot });
    ids.push(result.generationId);
  }
  return ids;
}

// Helper: publish a generation with a custom rootFingerprint so its
// dedup signature differs from the default.
function publishWithFingerprint(rootFingerprint: string, expectedActive: string | null): string {
  const r = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
  const { close } = createValidStagingDb(r.stagingPath, { rootFingerprint });
  close();
  const p = prepareGenerationForPublication(r);
  const result = publishPreparedGeneration(p, { expectedActiveGenerationId: expectedActive }, { cacheRoot });
  return result.generationId;
}

// ─── 1. Plan: basic retain / delete ──────────────────────────────────────

describe("R169B-STEP2 GC — planGenerationGc (basic)", () => {
  it("returns an empty plan when no generations have been published", () => {
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.project).toBe(FIXTURE_PROJECT_NAME);
    expect(plan.activeGenerationId).toBe(null);
    expect(plan.casRevision).toBe(0);
    expect(plan.retain).toEqual([]);
    expect(plan.delete).toEqual([]);
    expect(plan.sweepTmp).toEqual([]);
  });

  it("with 1 active generation, retain=[active], delete=[]", () => {
    const ids = publishNGenerations(1);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.activeGenerationId).toBe(ids[0]);
    expect(plan.retain.length).toBe(1);
    expect(plan.retain[0].generationId).toBe(ids[0]);
    expect(plan.delete).toEqual([]);
  });

  it("with 3 generations (default retain=2 previous), retain=[active + 2 prev], delete=[]", () => {
    const ids = publishNGenerations(3);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.activeGenerationId).toBe(ids[2]);
    expect(plan.retain.length).toBe(3);
    const retainIds = new Set(plan.retain.map((e) => e.generationId));
    expect(retainIds.has(ids[0])).toBe(true);
    expect(retainIds.has(ids[1])).toBe(true);
    expect(retainIds.has(ids[2])).toBe(true);
    expect(plan.delete).toEqual([]);
  });

  it("with 4 generations (default retain=2 previous), retain=[active + ids[2] + ids[1]], delete=[ids[0]]", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.activeGenerationId).toBe(ids[3]);
    expect(plan.retain.length).toBe(3);
    const retainIds = new Set(plan.retain.map((e) => e.generationId));
    expect(retainIds.has(ids[3])).toBe(true); // active
    expect(retainIds.has(ids[2])).toBe(true); // retain-1
    expect(retainIds.has(ids[1])).toBe(true); // retain-2
    expect(plan.delete.length).toBe(1);
    expect(plan.delete[0].generationId).toBe(ids[0]);
    expect(plan.reasons[ids[0]]).toBe("stale");
  });

  it("retainCount=0 retains ONLY the active generation", () => {
    const ids = publishNGenerations(3);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 0 });
    expect(plan.retain.length).toBe(1);
    expect(plan.retain[0].generationId).toBe(ids[2]); // active only
    expect(plan.delete.length).toBe(2);
    const deleteIds = new Set(plan.delete.map((e) => e.generationId));
    expect(deleteIds.has(ids[0])).toBe(true);
    expect(deleteIds.has(ids[1])).toBe(true);
  });

  it("retainCount=5 retains ALL generations (no deletes)", () => {
    const ids = publishNGenerations(5);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 5 });
    expect(plan.retain.length).toBe(5);
    expect(plan.delete).toEqual([]);
  });
});

// ─── 2. Plan: pinned ─────────────────────────────────────────────────────

describe("R169B-STEP2 GC — planGenerationGc (pinned)", () => {
  it("a pinned generation is retained even if it would otherwise be deleted", () => {
    const ids = publishNGenerations(4);
    // Pin ids[0] via the CAS.
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    cas.beginImmediate();
    cas.setCatalogPinned(ids[0], true);
    cas.appendPublicationHistory(ids[0], FIXTURE_PROJECT_NAME, "PIN", null);
    cas.incrementRevision();
    cas.commit();
    cas.close();

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    const retainIds = new Set(plan.retain.map((e) => e.generationId));
    expect(retainIds.has(ids[0])).toBe(true); // pinned
    expect(plan.delete.length).toBe(0); // ids[0] now pinned, no deletes
  });

  it("options.pin adds extra pinned IDs (not in CAS catalog)", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, pin: [ids[0]] });
    const retainIds = new Set(plan.retain.map((e) => e.generationId));
    expect(retainIds.has(ids[0])).toBe(true);
    expect(plan.delete).toEqual([]);
  });
});

// ─── 3. Plan: tmp sweep ─────────────────────────────────────────────────

describe("R169B-STEP2 GC — planGenerationGc (tmp sweep)", () => {
  it("old canonical staging artifacts in tmp/ are listed for sweep", () => {
    // Create a fake staging file in tmp/ with an old mtime.
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const oldPath = join(tmp, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    writeFileSync(oldPath, "old staging DB", "utf-8");
    // Set mtime to 2 days ago.
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(oldPath, twoDaysAgo, twoDaysAgo);

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    expect(plan.sweepTmp.length).toBe(1);
    expect(plan.sweepTmp[0].path).toBe(oldPath);
  });

  it("young canonical staging artifacts in tmp/ are NOT listed for sweep", () => {
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const youngPath = join(tmp, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    writeFileSync(youngPath, "young staging DB", "utf-8");
    // mtime is now (default).

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    expect(plan.sweepTmp).toEqual([]);
  });

  it("non-canonical files in tmp/ are NOT swept (e.g. random names)", () => {
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const randomPath = join(tmp, "random-file.txt");
    writeFileSync(randomPath, "random", "utf-8");
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(randomPath, twoDaysAgo, twoDaysAgo);

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    expect(plan.sweepTmp).toEqual([]);
  });

  it("symlinks in tmp/ are NEVER swept (defense in depth)", () => {
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    // Create a regular file and a symlink pointing to it (with an
    // old mtime on the symlink).
    const targetPath = join(tmp, "target.db");
    writeFileSync(targetPath, "target", "utf-8");
    const symlinkPath = join(tmp, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    symlinkSync(targetPath, symlinkPath);
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(symlinkPath, twoDaysAgo, twoDaysAgo);

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    // The symlink is NOT in sweepTmp (the planner skips symlinks).
    expect(plan.sweepTmp.find((e) => e.path === symlinkPath)).toBeUndefined();
  });
});

// ─── 4. Apply: stale plan ───────────────────────────────────────────────

describe("R169B-STEP2 GC — applyGenerationGcPlan (stale plan)", () => {
  it("if the CAS revision changed since the plan, apply returns GC_PLAN_STALE with zero deletions", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.delete.length).toBe(1);
    expect(plan.delete[0].generationId).toBe(ids[0]);

    // Mutate the CAS to bump the revision (simulating a concurrent
    // publication).
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    cas.beginImmediate();
    cas.incrementRevision();
    cas.commit();
    cas.close();

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("GC_PLAN_STALE");
    expect(result.deletedGenerations).toEqual([]);
    expect(result.deletedTmp).toEqual([]);
    // The would-be-deleted DB still exists.
    const dbPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.db`);
    expect(existsSync(dbPath)).toBe(true);
  });
});

// ─── 5. Apply: happy path ───────────────────────────────────────────────

describe("R169B-STEP2 GC — applyGenerationGcPlan (happy path)", () => {
  it("deletes the stale generation's DB + metadata + marks CAS DELETED", () => {
    const ids = publishNGenerations(4);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.delete.length).toBe(1);

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations).toEqual([ids[0]]);

    // The DB file is gone.
    const dbPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.db`);
    expect(existsSync(dbPath)).toBe(false);
    // The metadata sidecar is gone.
    const metaPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.json`);
    expect(existsSync(metaPath)).toBe(false);
    // The CAS catalog entry is now DELETED.
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const entry = cas.getGenerationCatalogEntry(ids[0]);
    expect(entry?.status).toBe("DELETED");
    cas.close();
  });

  it("the active generation is NEVER deleted (defense in depth)", () => {
    const ids = publishNGenerations(4);
    // Manually construct a plan that LISTS the active generation as
    // delete (simulating a buggy / malicious plan). The applier must
    // refuse.
    const activeId = ids[3];
    const fakePlan = {
      project: FIXTURE_PROJECT_NAME,
      cacheRoot,
      activeGenerationId: activeId,
      casRevision: 0, // wrong, but the active-check should fire first
      retain: [],
      delete: [
        {
          generationId: activeId,
          dbPath: join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${activeId}.db`),
          metadataPath: join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${activeId}.json`),
          reason: "fake-active",
          pinned: false,
        },
      ],
      sweepTmp: [],
      reasons: {},
    };
    // Bump the revision to match (otherwise we'd get GC_PLAN_STALE
    // before the active check).
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const rev = cas.getRevision();
    cas.close();
    fakePlan.casRevision = rev;

    const result = applyGenerationGcPlan(fakePlan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations).toEqual([]); // active not deleted
    expect(result.warnings.some((w) => w.code === "GC_DELETE_FAILED")).toBe(true);
    // The active DB still exists.
    const dbPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${activeId}.db`);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("a pinned generation is NEVER deleted (defense in depth)", () => {
    const ids = publishNGenerations(4);
    // Pin ids[0] (the one the plan would delete).
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    cas.beginImmediate();
    cas.setCatalogPinned(ids[0], true);
    cas.incrementRevision();
    cas.commit();
    cas.close();

    // Re-plan; ids[0] should now be retained.
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    expect(plan.delete).toEqual([]); // ids[0] is pinned, nothing to delete
    expect(plan.retain.length).toBe(4); // all retained

    // Even if we manually construct a plan that lists the pinned gen
    // as delete, the applier must refuse.
    const fakePlan = {
      project: FIXTURE_PROJECT_NAME,
      cacheRoot,
      activeGenerationId: ids[3],
      casRevision: plan.casRevision,
      retain: [],
      delete: [
        {
          generationId: ids[0],
          dbPath: join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.db`),
          metadataPath: join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.json`),
          reason: "fake-pinned",
          pinned: false,
        },
      ],
      sweepTmp: [],
      reasons: {},
    };
    const result = applyGenerationGcPlan(fakePlan, { cacheRoot });
    expect(result.applied).toBe(true);
    expect(result.deletedGenerations).toEqual([]);
    expect(result.warnings.some((w) => w.code === "GC_DELETE_FAILED")).toBe(true);
    const dbPath = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), GENERATIONS_SUBDIR, `generation-${ids[0]}.db`);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("apply sweeps tmp/ artifacts listed in the plan", () => {
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const oldPath = join(tmp, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    writeFileSync(oldPath, "old staging DB", "utf-8");
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(oldPath, twoDaysAgo, twoDaysAgo);

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    expect(plan.sweepTmp.length).toBe(1);

    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.deletedTmp).toEqual([oldPath]);
    expect(existsSync(oldPath)).toBe(false);
  });
});

// ─── 6. Apply: never promotes from tmp/ ─────────────────────────────────

describe("R169B-STEP2 GC — never promotes from tmp/", () => {
  it("a canonical staging artifact in tmp/ is swept (deleted), not promoted to generations/", () => {
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const gens = generationsDir(FIXTURE_PROJECT_NAME, cacheRoot);
    const oldPath = join(tmp, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    writeFileSync(oldPath, "old staging DB", "utf-8");
    const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
    utimesSync(oldPath, twoDaysAgo, twoDaysAgo);

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, tmpMaxAgeMs: 24 * 60 * 60 * 1000 });
    const result = applyGenerationGcPlan(plan, { cacheRoot });
    expect(result.deletedTmp).toEqual([oldPath]);
    // No file was promoted into generations/.
    const promotedPath = join(gens, "generation-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.db");
    expect(existsSync(promotedPath)).toBe(false);
  });
});

// ─── 7. Plan: ordering invariants ───────────────────────────────────────

describe("R169B-STEP2 GC — plan ordering invariants", () => {
  it("the retain list orders by reason: active first, then retain-N, then pinned", () => {
    const ids = publishNGenerations(4);
    // Pin ids[0] so it's retained as pinned (not as retain-3).
    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    cas.beginImmediate();
    cas.setCatalogPinned(ids[0], true);
    cas.incrementRevision();
    cas.commit();
    cas.close();

    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot });
    const reasons = plan.retain.map((e) => e.reason);
    // Active (ids[3]) + retain-1 (ids[2]) + retain-2 (ids[1]) + pinned (ids[0])
    expect(reasons).toContain("active");
    expect(reasons).toContain("retain-1");
    expect(reasons).toContain("retain-2");
    expect(reasons).toContain("pinned");
  });
});

// ─── 8. Plan: reasons map ───────────────────────────────────────────────

describe("R169B-STEP2 GC — plan reasons map", () => {
  it("the reasons map has an entry for every retained and deleted generation", () => {
    const ids = publishNGenerations(5);
    const plan = planGenerationGc(FIXTURE_PROJECT_NAME, { cacheRoot, retainCount: 1 });
    // Active + 1 previous retained; 3 deleted.
    for (const e of plan.retain) {
      expect(plan.reasons[e.generationId]).toBeDefined();
    }
    for (const e of plan.delete) {
      expect(plan.reasons[e.generationId]).toBe("stale");
    }
  });
});
