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
  type CasGenerationCatalogEntry,
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

/**
 * R169B-STEP10 (§7 POST-PUSH): Grace period for promotion temps.
 * A promotion temp younger than this is NOT swept — it may belong to
 * an active publisher that is between fsync(temp) and link(temp, final).
 * 60 seconds is generous for the copy+hash+fsync+link sequence (which
 * takes <1s for typical DBs) while still cleaning up crashed publishers
 * promptly.
 */
const PROMOTION_TEMP_GRACE_MS = 60 * 1000;

// ─── Plan authenticity token (private WeakMap) ──────────────────────────

/**
 * R169B-STEP3 (SEC-R169B-A1-01): A private WeakMap that authenticates
 * plans produced by `planGenerationGc`. The applier rejects plans not
 * in this WeakMap (GC_PLAN_UNAUTHENTICATED). A literal object, spread,
 * or JSON clone produces a new reference that is NOT in the WeakMap.
 */
const planTokens: WeakMap<GenerationGcPlan, true> = new WeakMap();

/**
 * R169B-STEP10 (P0 — CONSOLIDATED-AUDIT): A private WeakMap that
 * authenticates orphan recovery plans produced by
 * `planGenerationOrphanRecovery`. The applier rejects plans not in
 * this WeakMap (GC_PLAN_UNAUTHENTICATED). A literal object, spread,
 * or JSON clone produces a new reference that is NOT in the WeakMap.
 *
 * Without this authentication, a caller could forge a
 * `GenerationOrphanPlan` with an arbitrary `path` field and trick the
 * applier into deleting an arbitrary regular file (the applier was
 * using `orphan.path` directly as the unlink target for
 * PROMOTION_TEMP orphans).
 */
const orphanPlanTokens: WeakMap<GenerationOrphanPlan, true> = new WeakMap();

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
  let deletingEntries: ReturnType<typeof cas.listCatalogEntriesByStatus>;
  let history: ReturnType<typeof cas.listPublicationHistory>;
  try {
    casRevision = cas.getRevision();
    activeEntries = cas.listCatalogEntriesByStatus("ACTIVE");
    // R169B-STEP4 (GC-RECOVERY-R169B-A2-06): also collect DELETING
    // entries from a previous incomplete GC pass. The applier
    // re-attempts the deletion idempotently.
    deletingEntries = cas.listCatalogEntriesByStatus("DELETING");
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

  // 5. Build the retain / delete / recovery lists.
  // R169B-STEP3 (SEC-R169B-A1-01): The plan's dbPath/metadataPath
  // fields are DISPLAY-ONLY — derived from the generationId. The
  // applier re-derives them and never trusts these fields.
  const retainEntries: GenerationGcPlanEntry[] = [];
  const deleteEntries: GenerationGcPlanEntry[] = [];
  // R169B-STEP4 (GC-RECOVERY-R169B-A2-06): recovery entries for
  // generations stuck in DELETING status from a previous incomplete
  // GC pass.
  const recoveryEntries: GenerationGcPlanEntry[] = [];

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

  // R169B-STEP4 (GC-RECOVERY-R169B-A2-06): build the recovery list.
  // DELETING entries are NOT in the retain set (the active generation
  // is always ACTIVE, not DELETING). They are re-attempted by the
  // applier idempotently.
  for (const entry of deletingEntries) {
    const dbPath = deriveDbPath(projectStore, entry.generationId);
    const metadataPath = deriveMetadataPath(projectStore, entry.generationId);
    const planEntry: GenerationGcPlanEntry = {
      generationId: entry.generationId,
      dbPath,
      metadataPath: existsSync(metadataPath) ? metadataPath : null,
      reason: "recovery-deleting",
      pinned: entry.pinned,
    };
    recoveryEntries.push(planEntry);
  }

  // 6. R169B-STEP3 (TMP-R169B-A1-19): Compute the sweep-tmp list.
  // Include -wal, -shm, -journal sidecars, .json temp metadata, and
  // atomic temp JSON (.*.tmp.<rand>).
  const sweepTmp: GenerationGcTmpEntry[] = [];
  // R169B (§10 GATE): fail-closed on tmp/ errors.
  let tmpExists = false;
  try {
    const tmpStat = lstatSync(tmp);
    if (tmpStat.isSymbolicLink() || !tmpStat.isDirectory()) {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `tmp/ is not a regular directory: ${tmp}`);
    }
    tmpExists = true;
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      tmpExists = false;
    } else if (e instanceof GenerationStoreError) {
      throw e;
    } else {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `lstat tmp/ failed: ${(e as Error).message}`);
    }
  }
  if (tmpExists) {
    let tmpEntries: import("node:fs").Dirent[];
    try {
      tmpEntries = readdirSync(tmp, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch (e) {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `readdir tmp/ failed: ${(e as Error).message}`);
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
      // R169B-STEP4 (TMP-RACE-R169B-A2-08): capture the identity
      // (dev/ino/size/mtimeMs) so the applier can detect a file
      // replacement between plan and apply.
      sweepTmp.push({
        path: entPath,
        reason: `tmp-age-${Math.round(ageMs / 1000)}s`,
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeMs: st.mtimeMs,
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
    recovery: recoveryEntries,
    sweepTmp,
    reasons,
  };
  // Freeze the plan and all its nested arrays/entries so a caller
  // cannot mutate them in place.
  Object.freeze(plan);
  Object.freeze(plan.retain);
  Object.freeze(plan.delete);
  Object.freeze(plan.recovery);
  Object.freeze(plan.sweepTmp);
  for (const e of plan.retain) Object.freeze(e);
  for (const e of plan.delete) Object.freeze(e);
  for (const e of plan.recovery) Object.freeze(e);
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

  // R169B (§7 GATE): reject cacheRoot mismatch. The plan was created
  // with plan.cacheRoot — if options.cacheRoot differs, the applier
  // would operate on a different filesystem location than the planner
  // inspected, which is a security hole.
  if (options?.cacheRoot !== undefined && options.cacheRoot !== plan.cacheRoot) {
    throw new GenerationStoreError(
      "GC_PLAN_UNAUTHENTICATED",
      phase,
      project,
      `cacheRoot mismatch: options.cacheRoot="${options.cacheRoot}" != plan.cacheRoot="${plan.cacheRoot}" (the applier rejects cacheRoot overrides for security)`,
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

  // R169B-STEP4 (GC-RECOVERY-R169B-A2-06): first apply the recovery
  // list (DELETING entries from a previous incomplete GC pass). These
  // are re-attempted idempotently.
  for (const entry of plan.recovery) {
    if (!isValidUuidV4(entry.generationId)) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Recovery: refused generation with invalid UUID format: ${entry.generationId}`,
      });
      continue;
    }
    const dbPath = deriveDbPath(projectStore, entry.generationId);
    const metadataPath = deriveMetadataPath(projectStore, entry.generationId);
    try {
      assertPathInsideNoSymlinks(generations, dbPath, project, phase, "PATH_TRAVERSAL_REJECTED");
      assertPathInsideNoSymlinks(generations, metadataPath, project, phase, "PATH_TRAVERSAL_REJECTED");
    } catch (e) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Recovery: containment failed for ${entry.generationId}: ${(e as Error).message}`,
      });
      continue;
    }
    // Re-attempt the deletion under the CAS lock (Model A).
    const result = deleteGenerationUnderCasLock(
      project, cacheRoot, entry.generationId, dbPath, metadataPath,
      generations, currentActiveId, phase, /* isRecovery */ true,
    );
    for (const w of result.warnings) warnings.push(w);
    if (result.deleted) deletedGenerations.push(entry.generationId);
  }

  // 5. Apply the delete list.
  // R169B-STEP4 (GC-RACE-R169B-A2-02): each delete holds the CAS lock
  // for the ENTIRE deletion (mark DELETING → delete files → fsync →
  // mark DELETED → commit). This is "Model A" from the audit. The
  // publisher cannot activate a generation mid-delete because the CAS
  // lock serializes them. R169B is inactive; correctness > throughput.
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

    // d. Re-check active (defense in depth, before acquiring the lock).
    if (entry.generationId === currentActiveId) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete active generation ${entry.generationId} (defense in depth)`,
      });
      continue;
    }

    // e. R169B-STEP4 (GC-SAFETY-R169B-A2-07): Fail-safe on missing/
    // corrupt metadata. The safety check now receives the catalog
    // entry, verifies the DB's actual hash/size against the catalog,
    // and uses lstat (not existsSync) for absence checks. If any
    // check fails → retain (safety-refusal), do NOT delete.
    // We open the CAS first to read the catalog entry, then pass it
    // to the safety check.
    let safetyCatEntry: CasGenerationCatalogEntry | undefined;
    {
      const casS = openCasStore(project, cacheRoot);
      try {
        safetyCatEntry = casS.getGenerationCatalogEntry(entry.generationId);
      } finally {
        casS.close();
      }
    }
    if (safetyCatEntry === undefined) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Generation ${entry.generationId} not in catalog (already deleted?)`,
      });
      continue;
    }
    const safetyCheck = verifyGenerationSafety(project, entry.generationId, dbPath, metadataPath, safetyCatEntry, phase);
    if (!safetyCheck.ok) {
      warnings.push({
        code: "GC_SAFETY_REFUSAL",
        message: `Refused to delete generation ${entry.generationId} (safety-refusal): ${safetyCheck.reason}`,
      });
      continue;
    }

    // f-k. Delete the generation under the CAS lock (Model A).
    // R169B-STEP10 (§10): pass the proof captured by the safety check.
    // deleteGenerationUnderCasLock re-lstats and compares every field
    // under the lock to detect TOCTOU replacement.
    const result = deleteGenerationUnderCasLock(
      project, cacheRoot, entry.generationId, dbPath, metadataPath,
      generations, currentActiveId, phase, /* isRecovery */ false,
      safetyCheck.proof,
    );
    for (const w of result.warnings) warnings.push(w);
    if (result.deleted) deletedGenerations.push(entry.generationId);
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
    // b. Re-verify non-symlink + identity (R169B-STEP4 TMP-RACE-R169B-A2-08).
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
    // R169B-STEP4 (TMP-RACE-R169B-A2-08): verify the file's identity
    // (dev/ino/size/mtimeMs) matches what the plan captured. If the
    // file was replaced between plan and apply, skip with a warning.
    if (
      st.dev !== ent.dev ||
      st.ino !== ent.ino ||
      st.size !== ent.size ||
      st.mtimeMs !== ent.mtimeMs
    ) {
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to sweep tmp artifact (identity changed between plan and apply): ${ent.path} (plan: dev=${ent.dev} ino=${ent.ino} size=${ent.size} mtimeMs=${ent.mtimeMs}; current: dev=${st.dev} ino=${st.ino} size=${st.size} mtimeMs=${st.mtimeMs})`,
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

// ─── Safety verification helper (GC-SAFETY-R169B-A2-07) ───────────────

/**
 * R169B-STEP4 (GC-SAFETY-R169B-A2-07): Verify a generation is safe to
 * delete. The metadata sidecar MUST be present, regular, non-symlink,
 * parse to a valid V1 metadata, and have project/UUID/hash/size/
 * fingerprint/versions coherent with BOTH the metadata manifest AND
 * the CAS catalog entry. The DB's actual sha256 is re-computed and
 * compared against the catalog. If any check fails → retain (safety-
 * refusal), do NOT delete.
 *
 * The `catalogEntry` is the CAS catalog entry for the generation. It
 * provides the authoritative sha256/sizeBytes/rootFingerprint/versions.
 */
function verifyGenerationSafety(
  project: string,
  generationId: string,
  dbPath: string,
  metadataPath: string,
  catalogEntry: CasGenerationCatalogEntry,
  phase: string,
): { ok: true; proof: GenerationDeletionProof } | { ok: false; reason: string } {
  void phase;
  // 1. DB exists, regular, non-symlink.
  let dbStat: Stats;
  try {
    dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink()) {
      return { ok: false, reason: `DB path is a symlink: ${dbPath}` };
    }
    if (!dbStat.isFile()) {
      return { ok: false, reason: `DB path is not a regular file: ${dbPath}` };
    }
  } catch (e) {
    return { ok: false, reason: `DB lstat failed: ${(e as Error).message}` };
  }
  // 2. Metadata exists, regular, non-symlink.
  let metaStat: Stats;
  try {
    metaStat = lstatSync(metadataPath);
    if (metaStat.isSymbolicLink()) {
      return { ok: false, reason: `Metadata path is a symlink: ${metadataPath}` };
    }
    if (!metaStat.isFile()) {
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
  const dm = metadataValidated.manifest;
  // 4. Verify the metadata's manifest project matches.
  if (dm.project !== project) {
    return { ok: false, reason: `Metadata manifest project "${dm.project}" does not match expected "${project}"` };
  }
  // 5. Verify the metadata's manifest generationId matches.
  if (dm.generationId !== generationId) {
    return { ok: false, reason: `Metadata manifest generationId "${dm.generationId}" does not match expected "${generationId}"` };
  }
  // 6. R169B-STEP4 (GC-SAFETY-R169B-A2-07): Verify the DB's actual
  // size matches the manifest's sizeBytes AND the catalog's sizeBytes.
  if (dbStat.size !== dm.sizeBytes) {
    return { ok: false, reason: `DB size ${dbStat.size} does not match manifest sizeBytes ${dm.sizeBytes}` };
  }
  if (dbStat.size !== catalogEntry.sizeBytes) {
    return { ok: false, reason: `DB size ${dbStat.size} does not match catalog sizeBytes ${catalogEntry.sizeBytes}` };
  }
  // 7. Verify the manifest's content fields match the catalog.
  if (dm.sha256 !== catalogEntry.sha256) {
    return { ok: false, reason: `Manifest sha256 ${dm.sha256} does not match catalog sha256 ${catalogEntry.sha256}` };
  }
  if (dm.rootFingerprint !== catalogEntry.rootFingerprint) {
    return { ok: false, reason: `Manifest rootFingerprint ${dm.rootFingerprint} does not match catalog rootFingerprint ${catalogEntry.rootFingerprint}` };
  }
  if (dm.extractorSemanticsVersion !== catalogEntry.extractorSemanticsVersion) {
    return { ok: false, reason: `Manifest extractorSemanticsVersion ${dm.extractorSemanticsVersion} does not match catalog ${catalogEntry.extractorSemanticsVersion}` };
  }
  if (dm.discoveryPolicyVersion !== catalogEntry.discoveryPolicyVersion) {
    return { ok: false, reason: `Manifest discoveryPolicyVersion ${dm.discoveryPolicyVersion} does not match catalog ${catalogEntry.discoveryPolicyVersion}` };
  }
  if (catalogEntry.project !== project) {
    return { ok: false, reason: `Catalog project "${catalogEntry.project}" does not match expected "${project}"` };
  }
  // 8. R169B-STEP4 (GC-SAFETY-R169B-A2-07): Re-compute the DB's actual
  // sha256 and compare against the catalog. This is the expensive
  // check, but GC is best-effort and inactive; correctness > speed.
  const actualHash = computeGcSha256(dbPath);
  if (actualHash !== catalogEntry.sha256) {
    return { ok: false, reason: `DB actual sha256 ${actualHash} does not match catalog sha256 ${catalogEntry.sha256}` };
  }
  // R169B-STEP10 (§10 POST-PUSH): Capture a full GenerationDeletionProof
  // BEFORE acquiring the CAS lock. The proof contains dev/ino/size/sha256
  // for the DB and dev/ino/size for the metadata. Under the lock,
  // deleteGenerationUnderCasLock re-lstats both files and compares every
  // field. If any field changed (file was replaced between the safety
  // check and the lock), the deletion is refused.
  // Metadata sha256 is expensive to compute (would require reading the
  // full file twice); we use dev/ino/size which is sufficient to detect
  // replacement. The metadata content was already validated above.
  const proof: GenerationDeletionProof = {
    db: {
      dev: dbStat.dev,
      ino: dbStat.ino,
      size: dbStat.size,
      sha256: actualHash,
    },
    metadata: {
      dev: metaStat.dev,
      ino: metaStat.ino,
      size: metaStat.size,
      sha256: "",  // not recomputed — dev/ino/size is sufficient
    },
    catalogSha256: catalogEntry.sha256,
  };
  return { ok: true, proof };
}

/**
 * R169B-STEP10 (§10 POST-PUSH): A deletion proof captured by the safety
 * check (outside the CAS lock) and verified under the lock. Contains
 * dev/ino/size/sha256 for the DB and dev/ino/size for the metadata.
 * If any field changed between the safety check and the lock, the
 * deletion is refused (the file was replaced).
 */
interface GenerationDeletionProof {
  readonly db: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly sha256: string;
  };
  readonly metadata: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly sha256: string;  // empty if not recomputed
  };
  readonly catalogSha256: string;
}

/**
 * R169B-STEP4: Compute SHA-256 of a file using O_NOFOLLOW + fstat
 * identity checks (reuses the publisher's secure hash primitive).
 */
function computeGcSha256(path: string): string {
  // We inline a minimal secure hash here to avoid a circular import
  // with the publisher. The publisher's computeSha256WithIdentityChecks
  // is the same logic.
  const preStat = lstatSync(path);
  if (preStat.isSymbolicLink() || !preStat.isFile()) {
    throw new Error(`not a regular file: ${path}`);
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fdStat = fstatSync(fd);
    if (fdStat.dev !== preStat.dev || fdStat.ino !== preStat.ino) {
      throw new Error(`identity mismatch between lstat and fstat: ${path}`);
    }
    // Use node:crypto createHash for streaming.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("node:crypto");
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let totalRead = 0;
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hasher.update(chunk.subarray(0, n));
      totalRead += n;
    }
    const postStat = fstatSync(fd);
    if (postStat.dev !== fdStat.dev || postStat.ino !== fdStat.ino || postStat.size !== fdStat.size) {
      throw new Error(`file mutated during hash: ${path}`);
    }
    if (totalRead !== preStat.size) {
      throw new Error(`short read: expected ${preStat.size}, got ${totalRead}`);
    }
    return hasher.digest("hex");
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// ─── Delete-under-CAS-lock helper (GC-RACE-R169B-A2-02 Model A) ────────

/**
 * R169B-STEP4 (GC-RACE-R169B-A2-02): Delete a generation under the CAS
 * lock (Model A). The CAS lock is held for the ENTIRE deletion:
 *   1. BEGIN IMMEDIATE
 *   2. Re-read active manifest + CAS active + catalog entry
 *   3. Verify candidate != active (defense in depth)
 *   4. Verify not pinned
 *   5. Verify status (ACTIVE for fresh delete; DELETING for recovery)
 *   6. Mark DELETING (skip for recovery — already DELETING)
 *   7. Delete the DB file
 *   8. fsync generations/
 *   9. Delete the metadata sidecar
 *  10. fsync generations/
 *  11. Re-lstat to confirm both absent (lstat ENOENT, not existsSync)
 *  12. Mark DELETED + history
 *  13. COMMIT
 *
 * The publisher cannot activate a generation mid-delete because the CAS
 * lock serializes them. R169B is inactive; correctness > throughput.
 *
 * R169B-STEP4 (GC-RECOVERY-R169B-A2-06): for recovery (isRecovery=true),
 * the generation is already DELETING. We skip the MARK_DELETING step
 * and re-attempt the file deletion idempotently (if a file is already
 * absent, that's fine). The order is DB first, then metadata — if the
 * DB delete fails, the metadata is still present for the next recovery
 * pass to validate.
 */
function deleteGenerationUnderCasLock(
  project: string,
  cacheRoot: string,
  generationId: string,
  dbPath: string,
  metadataPath: string,
  generations: string,
  currentActiveId: string | null,
  phase: string,
  isRecovery: boolean,
  proof?: GenerationDeletionProof,
): { deleted: boolean; warnings: GenerationStoreWarning[] } {
  void phase;
  const warnings: GenerationStoreWarning[] = [];
  const cas = openCasStore(project, cacheRoot);
  try {
    cas.beginImmediate();
    // 2. Re-read active under the lock.
    const casActive = cas.getActiveGenerationId();
    // 3. Verify candidate != active.
    if (generationId === casActive) {
      cas.rollback();
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete generation ${generationId} — it became active during GC (race prevented)`,
      });
      return { deleted: false, warnings };
    }
    // R169B (§8 GATE): re-read the active manifest UNDER the lock.
    // currentActiveId was read before the lock — a publisher could have
    // written a new manifest between the plan and the lock. If the
    // candidate is now the manifest active, refuse (race prevented).
    let lockedActiveId: string | null = null;
    try {
      const lockedManifest = readOptionalGenerationManifest(
        activeManifestPath(project, cacheRoot), project,
      );
      lockedActiveId = lockedManifest?.generationId ?? null;
    } catch {
      // Corrupt manifest under lock = fail-closed.
      cas.rollback();
      warnings.push({
        code: "GC_SAFETY_REFUSAL",
        message: `Refused to delete generation ${generationId} — active manifest is corrupt/unreadable under the GC lock (fail-closed)`,
      });
      return { deleted: false, warnings };
    }
    if (generationId === lockedActiveId) {
      cas.rollback();
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete generation ${generationId} — it is the manifest active (re-read under lock)`,
      });
      return { deleted: false, warnings };
    }
    // Also re-check against the manifest active read before the lock.
    if (generationId === currentActiveId) {
      cas.rollback();
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete generation ${generationId} — it is the manifest active`,
      });
      return { deleted: false, warnings };
    }
    // 4-5. Verify catalog entry.
    const cat = cas.getGenerationCatalogEntry(generationId);
    if (cat === undefined) {
      cas.rollback();
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Generation ${generationId} not in catalog`,
      });
      return { deleted: false, warnings };
    }
    if (cat.pinned) {
      cas.rollback();
      warnings.push({
        code: "GC_DELETE_FAILED",
        message: `Refused to delete pinned generation ${generationId}`,
      });
      return { deleted: false, warnings };
    }
    if (isRecovery) {
      // Recovery: status must be DELETING.
      if (cat.status !== "DELETING") {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Recovery: generation ${generationId} status is ${cat.status} (expected DELETING)`,
        });
        return { deleted: false, warnings };
      }
    } else {
      // Fresh delete: status must be ACTIVE.
      if (cat.status !== "ACTIVE") {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `Generation ${generationId} status is ${cat.status} (not ACTIVE)`,
        });
        return { deleted: false, warnings };
      }
      // 6. Mark DELETING.
      cas.setCatalogStatus(generationId, "DELETING");
      cas.appendPublicationHistory(generationId, project, "MARK_DELETING", null);
    }

    // R169B-STEP10 (§10 POST-PUSH): GC proof under lock — re-lstat
    // DB/metadata and compare ALL fields (dev/ino/size/sha256 for DB,
    // dev/ino/size for metadata) to the proof captured by the safety
    // check BEFORE the lock. This closes the TOCTOU window between the
    // safety check (outside the lock) and the actual deletion (under
    // the lock).
    // R169B (§9 GATE): For recovery (isRecovery=true), the files may
    // already be absent (ENOENT = idempotent). But if a file is STILL
    // PRESENT, we must verify it is the same file the catalog describes
    // — otherwise a replacement file could be deleted by the recovery.
    if (!isRecovery && proof) {
      try {
        const proofDbStat = lstatSync(dbPath);
        if (proofDbStat.isSymbolicLink() || !proofDbStat.isFile()) {
          throw new Error(`DB is not a regular file under lock: ${dbPath}`);
        }
        // R169B-STEP10 (§10): Compare dev/ino/size to the proof.
        if (proofDbStat.dev !== proof.db.dev ||
            proofDbStat.ino !== proof.db.ino ||
            proofDbStat.size !== proof.db.size) {
          throw new Error(
            `DB identity changed under lock: dev=${proofDbStat.dev}/${proof.db.dev} ino=${proofDbStat.ino}/${proof.db.ino} size=${proofDbStat.size}/${proof.db.size}`,
          );
        }
        // Verify DB hash matches catalog entry (and the proof's hash).
        const proofHash = computeGcSha256(dbPath);
        if (proofHash !== cat.sha256) {
          throw new Error(`DB hash mismatch under lock: ${proofHash} != ${cat.sha256}`);
        }
        if (proofHash !== proof.db.sha256) {
          throw new Error(`DB hash changed under lock: ${proofHash} != ${proof.db.sha256}`);
        }
      } catch (e) {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `GC proof verification failed under lock for ${generationId}: ${(e as Error).message}`,
        });
        return { deleted: false, warnings };
      }
      // Verify metadata identity (dev/ino/size) matches the proof.
      try {
        const proofMetaStat = lstatSync(metadataPath);
        if (proofMetaStat.isSymbolicLink() || !proofMetaStat.isFile()) {
          throw new Error(`metadata is not a regular file under lock: ${metadataPath}`);
        }
        if (proofMetaStat.dev !== proof.metadata.dev ||
            proofMetaStat.ino !== proof.metadata.ino ||
            proofMetaStat.size !== proof.metadata.size) {
          throw new Error(
            `metadata identity changed under lock: dev=${proofMetaStat.dev}/${proof.metadata.dev} ino=${proofMetaStat.ino}/${proof.metadata.ino} size=${proofMetaStat.size}/${proof.metadata.size}`,
          );
        }
      } catch (e) {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `GC proof metadata verification failed under lock: ${(e as Error).message}`,
        });
        return { deleted: false, warnings };
      }
    } else if (!isRecovery) {
      // No proof provided (legacy caller) — fall back to the B3 hash check.
      try {
        const proofDbStat = lstatSync(dbPath);
        if (proofDbStat.isSymbolicLink() || !proofDbStat.isFile()) {
          throw new Error(`DB is not a regular file under lock: ${dbPath}`);
        }
        const proofHash = computeGcSha256(dbPath);
        if (proofHash !== cat.sha256) {
          throw new Error(`DB hash mismatch under lock: ${proofHash} != ${cat.sha256}`);
        }
      } catch (e) {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `GC proof verification failed under lock for ${generationId}: ${(e as Error).message}`,
        });
        return { deleted: false, warnings };
      }
      try {
        const proofMetaStat = lstatSync(metadataPath);
        if (proofMetaStat.isSymbolicLink() || !proofMetaStat.isFile()) {
          throw new Error(`metadata is not a regular file under lock: ${metadataPath}`);
        }
      } catch (e) {
        cas.rollback();
        warnings.push({
          code: "GC_DELETE_FAILED",
          message: `GC proof metadata verification failed under lock: ${(e as Error).message}`,
        });
        return { deleted: false, warnings };
      }
    }

    // 7. Delete the DB file (idempotent — ENOENT is OK for recovery).
    // R169B (§9 GATE): For recovery, if the DB is still present, verify
    // its hash matches the catalog before unlinking. Only ENOENT is
    // truly idempotent; a present file must be proven to be the original.
    let dbDeleteOk = false;
    try {
      const ds = lstatSync(dbPath);
      if (ds.isSymbolicLink()) {
        throw new Error(`db path is a symlink: ${dbPath}`);
      }
      if (!ds.isFile()) {
        throw new Error(`db path is not a regular file: ${dbPath}`);
      }
      // R169B (§9): recovery must verify hash for present files.
      if (isRecovery) {
        const recoveryHash = computeGcSha256(dbPath);
        if (recoveryHash !== cat.sha256) {
          throw new Error(`recovery DB hash mismatch: ${recoveryHash} != catalog ${cat.sha256}`);
        }
      }
      unlinkSync(dbPath);
      dbDeleteOk = true;
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        // Already gone — OK for recovery, suspicious for fresh delete.
        dbDeleteOk = true;
        if (!isRecovery) {
          warnings.push({
            code: "GC_DELETE_INCOMPLETE",
            message: `DB file was already absent before delete: ${dbPath}`,
          });
        }
      } else {
        warnings.push({
          code: "GC_DELETE_INCOMPLETE",
          message: `Failed to delete DB ${dbPath}: ${(e as Error).message}`,
        });
      }
    }

    // 8. fsync generations/ after DB delete.
    let dirFsync1Ok = false;
    let dirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(generations, PROD_OPS);
      dirFd = opened.fd;
      PROD_OPS.fsyncSync(dirFd);
      PROD_OPS.closeSync(dirFd);
      dirFd = null;
      dirFsync1Ok = true;
    } catch (e) {
      if (dirFd !== null) {
        try { PROD_OPS.closeSync(dirFd); } catch { /* best effort */ }
      }
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `fsync of generations/ after DB delete failed: ${(e as Error).message}`,
      });
    }

    // 9. Delete the metadata sidecar (idempotent).
    // R169B (§9 GATE): For recovery, if the metadata is still present,
    // validate it (parse + schema) before unlinking. Only ENOENT is
    // truly idempotent.
    let metadataDeleteOk = false;
    try {
      const ms = lstatSync(metadataPath);
      if (ms.isSymbolicLink()) {
        throw new Error(`metadata path is a symlink: ${metadataPath}`);
      }
      if (!ms.isFile()) {
        throw new Error(`metadata path is not a regular file: ${metadataPath}`);
      }
      // R169B (§9): recovery must validate metadata for present files.
      if (isRecovery) {
        const metaRaw = readFileSyncTextSafe(metadataPath, 256 * 1024);
        const metaParsed = JSON.parse(metaRaw);
        validateGenerationMetadata(metaParsed, project);
      }
      unlinkSync(metadataPath);
      metadataDeleteOk = true;
    } catch (e) {
      const errCode = (e as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        metadataDeleteOk = true;
      } else {
        warnings.push({
          code: "GC_DELETE_INCOMPLETE",
          message: `Failed to delete metadata sidecar ${metadataPath}: ${(e as Error).message}`,
        });
      }
    }

    // 10. fsync generations/ after metadata delete.
    let dirFsync2Ok = false;
    let dirFd2: number | null = null;
    try {
      const opened = openDirectoryNoFollow(generations, PROD_OPS);
      dirFd2 = opened.fd;
      PROD_OPS.fsyncSync(dirFd2);
      PROD_OPS.closeSync(dirFd2);
      dirFd2 = null;
      dirFsync2Ok = true;
    } catch (e) {
      if (dirFd2 !== null) {
        try { PROD_OPS.closeSync(dirFd2); } catch { /* best effort */ }
      }
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `fsync of generations/ after metadata delete failed: ${(e as Error).message}`,
      });
    }

    // 11. Re-lstat to confirm both absent (lstat ENOENT, not existsSync).
    let dbConfirmedAbsent = false;
    let metadataConfirmedAbsent = false;
    try {
      lstatSync(dbPath);
      // If lstat succeeded, the file is still there.
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        dbConfirmedAbsent = true;
      }
    }
    try {
      lstatSync(metadataPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        metadataConfirmedAbsent = true;
      }
    }

    if (!dbDeleteOk || !metadataDeleteOk || !dirFsync1Ok || !dirFsync2Ok || !dbConfirmedAbsent || !metadataConfirmedAbsent) {
      // Incomplete — do NOT mark DELETED. The status stays DELETING.
      // We COMMIT the MARK_DELETING (if we did it) so the next GC pass
      // sees the generation as DELETING and re-attempts.
      cas.commit();
      warnings.push({
        code: "GC_DELETE_INCOMPLETE",
        message: `Generation ${generationId} deletion incomplete (dbDeleteOk=${dbDeleteOk}, metadataDeleteOk=${metadataDeleteOk}, dirFsync1Ok=${dirFsync1Ok}, dirFsync2Ok=${dirFsync2Ok}, dbConfirmedAbsent=${dbConfirmedAbsent}, metadataConfirmedAbsent=${metadataConfirmedAbsent}). Status stays DELETING; next GC pass will re-attempt.`,
      });
      return { deleted: false, warnings };
    }

    // 12. Mark DELETED + history.
    cas.setCatalogStatus(generationId, "DELETED");
    cas.appendPublicationHistory(generationId, project, "DELETE", null);

    // 13. COMMIT.
    cas.commit();
    return { deleted: true, warnings };
  } catch (e) {
    try { cas.rollback(); } catch { /* best effort */ }
    warnings.push({
      code: "GC_DELETE_INCOMPLETE",
      message: `Failed to delete generation ${generationId} under CAS lock: ${(e as Error).message}`,
    });
    return { deleted: false, warnings };
  } finally {
    cas.close();
  }
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


// ─── B1: Orphan Recovery ────────────────────────────────────────────────

/**
 * R169B-STEP10 (§7 POST-PUSH): Identity snapshot for an orphan entry.
 * Captured at plan time so the applier can detect file replacement
 * (dev/ino/size/mtimeMs change) between plan and apply.
 */
export interface OrphanIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface GenerationOrphanEntry {
  readonly path: string;
  readonly kind: "DB_ONLY" | "METADATA_ONLY" | "NOT_IN_CATALOG" | "PROMOTION_TEMP" | "ACTIVE_NOT_IN_CATALOG";
  readonly generationId: string | null;
  readonly observedAt: string;
  readonly reason: string;
  /**
   * R169B-STEP10 (§7): Identity snapshot for PROMOTION_TEMP entries.
   * The applier re-lstats and compares before unlinking. If the
   * identity changed (file was replaced by a concurrent publisher),
   * the applier refuses to delete. null for non-PROMOTION_TEMP entries.
   */
  readonly identity: OrphanIdentity | null;
}

export interface GenerationOrphanPlan {
  readonly project: string;
  readonly cacheRoot: string;
  readonly orphans: readonly GenerationOrphanEntry[];
  readonly activeGenerationId: string | null;
  readonly casRevision: number;
}

export function planGenerationOrphanRecovery(
  project: string,
  options?: GenerationGcOptions,
): GenerationOrphanPlan {
  const phase = "planGenerationOrphanRecovery";
  if (!project || typeof project !== "string") {
    throw new GenerationStoreError("PROJECT_KEY_INVALID", phase, String(project), "project must be a non-empty string");
  }
  const cacheRoot = options?.cacheRoot ?? getCacheRoot();
  const graceMs = options?.promotionTempGraceMs ?? PROMOTION_TEMP_GRACE_MS;
  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const manifestPath = activeManifestPath(project, cacheRoot);

  let activeManifest: GenerationManifestV1 | null;
  try {
    activeManifest = readOptionalGenerationManifest(manifestPath, project);
  } catch (err) {
    if (err instanceof GenerationStoreError) {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `Active manifest corrupt: [${err.code}] ${err.message}`);
    }
    throw err;
  }
  const activeGenerationId = activeManifest?.generationId ?? null;

  const cas = openCasStore(project, cacheRoot);
  let casRevision: number;
  let catalogIds: Set<string>;
  let pinnedIds: Set<string>;
  try {
    casRevision = cas.getRevision();
    const active = cas.listCatalogEntriesByStatus("ACTIVE");
    catalogIds = new Set(active.map(e => e.generationId));
    pinnedIds = new Set(active.filter(e => e.pinned).map(e => e.generationId));
    cas.listCatalogEntriesByStatus("DELETING").forEach(e => catalogIds.add(e.generationId));
  } finally {
    cas.close();
  }

  const protectedIds = new Set<string>();
  if (activeGenerationId) protectedIds.add(activeGenerationId);
  pinnedIds.forEach(id => protectedIds.add(id));

  const orphans: GenerationOrphanEntry[] = [];
  const now = new Date().toISOString();

  // R169B (§10 GATE): fail-closed on filesystem errors. existsSync
  // masks permission errors and broken symlinks. Use lstat instead —
  // only ENOENT means "absent"; any other error is a safety refusal.
  let generationsExists = false;
  try {
    const gensStat = lstatSync(generations);
    if (gensStat.isSymbolicLink()) {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `generations/ is a symlink: ${generations}`);
    }
    if (!gensStat.isDirectory()) {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `generations/ is not a directory: ${generations}`);
    }
    generationsExists = true;
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      generationsExists = false;
    } else if (e instanceof GenerationStoreError) {
      throw e;
    } else {
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `lstat generations/ failed: ${(e as Error).message}`);
    }
  }

  if (generationsExists) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(generations, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch (e) {
      // R169B (§10): readdir error = fail-closed, not empty list.
      throw new GenerationStoreError("GC_SAFETY_REFUSAL", phase, project,
        `readdir generations/ failed: ${(e as Error).message}`);
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;

      // Promotion temps.
      if (/^\.publish-[0-9a-f-]+-[0-9a-f-]+\.db$/.test(ent.name)) {
        const tempPath = join(generations, ent.name);
        // R169B-STEP10 (§7): Capture identity (dev/ino/size/mtimeMs)
        // so the applier can detect file replacement between plan and
        // apply. Also enforce a grace period — only sweep temps older
        // than PROMOTION_TEMP_GRACE_MS to avoid racing with an active
        // publisher that is between fsync(temp) and link(temp, final).
        let identity: OrphanIdentity | null = null;
        let ageMs = 0;
        try {
          const st = lstatSync(tempPath);
          if (st.isSymbolicLink() || !st.isFile()) {
            // Not a regular file — skip (will be re-evaluated next pass).
            continue;
          }
          ageMs = Date.now() - st.mtimeMs;
          if (ageMs < graceMs) {
            // Too new — might be an active publisher. Skip for now.
            continue;
          }
          identity = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          // lstat failed — skip (file may have been removed).
          continue;
        }
        orphans.push({
          path: tempPath,
          kind: "PROMOTION_TEMP",
          generationId: null,
          observedAt: now,
          reason: `promotion temp left by failed publication (age=${Math.round(ageMs / 1000)}s)`,
          identity,
        });
        continue;
      }

      // generation-<uuid>.db
      const dbMatch = ent.name.match(/^generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db$/);
      if (dbMatch) {
        const gid = dbMatch[1];
        const dbPath = join(generations, ent.name);
        const metaPath = deriveMetadataPath(projectStore, gid);

        if (!catalogIds.has(gid) && !protectedIds.has(gid)) {
          orphans.push({ path: dbPath, kind: "NOT_IN_CATALOG", generationId: gid, observedAt: now, reason: "DB not in CAS catalog", identity: null });
          continue;
        }

        try {
          lstatSync(metaPath);
        } catch (err2) {
          if ((err2 as NodeJS.ErrnoException).code === "ENOENT") {
            orphans.push({ path: dbPath, kind: "DB_ONLY", generationId: gid, observedAt: now, reason: "DB exists but metadata missing", identity: null });
          }
          continue;
        }
        continue;
      }

      // generation-<uuid>.json without DB
      const jsonMatch = ent.name.match(/^generation-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/);
      if (jsonMatch) {
        const gid = jsonMatch[1];
        const jsonPath = join(generations, ent.name);
        const dbPath = deriveDbPath(projectStore, gid);

        try {
          lstatSync(dbPath);
        } catch (err2) {
          if ((err2 as NodeJS.ErrnoException).code === "ENOENT" && !protectedIds.has(gid)) {
            orphans.push({ path: jsonPath, kind: "METADATA_ONLY", generationId: gid, observedAt: now, reason: "Metadata exists but DB missing", identity: null });
          }
          continue;
        }
        continue;
      }
    }
  }

  if (activeGenerationId && !catalogIds.has(activeGenerationId)) {
    orphans.push({ path: manifestPath, kind: "ACTIVE_NOT_IN_CATALOG", generationId: activeGenerationId, observedAt: now, reason: "Active manifest generation not in CAS catalog", identity: null });
  }

  const plan: GenerationOrphanPlan = {
    project,
    cacheRoot,
    orphans,
    activeGenerationId,
    casRevision,
  };
  // R169B-STEP10 (P0 — CONSOLIDATED-AUDIT): Freeze the plan and all
  // its nested arrays/entries so a caller cannot mutate them in place.
  Object.freeze(plan);
  Object.freeze(plan.orphans);
  for (const e of plan.orphans) Object.freeze(e);
  // Register the plan in the WeakMap so the applier can authenticate it.
  orphanPlanTokens.set(plan, true);
  return plan;
}

export interface GenerationOrphanResult {
  readonly project: string;
  readonly deletedTempPaths: readonly string[];
  readonly retainedOrphans: readonly GenerationOrphanEntry[];
  readonly casRecovered: boolean;
  readonly warnings: readonly GenerationStoreWarning[];
}

export function applyGenerationOrphanRecovery(
  plan: GenerationOrphanPlan,
  options?: GenerationGcOptions,
): GenerationOrphanResult {
  const phase = "applyGenerationOrphanRecovery";
  const project = plan.project;
  const cacheRoot = options?.cacheRoot ?? plan.cacheRoot ?? getCacheRoot();

  // R169B-STEP10 (P0 — CONSOLIDATED-AUDIT): Authenticate the plan via
  // the private WeakMap. A literal, spread, or JSON clone produces a
  // new reference that is NOT in the WeakMap → GC_PLAN_UNAUTHENTICATED.
  if (!orphanPlanTokens.has(plan)) {
    throw new GenerationStoreError(
      "GC_PLAN_UNAUTHENTICATED",
      phase,
      project,
      `Orphan plan is not authentic (not in the private WeakMap). Plans MUST be produced by planGenerationOrphanRecovery in the same process; spread/JSON-clone/literal objects are rejected.`,
    );
  }

  // R169B-STEP10 (P0 — CONSOLIDATED-AUDIT): Verify cacheRoot/project
  // consistency. The applier NEVER trusts the plan's cacheRoot field
  // as authority — it re-derives from options or getCacheRoot(), and
  // verifies it matches the plan's cacheRoot.
  if (cacheRoot !== plan.cacheRoot) {
    throw new GenerationStoreError(
      "GC_PLAN_UNAUTHENTICATED",
      phase,
      project,
      `cacheRoot mismatch: options/plan.cacheRoot="${plan.cacheRoot}" but resolved cacheRoot="${cacheRoot}" (the applier re-derives cacheRoot and rejects mismatches)`,
    );
  }

  // R169B-STEP10 (§8 POST-PUSH): Staleness check. Re-read the CAS
  // revision and the active manifest. If either changed since the plan
  // was created, the plan is stale — refuse to apply any mutations.
  // This prevents the orphan applier from acting on a snapshot that
  // no longer reflects the current state (e.g., a new publication or
  // GC pass happened between plan and apply).
  const casForStaleness = openCasStore(project, cacheRoot);
  let currentCasRevision: number;
  try {
    currentCasRevision = casForStaleness.getRevision();
  } finally {
    casForStaleness.close();
  }
  if (currentCasRevision !== plan.casRevision) {
    return {
      project,
      deletedTempPaths: [],
      retainedOrphans: plan.orphans,
      casRecovered: false,
      warnings: [{
        code: "GC_PLAN_STALE",
        message: `Orphan plan stale: CAS revision changed from ${plan.casRevision} to ${currentCasRevision} between plan and apply`,
      }],
    };
  }

  // R169B-STEP10 (§8): Re-read the active manifest. If it changed, the
  // plan is stale.
  const manifestPathForStaleness = activeManifestPath(project, cacheRoot);
  let currentActiveId: string | null = null;
  try {
    const m = readOptionalGenerationManifest(manifestPathForStaleness, project);
    currentActiveId = m?.generationId ?? null;
  } catch {
    // If the manifest is corrupt, fail-closed — refuse to apply.
    return {
      project,
      deletedTempPaths: [],
      retainedOrphans: plan.orphans,
      casRecovered: false,
      warnings: [{
        code: "GC_SAFETY_REFUSAL",
        message: `Orphan plan stale: active manifest is corrupt/unreadable`,
      }],
    };
  }
  if (currentActiveId !== plan.activeGenerationId) {
    return {
      project,
      deletedTempPaths: [],
      retainedOrphans: plan.orphans,
      casRecovered: false,
      warnings: [{
        code: "GC_PLAN_STALE",
        message: `Orphan plan stale: active generation changed from ${plan.activeGenerationId} to ${currentActiveId} between plan and apply`,
      }],
    };
  }

  assertTrustedRootNoSymlinks(cacheRoot, project, phase);

  const projectStore = projectStoreDir(project, cacheRoot);
  const generations = generationsDir(project, cacheRoot);
  const warnings: GenerationStoreWarning[] = [];
  const deletedTempPaths: string[] = [];
  const retainedOrphans: GenerationOrphanEntry[] = [];
  let casRecovered = false;

  // R169B-STEP10 (P0 — CONSOLIDATED-AUDIT): Derive the canonical
  // promotion-temp path from the basename. The applier NEVER uses
  // orphan.path as authority for unlink — it extracts the basename,
  // validates it matches the promotion-temp pattern, and re-joins
  // with the canonical generations/ dir. This prevents path traversal
  // and arbitrary-file deletion.
  const PROMOTION_TEMP_RE = /^\.publish-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f-]+\.db$/;

  for (const orphan of plan.orphans) {
    switch (orphan.kind) {
      case "PROMOTION_TEMP": {
        try {
          // R169B-STEP10 (P0): Re-derive the path from the basename.
          // Extract the basename from orphan.path, validate it matches
          // the promotion-temp pattern, and re-join with generations/.
          const basename = orphan.path.split("/").pop() ?? "";
          if (!PROMOTION_TEMP_RE.test(basename)) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Orphan temp basename does not match canonical pattern: ${basename}` });
            retainedOrphans.push(orphan);
            continue;
          }
          const canonicalPath = join(generations, basename);
          // Verify the canonical path is inside generations/ (containment).
          try {
            assertPathInsideNoSymlinks(generations, canonicalPath, project, phase);
          } catch (e) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Orphan temp path containment check failed: ${(e as Error).message}` });
            retainedOrphans.push(orphan);
            continue;
          }
          const st = lstatSync(canonicalPath);
          if (st.isSymbolicLink() || !st.isFile()) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Orphan temp not a regular file: ${canonicalPath}` });
            retainedOrphans.push(orphan);
            continue;
          }
          // R169B-STEP10 (§7 POST-PUSH): Identity check. Compare the
          // current dev/ino/size/mtimeMs to the plan's snapshot. If
          // any field changed, the file was replaced by a concurrent
          // publisher — refuse to delete.
          if (orphan.identity) {
            if (st.dev !== orphan.identity.dev ||
                st.ino !== orphan.identity.ino ||
                st.size !== orphan.identity.size ||
                st.mtimeMs !== orphan.identity.mtimeMs) {
              warnings.push({
                code: "GC_DELETE_FAILED",
                message: `Orphan temp identity changed (dev=${st.dev}/${orphan.identity.dev} ino=${st.ino}/${orphan.identity.ino} size=${st.size}/${orphan.identity.size} mtimeMs=${st.mtimeMs}/${orphan.identity.mtimeMs}) — file was replaced, refusing to delete: ${canonicalPath}`,
              });
              retainedOrphans.push(orphan);
              continue;
            }
          }
          unlinkSync(canonicalPath);
          deletedTempPaths.push(canonicalPath);
        } catch (e) {
          warnings.push({ code: "GC_DELETE_FAILED", message: `Failed to delete orphan temp: ${(e as Error).message}` });
          retainedOrphans.push(orphan);
        }
        break;
      }
      case "ACTIVE_NOT_IN_CATALOG": {
        if (!orphan.generationId) { retainedOrphans.push(orphan); continue; }
        const gid = orphan.generationId;
        // R169B-STEP10 (P0): Re-derive paths from generationId — never
        // trust orphan.path for ACTIVE_NOT_IN_CATALOG (it points at the
        // manifest, which we don't delete; we only recover the CAS).
        const dbPath = deriveDbPath(projectStore, gid);
        const metaPath = deriveMetadataPath(projectStore, gid);
        // R169B-STEP10 (§8): Re-read the active manifest at apply time.
        // It must match the metadata's manifest for the recovery to be valid.
        const manifestPathForRecovery = activeManifestPath(project, cacheRoot);
        try {
          // 1. DB: lstat, regular, non-symlink, mode 0600, owner match.
          const dbStat = lstatSync(dbPath);
          if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active DB not a regular file: ${dbPath}` });
            retainedOrphans.push(orphan); continue;
          }
          if ((dbStat.mode & 0o777) !== 0o600) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active DB mode ${String(dbStat.mode & 0o777)} != 0600: ${dbPath}` });
            retainedOrphans.push(orphan); continue;
          }
          if (typeof process.getuid === "function" && dbStat.uid !== process.getuid()) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active DB owner uid=${dbStat.uid} != process uid=${process.getuid()}: ${dbPath}` });
            retainedOrphans.push(orphan); continue;
          }
          // 2. Metadata: lstat, regular, non-symlink, mode 0600, owner match.
          const metaStat = lstatSync(metaPath);
          if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active metadata not a regular file: ${metaPath}` });
            retainedOrphans.push(orphan); continue;
          }
          if ((metaStat.mode & 0o777) !== 0o600) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active metadata mode ${String(metaStat.mode & 0o777)} != 0600: ${metaPath}` });
            retainedOrphans.push(orphan); continue;
          }
          if (typeof process.getuid === "function" && metaStat.uid !== process.getuid()) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active metadata owner uid=${metaStat.uid} != process uid=${process.getuid()}: ${metaPath}` });
            retainedOrphans.push(orphan); continue;
          }
          // 3. DB size == manifest.sizeBytes (from metadata).
          const metaRaw = readFileSyncTextSafe(metaPath, 256 * 1024);
          const metaParsed = JSON.parse(metaRaw);
          const metaValidated = validateGenerationMetadata(metaParsed, project);
          const m = metaValidated.manifest;
          if (dbStat.size !== m.sizeBytes) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active DB size ${dbStat.size} != manifest sizeBytes ${m.sizeBytes}` });
            retainedOrphans.push(orphan); continue;
          }
          // 4. DB hash == manifest.sha256.
          const actualHash = computeGcSha256(dbPath);
          if (actualHash !== m.sha256) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active DB hash mismatch during CAS recovery` });
            retainedOrphans.push(orphan); continue;
          }
          // 5. dbFile canonique: manifest.dbFile must match the canonical path.
          const expectedDbFile = `generations/generation-${gid}.db`;
          if (m.dbFile !== expectedDbFile) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active manifest dbFile ${m.dbFile} != canonical ${expectedDbFile}` });
            retainedOrphans.push(orphan); continue;
          }
          // 6. Active manifest == metadata.manifest (re-read manifest, compare).
          let activeManifest: GenerationManifestV1 | null;
          try {
            activeManifest = readOptionalGenerationManifest(manifestPathForRecovery, project);
          } catch {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active manifest corrupt/unreadable during CAS recovery` });
            retainedOrphans.push(orphan); continue;
          }
          if (!activeManifest || activeManifest.generationId !== gid) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active manifest does not point at generation ${gid} — refusing CAS recovery` });
            retainedOrphans.push(orphan); continue;
          }
          // Compare manifest fields.
          const am = activeManifest;
          if (am.sha256 !== m.sha256 || am.sizeBytes !== m.sizeBytes ||
              am.rootFingerprint !== m.rootFingerprint ||
              am.extractorSemanticsVersion !== m.extractorSemanticsVersion ||
              am.discoveryPolicyVersion !== m.discoveryPolicyVersion) {
            warnings.push({ code: "GC_DELETE_FAILED", message: `Active manifest != metadata.manifest (sha256/size/fingerprint/versions mismatch)` });
            retainedOrphans.push(orphan); continue;
          }
          // All disk checks passed. Recover the CAS under lock.
          const cas = openCasStore(project, cacheRoot);
          try {
            cas.beginImmediate();
            const now = new Date().toISOString();
            const existing = cas.getGenerationCatalogEntry(gid);
            // R169B-STEP10 (§9): preserve pinned from metadata if the
            // metadata's pinned field is set. The metadata V1 schema
            // may carry a `pinned` boolean; if so, honor it.
            const pinnedFromMeta = (metaValidated as { pinned?: boolean }).pinned === true;
            const pinned = existing?.pinned ?? pinnedFromMeta;
            if (!existing) {
              cas.upsertGenerationCatalog({
                generationId: gid, project,
                sha256: m.sha256, sizeBytes: m.sizeBytes,
                rootFingerprint: m.rootFingerprint,
                extractorSemanticsVersion: m.extractorSemanticsVersion,
                discoveryPolicyVersion: m.discoveryPolicyVersion,
                firstPublishedAt: m.createdAt, lastSeenAt: now,
                pinned, status: "ACTIVE",
              });
            }
            cas.setActiveGenerationId(gid);
            cas.appendPublicationHistory(gid, project, "RECOVER", null);
            cas.commit();
            casRecovered = true;
          } catch (e) {
            try { cas.rollback(); } catch {}
            warnings.push({ code: "GC_DELETE_FAILED", message: `CAS recovery failed: ${(e as Error).message}` });
            retainedOrphans.push(orphan);
          } finally {
            cas.close();
          }
        } catch (e) {
          warnings.push({ code: "GC_DELETE_FAILED", message: `CAS recovery disk verification failed: ${(e as Error).message}` });
          retainedOrphans.push(orphan);
        }
        break;
      }
      default:
        retainedOrphans.push(orphan);
        warnings.push({ code: "GC_SAFETY_REFUSAL", message: `Orphan ${orphan.kind} at ${orphan.path} retained (grace period required)` });
        break;
    }
  }

  if (deletedTempPaths.length > 0) {
    let dirFd: number | null = null;
    try {
      const opened = openDirectoryNoFollow(generations, PROD_OPS);
      dirFd = opened.fd;
      PROD_OPS.fsyncSync(dirFd);
      PROD_OPS.closeSync(dirFd);
      dirFd = null;
    } catch (e) {
      if (dirFd !== null) { try { PROD_OPS.closeSync(dirFd); } catch {} }
      warnings.push({ code: "GC_DELETE_FAILED", message: `fsync generations/ after orphan temp cleanup failed: ${(e as Error).message}` });
    }
  }

  return { project, deletedTempPaths, retainedOrphans, casRecovered, warnings };
}
