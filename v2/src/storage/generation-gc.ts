/**
 * R169B-STEP2 — Generation GC planner and executor (§13, §17).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * This module owns the garbage-collection pipeline for the R169B
 * generation store. It is split into a PLANNER (read-only) and an
 * APPLIER (write), so a plan can be inspected, logged, or compared
 * against another plan before any deletion happens.
 *
 * PLANNER (planGenerationGc):
 *   - Reads the active manifest.
 *   - Reads the CAS revision and the catalog / publication_history.
 *   - Computes the retain set: active + N previous DISTINCT
 *     generations (ordered by publication_history DESC) + pinned.
 *   - Computes the delete set: every ACTIVE catalog entry not in the
 *     retain set.
 *   - Computes the sweep-tmp set: canonical staging artifacts in
 *     tmp/ older than tmpMaxAgeMs.
 *   - NEVER uses mtime or readdir order for the retain/delete
 *     decision. mtime is only used for the tmp/ age sweep (which is
 *     explicitly age-based).
 *   - NEVER promotes anything from tmp/ — promotion is a separate
 *     publication act.
 *
 * APPLIER (applyGenerationGcPlan):
 *   - Re-reads the active manifest and CAS revision.
 *   - If the CAS revision changed since the plan was made → GC_PLAN_STALE,
 *     zero deletions.
 *   - For each delete entry:
 *       1. Re-check the entry is not the active generation (defense
 *          in depth — the planner already excluded it).
 *       2. Re-check the entry is not pinned.
 *       3. Open CAS, BEGIN IMMEDIATE, mark DELETING, COMMIT.
 *       4. Delete the metadata sidecar.
 *       5. Delete the DB file (final path).
 *       6. fsync the generations/ directory.
 *       7. Open CAS, BEGIN IMMEDIATE, mark DELETED, COMMIT.
 *       8. On any failure → GC_DELETE_FAILED warning, continue.
 *   - For each sweep-tmp entry:
 *       1. Stat the path; verify it is a regular file (not symlink).
 *       2. Verify the path is inside tmp/ (containment).
 *       3. unlink.
 *       4. On any failure → GC_DELETE_FAILED warning, continue.
 *
 * DEPENDENCY DIRECTION (R169B-STEP2):
 *   types -> paths/validation -> internal I/O + CAS store -> public facades
 *
 *   - This module imports types from `./generation-types.js`.
 *   - This module imports path helpers from `./generation-paths.js`.
 *   - This module imports validators / trust-root checks from
 *     `./generation-validation.js`.
 *   - This module imports the CAS store (openCasStore) from
 *     `./internal/generation-cas-store.js`.
 *   - This module imports the internal I/O harness (PROD_OPS,
 *     openDirectoryNoFollow) from `./internal/generation-store-io.js`.
 *   - This module does NOT import from the publisher — the GC operates
 *     purely on the CAS + on-disk state, not on PreparedGeneration
 *     handles.
 *
 * R169B remains FOUNDATION / INACTIVE.
 */

import {
  lstatSync,
  unlinkSync,
  existsSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import {
  GenerationStoreError,
  type GenerationStoreWarning,
  type GenerationGcOptions,
  type GenerationGcPlan,
  type GenerationGcPlanEntry,
  type GenerationGcTmpEntry,
  type GenerationGcResult,
  type GenerationManifestV1,
} from "./generation-types.js";
import {
  getCacheRoot,
  projectStoreDir,
  generationsDir,
  tmpDir,
  activeManifestPath,
  GENERATIONS_SUBDIR,
} from "./generation-paths.js";
import {
  assertTrustedRootNoSymlinks,
  assertPathInsideNoSymlinks,
  parseGenerationManifest,
} from "./generation-validation.js";
import { PROD_OPS, openDirectoryNoFollow } from "./internal/generation-store-io.js";
import { openCasStore } from "./internal/generation-cas-store.js";

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * R169B-STEP2: Default retain count. The active generation + 2
 * previous distinct generations are retained. Anything older (and not
 * pinned) is eligible for deletion.
 */
const DEFAULT_RETAIN_COUNT = 2;

/**
 * R169B-STEP2: Default max age for tmp/ artifacts (24 hours). Older
 * canonical staging DBs are swept by the GC (with identity
 * verification). The age is mtime-based — this is the ONLY place
 * where mtime is consulted, and it is explicitly age-based (not
 * ordering-based).
 */
const DEFAULT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── PLANNER: planGenerationGc ───────────────────────────────────────────

/**
 * R169B-STEP2 §13: Plan a generation GC pass.
 *
 * The plan is computed from the active manifest + CAS catalog +
 * publication_history. It NEVER uses mtime or readdir order for the
 * retain/delete decision — only the publication_history ordering
 * (most-recent-first) is used.
 *
 * Returns a `GenerationGcPlan` with:
 *   - `retain`: active + retainCount previous DISTINCT + pinned.
 *   - `delete`: every ACTIVE catalog entry not in retain.
 *   - `sweepTmp`: canonical staging artifacts in tmp/ older than
 *     `tmpMaxAgeMs`.
 *   - `reasons`: per-generation-ID reason string.
 *
 * Throws:
 *   - PATH_TRAVERSAL_REJECTED — trust-root validation failed.
 *   - PUBLICATION_CAS_STATE_CORRUPT — CAS could not be opened.
 */
export function planGenerationGc(
  project: string,
  options?: GenerationGcOptions,
): GenerationGcPlan {
  const phase = "planGenerationGc";
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError(
      "PROJECT_KEY_INVALID",
      phase,
      String(project),
      "project must be a non-empty string",
    );
  }
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();
  const retainCount = options?.retainCount ?? DEFAULT_RETAIN_COUNT;
  const tmpMaxAgeMs = options?.tmpMaxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
  const extraPinned = new Set(options?.pin ?? []);

  // 1. Validate trust root.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  const tmp = tmpDir(project, cacheRoot);
  const manifestPath = activeManifestPath(project, cacheRoot);

  // 2. Read the active manifest (ground truth for "what is active").
  let activeManifest: GenerationManifestV1 | null = null;
  try {
    activeManifest = parseGenerationManifest(manifestPath, project);
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      if (e.code !== "MANIFEST_PARSE_ERROR") {
        throw e;
      }
      activeManifest = null;
    } else {
      throw e;
    }
  }
  const activeGenerationId = activeManifest?.generationId ?? null;

  // 3. Open the CAS and read the catalog + history + revision.
  const cas = openCasStore(project, cacheRoot);
  let casRevision: number;
  let activeEntries: ReturnType<typeof cas.listCatalogEntriesByStatus>;
  let history: ReturnType<typeof cas.listPublicationHistory>;
  try {
    casRevision = cas.getRevision();
    activeEntries = cas.listCatalogEntriesByStatus("ACTIVE");
    history = cas.listPublicationHistory(project);
  } finally {
    cas.close();
  }

  // 4. Build the retain set:
  //    a. Active generation.
  //    b. retainCount previous DISTINCT generations (ordered by
  //       publication_history DESC). "Distinct" means we skip
  //       duplicates of the active generation.
  //    c. Pinned generations (catalog.pinned=true OR in options.pin).
  const retainIds: Set<string> = new Set();
  const reasons: Record<string, string> = {};

  if (activeGenerationId !== null) {
    retainIds.add(activeGenerationId);
    reasons[activeGenerationId] = "active";
  }

  // Walk publication_history (already most-recent-first) and collect
  // distinct generation IDs that are NOT the active generation, until
  // we have retainCount of them.
  const distinctPrevious: string[] = [];
  const seen = new Set<string>(activeGenerationId ? [activeGenerationId] : []);
  for (const entry of history) {
    if (distinctPrevious.length >= retainCount) break;
    // Only PUBLISH actions count as a "previous generation" publication.
    // PIN / UNPIN / MARK_DELETING / DELETE / UNPUBLISH actions are
    // bookkeeping and do NOT advance the retain-N cursor.
    if (entry.action !== "PUBLISH") continue;
    if (entry.generationId === activeGenerationId) continue;
    if (entry.generationId === "") continue; // skip UNPUBLISH placeholders
    if (seen.has(entry.generationId)) continue;
    seen.add(entry.generationId);
    distinctPrevious.push(entry.generationId);
  }
  distinctPrevious.forEach((gid, idx) => {
    retainIds.add(gid);
    reasons[gid] = `retain-${idx + 1}`;
  });

  // Pinned (from CAS catalog).
  for (const entry of activeEntries) {
    if (entry.pinned) {
      if (!retainIds.has(entry.generationId)) {
        retainIds.add(entry.generationId);
        reasons[entry.generationId] = "pinned";
      } else if (reasons[entry.generationId] === "active") {
        // Active + pinned — keep "active" reason.
      } else if (reasons[entry.generationId]?.startsWith("retain-")) {
        // Retain + pinned — keep retain reason.
      }
    }
  }
  // Pinned (from options.pin).
  for (const gid of extraPinned) {
    if (!retainIds.has(gid)) {
      retainIds.add(gid);
      reasons[gid] = "pinned-extra";
    }
  }

  // 5. Build the retain / delete lists.
  const retainEntries: GenerationGcPlanEntry[] = [];
  const deleteEntries: GenerationGcPlanEntry[] = [];

  for (const entry of activeEntries) {
    const dbPath = join(projectStore, GENERATIONS_SUBDIR, `generation-${entry.generationId}.db`);
    const metadataPath = join(projectStore, GENERATIONS_SUBDIR, `generation-${entry.generationId}.json`);
    const metadataExists = existsSync(metadataPath);
    const planEntry: GenerationGcPlanEntry = {
      generationId: entry.generationId,
      dbPath,
      metadataPath: metadataExists ? metadataPath : null,
      reason: reasons[entry.generationId] ?? "stale",
      pinned: entry.pinned || extraPinned.has(entry.generationId),
    };
    if (retainIds.has(entry.generationId)) {
      retainEntries.push(planEntry);
    } else {
      if (!reasons[entry.generationId]) {
        reasons[entry.generationId] = "stale";
      }
      deleteEntries.push(planEntry);
    }
  }

  // 6. Compute the sweep-tmp list.
  const sweepTmp: GenerationGcTmpEntry[] = [];
  if (existsSync(tmp)) {
    let tmpEntries: import("node:fs").Dirent[];
    try {
      tmpEntries = readdirSync(tmp, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch {
      // Best-effort — if we can't read tmp/, skip the sweep.
      tmpEntries = [];
    }
    const now = Date.now();
    for (const ent of tmpEntries) {
      if (!ent.isFile()) continue;
      // Only consider canonical staging artifacts: generation-<uuid>.db.
      if (!/^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/.test(ent.name)) {
        continue;
      }
      const entPath = join(tmp, ent.name);
      let st: Stats;
      try {
        st = lstatSync(entPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never sweep symlinks
      if (!st.isFile()) continue;
      // Age check (mtime-based — explicitly age-based, not ordering).
      const ageMs = now - st.mtimeMs;
      if (ageMs < tmpMaxAgeMs) continue;
      sweepTmp.push({
        path: entPath,
        reason: `tmp-age-${Math.round(ageMs / 1000)}s`,
      });
    }
  }

  return {
    project,
    cacheRoot,
    activeGenerationId,
    casRevision,
    retain: retainEntries,
    delete: deleteEntries,
    sweepTmp,
    reasons,
  };
}

// ─── APPLIER: applyGenerationGcPlan ──────────────────────────────────────

/**
 * R169B-STEP2 §17: Apply a generation GC plan.
 *
 * The applier:
 *   1. Re-reads the active manifest and CAS revision.
 *   2. If the CAS revision changed since the plan was made →
 *      GC_PLAN_STALE, zero deletions.
 *   3. For each delete entry:
 *      a. Re-check the entry is not the active generation (defense
 *         in depth — the planner already excluded it).
 *      b. Re-check the entry is not pinned.
 *      c. Mark DELETING in the CAS.
 *      d. Delete the metadata sidecar (best-effort).
 *      e. Delete the DB file (best-effort).
 *      f. fsync the generations/ directory.
 *      g. Mark DELETED in the CAS.
 *      h. On any failure → GC_DELETE_FAILED warning, continue.
 *   4. For each sweep-tmp entry:
 *      a. Re-verify the path is inside tmp/ (containment).
 *      b. Re-verify the file is not a symlink.
 *      c. unlink (best-effort).
 *      d. On any failure → GC_DELETE_FAILED warning, continue.
 *
 * The applier NEVER:
 *   - Deletes the active generation (defense in depth).
 *   - Deletes a pinned generation (defense in depth).
 *   - Promotes anything from tmp/ — promotion is a separate
 *     publication act.
 *
 * Returns a `GenerationGcResult`:
 *   - `applied`: true if the plan was applied.
 *   - `reason`: null if applied; "GC_PLAN_STALE" if the CAS revision
 *     changed.
 *   - `deletedGenerations`: IDs actually deleted.
 *   - `deletedTmp`: paths actually unlinked.
 *   - `warnings`: non-fatal anomalies.
 */
export function applyGenerationGcPlan(
  plan: GenerationGcPlan,
  options?: GenerationGcOptions,
): GenerationGcResult {
  const phase = "applyGenerationGcPlan";
  const project = plan.project;
  const cacheRoot = options?.cacheRoot ?? plan.cacheRoot ?? getCacheRoot();

  // 1. Re-validate trust root.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const generations = generationsDir(project, cacheRoot);
  const tmp = tmpDir(project, cacheRoot);
  const manifestPath = activeManifestPath(project, cacheRoot);

  // 2. Re-read the active manifest.
  let activeManifest: GenerationManifestV1 | null = null;
  try {
    activeManifest = parseGenerationManifest(manifestPath, project);
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      if (e.code !== "MANIFEST_PARSE_ERROR") {
        throw e;
      }
      activeManifest = null;
    } else {
      throw e;
    }
  }
  const currentActiveId = activeManifest?.generationId ?? null;

  // 3. Re-read the CAS revision.
  const cas = openCasStore(project, cacheRoot);
  let currentRevision: number;
  try {
    currentRevision = cas.getRevision();
  } finally {
    cas.close();
  }

  // 4. Stale check.
  if (currentRevision !== plan.casRevision) {
    return {
      applied: false,
      reason: "GC_PLAN_STALE",
      deletedGenerations: [],
      deletedTmp: [],
      warnings: [],
    };
  }

  const warnings: GenerationStoreWarning[] = [];
  const deletedGenerations: string[] = [];
  const deletedTmp: string[] = [];

  // 5. Apply the delete list.
  for (const entry of plan.delete) {
    // a. Re-check active.
    if (entry.generationId === currentActiveId) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete active generation ${entry.generationId} (defense in depth — plan was stale?)`,
      });
      continue;
    }
    // b. Re-check pinned.
    const cas2 = openCasStore(project, cacheRoot);
    let isPinned = false;
    try {
      const catalogEntry = cas2.getGenerationCatalogEntry(entry.generationId);
      isPinned = catalogEntry?.pinned ?? false;
    } finally {
      cas2.close();
    }
    if (isPinned) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete pinned generation ${entry.generationId} (defense in depth)`,
      });
      continue;
    }

    // c. Mark DELETING in the CAS.
    const cas3 = openCasStore(project, cacheRoot);
    let markedDeleting = false;
    try {
      cas3.beginImmediate();
      // Re-check pinning under the lock (avoid TOCTOU).
      const cat = cas3.getGenerationCatalogEntry(entry.generationId);
      if (cat?.pinned) {
        cas3.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Refused to delete pinned generation ${entry.generationId} (under CAS lock)`,
        });
        continue;
      }
      cas3.setCatalogStatus(entry.generationId, "DELETING");
      cas3.appendPublicationHistory(entry.generationId, project, "MARK_DELETING", null);
      cas3.incrementRevision();
      cas3.commit();
      markedDeleting = true;
    } catch (e) {
      try { cas3.rollback(); } catch { /* best effort */ }
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Failed to mark ${entry.generationId} as DELETING: ${(e as Error).message}`,
      });
      continue;
    } finally {
      cas3.close();
    }
    if (!markedDeleting) continue;

    // d. Delete the metadata sidecar (best-effort).
    if (entry.metadataPath) {
      try {
        if (existsSync(entry.metadataPath)) {
          unlinkSync(entry.metadataPath);
        }
      } catch (e) {
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Failed to delete metadata sidecar ${entry.metadataPath}: ${(e as Error).message}`,
        });
      }
    }

    // e. Delete the DB file (best-effort).
    try {
      if (existsSync(entry.dbPath)) {
        // Defense in depth: verify the DB path is inside generations/.
        assertPathInsideNoSymlinks(
          generations,
          entry.dbPath,
          project,
          phase,
          "GENERATION_TARGET_SYMLINK_REJECTED",
        );
        unlinkSync(entry.dbPath);
      }
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Failed to delete DB ${entry.dbPath}: ${(e as Error).message}`,
      });
    }

    // f. fsync the generations/ directory.
    let dirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(generations, PROD_OPS);
      dirFd = opened.fd;
      PROD_OPS.fsyncSync(dirFd);
      PROD_OPS.closeSync(dirFd);
      dirFd = null;
    } catch (e) {
      if (dirFd !== null) {
        try { PROD_OPS.closeSync(dirFd); } catch { /* best effort */ }
      }
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `fsync of generations/ failed after deleting ${entry.generationId}: ${(e as Error).message}`,
      });
    }

    // g. Mark DELETED in the CAS.
    const cas4 = openCasStore(project, cacheRoot);
    try {
      cas4.beginImmediate();
      cas4.setCatalogStatus(entry.generationId, "DELETED");
      cas4.appendPublicationHistory(entry.generationId, project, "DELETE", null);
      cas4.incrementRevision();
      cas4.commit();
      deletedGenerations.push(entry.generationId);
    } catch (e) {
      try { cas4.rollback(); } catch { /* best effort */ }
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Failed to mark ${entry.generationId} as DELETED in CAS: ${(e as Error).message}`,
      });
    } finally {
      cas4.close();
    }
  }

  // 6. Apply the sweep-tmp list.
  for (const ent of plan.sweepTmp) {
    // a. Re-verify containment.
    try {
      assertPathInsideNoSymlinks(
        tmp,
        ent.path,
        project,
        phase,
        "PATH_TRAVERSAL_REJECTED",
      );
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to sweep tmp path outside tmp/: ${ent.path}: ${(e as Error).message}`,
      });
      continue;
    }
    // b. Re-verify it is not a symlink.
    let st: Stats;
    try {
      st = lstatSync(ent.path);
    } catch (e) {
      // Already gone — fine.
      continue;
    }
    if (st.isSymbolicLink()) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to sweep symlink in tmp/: ${ent.path}`,
      });
      continue;
    }
    if (!st.isFile()) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to sweep non-file in tmp/: ${ent.path}`,
      });
      continue;
    }
    // c. unlink.
    try {
      unlinkSync(ent.path);
      deletedTmp.push(ent.path);
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Failed to sweep tmp artifact ${ent.path}: ${(e as Error).message}`,
      });
    }
  }

  return {
    applied: true,
    reason: null,
    deletedGenerations,
    deletedTmp,
    warnings,
  };
}
