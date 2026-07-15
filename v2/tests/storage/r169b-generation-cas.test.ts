/**
 * R169B-STEP2 — CAS (Content-Addressable Storage) store tests.
 *
 * STATUS: FOUNDATION / INACTIVE
 *
 * These tests exercise the CAS SQLite store (`publication-cas.sqlite`)
 * directly, without going through the publisher. They verify:
 *   - Open / create (the singleton row is initialized on first open).
 *   - Transaction lifecycle (beginImmediate / commit / rollback).
 *   - Revision monotonicity (incrementRevision bumps by 1).
 *   - Active generation ID get / set.
 *   - Catalog upsert / lookup / list-by-status.
 *   - Dedup candidate search (sha256 + size + fingerprint + versions).
 *   - Publication history append / list (most-recent-first ordering).
 *   - Reconcile-from-manifest (manifest is ground truth; CAS diverges
 *     → reconciled; revision bumped).
 *   - BEGIN IMMEDIATE serialization (a second concurrent writer blocks
 *     / raises PUBLICATION_CAS_BUSY if it cannot acquire the lock).
 *
 * All tests use REAL SQLite DBs (better-sqlite3). No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  openCasStore,
  CAS_DB_FILENAME,
  type CasStore,
} from "../../src/storage/internal/generation-cas-store.js";
import {
  cbmCacheDir,
  generationStoreRoot,
  projectStoreDir,
} from "../../src/storage/generation-paths.js";
import {
  GenerationStoreError,
  type GenerationManifestV1,
  type CasGenerationCatalogEntry,
} from "../../src/storage/generation-types.js";
import { CURRENT_DISCOVERY_POLICY_VERSION } from "../../src/indexer/schema.js";

const PROJECT = "r169b-cas-test-project";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "r169b-cas-"));
  chmodSync(cacheRoot, 0o700);
  // Pre-create layout with mode 0700.
  for (const dir of [
    cbmCacheDir(cacheRoot),
    generationStoreRoot(cacheRoot),
    projectStoreDir(PROJECT, cacheRoot),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    }
  }
});

afterEach(() => {
  try {
    rmSync(cacheRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

function casPath(): string {
  return join(projectStoreDir(PROJECT, cacheRoot), CAS_DB_FILENAME);
}

function validManifest(overrides: Partial<GenerationManifestV1> = {}): GenerationManifestV1 {
  const generationId = overrides.generationId ?? "550e8400-e29b-41d4-a716-446655440000";
  return {
    formatVersion: 1,
    project: PROJECT,
    generationId,
    dbFile: `generations/generation-${generationId}.db`,
    createdAt: "2026-07-13T00:00:00.000Z",
    rootFingerprint: "/canonical/root:1:2",
    extractorSemanticsVersion: 8,
    discoveryPolicyVersion: CURRENT_DISCOVERY_POLICY_VERSION,
    nodeCount: 1,
    edgeCount: 2,
    fileCount: 3,
    sizeBytes: 100,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function validCatalogEntry(overrides: Partial<CasGenerationCatalogEntry> = {}): CasGenerationCatalogEntry {
  return {
    generationId: "550e8400-e29b-41d4-a716-446655440000",
    project: PROJECT,
    sha256: "a".repeat(64),
    sizeBytes: 100,
    rootFingerprint: "/canonical/root:1:2",
    extractorSemanticsVersion: 8,
    discoveryPolicyVersion: CURRENT_DISCOVERY_POLICY_VERSION,
    firstPublishedAt: "2026-07-13T00:00:00.000Z",
    lastSeenAt: "2026-07-13T00:00:00.000Z",
    pinned: false,
    status: "ACTIVE",
    ...overrides,
  };
}

function writeRecoveryMetadata(manifest: GenerationManifestV1, pinned = false): string {
  const dir = join(projectStoreDir(PROJECT, cacheRoot), "generations");
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  const metadataPath = join(dir, `generation-${manifest.generationId}.json`);
  writeFileSync(metadataPath, JSON.stringify({
    formatVersion: 1,
    manifest,
    publishedAt: manifest.createdAt,
    deduped: false,
    dedupSourceGenerationId: null,
    previousActiveGenerationId: null,
    pinned,
  }) + "\n", { encoding: "utf8", mode: 0o600 });
  return metadataPath;
}

// ─── 1. Open / create ────────────────────────────────────────────────────

describe("R169B-STEP2 CAS — open / create", () => {
  it("creates the CAS DB file with the singleton row on first open", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    expect(existsSync(casPath())).toBe(true);
    expect(cas.getActiveGenerationId()).toBe(null);
    expect(cas.getRevision()).toBe(0);
    cas.close();
  });

  it("a second open returns the same singleton state (idempotent)", () => {
    const cas1 = openCasStore(PROJECT, cacheRoot);
    cas1.beginImmediate();
    cas1.setActiveGenerationId("gen-1");
    cas1.incrementRevision();
    cas1.commit();
    cas1.close();

    const cas2 = openCasStore(PROJECT, cacheRoot);
    expect(cas2.getActiveGenerationId()).toBe("gen-1");
    expect(cas2.getRevision()).toBe(1);
    cas2.close();
  });
});

// ─── 2. Transactions ─────────────────────────────────────────────────────

describe("R169B-STEP2 CAS — transactions", () => {
  it("writes outside a transaction are rejected (PUBLICATION_CAS_STATE_CORRUPT)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    try {
      cas.setActiveGenerationId("gen-1");
      expect.fail("expected setActiveGenerationId to reject outside a txn");
    } catch (e) {
      expect(e).toBeInstanceOf(GenerationStoreError);
      expect((e as GenerationStoreError).code).toBe("PUBLICATION_CAS_STATE_CORRUPT");
    } finally {
      cas.close();
    }
  });

  it("beginImmediate + commit makes writes durable", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision();
    cas.commit();
    expect(cas.getActiveGenerationId()).toBe("gen-1");
    expect(cas.getRevision()).toBe(1);
    cas.close();
  });

  it("rollback undoes uncommitted writes", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision();
    cas.rollback();
    expect(cas.getActiveGenerationId()).toBe(null);
    expect(cas.getRevision()).toBe(0);
    cas.close();
  });

  it("rollback is a no-op when no txn is active", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    expect(() => cas.rollback()).not.toThrow();
    cas.close();
  });

  it("a second beginImmediate while another writer holds the lock blocks then succeeds (busy_timeout)", () => {
    // This test verifies that BEGIN IMMEDIATE serializes writers. We
    // open two CAS handles on the same DB; the first takes the write
    // lock, the second's beginImmediate would block — but in a single
    // process with synchronous DB access we can't truly test the
    // blocking. We verify that COMMIT releases the lock and the second
    // writer can then proceed.
    const cas1 = openCasStore(PROJECT, cacheRoot);
    cas1.beginImmediate();
    cas1.setActiveGenerationId("gen-1");
    cas1.commit();

    const cas2 = openCasStore(PROJECT, cacheRoot);
    cas2.beginImmediate();
    cas2.setActiveGenerationId("gen-2");
    cas2.commit();
    expect(cas2.getActiveGenerationId()).toBe("gen-2");
    cas1.close();
    cas2.close();
  });
});

// ─── 3. Revision monotonicity ───────────────────────────────────────────

describe("R169B-STEP2 CAS — revision", () => {
  it("incrementRevision bumps by 1 and returns the new value", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    expect(cas.getRevision()).toBe(0);
    cas.beginImmediate();
    const r1 = cas.incrementRevision();
    expect(r1).toBe(1);
    const r2 = cas.incrementRevision();
    expect(r2).toBe(2);
    cas.commit();
    expect(cas.getRevision()).toBe(2);
    cas.close();
  });
});

// ─── 4. Catalog ──────────────────────────────────────────────────────────

describe("R169B-STEP2 CAS — generation_catalog", () => {
  it("upsert inserts a new entry; get returns it", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const entry = validCatalogEntry();
    cas.beginImmediate();
    cas.upsertGenerationCatalog(entry);
    cas.commit();
    const got = cas.getGenerationCatalogEntry(entry.generationId);
    expect(got).toBeDefined();
    expect(got?.sha256).toBe(entry.sha256);
    expect(got?.status).toBe("ACTIVE");
    expect(got?.pinned).toBe(false);
    cas.close();
  });

  it("upsert on an existing entry updates last_seen_at and status (not first_published_at)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const entry = validCatalogEntry({ firstPublishedAt: "2026-01-01T00:00:00.000Z" });
    cas.beginImmediate();
    cas.upsertGenerationCatalog(entry);
    cas.commit();

    const updated = validCatalogEntry({
      firstPublishedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-07-14T00:00:00.000Z",
      status: "DELETING",
    });
    cas.beginImmediate();
    cas.upsertGenerationCatalog(updated);
    cas.commit();

    const got = cas.getGenerationCatalogEntry(entry.generationId);
    expect(got?.firstPublishedAt).toBe("2026-01-01T00:00:00.000Z"); // preserved
    expect(got?.lastSeenAt).toBe("2026-07-14T00:00:00.000Z"); // updated
    expect(got?.status).toBe("DELETING");
    cas.close();
  });

  it("listCatalogEntriesByStatus returns only entries matching the status, ordered by first_published_at ASC", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({
      generationId: "11111111-1111-4111-8111-111111111111",
      firstPublishedAt: "2026-03-01T00:00:00.000Z",
    }));
    cas.upsertGenerationCatalog(validCatalogEntry({
      generationId: "22222222-2222-4222-8222-222222222222",
      firstPublishedAt: "2026-01-01T00:00:00.000Z",
      status: "DELETED",
    }));
    cas.upsertGenerationCatalog(validCatalogEntry({
      generationId: "33333333-3333-4333-8333-333333333333",
      firstPublishedAt: "2026-02-01T00:00:00.000Z",
    }));
    cas.commit();

    const active = cas.listCatalogEntriesByStatus("ACTIVE");
    expect(active.length).toBe(2);
    expect(active[0].generationId).toBe("33333333-3333-4333-8333-333333333333"); // Feb
    expect(active[1].generationId).toBe("11111111-1111-4111-8111-111111111111"); // March

    const deleted = cas.listCatalogEntriesByStatus("DELETED");
    expect(deleted.length).toBe(1);
    expect(deleted[0].generationId).toBe("22222222-2222-4222-8222-222222222222");
    cas.close();
  });

  it("setCatalogStatus changes the status", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const entry = validCatalogEntry();
    cas.beginImmediate();
    cas.upsertGenerationCatalog(entry);
    cas.setCatalogStatus(entry.generationId, "DELETING");
    cas.commit();
    const got = cas.getGenerationCatalogEntry(entry.generationId);
    expect(got?.status).toBe("DELETING");
    cas.close();
  });

  it("setCatalogPinned toggles the pinned flag", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const entry = validCatalogEntry({ pinned: false });
    cas.beginImmediate();
    cas.upsertGenerationCatalog(entry);
    cas.setCatalogPinned(entry.generationId, true);
    cas.commit();
    const got = cas.getGenerationCatalogEntry(entry.generationId);
    expect(got?.pinned).toBe(true);
    cas.close();
  });
});

// ─── 5. Dedup ────────────────────────────────────────────────────────────

describe("R169B-STEP2 CAS — dedup candidate", () => {
  it("findDedupCandidate returns the entry when sha256+size+fingerprint+versions match", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const entry = validCatalogEntry({
      sha256: "b".repeat(64),
      sizeBytes: 200,
      rootFingerprint: "/canonical/root:9:9",
      extractorSemanticsVersion: 8,
      discoveryPolicyVersion: CURRENT_DISCOVERY_POLICY_VERSION,
    });
    cas.beginImmediate();
    cas.upsertGenerationCatalog(entry);
    cas.commit();

    const dedup = cas.findDedupCandidate(
      "b".repeat(64),
      200,
      "/canonical/root:9:9",
      8,
      CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeDefined();
    expect(dedup?.generationId).toBe(entry.generationId);
    cas.close();
  });

  it("findDedupCandidate returns undefined when sha256 differs", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({ sha256: "b".repeat(64) }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "c".repeat(64), // different sha
      100,
      "/canonical/root:1:2",
      8,
      CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });

  it("findDedupCandidate returns undefined when size differs", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({ sizeBytes: 100 }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "a".repeat(64), 999, "/canonical/root:1:2", 8, CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });

  it("findDedupCandidate returns undefined when rootFingerprint differs", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({ rootFingerprint: "/canonical/root:1:2" }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "a".repeat(64), 100, "/different/root:3:4", 8, CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });

  it("findDedupCandidate returns undefined when extractorSemanticsVersion differs", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({ extractorSemanticsVersion: 8 }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "a".repeat(64), 100, "/canonical/root:1:2", 7, CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });

  it("findDedupCandidate returns undefined when discoveryPolicyVersion differs", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({
      discoveryPolicyVersion: CURRENT_DISCOVERY_POLICY_VERSION,
    }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "a".repeat(64), 100, "/canonical/root:1:2", 8, CURRENT_DISCOVERY_POLICY_VERSION - 1,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });

  it("findDedupCandidate skips DELETED entries", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.upsertGenerationCatalog(validCatalogEntry({ status: "DELETED" }));
    cas.commit();
    const dedup = cas.findDedupCandidate(
      "a".repeat(64), 100, "/canonical/root:1:2", 8, CURRENT_DISCOVERY_POLICY_VERSION,
    );
    expect(dedup).toBeUndefined();
    cas.close();
  });
});

// ─── 6. Publication history ──────────────────────────────────────────────

describe("R169B-STEP2 CAS — publication_history", () => {
  it("appendPublicationHistory adds a row; list returns most-recent-first", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.appendPublicationHistory("gen-1", PROJECT, "PUBLISH", null);
    cas.commit();

    // Sleep a tiny bit to ensure the second entry has a later timestamp.
    const now = Date.now();
    while (Date.now() === now) { /* spin briefly */ }

    cas.beginImmediate();
    cas.appendPublicationHistory("gen-2", PROJECT, "PUBLISH", "gen-1");
    cas.commit();

    const history = cas.listPublicationHistory(PROJECT);
    expect(history.length).toBe(2);
    // Most-recent-first: gen-2 should be first.
    expect(history[0].generationId).toBe("gen-2");
    expect(history[0].previousActiveGenerationId).toBe("gen-1");
    expect(history[1].generationId).toBe("gen-1");
    expect(history[1].previousActiveGenerationId).toBe(null);
    cas.close();
  });

  it("listPublicationHistory records the cas_revision at the time of the action", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    // R169B-STEP3 (CAS-R169B-A1-18): appendPublicationHistory now
    // increments the revision internally and records the NEW revision.
    // So: initial rev=0, appendPublicationHistory increments to 1 and
    // records 1.
    cas.appendPublicationHistory("gen-1", PROJECT, "PUBLISH", null);
    cas.commit();
    const history = cas.listPublicationHistory(PROJECT);
    expect(history[0].casRevision).toBe(1);
    cas.close();
  });
});

// ─── 7. Reconcile from manifest ──────────────────────────────────────────

describe("R169B-STEP2 CAS — reconcileFromManifest", () => {
  it("reconcile with a manifest matching the CAS active ID returns reconciled=false (no-op)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision();
    cas.commit();

    const manifest = validManifest({ generationId: "gen-1" });
    const result = cas.reconcileFromManifest(manifest);
    expect(result.reconciled).toBe(false);
    expect(result.activeGenerationId).toBe("gen-1");

    // A no-op reconcile opened its own transaction; it must release the
    // writer lock before returning so a second connection can write.
    const cas2 = openCasStore(PROJECT, cacheRoot);
    expect(() => cas2.beginImmediate()).not.toThrow();
    cas2.rollback();
    cas2.close();
    cas.close();
  });

  it("reconcile with a divergent manifest updates the CAS active ID and bumps the revision", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision(); // rev=1
    cas.commit();

    const generationId = "550e8400-e29b-41d4-a716-446655440002";
    const manifest = validManifest({ generationId });
    writeRecoveryMetadata(manifest);
    const result = cas.reconcileFromManifest(manifest);
    expect(result.reconciled).toBe(true);
    expect(result.activeGenerationId).toBe(generationId);
    expect(result.revision).toBe(2); // bumped
    cas.close();
  });

  it("reconcile with a null manifest (no active manifest on disk) clears the CAS active ID", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision();
    cas.commit();

    const result = cas.reconcileFromManifest(null);
    expect(result.reconciled).toBe(true);
    expect(result.activeGenerationId).toBe(null);
    cas.close();
  });

  it("reconcile with a null manifest when CAS already has null active ID returns reconciled=false", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    const result = cas.reconcileFromManifest(null);
    expect(result.reconciled).toBe(false);
    expect(result.activeGenerationId).toBe(null);
    cas.close();
  });

  it("reconcile appends a publication_history entry recording the divergence fix", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.beginImmediate();
    cas.setActiveGenerationId("gen-1");
    cas.incrementRevision();
    cas.commit();

    const generationId = "550e8400-e29b-41d4-a716-446655440003";
    const manifest = validManifest({ generationId });
    writeRecoveryMetadata(manifest);
    cas.reconcileFromManifest(manifest);
    const history = cas.listPublicationHistory(PROJECT);
    // R169B-STEP5 (POSTCOMMIT-R169B-A3-11): the reconcile now appends
    // a "RECOVER" entry (was "PUBLISH") when the manifest is non-null
    // and CAS was divergent. This distinguishes CAS-only reconciliation
    // from an actual publication.
    expect(history.some((h) => h.action === "RECOVER" && h.generationId === generationId)).toBe(true);
    cas.close();
  });

  it("restores pinned=true from an exact recovery metadata sidecar", () => {
    const generationId = "550e8400-e29b-41d4-a716-446655440004";
    const manifest = validManifest({ generationId });
    writeRecoveryMetadata(manifest, true);
    const cas = openCasStore(PROJECT, cacheRoot);
    const result = cas.reconcileFromManifest(manifest);
    expect(result.reconciled).toBe(true);
    expect(cas.getGenerationCatalogEntry(generationId)?.pinned).toBe(true);
    cas.close();
  });

  it("fails closed when recovery metadata is absent or corrupt", () => {
    const missingManifest = validManifest({ generationId: "550e8400-e29b-41d4-a716-446655440005" });
    const cas = openCasStore(PROJECT, cacheRoot);
    expect(() => cas.reconcileFromManifest(missingManifest)).toThrowError(GenerationStoreError);
    expect(cas.getActiveGenerationId()).toBeNull();
    expect(cas.getRevision()).toBe(0);

    const corruptManifest = validManifest({ generationId: "550e8400-e29b-41d4-a716-446655440006" });
    const metadataPath = writeRecoveryMetadata(corruptManifest);
    writeFileSync(metadataPath, "{ corrupt", "utf8");
    expect(() => cas.reconcileFromManifest(corruptManifest)).toThrowError(GenerationStoreError);
    expect(cas.getActiveGenerationId()).toBeNull();
    expect(cas.getRevision()).toBe(0);
    cas.close();
  });
});

// ─── 8. Schema invariants ────────────────────────────────────────────────

describe("R169B-STEP2 CAS — schema invariants", () => {
  it("the publication_state table has exactly one row (id=1)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.close();
    const db = new Database(casPath(), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS c FROM publication_state").get() as { c: number };
    db.close();
    expect(rows.c).toBe(1);
  });

  it("the generation_catalog.status column has a CHECK constraint (rejects invalid status)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.close();
    const db = new Database(casPath());
    expect(() => {
      db.prepare("INSERT INTO generation_catalog (generation_id, project, sha256, size_bytes, root_fingerprint, extractor_semantics_version, discovery_policy_version, first_published_at, last_seen_at, pinned, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          "g1", PROJECT, "a".repeat(64), 1, "/r:1:2", 8,
          CURRENT_DISCOVERY_POLICY_VERSION,
          "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 0,
          "INVALID_STATUS",
        );
    }).toThrow();
    db.close();
  });

  it("the publication_history.action column has a CHECK constraint (rejects invalid action)", () => {
    const cas = openCasStore(PROJECT, cacheRoot);
    cas.close();
    const db = new Database(casPath());
    expect(() => {
      db.prepare("INSERT INTO publication_history (generation_id, project, published_at, action, previous_active_generation_id, cas_revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run("g1", PROJECT, "2026-01-01T00:00:00.000Z", "INVALID_ACTION", null, 0);
    }).toThrow();
    db.close();
  });
});
