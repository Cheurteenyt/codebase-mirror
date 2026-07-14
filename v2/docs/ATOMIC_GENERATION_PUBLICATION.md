# Atomic Generation Publication — R169B Design Doc

**Status:** FOUNDATION / INACTIVE  
**Version:** 0.75.0  
**Semantics:** 8  
**Discovery:** 2  
**Manifest:** 1  
**Last updated:** 2026-07-14 (R169B-STEP10)

## 1. Overview

The Atomic Generation Publication system (R169A + R169B) provides a
crash-safe, concurrency-safe, content-addressed storage layer for
codebase indexer generations. A "generation" is a complete snapshot of
the indexer's output (SQLite DB + metadata sidecar), identified by a
UUID v4 and pinned by a SHA-256 content hash.

The system guarantees:

1. **Atomicity** — a generation is either fully visible (DB + metadata +
   manifest + CAS entry) or not visible at all. No partial state is
   observable by readers.
2. **Durability** — once a publication returns success, the data is
   fsync'd to disk and survives a crash.
3. **Immutability** — a published generation's DB file is a copy
   (separate inode) from the staging DB. Mutating the staging DB after
   publication does NOT affect the published DB.
4. **Concurrency safety** — concurrent publishers are serialized by a
   SQLite CAS (compare-and-swap) lock. Exactly one wins; losers get
   `PUBLICATION_CAS_MISMATCH`.
5. **GC safety** — the GC never deletes the active generation. Deletion
   happens under the CAS lock with a proof re-verification (B3).

## 2. Pipeline

The publication pipeline has four phases:

```
reserve → populate → prepare → publish
```

### 2.1 Reserve

`reserveGenerationStaging(project, options)` creates an empty staging DB
file at `<projectStore>/tmp/generation-<uuid>.db` with mode 0600. The
UUID is fresh (crypto.randomUUID). The staging path is validated for
containment (must be inside `tmp/`) and no-symlink. The reservation is
returned as a `GenerationStagingReservation` handle.

### 2.2 Populate

The caller (indexer) opens the staging DB via better-sqlite3 and
populates it with nodes, edges, file_hashes, etc. using
`initIndexerSchema`. The caller then closes the DB.

### 2.3 Prepare

`prepareGenerationForPublication(reservation)`:

1. Re-validates the trust root (no symlinks in the path chain).
2. Opens the staging DB read-only and verifies the schema (required
   tables exist).
3. Computes the SHA-256 of the staging DB (streaming, 64 KiB chunks).
4. Captures the staging file identity (dev/ino/size) via `fstat(fd)`.
5. Builds the manifest (formatVersion, project, generationId, dbFile,
   createdAt, rootFingerprint, extractorSemanticsVersion,
   discoveryPolicyVersion, nodeCount, edgeCount, fileCount, sizeBytes,
   sha256).
6. Issues a `PreparedToken` (private WeakMap) that authenticates the
   `PreparedGeneration` handle. The token is single-use:
   `PREPARED → PUBLISHING → CONSUMED` (or `DISCARDED`).
7. Returns the `PreparedGeneration` handle.

### 2.4 Publish

`publishPreparedGeneration(prepared, options, storeOptions)`:

1. Validates the token (WeakMap lookup). Rejects forged handles.
2. Checks the token state machine (`PREPARED` → `PUBLISHING`).
3. Validates `options.expectedActiveGenerationId` (REQUIRED — pass
   `null` for first publication, or the current active generation ID
   for an optimistic-lock guard).
4. Re-validates the staging DB (lstat + fstat identity check — detects
   mutation since prepare).
5. **Dedup check**: if an ACTIVE catalog entry has the same sha256 +
   size + rootFingerprint + versions, the publication dedups against
   it (no copy, just metadata + CAS update).
6. **Temp-file promotion** (non-dedup path):
   a. Open staging source `O_RDONLY|O_NOFOLLOW`, fstat and compare to
      `token.preStat`.
   b. Create temp `O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW`, mode 0600, in
      `generations/.publish-<uuid>-<nonce>.db`.
   c. Capture temp identity IMMEDIATELY via `fstat(tempFd)`.
   d. fd-based copy+hash (single pass): read(sourceFd) →
      hasher.update() → writeAll(tempFd).
   e. `fsync(tempFd)` — failure BLOCKS promotion
      (`GENERATION_PROMOTION_DURABILITY_UNKNOWN`).
   f. `closeSync(tempFd)`.
   g. `lstat(tempPath)` — verify identity matches temp identity.
   h. `linkSync(tempPath, finalPath)` — no-clobber (EEXIST →
      `GENERATION_PROMOTION_CONFLICT`).
   i. Verify final dev/ino == temp dev/ino.
   j. `fsync(generations/)` — makes the dir entry durable.
   k. Authenticated cleanup: unlink temp (only if dev/ino/size match).
   l. `fsync(generations/)` again.
7. Write metadata sidecar (`generation-<uuid>.json`) atomically.
8. Write active manifest (`active-manifest.json`) atomically.
9. **Post-verify** (strict): re-read the manifest, metadata, and DB;
   verify hash, identity, metadata schema, manifest exact match.
10. Open CAS, `BEGIN IMMEDIATE`:
    a. Reconcile from manifest (CAS active ← manifest active).
    b. CAS compare-and-swap: `expectedActive == casActive`?
       - No → `PUBLICATION_CAS_MISMATCH`, rollback, token reverts to
         `PREPARED` (if no visible mutation).
    c. Upsert catalog entry (status=ACTIVE).
    d. `setActiveGenerationId(generationId)`.
    e. `appendPublicationHistory(PUBLISH)`.
    f. `COMMIT`.
11. Token → `CONSUMED`.
12. Return `PublicationResult`.

## 3. CAS Catalog Model

The CAS (compare-and-swap) store is a SQLite DB at
`<projectStore>/publication-cas.sqlite` with mode 0600. It contains:

- `publication_state` — singleton row with `active_generation_id` and
  `revision` (incremented on every mutation).
- `generation_catalog` — one row per generation UUID, with sha256,
  sizeBytes, rootFingerprint, versions, pinned, status
  (ACTIVE|DELETING|DELETED).
- `publication_history` — append-only log of PUBLISH, UNPUBLISH,
  DELETE, PIN, UNPIN, MARK_DELETING, RECOVER actions.

The CAS serializes writers via `BEGIN IMMEDIATE` (SQLite busy timeout
0 — immediate SQLITE_BUSY on contention). This ensures exactly one
publisher can mutate the CAS at a time.

## 4. GC Model A

The GC (Garbage Collector) uses Model A: the CAS lock is held during
the ENTIRE deletion. This prevents the race where a generation becomes
active between the GC's safety check and the actual deletion.

`deleteGenerationUnderCasLock`:

1. `BEGIN IMMEDIATE`.
2. Re-read `casActive` under the lock. If `generationId == casActive`,
   refuse (race prevented).
3. Verify catalog entry exists, is not pinned, status is ACTIVE.
4. Mark `DELETING` + append history.
5. **B3 proof under lock**: re-lstat DB and metadata, verify regular
   non-symlink, recompute DB sha256, compare to catalog. If mismatch,
   rollback and refuse.
6. Delete DB + metadata + fsync `generations/`.
7. Confirm both files absent (ENOENT).
8. `fsync(generations/)` again.
9. Mark `DELETED` + append history.
10. `COMMIT`.

## 5. Orphan Recovery (B1)

`planGenerationOrphanRecovery` scans `generations/` for orphans:

- `PROMOTION_TEMP` — `.publish-<uuid>-<nonce>.db` files left by
  failed publications. Safe to delete.
- `NOT_IN_CATALOG` — `generation-<uuid>.db` with no catalog entry.
  Retained (grace period).
- `DB_ONLY` — DB exists, metadata missing, UUID IS in catalog.
  Retained (grace period).
- `METADATA_ONLY` — metadata exists, DB missing. Retained (grace
  period).
- `ACTIVE_NOT_IN_CATALOG` — active manifest points at a generation
  not in the CAS catalog. Triggers CAS recovery (B2).

`applyGenerationOrphanRecovery`:

- Deletes `PROMOTION_TEMP` orphans.
- Retains `NOT_IN_CATALOG`, `DB_ONLY`, `METADATA_ONLY` (grace period).
- For `ACTIVE_NOT_IN_CATALOG`, runs CAS recovery (B2).

## 6. CAS Recovery Disk-Aware (B2)

When the active manifest points at a generation NOT in the CAS catalog
(crash between manifest write and CAS commit), the recovery:

1. Verifies the DB exists and is a regular non-symlink file.
2. Verifies the metadata exists and is a regular non-symlink file.
3. Parses + validates the metadata (strict V1 schema).
4. Recomputes the DB sha256 and compares to the metadata's manifest
   sha256.
5. Only if ALL checks pass: rebuilds the catalog entry, sets active,
   appends RECOVER history, commits.

If any check fails, the orphan is retained (not recovered).

## 7. Crash Safety Invariants

### 7.1 fsync(tempFd) failure blocks promotion

If `fsync(tempFd)` fails (EIO, EDQUOT, ENOSPC), the temp bytes may not
be durable. The promotion is BLOCKED: temp is cleaned up, no final DB
is created, no manifest is written, the token reverts to PREPARED.

### 7.2 link(temp, final) failure is recoverable

If `linkSync(tempPath, finalPath)` fails:
- `EEXIST` → another publisher won the race to the same finalPath
  (`GENERATION_PROMOTION_CONFLICT`). Token reverts to PREPARED.
- Other errors → `GENERATION_PROMOTION_FAILED`. Temp is cleaned up.

### 7.3 fsync(generations/) failure blocks manifest

If `fsync(generations/)` fails after link, the link may not be durable.
The promotion is BLOCKED: temp is cleaned up, no manifest is written
(`GENERATION_PROMOTION_DURABILITY_UNKNOWN`).

### 7.4 Token state machine

```
PREPARED → PUBLISHING → CONSUMED (success)
                    ↘ PREPARED (no-mutation failure)
                    ↘ CONSUMED (mutation failure — staging removed, etc.)
PREPARED → DISCARDED (discard)
```

The token reverts to PREPARED only if NO visible mutation happened
(staging not removed, final DB not created, metadata not created,
manifest not visible, CAS not committed).

### 7.5 CAS_MISMATCH is strict

Under concurrent publication, the loser ALWAYS gets
`PUBLICATION_CAS_MISMATCH` (never `PUBLICATION_CAS_BUSY`, never
`GENERATION_PROMOTION_CONFLICT`). This is validated across 50
iterations in the concurrency barrier test (C1).

## 8. Test Coverage

- `r169b-generation-publisher.test.ts` — 55 tests (happy path, validation).
- `r169b-publication-crash.test.ts` — 31 tests (crash matrix, immutability,
  GC recovery, safety hash, tmp identity, MANIFEST_NOT_FOUND).
- `r169b-publication-concurrency.test.ts` — 4 tests (multi-process race).
- `r169b-concurrency-barrier.test.ts` — 5 tests (50-iteration barrier, C1).
- `r169b-publisher-gc-race.test.ts` — 5 tests (publisher/GC race, C2).
- `r169b-crash-harness.test.ts` — 7 tests (fault injection + child crash, C3).
- `r169b-bloc-b-tests.test.ts` — 21 tests (B1-B4 dedicated, B1+B2+B3+B4).
- `r169b-generation-cas.test.ts` — 30 tests (CAS store).
- `r169b-generation-gc.test.ts` — 22 tests (GC planner + applier).
- `r169b-module-split.test.ts` — 48 tests (module structure).

Total: 228 R169B-specific tests.

## 9. Module Structure

```
src/storage/
├── generation-types.ts          # Types, error codes, PublisherOps interface
├── generation-paths.ts          # Path derivation (no I/O)
├── generation-validation.ts     # Manifest/metadata validation
├── generation-publisher.ts      # reserve, prepare, publish, discard
├── generation-gc.ts             # plan, apply, orphan recovery
├── generation-store.ts          # Public facade (R169A)
└── internal/
    ├── generation-cas-store.ts       # CAS store (SQLite)
    ├── generation-store-io.ts        # PROD_OPS, atomic JSON write
    ├── generation-publisher-ops.ts   # PublisherOps + createFaultablePublisherOps
    └── generation-layout-io.ts       # ensureDirDurable (B4 leaf)
```

Dependency direction: `types → paths/validation → internal I/O + CAS + publisher ops → facades`. No cycles.

## 10. Performance

The publication pipeline is dominated by:
1. SHA-256 hash of the staging DB (streaming, 64 KiB chunks).
2. fd-based copy (read → write, 64 KiB chunks).
3. fsync(tempFd) + fsync(generations/).

For a typical 10 MB staging DB, publication takes ~50-100 ms on SSD
(hash ~20 ms, copy ~10 ms, fsync ~20 ms × 2). The CAS transaction adds
~5 ms. Total: ~80-130 ms per publication.

The publication benchmark (`scripts/publication-benchmark-r169b.ts`)
validates these numbers on every CI run.
