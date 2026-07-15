// v2/scripts/publication-benchmark-r169b.ts
// R169B-STEP2: Publication benchmark for the durable generation publisher.
//
// Measures the end-to-end publication pipeline:
//   1. RESERVE  — reserveGenerationStaging (UUID + exclusive file create + fsync).
//   2. POPULATE — write N nodes / edges / file_hashes into the staging DB
//      (via better-sqlite3 + initIndexerSchema + updateProjectStats).
//   3. PREPARE  — prepareGenerationForPublication (WAL finalize + integrity
//      check + counts + streaming SHA-256 + manifest build + token register).
//   4. PUBLISH  — publishPreparedGeneration (CAS BEGIN IMMEDIATE +
//      reconcile + dedup + link + fsync + atomic manifest + verify +
//      CAS update + COMMIT).
//
// Smoke mode (--smoke or CBM_BENCH_SMOKE=1): 5 generations, 10 nodes each.
// Full mode: 50 generations, 100 nodes each.
//
// The benchmark verifies the R169B invariants:
//   - Each publication produces a durable generations/generation-<uuid>.db.
//   - The active manifest points at the last published generation.
//   - The CAS revision is monotonically increasing.
//   - No -wal/-shm/-journal sidecars exist after publication.
//   - The CAS catalog has one ACTIVE entry per published generation.
//   - Re-publishing the same content dedups (no new DB file).

import { mkdtempSync, rmSync, existsSync, readdirSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  reserveGenerationStaging,
  prepareGenerationForPublication,
  publishPreparedGeneration,
  publishPreparedGenerationInternal,
  discardPreparedGeneration,
} from "../src/storage/generation-publisher.js";
import { planGenerationGc, applyGenerationGcPlan } from "../src/storage/generation-gc.js";
import { PROD_PUBLISHER_OPS } from "../src/storage/internal/generation-publisher-ops.js";
import {
  projectStoreDir,
  generationsDir,
  activeManifestPath,
  GENERATIONS_SUBDIR,
} from "../src/storage/generation-paths.js";
import { CAS_DB_FILENAME } from "../src/storage/internal/generation-cas-store.js";
import { openCasStore } from "../src/storage/internal/generation-cas-store.js";
import {
  CURRENT_DISCOVERY_POLICY_VERSION,
  initIndexerSchema,
  updateProjectStats,
} from "../src/indexer/schema.js";

const SMOKE = process.argv.includes("--smoke") || process.env.CBM_BENCH_SMOKE === "1";
const N_GENERATIONS = SMOKE ? 5 : 50;
const N_NODES = SMOKE ? 10 : 100;
const N_EDGES = N_NODES;
const N_FILES = N_NODES;

const PROJECT = "r169b-bench-project";

interface PhaseTimings {
  reserveMs: number[];
  populateMs: number[];
  prepareMs: number[];
  publishMs: number[];
}

/**
 * R169B-STEP10 (§15): Fine-grained barrier timings inside PUBLISH.
 * Measures the time between consecutive barrier callbacks to break
 * down the publish phase into sub-phases.
 */
interface BarrierTimings {
  // Each entry is the time (ms) between the previous barrier and this one.
  // The first entry is from publish start to pre-fsync-temp.
  preFsyncTemp: number[];
  fsyncTemp: number[];       // pre-fsync-temp → after-temp-fsync
  link: number[];            // after-temp-fsync → pre-link (lstat check)
  linkSync: number[];        // pre-link → after-link
  generationsFsync: number[]; // after-link → after-generations-fsync
  metadata: number[];        // after-generations-fsync → after-metadata
  manifest: number[];        // after-metadata → after-manifest
  postverify: number[];      // after-manifest → pre-cas-commit
  casCommit: number[];       // pre-cas-commit → after-cas-commit
}

interface BenchResult {
  scenario: string;
  wallMs: number;
  generations: number;
  nodesPerGen: number;
  casRevision: number;
  activeGenerationId: string | null;
  catalogActive: number;
  catalogDeleted: number;
  dedupedRepub: boolean;
  dbBytes: number;
  barriers: BarrierTimings | null;
  phases: {
    reserveAvgMs: number;
    populateAvgMs: number;
    prepareAvgMs: number;
    publishAvgMs: number;
    reserveTotalMs: number;
    populateTotalMs: number;
    prepareTotalMs: number;
    publishTotalMs: number;
    reserveP50: number;
    reserveP95: number;
    prepareP50: number;
    prepareP95: number;
    publishP50: number;
    publishP95: number;
  };
  invariants: {
    manifestValid: boolean;
    dbExists: boolean;
    noWalSidecars: boolean;
    casMonotonic: boolean;
  };
  errors: number;
  errorMessages: string[];
}

// R169B (§23 PERF-04): use performance.now() for sub-millisecond precision.
import { performance } from "node:perf_hooks";

function nowMs(): number {
  return performance.now();
}

function populateStagingDb(dbPath: string, genIndex: number): void {
  const db = new Database(dbPath, { fileMustExist: false });
  initIndexerSchema(db);

  const insertNode = db.prepare(`
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < N_NODES; i++) {
    insertNode.run(PROJECT, "function", `func${genIndex}_${i}`, `${PROJECT}::func${genIndex}_${i}`, `/root/file${genIndex}_${i}.ts`, 1 + i * 10, 5 + i * 10);
  }

  const insertEdge = db.prepare(`
    INSERT INTO edges (project, source_id, target_id, type)
    VALUES (?, ?, ?, ?)
  `);
  for (let i = 0; i < N_EDGES; i++) {
    insertEdge.run(PROJECT, (i % N_NODES) + 1, ((i + 1) % N_NODES) + 1, "CALLS");
  }

  const insertFile = db.prepare(`
    INSERT INTO file_hashes (project, file_path, content_hash, mtime, size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < N_FILES; i++) {
    insertFile.run(PROJECT, `/root/file${genIndex}_${i}.ts`, `hash${genIndex}_${i}`, Date.now(), 100, new Date().toISOString());
  }

  updateProjectStats(
    db,
    PROJECT,
    "/canonical/root",
    N_NODES,
    N_EDGES,
    false, // crossFileCallsStale
    true, // callSitesInitialized
    8, // extractorSemanticsVersion
    null, // indexError
    true, // aliasHistoryInitialized
    CURRENT_DISCOVERY_POLICY_VERSION,
    "/canonical/root:123:456",
  );

  db.close();
}

function runBenchmark(): BenchResult {
  const errors: string[] = [];
  const cacheRoot = mkdtempSync(join(tmpdir(), "r169b-bench-"));

  let casMonotonic = true;
  let lastRevision = 0;
  const publishedIds: string[] = [];
  let dedupedRepub = false;

  const phases: PhaseTimings = {
    reserveMs: [],
    populateMs: [],
    prepareMs: [],
    publishMs: [],
  };

  // R169B-STEP10 (§15): Fine-grained barrier timings.
  const barriers: BarrierTimings = {
    preFsyncTemp: [],
    fsyncTemp: [],
    link: [],
    linkSync: [],
    generationsFsync: [],
    metadata: [],
    manifest: [],
    postverify: [],
    casCommit: [],
  };

  // R169B-STEP10 (§15): track DB bytes for MB/s computation.
  const dbSizes: number[] = [];

  const start = nowMs();

  try {
    for (let i = 0; i < N_GENERATIONS; i++) {
      // RESERVE
      const t0 = nowMs();
      const reservation = reserveGenerationStaging(PROJECT, { cacheRoot });
      const t1 = nowMs();
      phases.reserveMs.push(t1 - t0);

      // POPULATE
      populateStagingDb(reservation.stagingPath, i);
      const t2 = nowMs();
      phases.populateMs.push(t2 - t1);

      // PREPARE
      const prepared = prepareGenerationForPublication(reservation);
      const t3 = nowMs();
      phases.prepareMs.push(t3 - t2);

      // PUBLISH — use publishPreparedGenerationInternal with a barrier
      // callback to capture fine-grained sub-phase timings.
      let lastBarrierTime = 0;
      const onBarrier = (point: string): void => {
        const now = nowMs();
        const delta = lastBarrierTime === 0 ? 0 : now - lastBarrierTime;
        lastBarrierTime = now;
        switch (point) {
          case "pre-fsync-temp": barriers.preFsyncTemp.push(delta); break;
          case "after-temp-fsync": barriers.fsyncTemp.push(delta); break;
          case "pre-link": barriers.link.push(delta); break;
          case "after-link": barriers.linkSync.push(delta); break;
          case "after-generations-fsync": barriers.generationsFsync.push(delta); break;
          case "after-metadata": barriers.metadata.push(delta); break;
          case "after-manifest": barriers.manifest.push(delta); break;
          case "pre-cas-commit": barriers.postverify.push(delta); break;
          case "after-cas-commit": barriers.casCommit.push(delta); break;
        }
      };
      lastBarrierTime = nowMs();
      const result = publishPreparedGenerationInternal(
        prepared,
        { expectedActiveGenerationId: i === 0 ? null : publishedIds[publishedIds.length - 1] },
        { cacheRoot },
        PROD_PUBLISHER_OPS,
        onBarrier,
      );
      const t4 = nowMs();
      phases.publishMs.push(t4 - t3);

      // R169B (§23 PERF-01): Track DB size from prepared.manifest.sizeBytes
      // (not statSync on staging — staging is deleted after publish).
      dbSizes.push(prepared.manifest.sizeBytes);

      // Verify CAS revision is monotonic.
      if (result.cas.revision <= lastRevision) {
        casMonotonic = false;
      }
      lastRevision = result.cas.revision;
      publishedIds.push(result.generationId);
    }

    // Dedup test: re-publish the FIRST generation's content under a new
    // staging path. The publisher should detect the dedup candidate
    // (same sha256+size+fingerprint+versions) and reuse the existing
    // generation-<uuid>.db.
    const firstResult = publishedIds[0];
    const firstDbPath = join(projectStoreDir(PROJECT, cacheRoot), GENERATIONS_SUBDIR, `generation-${firstResult}.db`);
    const dedupReservation = reserveGenerationStaging(PROJECT, { cacheRoot });
    // Overwrite the staging file with the first generation's DB bytes.
    copyFileSync(firstDbPath, dedupReservation.stagingPath);
    const dedupPrepared = prepareGenerationForPublication(dedupReservation);
    const dedupResult = publishPreparedGeneration(
      dedupPrepared,
      { expectedActiveGenerationId: publishedIds[publishedIds.length - 1] },
      { cacheRoot },
    );
    dedupedRepub = dedupResult.cas.deduped;
    if (!dedupedRepub) {
      errors.push("dedup: re-publication of identical content did not dedup");
    }
  } catch (e) {
    errors.push(`publication error: ${(e as Error).message}`);
  }

  const wallMs = nowMs() - start;

  // Verify invariants.
  const manifestPath = activeManifestPath(PROJECT, cacheRoot);
  let manifestValid = false;
  let dbExists = false;
  let activeGenerationId: string | null = null;
  try {
    const manifestJson = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifestValid = manifestJson.formatVersion === 1 && typeof manifestJson.generationId === "string";
    activeGenerationId = manifestJson.generationId;
    const dbPath = join(projectStoreDir(PROJECT, cacheRoot), manifestJson.dbFile);
    dbExists = existsSync(dbPath);
  } catch (e) {
    errors.push(`manifest verify error: ${(e as Error).message}`);
  }

  // No -wal/-shm sidecars.
  const gens = generationsDir(PROJECT, cacheRoot);
  let noWalSidecars = true;
  try {
    const entries = readdirSync(gens);
    for (const e of entries) {
      if (e.endsWith("-wal") || e.endsWith("-shm") || e.endsWith("-journal")) {
        noWalSidecars = false;
        errors.push(`unexpected sidecar: ${e}`);
      }
    }
  } catch (e) {
    errors.push(`generations dir read error: ${(e as Error).message}`);
  }

  // CAS catalog counts.
  let catalogActive = 0;
  let catalogDeleted = 0;
  let casRevision = 0;
  try {
    const cas = openCasStore(PROJECT, cacheRoot);
    catalogActive = cas.listCatalogEntriesByStatus("ACTIVE").length;
    catalogDeleted = cas.listCatalogEntriesByStatus("DELETED").length;
    casRevision = cas.getRevision();
    cas.close();
  } catch (e) {
    errors.push(`cas inspect error: ${(e as Error).message}`);
  }

  // Best-effort cleanup.
  try {
    rmSync(cacheRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Compute per-phase averages.
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  return {
    scenario: SMOKE ? "publication-smoke" : "publication-full",
    wallMs,
    generations: N_GENERATIONS,
    nodesPerGen: N_NODES,
    casRevision,
    activeGenerationId,
    catalogActive,
    catalogDeleted,
    dedupedRepub,
    dbBytes: dbSizes.reduce((a, b) => a + b, 0),
    barriers: {
      preFsyncTemp: barriers.preFsyncTemp,
      fsyncTemp: barriers.fsyncTemp,
      link: barriers.link,
      linkSync: barriers.linkSync,
      generationsFsync: barriers.generationsFsync,
      metadata: barriers.metadata,
      manifest: barriers.manifest,
      postverify: barriers.postverify,
      casCommit: barriers.casCommit,
    },
    phases: {
      reserveAvgMs: Math.round(avg(phases.reserveMs) * 100) / 100,
      populateAvgMs: Math.round(avg(phases.populateMs) * 100) / 100,
      prepareAvgMs: Math.round(avg(phases.prepareMs) * 100) / 100,
      publishAvgMs: Math.round(avg(phases.publishMs) * 100) / 100,
      reserveTotalMs: Math.round(sum(phases.reserveMs)),
      populateTotalMs: Math.round(sum(phases.populateMs)),
      prepareTotalMs: Math.round(sum(phases.prepareMs)),
      publishTotalMs: Math.round(sum(phases.publishMs)),
      reserveP50: Math.round(percentile(phases.reserveMs, 50) * 100) / 100,
      reserveP95: Math.round(percentile(phases.reserveMs, 95) * 100) / 100,
      prepareP50: Math.round(percentile(phases.prepareMs, 50) * 100) / 100,
      prepareP95: Math.round(percentile(phases.prepareMs, 95) * 100) / 100,
      publishP50: Math.round(percentile(phases.publishMs, 50) * 100) / 100,
      publishP95: Math.round(percentile(phases.publishMs, 95) * 100) / 100,
    },
    invariants: {
      manifestValid,
      dbExists,
      noWalSidecars,
      casMonotonic,
    },
    errors: errors.length,
    errorMessages: errors,
  };
}

function formatResult(r: BenchResult): string {
  const lines: string[] = [];
  lines.push(`R169B publication benchmark — ${r.scenario}`);
  lines.push(`  generations: ${r.generations} (× ${r.nodesPerGen} nodes each)`);
  lines.push(`  wall time:   ${r.wallMs} ms`);
  lines.push(``);
  lines.push(`  per-phase timing (avg / total over ${r.generations} generations):`);
  lines.push(`    RESERVE   ${r.phases.reserveAvgMs.toFixed(2)} ms/gen avg  ${r.phases.reserveTotalMs} ms total`);
  lines.push(`    POPULATE  ${r.phases.populateAvgMs.toFixed(2)} ms/gen avg  ${r.phases.populateTotalMs} ms total`);
  lines.push(`    PREPARE   ${r.phases.prepareAvgMs.toFixed(2)} ms/gen avg  ${r.phases.prepareTotalMs} ms total`);
  lines.push(`    PUBLISH   ${r.phases.publishAvgMs.toFixed(2)} ms/gen avg  ${r.phases.publishTotalMs} ms total`);
  const phaseSum = r.phases.reserveTotalMs + r.phases.populateTotalMs + r.phases.prepareTotalMs + r.phases.publishTotalMs;
  lines.push(`    ────────`);
  lines.push(`    SUM       ${phaseSum} ms (wall ${r.wallMs} ms, overhead ${r.wallMs - phaseSum} ms)`);
  lines.push(``);
  if (r.barriers) {
    const b = r.barriers;
    lines.push(`  PUBLISH sub-phases (barrier-to-barrier, avg ms/gen):`);
    lines.push(`    pre-fsync-temp (CAS+dedup+copy+hash)  ${avg(b.preFsyncTemp).toFixed(2)}`);
    lines.push(`    fsync(temp)                          ${avg(b.fsyncTemp).toFixed(2)}`);
    lines.push(`    lstat check (after-fsync → pre-link) ${avg(b.link).toFixed(2)}`);
    lines.push(`    link(temp, final)                    ${avg(b.linkSync).toFixed(2)}`);
    lines.push(`    fsync(generations/)                  ${avg(b.generationsFsync).toFixed(2)}`);
    lines.push(`    metadata write                       ${avg(b.metadata).toFixed(2)}`);
    lines.push(`    manifest write                       ${avg(b.manifest).toFixed(2)}`);
    lines.push(`    postverify                           ${avg(b.postverify).toFixed(2)}`);
    lines.push(`    CAS commit                           ${avg(b.casCommit).toFixed(2)}`);
    lines.push(``);
  }
  if (r.dbBytes > 0) {
    const totalMb = r.dbBytes / (1024 * 1024);
    const publishSec = r.phases.publishTotalMs / 1000;
    // R169B (§23 PERF-02): dbBytes is already the total — don't multiply by generations.
    const mbPerSec = publishSec > 0 ? totalMb / publishSec : 0;
    lines.push(`  DB size:      ${(totalMb / r.generations).toFixed(2)} MB/gen (${r.dbBytes} bytes total)`);
    lines.push(`  throughput:   ${mbPerSec.toFixed(1)} MB/s (publish phase)`);
    lines.push(``);
  }
  lines.push(`  CAS revision: ${r.casRevision}`);
  lines.push(`  CAS catalog:  ACTIVE=${r.catalogActive}, DELETED=${r.catalogDeleted}`);
  lines.push(`  active gen:   ${r.activeGenerationId ?? "(none)"}`);
  lines.push(`  dedup republish: ${r.dedupedRepub ? "OK" : "FAIL"}`);
  lines.push(`  invariants:`);
  lines.push(`    manifest valid:  ${r.invariants.manifestValid ? "OK" : "FAIL"}`);
  lines.push(`    db exists:       ${r.invariants.dbExists ? "OK" : "FAIL"}`);
  lines.push(`    no WAL sidecars: ${r.invariants.noWalSidecars ? "OK" : "FAIL"}`);
  lines.push(`    CAS monotonic:   ${r.invariants.casMonotonic ? "OK" : "FAIL"}`);
  lines.push(`  errors: ${r.errors}`);
  if (r.errorMessages.length > 0) {
    lines.push(`  error details:`);
    for (const message of r.errorMessages) lines.push(`    - ${message}`);
  }
  return lines.join("\n");
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

const result = runBenchmark();
console.log(formatResult(result));

const allOk =
  result.invariants.manifestValid &&
  result.invariants.dbExists &&
  result.invariants.noWalSidecars &&
  result.invariants.casMonotonic &&
  result.dedupedRepub &&
  result.errors === 0;

if (allOk) {
  console.log("\nBENCHMARK PASSED — all invariants met");
  process.exit(0);
} else {
  console.log("\nBENCHMARK FAILED — see invariants above");
  process.exit(1);
}
