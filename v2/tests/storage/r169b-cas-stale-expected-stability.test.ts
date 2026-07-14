/**
 * R169B — CAS stale-expected-active stability test.
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * RENAMED from r169b-concurrency-barrier.test.ts (GPT 5.6 deep audit §13):
 * this test does NOT prove true simultaneous concurrency. It proves the
 * stability of the CAS stale-expected-active guard over 50 iterations.
 *
 * What this test proves:
 *   - A publisher that starts AFTER the previous winner has committed
 *     will deterministically get PUBLICATION_CAS_MISMATCH (not BUSY).
 *   - The CAS revision strictly increases per successful publication.
 *   - A failed publication does NOT bump the revision.
 *   - No state leakage between iterations.
 *   - No staging DB files leak in tmp/.
 *   - generations/ contains exactly N .db files (one per winner).
 *
 * What this test does NOT prove:
 *   - Two publishers starting simultaneously (true race).
 *   - PUBLICATION_CAS_BUSY under contention.
 *
 * For true simultaneous concurrency, see
 * `r169b-publication-concurrency.test.ts` test #2 (multi-process race
 * via spawn, which CAN produce CAS_BUSY when BEGIN IMMEDIATE collides).
 *
 * Note: with busy_timeout=0, a true simultaneous loser may legitimately
 * receive PUBLICATION_CAS_BUSY (not CAS_MISMATCH). This test avoids
 * that by running the loser strictly AFTER the winner commits.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  reserveGenerationStaging,
  prepareGenerationForPublication,
  publishPreparedGeneration,
  discardPreparedGeneration,
} from "../../src/storage/generation-publisher.js";
import {
  GenerationStoreError,
  type PreparedGeneration,
  type GenerationStagingReservation,
} from "../../src/storage/generation-types.js";
import {
  activeManifestPath,
  projectStoreDir,
  tmpDir,
} from "../../src/storage/generation-paths.js";
import { openCasStore } from "../../src/storage/internal/generation-cas-store.js";
import {
  freshCacheRoot,
  createValidStagingDb,
  FIXTURE_PROJECT_NAME,
} from "../helpers/r169b-publisher-fixtures.js";

const ITERATIONS = 50;
const STABILITY_TEST_TIMEOUT_MS = 30_000;

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = freshCacheRoot("r169b-barrier-");
});

afterEach(() => {
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── In-process publisher (winner or loser) ───────────────────────────

interface PublisherRunResult {
  ok: boolean;
  generationId?: string;
  code?: string;
  message?: string;
  prepared?: PreparedGeneration;
  reservation?: GenerationStagingReservation;
}

function runPublisherOnce(opts: { expectedActive: string | null }): PublisherRunResult {
  const reservation = reserveGenerationStaging(FIXTURE_PROJECT_NAME, { cacheRoot });
  const { close } = createValidStagingDb(reservation.stagingPath);
  close();
  const prepared = prepareGenerationForPublication(reservation);
  try {
    const result = publishPreparedGeneration(
      prepared,
      { expectedActiveGenerationId: opts.expectedActive },
      { cacheRoot },
    );
    return { ok: true, generationId: result.generationId, prepared, reservation };
  } catch (e) {
    const code = e instanceof GenerationStoreError ? e.code : "UNKNOWN";
    const message = e instanceof Error ? e.message : String(e);
    // Discard the prepared handle so the staging DB is removed. This
    // models the production error path: a failed publisher MUST call
    // discardPreparedGeneration to avoid leaking tmp files.
    try { discardPreparedGeneration(prepared); } catch { /* best effort */ }
    return { ok: false, code, message, prepared, reservation };
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("R169B — CAS stale-expected-active stability (50 iterations)", () => {
  it("across 50 iterations, the loser ALWAYS gets PUBLICATION_CAS_MISMATCH (strict)", () => {
    const failures: string[] = [];
    let lastWinnerId: string | null = null;

    for (let i = 0; i < ITERATIONS; i++) {
      // Winner: expectedActive = previous winner (or null on iter 0).
      const winner = runPublisherOnce({ expectedActive: lastWinnerId });
      if (!winner.ok) {
        failures.push(`iter ${i}: winner failed unexpectedly: ${winner.code} — ${winner.message}`);
        continue;
      }
      lastWinnerId = winner.generationId!;

      // Loser: expectedActive=null, but active is now lastWinnerId.
      // The loser MUST get STRICTLY PUBLICATION_CAS_MISMATCH (not BUSY,
      // not PROMOTION_CONFLICT, not anything else).
      const loser = runPublisherOnce({ expectedActive: null });
      if (loser.ok) {
        failures.push(`iter ${i}: loser succeeded unexpectedly (generationId=${loser.generationId}) — CAS barrier broken`);
        continue;
      }
      if (loser.code !== "PUBLICATION_CAS_MISMATCH") {
        failures.push(`iter ${i}: loser got code=${loser.code} (expected PUBLICATION_CAS_MISMATCH) — ${loser.message}`);
        continue;
      }

      // Manifest points at the winner's generationId.
      const manifestPath = activeManifestPath(FIXTURE_PROJECT_NAME, cacheRoot);
      if (!existsSync(manifestPath)) {
        failures.push(`iter ${i}: active manifest missing after publication`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (manifest.generationId !== winner.generationId) {
        failures.push(`iter ${i}: manifest.generationId=${manifest.generationId} !== winner=${winner.generationId}`);
        continue;
      }

      // CAS active_generation_id matches the winner.
      const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
      const activeId = cas.getActiveGenerationId();
      const loserEntry = cas.getGenerationCatalogEntry(loser.reservation!.generationId);
      cas.close();
      if (activeId !== winner.generationId) {
        failures.push(`iter ${i}: CAS active=${activeId} !== winner=${winner.generationId}`);
        continue;
      }
      // The loser's UUID MUST NOT appear in the catalog at all.
      // CAS_MISMATCH throws BEFORE the catalog upsert, so the loser's
      // UUID is never inserted. (Note: previous iterations' winners
      // remain in the catalog with status=ACTIVE — only GC transitions
      // them to DELETING/DELETED. So the catalog grows by 1 per iter.)
      if (loserEntry !== undefined) {
        failures.push(`iter ${i}: loser UUID ${loser.reservation!.generationId} appears in catalog with status=${loserEntry.status} (CAS leak)`);
        continue;
      }
    }

    if (failures.length > 0) {
      const sample = failures.slice(0, 10).join("\n  - ");
      throw new Error(`Concurrency barrier failed (${failures.length}/${ITERATIONS} iterations):\n  - ${sample}`);
    }
  }, STABILITY_TEST_TIMEOUT_MS);

  it("CAS revision strictly increases per successful publication across 50 iterations", () => {
    let lastRev = 0;
    let lastWinnerId: string | null = null;

    for (let i = 0; i < ITERATIONS; i++) {
      const r = runPublisherOnce({ expectedActive: lastWinnerId });
      if (!r.ok) {
        throw new Error(`iter ${i}: setup publish failed: ${r.code} — ${r.message}`);
      }
      lastWinnerId = r.generationId!;

      const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
      const rev = cas.getRevision();
      cas.close();
      // The revision MUST strictly increase. We don't require exactly
      // +1 because the publisher may write multiple history rows per
      // publication (PUBLISH + RECONCILE). The key invariant: rev
      // strictly increases on every successful publication.
      if (rev <= lastRev) {
        throw new Error(`iter ${i}: revision did not increase: rev=${rev} <= lastRev=${lastRev}`);
      }
      lastRev = rev;
    }
    // After 50 iterations, the revision MUST be >= 50.
    expect(lastRev).toBeGreaterThanOrEqual(ITERATIONS);
  }, STABILITY_TEST_TIMEOUT_MS);

  it("a loser's failed publication does NOT bump the CAS revision", () => {
    // 1. Winner publishes (rev bumps from 0 to R1).
    const winner = runPublisherOnce({ expectedActive: null });
    expect(winner.ok).toBe(true);
    const cas1 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const rev1 = cas1.getRevision();
    cas1.close();
    expect(rev1).toBeGreaterThan(0);

    // 2. Loser attempts to publish with expectedActive=null → CAS_MISMATCH.
    //    This MUST NOT bump the revision.
    const loser = runPublisherOnce({ expectedActive: null });
    expect(loser.ok).toBe(false);
    expect(loser.code).toBe("PUBLICATION_CAS_MISMATCH");

    const cas2 = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const rev2 = cas2.getRevision();
    cas2.close();
    expect(rev2).toBe(rev1);
  });

  it("across 50 iterations, no staging DB files are leaked in tmp/", () => {
    let lastWinnerId: string | null = null;

    for (let i = 0; i < ITERATIONS; i++) {
      // Winner publishes (staging DB is promoted via temp-file copy
      // into generations/, then staging is unlinked from tmp/).
      const winner = runPublisherOnce({ expectedActive: lastWinnerId });
      if (!winner.ok) {
        throw new Error(`iter ${i}: winner publish failed: ${winner.code} — ${winner.message}`);
      }
      lastWinnerId = winner.generationId!;

      // Loser fails (staging DB is discarded, which unlinks it from tmp/).
      const loser = runPublisherOnce({ expectedActive: null });
      if (loser.ok) {
        throw new Error(`iter ${i}: loser succeeded unexpectedly`);
      }
    }

    // tmp/ should be empty — all staging DBs were promoted or discarded.
    const tmp = tmpDir(FIXTURE_PROJECT_NAME, cacheRoot);
    if (existsSync(tmp)) {
      const files = readdirSync(tmp);
      const dbFiles = files.filter((f) => f.endsWith(".db"));
      expect(dbFiles.length).toBe(0);
    }
  }, STABILITY_TEST_TIMEOUT_MS);

  it("across 50 iterations, generations/ contains exactly 50 .db files (one per winner, none for losers)", () => {
    let lastWinnerId: string | null = null;

    for (let i = 0; i < ITERATIONS; i++) {
      const winner = runPublisherOnce({ expectedActive: lastWinnerId });
      if (!winner.ok) {
        throw new Error(`iter ${i}: winner publish failed: ${winner.code} — ${winner.message}`);
      }
      lastWinnerId = winner.generationId!;

      // Loser fails (no .db file should be created in generations/).
      const loser = runPublisherOnce({ expectedActive: null });
      if (loser.ok) {
        throw new Error(`iter ${i}: loser succeeded unexpectedly`);
      }
    }

    // After 50 iterations, generations/ contains 50 .db files (one per
    // winner). Losers never reach the link step, so their UUIDs are
    // absent from generations/. The CAS catalog has 50 ACTIVE entries
    // (the publisher does NOT transition the previous active to ARCHIVED
    // — that's the GC's job).
    const generations = join(projectStoreDir(FIXTURE_PROJECT_NAME, cacheRoot), "generations");
    const files = readdirSync(generations).filter((f) => f.endsWith(".db"));
    expect(files.length).toBe(ITERATIONS);

    const cas = openCasStore(FIXTURE_PROJECT_NAME, cacheRoot);
    const active = cas.listCatalogEntriesByStatus("ACTIVE");
    cas.close();
    expect(active.length).toBe(ITERATIONS);
  }, STABILITY_TEST_TIMEOUT_MS);
});
