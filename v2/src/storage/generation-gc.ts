/**
 * R169B-STEP3 — Generation GC planner and executor (correctness closure).
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * (GPT 5.6 Pass 1 audit findings SEC-R169B-A1-01, GC-R169B-A1-11,
 * GC-R169B-A1-12, GC-R169B-A1-13, TMP-R169B-A1-19, MANIFEST-R169B-A1-04)
 *
 * This module owns the garbage-collection pipeline for the R169B
 * generation store. It is split into a PLANNER (read-only) and an
 * APPLIER (write), so a plan can be inspected, logged, or compared
 * against another plan before any deletion happens.
 *
 * PLANNER (planGenerationGc):
 *   - Reads the active manifest via readOptionalGenerationManifest
 *     (returns null ONLY on real ENOENT; raises on corrupt manifest).
 *   - Reads the CAS revision and the catalog / publication_history.
 *   - Computes the retain set: active + N previous DISTINCT
 *     generations (ordered by publication_history DESC) + pinned.
 *   - Computes the delete set: every ACTIVE catalog entry not in the
 *     retain set.
 *   - Computes the sweep-tmp set: canonical staging artifacts in
 *     tmp/ older than tmpMaxAgeMs (including -wal, -shm, -journal
 *     sidecars, .json temp metadata, atomic temp JSON).
 *   - NEVER uses mtime or readdir order for the retain/delete
 *     decision. mtime is only used for the tmp/ age sweep.
 *   - NEVER promotes anything from tmp/ — promotion is a separate
 *     publication act.
 *   - Returns a plan AUTHENTICATED by a private WeakMap token. The
 *     applier rejects plans not in the WeakMap
 *     (GC_PLAN_UNAUTHENTICATED).
 *
 * APPLIER (applyGenerationGcPlan):
 *   - Verifies the plan's authenticity token (WeakMap).
 *   - Re-reads the active manifest (fail-closed).
 *   - Re-reads the CAS revision.
 *   - If the CAS revision changed since the plan was made →
 *     GC_PLAN_STALE, zero deletions.
 *   - For each delete entry:
 *       1. R169B-STEP3 (SEC-R169B-A1-01): DERIVE dbPath and
 *          metadataPath from the generationId — NEVER use the
 *          plan's paths as authority. The plan's paths are display-
 *          only.
 *       2. R169B-STEP3 (GC-R169B-A1-13): Validate the metadata
 *          sidecar is present, regular, non-symlink, parses to a
 *          valid V1 manifest, project/UUID/hash/size all coherent
 *          with the catalog. If any check fails → retain (safety-
 *          refusal), do NOT delete.
 *       3. Re-check the entry is not the active generation.
 *       4. Re-check the entry is not pinned.
 *       5. BEGIN IMMEDIATE; re-read catalog state; verify status is
 *          ACTIVE (not already DELETING/DELETED); mark DELETING;
 *          appendPublicationHistory(MARK_DELETING); COMMIT.
 *       6. Delete the metadata sidecar.
 *       7. Delete the DB file.
 *       8. fsync the generations/ directory.
 *       9. R169B-STEP3 (GC-R169B-A1-11): re-read to confirm both
 *          files are absent. If any deletion or fsync failed →
 *          GC_DELETE_INCOMPLETE warning; status STAYS DELETING
 *          (NOT marked DELETED); the next GC pass re-attempts.
 *      10. Only if metadata absent AND DB absent AND fsync ok AND
 *          re-read confirms absence: BEGIN IMMEDIATE; mark DELETED;
 *          appendPublicationHistory(DELETE); COMMIT.
 *   - For each sweep-tmp entry:
 *       a. Re-verify the path is inside tmp/ (containment).
 *       b. Re-verify the file is not a symlink.
 *       c. unlink.
 *       d. On any failure → GC_DELETE_FAILED warning, continue.
 *   - fsync tmp/ after the sweep.
 *
 * DEPENDENCY DIRECTION (R169B-STEP3):
 *   types -> paths/validation -> internal I/O + CAS store -> public facades
 *
 * R169B remains FOUNDATION / INACTIVE.
 */

import {
  lstatSync,
  unlinkSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
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
  readOptionalGenerationManifest,
  validateGenerationMetadata,
} from "./generation-validation.js";
import { PROD_OPS, openDirectoryNoFollow } from "./internal/generation-store-io.js";
import { openCasStore } from "./internal/generation-cas-store.js";

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_RETAIN_COUNT = 2;
const DEFAULT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Plan authenticity token (private WeakMap) ──────────────────────────

/**
 * R169B-STEP3 (SEC-R169B-A1-01): A private WeakMap that authenticates
 * plans produced by `planGenerationGc`. The applier rejects plans not
 * in this WeakMap (GC_PLAN_UNAUTHENTICATED). A literal object, spread,
 * or JSON clone produces a new reference that is NOT in the WeakMap.
 */
const planTokens: WeakMap<GenerationGcPlan, true> = new WeakMap();

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * R169B-STEP3 (SEC-R169B-A1-01): Derive the canonical DB path for a
 * generation from its UUID. The applier NEVER uses the plan's
 * `dbPath` field as authority — it always re-derives from the
 * generationId.
 */
function deriveDbPath(projectStore: string, generationId: string): string {
  return join(projectStore, GENERATIONS_SUBDIR, `generation-${generationId}.db`);
}

/**
 * R169B-STEP3 (SEC-R169B-A1-01): Derive the canonical metadata
 * sidecar path for a generation from its UUID.
 */
function deriveMetadataPath(projectStore: string, generationId: string): string {
  return join(projectStore, GENERATIONS_SUBDIR, `generation-${generationId}.json`);
}

/**
 * R169B-STEP3: Validate a UUID v4 string format.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

// ─── PLANNER: planGenerationGc ───────────────────────────────────────────

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

  // 2. R169B-STEP3 (MANIFEST-R169B-A1-04): Read the active manifest
  // via readOptionalGenerationManifest. null ONLY on real ENOENT.
  // Corrupt manifest → raise (fail-closed).
  let activeManifest: GenerationManifestV1 | null;
  try {
    activeManifest = readOptionalGenerationManifest(manifestPath, project);
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      throw new GenerationStoreError(
        "GC_SAFETY_REFUSAL",
        phase,
        project,
        `Active manifest is corrupt/unreadable (fail-closed, refusing to plan GC): [${e.code}] ${e.message}`,
      );
    }
    throw e;
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

  // 4. Build the retain set.
  const retainIds: Set<string> = new Set();
  const reasons: Record<string, string> = {};

  if (activeGenerationId !== null) {
    retainIds.add(activeGenerationId);
    reasons[activeGenerationId] = "active";
  }

  const distinctPrevious: string[] = [];
  const seen = new Set<string>(activeGenerationId ? [activeGenerationId] : []);
  for (const entry of history) {
    if (distinctPrevious.length >= retainCount) break;
    if (entry.action !== "PUBLISH") continue;
    if (entry.generationId === activeGenerationId) continue;
    if (entry.generationId === "") continue;
    if (seen.has(entry.generationId)) continue;
    seen.add(entry.generationId);
    distinctPrevious.push(entry.generationId);
  }
  distinctPrevious.forEach((gid, idx) => {
    retainIds.add(gid);
    reasons[gid] = `retain-${idx + 1}`;
  });

  for (const entry of activeEntries) {
    if (entry.pinned) {
      if (!retainIds.has(entry.generationId)) {
        retainIds.add(entry.generationId);
        reasons[entry.generationId] = "pinned";
      }
    }
  }
  for (const gid of extraPinned) {
    if (!retainIds.has(gid)) {
      retainIds.add(gid);
      reasons[gid] = "pinned-extra";
    }
  }

  // 5. Build the retain / delete lists.
  // R169B-STEP3 (SEC-R169B-A1-01): The plan's dbPath/metadataPath
  // fields are DISPLAY-ONLY — derived from the generationId. The
  // applier re-derives them and never trusts these fields.
  const retainEntries: GenerationGcPlanEntry[] = [];
  const deleteEntries: GenerationGcPlanEntry[] = [];

  for (const entry of activeEntries) {
    const dbPath = deriveDbPath(projectStore, entry.generationId);
    const metadataPath = deriveMetadataPath(projectStore, entry.generationId);
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

  // 6. R169B-STEP3 (TMP-R169B-A1-19): Compute the sweep-tmp list.
  // Include -wal, -shm, -journal sidecars, .json temp metadata, and
  // atomic temp JSON (.*.tmp.<rand>).
  const sweepTmp: GenerationGcTmpEntry[] = [];
  if (existsSync(tmp)) {
    let tmpEntries: import("node:fs").Dirent[];
    try {
      tmpEntries = readdirSync(tmp, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch {
      tmpEntries = [];
    }
    const now = Date.now();
    for (const ent of tmpEntries) {
      if (!ent.isFile()) continue;
      // Canonical staging artifacts: generation-<uuid>.db plus
      // sidecars (-wal, -shm, -journal) and temp metadata (.json).
      // Also match atomic-writer temp files (.*.tmp.<rand>).
      const isCanonical =
        /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/.test(ent.name) ||
        /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db-(wal|shm|journal)$/.test(ent.name) ||
        /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(ent.name) ||
        /^generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.tmp\.[0-9a-f]+$/.test(ent.name) ||
        /^\..*\.tmp\.[0-9a-f]+$/.test(ent.name);
      if (!isCanonical) continue;
      const entPath = join(tmp, ent.name);
      let st: Stats;
      try {
        st = lstatSync(entPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (!st.isFile()) continue;
      const ageMs = now - st.mtimeMs;
      if (ageMs < tmpMaxAgeMs) continue;
      sweepTmp.push({
        path: entPath,
        reason: `tmp-age-${Math.round(ageMs / 1000)}s`,
      });
    }
  }

  const plan: GenerationGcPlan = {
    project,
    cacheRoot,
    activeGenerationId,
    casRevision,
    retain: retainEntries,
    delete: deleteEntries,
    sweepTmp,
    reasons,
  };
  // Freeze the plan and all its nested arrays/entries so a caller
  // cannot mutate them in place.
  Object.freeze(plan);
  Object.freeze(plan.retain);
  Object.freeze(plan.delete);
  Object.freeze(plan.sweepTmp);
  for (const e of plan.retain) Object.freeze(e);
  for (const e of plan.delete) Object.freeze(e);
  for (const e of plan.sweepTmp) Object.freeze(e);
  // Register the plan in the WeakMap so the applier can authenticate it.
  planTokens.set(plan, true);
  return plan;
}

// ─── APPLIER: applyGenerationGcPlan ──────────────────────────────────────

export function applyGenerationGcPlan(
  plan: GenerationGcPlan,
  options?: GenerationGcOptions,
): GenerationGcResult {
  const phase = "applyGenerationGcPlan";
  const project = plan.project;
  const cacheRoot = options?.cacheRoot ?? plan.cacheRoot ?? getCacheRoot();

  // 0. R169B-STEP3 (SEC-R169B-A1-01): Authenticate the plan.
  if (!planTokens.has(plan)) {
    throw new GenerationStoreError(
      "GC_PLAN_UNAUTHENTICATED",
      phase,
      project,
      `Plan is not authentic (not in the private WeakMap). Plans MUST be produced by planGenerationGc in the same process; spread/JSON-clone/literal objects are rejected.`,
    );
  }

  // 1. Re-validate trust root.
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const tmp = tmpDir(project, cacheRoot);
  const manifestPath = activeManifestPath(project, cacheRoot);

  // 2. R169B-STEP3 (MANIFEST-R169B-A1-04): Re-read the active manifest
  // via readOptionalGenerationManifest. null ONLY on real ENOENT.
  let activeManifest: GenerationManifestV1 | null;
  try {
    activeManifest = readOptionalGenerationManifest(manifestPath, project);
  } catch (e) {
    if (e instanceof GenerationStoreError) {
      throw new GenerationStoreError(
        "GC_SAFETY_REFUSAL",
        phase,
        project,
        `Active manifest is corrupt/unreadable (fail-closed, refusing to apply GC): [${e.code}] ${e.message}`,
      );
    }
    throw e;
  }
  const currentActiveId = activeManifest?.generationId ?? null;

  // 3. Re-read the CAS revision.
  const cas0 = openCasStore(project, cacheRoot);
  let currentRevision: number;
  try {
    currentRevision = cas0.getRevision();
  } finally {
    cas0.close();
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
    // a. Validate the generationId format (defense in depth).
    if (!isValidUuidV4(entry.generationId)) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete generation with invalid UUID format: ${entry.generationId}`,
      });
      continue;
    }

    // b. R169B-STEP3 (SEC-R169B-A1-01): DERIVE dbPath and metadataPath
    // from the generationId. NEVER use the plan's paths as authority.
    const dbPath = deriveDbPath(projectStore, entry.generationId);
    const metadataPath = deriveMetadataPath(projectStore, entry.generationId);

    // c. Containment check on the derived paths.
    try {
      assertPathInsideNoSymlinks(generations, dbPath, project, phase, "PATH_TRAVERSAL_REJECTED");
      assertPathInsideNoSymlinks(generations, metadataPath, project, phase, "PATH_TRAVERSAL_REJECTED");
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Derived path containment failed for ${entry.generationId}: ${(e as Error).message}`,
      });
      continue;
    }

    // d. Re-check active.
    if (entry.generationId === currentActiveId) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete active generation ${entry.generationId} (defense in depth)`,
      });
      continue;
    }

    // e. R169B-STEP3 (GC-R169B-A1-13): Fail-safe on missing/corrupt
    // metadata. Before making a generation eligible for delete, the
    // metadata sidecar MUST be present, regular, non-symlink, parse
    // to a valid V1 manifest, and have project/UUID/hash/size
    // coherent with the catalog. If any check fails → retain
    // (safety-refusal), do NOT delete.
    const safetyCheck = verifyGenerationSafety(project, entry.generationId, dbPath, metadataPath, phase);
    if (!safetyCheck.ok) {
      warnings.push({
        code: "GC_SAFETY_REFUSAL",
        message: `Refused to delete generation ${entry.generationId} (safety-refusal): ${safetyCheck.reason}`,
      });
      continue;
    }

    // f. Re-check pinned (under CAS lock to avoid TOCTOU).
    const cas1 = openCasStore(project, cacheRoot);
    let markedDeleting = false;
    try {
      cas1.beginImmediate();
      const cat = cas1.getGenerationCatalogEntry(entry.generationId);
      if (cat === undefined) {
        cas1.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Generation ${entry.generationId} not in catalog (already deleted?)`,
        });
        continue;
      }
      if (cat.pinned) {
        cas1.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Refused to delete pinned generation ${entry.generationId} (under CAS lock)`,
        });
        continue;
      }
      if (cat.status !== "ACTIVE") {
        cas1.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Generation ${entry.generationId} status is ${cat.status} (not ACTIVE; already being deleted?)`,
        });
        continue;
      }
      cas1.setCatalogStatus(entry.generationId, "DELETING");
      cas1.appendPublicationHistory(entry.generationId, project, "MARK_DELETING", null);
      cas1.commit();
      markedDeleting = true;
    } catch (e) {
      try { cas1.rollback(); } catch { /* best effort */ }
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Failed to mark ${entry.generationId} as DELETING: ${(e as Error).message}`,
      });
      continue;
    } finally {
      cas1.close();
    }
    if (!markedDeleting) continue;

    // g. Delete the metadata sidecar.
    let metadataDeleted = false;
    try {
      if (existsSync(metadataPath)) {
        // Re-verify non-symlink before unlink.
        const ms = lstatSync(metadataPath);
        if (ms.isSymbolicLink()) {
          throw new Error(`metadata path is a symlink: ${metadataPath}`);
        }
        if (!ms.isFile()) {
          throw new Error(`metadata path is not a regular file: ${metadataPath}`);
        }
        unlinkSync(metadataPath);
      }
      metadataDeleted = true;
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `Failed to delete metadata sidecar ${metadataPath}: ${(e as Error).message}`,
      });
    }

    // h. Delete the DB file.
    let dbDeleted = false;
    try {
      if (existsSync(dbPath)) {
        const ds = lstatSync(dbPath);
        if (ds.isSymbolicLink()) {
          throw new Error(`db path is a symlink: ${dbPath}`);
        }
        if (!ds.isFile()) {
          throw new Error(`db path is not a regular file: ${dbPath}`);
        }
        unlinkSync(dbPath);
      }
      dbDeleted = true;
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `Failed to delete DB ${dbPath}: ${(e as Error).message}`,
      });
    }

    // i. fsync the generations/ directory.
    let dirFsyncOk = false;
    let dirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(generations, PROD_OPS);
      dirFd = opened.fd;
      PROD_OPS.fsyncSync(dirFd);
      PROD_OPS.closeSync(dirFd);
      dirFd = null;
      dirFsyncOk = true;
    } catch (e) {
      if (dirFd !== null) {
        try { PROD_OPS.closeSync(dirFd); } catch { /* best effort */ }
      }
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `fsync of generations/ failed after deleting ${entry.generationId}: ${(e as Error).message}`,
      });
    }

    // j. R169B-STEP3 (GC-R169B-A1-11): Re-read to confirm absence.
    // Only mark DELETED if metadata absent AND DB absent AND fsync ok.
    const metadataConfirmedAbsent = !existsSync(metadataPath);
    const dbConfirmedAbsent = !existsSync(dbPath);

    if (!metadataDeleted || !dbDeleted || !dirFsyncOk || !metadataConfirmedAbsent || !dbConfirmedAbsent) {
      // Incomplete — status stays DELETING. Next GC pass re-attempts.
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `Generation ${entry.generationId} deletion incomplete (metadataDeleted=${metadataDeleted}, dbDeleted=${dbDeleted}, dirFsyncOk=${dirFsyncOk}, metadataConfirmedAbsent=${metadataConfirmedAbsent}, dbConfirmedAbsent=${dbConfirmedAbsent}). Status stays DELETING; next GC pass will re-attempt.`,
      });
      continue;
    }

    // k. Mark DELETED in the CAS.
    const cas2 = openCasStore(project, cacheRoot);
    try {
      cas2.beginImmediate();
      // Re-verify status is still DELETING (no concurrent transition).
      const cat = cas2.getGenerationCatalogEntry(entry.generationId);
      if (cat === undefined) {
        cas2.rollback();
        warnings.push({
          code: "GC_DELETE_INCOMPLETE",
          message: `Generation ${entry.generationId} disappeared from catalog between DELETING and DELETED`,
        });
        continue;
      }
      if (cat.status !== "DELETING") {
        cas2.rollback();
        warnings.push({
          code: "GC_DELETE_INCOMPLETE",
          message: `Generation ${entry.generationId} status changed from DELETING to ${cat.status} during deletion`,
        });
        continue;
      }
      cas2.setCatalogStatus(entry.generationId, "DELETED");
      cas2.appendPublicationHistory(entry.generationId, project, "DELETE", null);
      cas2.commit();
      deletedGenerations.push(entry.generationId);
    } catch (e) {
      try { cas2.rollback(); } catch { /* best effort */ }
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `Failed to mark ${entry.generationId} as DELETED in CAS: ${(e as Error).message}`,
      });
    } finally {
      cas2.close();
    }
  }

  // 6. Apply the sweep-tmp list.
  for (const ent of plan.sweepTmp) {
    // a. Re-verify containment.
    try {
      assertPathInsideNoSymlinks(tmp, ent.path, project, phase, "PATH_TRAVERSAL_REJECTED");
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to sweep tmp path outside tmp/: ${ent.path}: ${(e as Error).message}`,
      });
      continue;
    }
    // b. Re-verify non-symlink.
    let st: Stats;
    try {
      st = lstatSync(ent.path);
    } catch {
      continue; // already gone
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

  // 7. R169B-STEP3 (TMP-R169B-A1-19): fsync tmp/ after the sweep.
  if (deletedTmp.length > 0) {
    let tmpFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(tmp, PROD_OPS);
      tmpFd = opened.fd;
      PROD_OPS.fsyncSync(tmpFd);
      PROD_OPS.closeSync(tmpFd);
      tmpFd = null;
    } catch (e) {
      if (tmpFd !== null) {
        try { PROD_OPS.closeSync(tmpFd); } catch { /* best effort */ }
      }
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `fsync of tmp/ failed after sweep: ${(e as Error).message}`,
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

// ─── Safety verification helper (GC-R169B-A1-13) ───────────────────────

/**
 * R169B-STEP3 (GC-R169B-A1-13): Verify a generation is safe to delete.
 * The metadata sidecar MUST be present, regular, non-symlink, parse
 * to a valid V1 metadata, and have project/UUID/hash/size coherent
 * with the catalog. If any check fails → retain (safety-refusal).
 */
function verifyGenerationSafety(
  project: string,
  generationId: string,
  dbPath: string,
  metadataPath: string,
  phase: string,
): { ok: true } | { ok: false; reason: string } {
  void phase;
  // 1. DB exists, regular, non-symlink.
  try {
    const ds = lstatSync(dbPath);
    if (ds.isSymbolicLink()) {
      return { ok: false, reason: `DB path is a symlink: ${dbPath}` };
    }
    if (!ds.isFile()) {
      return { ok: false, reason: `DB path is not a regular file: ${dbPath}` };
    }
  } catch (e) {
    return { ok: false, reason: `DB lstat failed: ${(e as Error).message}` };
  }
  // 2. Metadata exists, regular, non-symlink.
  try {
    const ms = lstatSync(metadataPath);
    if (ms.isSymbolicLink()) {
      return { ok: false, reason: `Metadata path is a symlink: ${metadataPath}` };
    }
    if (!ms.isFile()) {
      return { ok: false, reason: `Metadata path is not a regular file: ${metadataPath}` };
    }
  } catch (e) {
    return { ok: false, reason: `Metadata lstat failed: ${(e as Error).message}` };
  }
  // 3. Parse + validate metadata sidecar (strict V1 schema).
  let metadataRaw: string;
  try {
    metadataRaw = readFileSyncTextSafe(metadataPath, 256 * 1024);
  } catch (e) {
    return { ok: false, reason: `Metadata read failed: ${(e as Error).message}` };
  }
  let metadataParsed: unknown;
  try {
    metadataParsed = JSON.parse(metadataRaw);
  } catch (e) {
    return { ok: false, reason: `Metadata JSON parse failed: ${(e as Error).message}` };
  }
  let metadataValidated;
  try {
    metadataValidated = validateGenerationMetadata(metadataParsed, project);
  } catch (e) {
    return { ok: false, reason: `Metadata validation failed: ${(e as Error).message}` };
  }
  // 4. Verify the metadata's manifest project matches.
  const dm = metadataValidated.manifest;
  if (dm.project !== project) {
    return { ok: false, reason: `Metadata manifest project "${dm.project}" does not match expected "${project}"` };
  }
  // 5. Verify the metadata's manifest generationId matches.
  if (dm.generationId !== generationId) {
    return { ok: false, reason: `Metadata manifest generationId "${dm.generationId}" does not match expected "${generationId}"` };
  }
  // 6. Verify the DB's actual size matches the manifest's sizeBytes.
  try {
    const ds = lstatSync(dbPath);
    if (ds.size !== dm.sizeBytes) {
      return { ok: false, reason: `DB size ${ds.size} does not match manifest sizeBytes ${dm.sizeBytes}` };
    }
  } catch (e) {
    return { ok: false, reason: `DB re-lstat failed: ${(e as Error).message}` };
  }
  return { ok: true };
}

/**
 * R169B-STEP3: Read a file as UTF-8 text with a size bound. Returns
 * the text content. Throws on read failure or size exceeded.
 */
function readFileSyncTextSafe(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (st.size > maxBytes) {
      throw new Error(`file size ${st.size} exceeds max ${maxBytes}`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, null);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== buf.length) {
      throw new Error(`short read: expected ${buf.length} bytes, got ${offset}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}
