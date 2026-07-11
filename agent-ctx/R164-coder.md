# R164 — Coder Work Record

**Task ID:** R164
**Branch:** `v2/r164-verified-refusal-snapshot-contract` (from main, R163 merged at 9465fae)
**Round:** 89 (R163 audit)
**Version bump:** 0.68.0 → 0.69.0
**Date:** 2026-07-12

## Summary

Closed all 5 confirmed code findings of the R163 audit. The R163 round had
introduced the inline trust-state UPDATE pattern (replacing
`markProjectStalePreservingGraph`'s reopen) but left three issues in the
persist path (swallowed errors, unchecked `info.changes`, no CAS), one
issue in `updateProjectStats` (`last_index_error` cleared on stale runs
without error), and one API contract issue (`preservedSnapshot=true` was
misleading on a partial DB).

## Per-finding change log

### 258 — STATE-R164-01 (P1/P2): Catch block swallowed all errors

**File:** `v2/src/indexer/indexer.ts`
**Block:** `if (rootChanged) { ... }` (~line 1232) and
`if (rootIdentityUnknown) { ... }` (~line 1409)

R163's try/catch set `stalePersisted=false` on exception but the early
return still returned `outcome='STALE'`. R164 adds a `persistFailure` flag
set in the catch; when true, the return is `outcome='FAILED'` with
`failure.code='PERSIST_FAILURE'`, `failure.phase='root-refusal-state'`,
and `staleReason` carrying the root-change code (ROOT_CHANGED or
ROOT_IDENTITY_UNKNOWN) so consumers can still see the underlying cause.
The `preservedSnapshot=true` flag is also set on the FAILED return — the
early return did NOT mutate structural graph data.

### 259 — STATE-R164-02 (P1/P2): Unconditional `stalePersisted = true`

**File:** `v2/src/indexer/indexer.ts`
**Block:** Both root-change early returns

R163 set `stalePersisted = true` unconditionally after `.run()` returned,
ignoring `RunResult.changes`. R164 captures the RunResult and sets
`stalePersisted = info.changes === 1`:
- `ROOT_CHANGED`: when `info.changes === 0`, the CAS detected a concurrent
  update (see CONC-R164-01) — set `concurrentUpdate = true` (return STALE
  with note, NOT FAILED).
- `ROOT_IDENTITY_UNKNOWN`: when `info.changes === 0`, the projects row is
  gone OR a concurrent indexer populated `root_fingerprint` — set
  `persistFailure = true` (return FAILED/PERSIST_FAILURE). Stricter than
  ROOT_CHANGED because we can't distinguish "row missing" from "row
  updated by concurrent indexer" without an extra query, and a
  missing-row case means the projects metadata is incoherent with the
  structural graph data — a FAILED return is safer than a silent STALE.

### 260 — CONC-R164-01 (P1/P2): No CAS between read and UPDATE

**File:** `v2/src/indexer/indexer.ts`
**Block:** Both root-change early returns

R163 read `projectState.rootFingerprint` at the start of the run, then ran
the trust-state UPDATE later. Between the read and the UPDATE, another
indexer could `commitAliasStateAtomically` (publishing a fresh snapshot
under a new `root_fingerprint`). The stale UPDATE would then mark the
fresh snapshot as stale.

R164 adds a CAS WHERE condition:
- `ROOT_CHANGED`: `WHERE name = ? AND root_fingerprint = ?` (the expected
  fingerprint is `publishedRootFingerprint`).
- `ROOT_IDENTITY_UNKNOWN`: `WHERE name = ? AND root_fingerprint IS NULL`.

For ROOT_CHANGED, when `info.changes === 0` (concurrent update detected),
the STALE return's `staleReason.message` gets a
`[WARNING: concurrent update — another indexer changed root_fingerprint
between read and write; new snapshot not marked stale]` suffix so
consumers can detect this. The (possibly fresh) snapshot is NOT marked
stale — the CAS UPDATE was a no-op.

The CAS pattern mirrors the one used by `commitAliasStateAtomically`
(R155) for alias_history writes (`last_observed_run_id` CAS). R164
extends the pattern to the trust-state UPDATE.

### 261 — STATE-R164-03 (P2): `last_index_error` cleared on stale runs

**File:** `v2/src/indexer/schema.ts`
**Function:** `updateProjectStats()`

R163-02 prevented `last_successful_index_at` from advancing on a stale
run with no error text (`succeeded = indexError === null && !crossFileCallsStale`).
But the UPSERT's `last_index_error = excluded.last_index_error` still
CLEARED the prior error when `indexError=null` was passed (the
deletion-only path's "previously stale" no-error scenario).

R164 changes the clause to a CASE WHEN:
```sql
last_index_error = CASE
  WHEN excluded.cross_file_calls_stale = 1 AND excluded.last_index_error IS NULL
  THEN last_index_error
  ELSE excluded.last_index_error
END,
```
When the run is stale (`excluded.cross_file_calls_stale=1`) AND the new
error is NULL, preserve the prior `last_index_error`. Otherwise (success,
or stale with a new error message), use the new value.

The success path (`commitAliasStateAtomically`) still uses the
unconditional `last_index_error = excluded.last_index_error` — R164 only
changed `updateProjectStats` (the stale/failed path). This is correct
because on success we ALWAYS want to clear the prior error.

### 262 — API-R164-01 (P1/P2): `preservedSnapshot` misleading on partial DB

**File:** `v2/src/indexer/indexer.ts`
**Interface:** `IndexResult`

R163 added `preservedSnapshot=true` to signal that a previous snapshot
exists in the DB. But on a partial DB (e.g., an interrupted full index
after `clearProjectData` deleted `nodes` and `file_hashes` but before
deleting `edges`), `preservedSnapshot=true` is misleading — there's no
coherent published snapshot to query.

R164 adds a new `publishedSnapshotPreserved?: boolean` field to
`IndexResult`:
- `preservedSnapshot=true` — structural data exists (nodes, edges,
  file_hashes, call_sites, imports, OR exports) and was not modified by
  the early return. Does NOT guarantee a coherent published snapshot.
- `publishedSnapshotPreserved=true` — the DB contains a complete, coherent
  snapshot from a previous successful run (nodes AND file_hashes AND
  projects row).

`hasPublishedSnapshot` is computed in both early returns via:
```ts
const hasPublishedSnapshot = projectState !== undefined
  && (db.prepare('SELECT EXISTS(SELECT 1 FROM nodes WHERE project = ? LIMIT 1) AS e').get(opts.project) as { e: number }).e === 1
  && (db.prepare('SELECT EXISTS(SELECT 1 FROM file_hashes WHERE project = ? LIMIT 1) AS e').get(opts.project) as { e: number }).e === 1;
```

Both flags are set on both root-change early returns (STALE and FAILED).
A partial DB with edges but no nodes/hashes has `preservedSnapshot=true`
(structural data exists) but `publishedSnapshotPreserved=false` (no
coherent snapshot).

## Tests

Created `v2/tests/indexer/r164-verified-refusal.test.ts` with 16 tests:

**Behavioral (9):**
1. `STATE-R164-01/02a`: root change stale persists via same connection
   (DB stale=1, info.changes=1, no failure field, publishedSnapshotPreserved=true)
2. `CONC-R164-01a`: CAS UPDATE returns info.changes=0 when root_fingerprint
   changed between read and write (direct SQL test of the CAS contract)
3. `CONC-R164-01b`: CAS UPDATE returns info.changes=1 when fingerprint
   UNCHANGED (counter-test for the normal single-process case)
4. `STATE-R164-01/02b + CONC-R164-01c`: root identity unknown with no
   projects row → FAILED/PERSIST_FAILURE (info.changes=0 → FAILED,
   preservedSnapshot=true, publishedSnapshotPreserved=false)
5. `STATE-R164-03a`: last_index_error preserved on stale run with
   indexError=null (direct updateProjectStats call — verifies an arbitrary
   prior error is preserved)
6. `STATE-R164-03a-end-to-end`: deletion-only stale-without-error run does
   NOT clear last_index_error (verifies the premark's 'Index publication
   in progress' is preserved by the CASE WHEN)
7. `STATE-R164-03b`: last_index_error is CLEARED on success (counter-test
   — the CASE WHEN does not over-preserve)
8. `API-R164-01a`: publishedSnapshotPreserved=false on partial DB
   (edges-only, no nodes/hashes) but preservedSnapshot=true
9. `API-R164-01b`: publishedSnapshotPreserved=true on coherent DB
   (nodes + hashes + projects row)

**Source-inspection (6):**
1. `regression (STATE-R164-01)`: ROOT_CHANGED block returns
   FAILED/PERSIST_FAILURE on persist exception
2. `regression (STATE-R164-02)`: ROOT_CHANGED block checks
   `info.changes === 1`
3. `regression (CONC-R164-01)`: ROOT_CHANGED CAS WHERE clause includes
   `root_fingerprint = ?` and the concurrentUpdate flag + nested ternary
   message
4. `regression (STATE-R164-01/02 + CONC-R164-01)`: ROOT_IDENTITY_UNKNOWN
   block uses CAS WHERE `root_fingerprint IS NULL` and returns FAILED on
   `info.changes=0`
5. `regression (STATE-R164-03)`: updateProjectStats uses CASE WHEN for
   last_index_error preservation (and commitAliasStateAtomically still
   uses unconditional)
6. `regression (API-R164-01)`: publishedSnapshotPreserved field on
   IndexResult + hasPublishedSnapshot computed in both early returns

**Version-bump (1):**
- `regression: package.json version is 0.69.0`

## Updated prior-round tests

- `v2/tests/indexer/r160-full-orchestrator-failure-taxonomy.test.ts`:
  version-bump assertion 0.68.0 → 0.69.0 (test name updated to R164 override)
- `v2/tests/indexer/r161-root-snapshot-identity.test.ts`:
  version-bump assertion 0.68.0 → 0.69.0 (test name updated to R164 override)
- `v2/tests/indexer/r162-root-early-refusal.test.ts`:
  - version-bump assertion 0.68.0 → 0.69.0 (test name updated to R164 bump)
  - `ROOT_CHANGED staleReason` source-inspection test: updated to reflect
    the new nested-ternary message pattern (concurrent update vs persist
    failure). The old assertion checked for the exact string
    `"rootMsg + (stalePersisted ? '' : ' [WARNING: stale flag could not be persisted to DB]')"`
    which no longer matches R164's nested ternary. The new assertions
    check for both warning suffixes independently:
    `' [WARNING: stale flag could not be persisted to DB]'` (persist-failure
    branch) and
    `' [WARNING: concurrent update — another indexer changed root_fingerprint between read and write; new snapshot not marked stale]'`
    (concurrent-update branch).
- `v2/tests/indexer/r163-atomic-refusal-success-predicate.test.ts`:
  version-bump assertion 0.68.0 → 0.69.0

## Documentation

- `v2/CHANGELOG.md`: Added R164 entry (findings 258–262, 5 sections)
- `v2/package.json`: 0.68.0 → 0.69.0
- `docs/V2_CURRENT_STATE.md`:
  - Header updated to R164
  - New R164 section (5 findings + known limitations)
  - R163's "Stale-without-error still clears `last_index_error`"
    limitation marked CLOSED in R164
  - Validation date updated to R164

## Verification

| Step | Command | Result |
|------|---------|--------|
| Typecheck | `cd v2 && npx tsc -p tsconfig.json --noEmit` | PASS (no output) |
| Build | `cd v2 && npm run build` | PASS (clean exit, dist/ produced) |
| Tests | `cd v2 && npx vitest run` | PASS — 95 files, 955 tests, 0 failures |

## Design decisions

### Why ROOT_IDENTITY_UNKNOWN is stricter than ROOT_CHANGED on `info.changes === 0`

The task spec treated both early returns symmetrically: `info.changes === 0`
→ FAILED/PERSIST_FAILURE. But for ROOT_CHANGED, the task ALSO said:
> If `info.changes === 0`, it means another indexer changed the state
> between our read and write. In this case, return STALE with a
> CONCURRENT_UPDATE message rather than FAILED (the other indexer may
> have published successfully)

These two instructions conflict for ROOT_CHANGED. R164 resolves the
conflict by treating them differently:

- **ROOT_CHANGED** (`WHERE name = ? AND root_fingerprint = ?`): when
  `info.changes === 0`, the fingerprint changed between read and write.
  This is unambiguously a concurrent update (the projects row still
  exists — only the fingerprint changed). The other indexer may have
  published successfully, so returning FAILED would be misleading.
  Return STALE with a CONCURRENT_UPDATE note instead.

- **ROOT_IDENTITY_UNKNOWN** (`WHERE name = ? AND root_fingerprint IS NULL`):
  when `info.changes === 0`, EITHER the projects row is gone (no metadata
  despite structural data — partial DB) OR another indexer populated
  `root_fingerprint` (concurrent publish). We can't distinguish these
  without an extra query. A missing-row case means the projects metadata
  is incoherent with the structural graph data — a FAILED return is
  safer than a silent STALE. R164 treats both as PERSIST_FAILURE.

This asymmetry is documented in the code comments on both early returns.

### Why the CONC-R164-01 test uses a direct SQL test instead of end-to-end

Testing the CAS end-to-end requires injecting a DB change BETWEEN the
indexer's read and its UPDATE (which run synchronously in the same
function call). That's not feasible in a single-process vitest without
monkey-patching `better-sqlite3`. Instead, the test verifies the CAS SQL
contract directly: prepare the DB state, simulate the concurrent
fingerprint change, then run the EXACT CAS UPDATE statement the indexer
uses (same SQL, same parameters) and verify `info.changes === 0`. This
proves the CAS pattern detects the concurrent update — the indexer's
code path uses this exact statement. The source-inspection test then
verifies the CAS WHERE clause is present in the indexer source.

### Why STATE-R164-03a uses a direct `updateProjectStats` call

The end-to-end deletion-only path's `updateProjectStats` call is
preceded by a premark UPSERT that overwrites `last_index_error` with
'Index publication in progress'. So an end-to-end test can only verify
the premark value is preserved, not an arbitrary prior error. The direct
test calls `updateProjectStats` with a known prior error and verifies
it's preserved — this is the cleanest way to test the CASE WHEN. An
end-to-end variant (`STATE-R164-03a-end-to-end`) is also included to
verify the premark value is preserved (not cleared to NULL) by the
subsequent `updateProjectStats` call.

## Known limitations introduced

- **ROOT_CHANGED concurrent update is detected but not retried** (new, R164):
  when `info.changes === 0` on the ROOT_CHANGED CAS, the early return
  gives up and returns STALE with a CONCURRENT_UPDATE note. A future round
  may re-read `projectState` and retry the CAS once, or fall through to
  the no-op path (which would then detect the fresh publication and
  short-circuit). The current behavior is conservative: the caller sees
  STALE + the warning, and can retry.

## Carryover limitations (unchanged)

- No cross-process alias_history lock.
- Full publication non-atomic (P1).
- DB dialect divergence (P1).
- ~~Stale-without-error still clears `last_index_error`~~ — CLOSED in R164.
