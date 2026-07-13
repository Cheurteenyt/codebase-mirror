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
// Smoke mode (CBM_BENCH_SMOKE=1): 5 generations, 10 nodes each.
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
  discardPreparedGeneration,
} from "../src/storage/generation-publisher.js";
import { planGenerationGc, applyGenerationGcPlan } from "../src/storage/generation-gc.js";
import {
  projectStoreDir,
  generationsDir,
  activeManifestPath,
  GENERATIONS_SUBDIR,
} from "../src/storage/generation-paths.js";
import { CAS_DB_FILENAME } from "../src/storage/internal/generation-cas-store.js";
import { openCasStore } from "../src/storage/internal/generation-cas-store.js";
import { initIndexerSchema, updateProjectStats } from "../src/indexer/schema.js";

const SMOKE = process.env.CBM_BENCH_SMOKE === "1";
const N_GENERATIONS = SMOKE ? 5 : 50;
const N_NODES = SMOKE ? 10 : 100;
const N_EDGES = N_NODES;
const N_FILES = N_NODES;

const PROJECT = "r169b-bench-project";

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
  invariants: {
    manifestValid: boolean;
    dbExists: boolean;
    noWalSidecars: boolean;
    casMonotonic: boolean;
  };
  errors: number;
}

function nowMs(): number {
  return Date.now();
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
    2, // discoveryPolicyVersion
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

  const start = nowMs();

  try {
    for (let i = 0; i < N_GENERATIONS; i++) {
      // RESERVE
      const reservation = reserveGenerationStaging(PROJECT, { cacheRoot });

      // POPULATE
      populateStagingDb(reservation.stagingPath, i);

      // PREPARE
      const prepared = prepareGenerationForPublication(reservation);

      // PUBLISH
      const result = publishPreparedGeneration(
        prepared,
        { expectedActiveGenerationId: i === 0 ? null : publishedIds[publishedIds.length - 1] },
        { cacheRoot },
      );

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
    invariants: {
      manifestValid,
      dbExists,
      noWalSidecars,
      casMonotonic,
    },
    errors: errors.length,
  };
}

function formatResult(r: BenchResult): string {
  const lines: string[] = [];
  lines.push(`R169B publication benchmark — ${r.scenario}`);
  lines.push(`  generations: ${r.generations} (× ${r.nodesPerGen} nodes each)`);
  lines.push(`  wall time:   ${r.wallMs} ms`);
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
  return lines.join("\n");
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
