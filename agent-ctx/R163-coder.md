# R163 — Atomic Refusal State + Success Predicate

**Task ID:** R163
**Branch:** `v2/r163-atomic-refusal-success-predicate` (from main, R162 merged at d7f4e44)
**Round:** 88 (GPT 5.6 Sol audit R162)
**Version bump:** 0.67.0 → 0.68.0
**Date:** 2026-07-12

## Summary

R163 closes the 5 confirmed code findings of the R162 audit (2 P1/P2 + 3 P2).
The R162 audit found that the root-change early-return path had a connection
lifecycle bug (DB reopen failure left stale=0 while API returned STALE), the
shared success predicate treated stale-without-error-text as a success (advancing
`last_successful_index_at`), the `hasExistingGraphData` check missed four of
six structural tables, the "no mutation" claim was inaccurate, and the early
return's `nodes=0`/`edges=0` were ambiguous between "graph empty" and "no new
work published".

## Findings fixed

| # | Code | Priority | File | Description |
|---|------|----------|------|-------------|
| 253 | STATE-R163-01 | P1/P2 | `indexer.ts` | Early returns did `db.close()` then `markProjectStalePreservingGraph()` (reopen). If reopen failed, `stalePersisted=false` was ignored → DB stayed stale=0 while API returned STALE. |
| 254 | STATE-R163-02 | P1/P2 | `schema.ts` | `succeeded = indexError === null` but `crossFileCallsStale` can be true with `indexError=null`. Stale-without-error advanced `last_successful_index_at` + cleared `last_index_error`. |
| 255 | ROOT-R163-02 | P2 | `indexer.ts` | `hasExistingGraphData` only checked `nodes` and `file_hashes`. Partial DB with edges/call_sites/imports/exports but no nodes/hashes wasn't detected. |
| 256 | COMP-R163-01 | P2 | `indexer.ts` | "No mutation" claim was too broad — `markProjectStalePreservingGraph` writes trust-state columns AND may `clearCrossFileCallEdges` on semantics mismatch. |
| 257 | API-R163-01 | P2 | `indexer.ts` | Early refusal returned `nodes=0, edges=0` despite preserved snapshot having thousands of nodes. |

## Changes

### `v2/src/indexer/indexer.ts`

1. **STATE-R163-01 (rootChanged early return)**: Replaced
   `db.close(); markProjectStalePreservingGraph(dbPath, ...)` with an
   inline `UPDATE projects SET cross_file_calls_stale=1,
   last_index_attempt_at=?, last_index_error=?` on the SAME connection,
   followed by `db.close()`. A `stalePersisted` flag is set in the
   try/catch; when `false`, the STALE return's `staleReason.message`
   gets a `[WARNING: stale flag could not be persisted to DB]` suffix.

2. **STATE-R163-01 (rootIdentityUnknown early return)**: Same fix —
   inline UPDATE before `db.close()`, no helper call.

3. **ROOT-R163-02**: Expanded `hasExistingGraphData` from a 2-table
   EXISTS check (`nodes`, `file_hashes`) to a 6-table check that also
   covers `edges`, `call_sites`, `imports`, `exports`. Any non-empty
   table triggers `hasExistingGraphData=true`.

4. **COMP-R163-01**: Added comments on both early returns distinguishing
   "trust-state mutations" (which DO happen: `cross_file_calls_stale`,
   `last_index_attempt_at`, `last_index_error`) from "structural graph
   mutations" (which do NOT: `nodes`, `edges`, `file_hashes`,
   `call_sites`, `imports`, `exports`, `root_path`, `root_fingerprint`).
   The semantics-mismatch edge clear is removed entirely (the inline
   UPDATE writes trust-state only — a root change is not a semantics
   mismatch).

5. **API-R163-01**: Added `preservedSnapshot?: boolean` field to
   `IndexResult`. Set to `true` on both root-change early returns.
   Documents that `nodes=0`/`edges=0` mean "no new work published",
   NOT "graph empty" — consumers should query the DB for actual counts.

### `v2/src/indexer/schema.ts`

6. **STATE-R163-02**: Changed `updateProjectStats()` predicate from
   `succeeded = indexError === null` to
   `succeeded = indexError === null && !crossFileCallsStale`. When
   `crossFileCallsStale=true`, the run is NOT a success —
   `last_successful_index_at` is preserved (the CASE WHEN clause passes
   NULL when `succeeded=false`).

### `v2/package.json`

7. Bumped version from `0.67.0` to `0.68.0`.

### `v2/CHANGELOG.md`

8. Added R163 entry (5 findings + 1 test-coverage entry, #253-#258).

### `docs/V2_CURRENT_STATE.md`

9. Updated "Updated R" header to R163 (2026-07-12). Added R163 section
   with full finding descriptions and a "Known limitations (R163,
   carried over)" section.

### `v2/tests/indexer/r163-atomic-refusal-success-predicate.test.ts` (NEW)

10. 12 tests covering:
    - `STATE-R163-01a`: root change stale persisted via SAME connection
    - `STATE-R163-01b`: root identity unknown stale persisted via SAME connection
    - `STATE-R163-02a`: stale run with `indexError=null` does NOT advance `last_successful_index_at`
    - `ROOT-R163-02a`: `hasExistingGraphData` detects partial DB with edges but no nodes
    - `API-R163-01a`: `preservedSnapshot=true` on root change early return
    - 7 source-inspection regression guards

### `v2/tests/indexer/r162-root-early-refusal.test.ts` (UPDATED)

11. Updated 4 R162 regression tests to reflect R163 changes:
    - `ROOT-R162-01c`: now deletes from all six structural tables (R163
      expanded `hasExistingGraphData` to check all six).
    - `regression: both early returns inline UPDATE before db.close()`:
      replaced the old `markProjectStalePreservingGraph + db.close()`
      guard with an inline UPDATE guard.
    - `regression: ROOT_CHANGED staleReason includes totalPaths=0 +
      pathsTruncated=false`: updated to match R163's
      `rootMsg + (stalePersisted ? '' : ' [WARNING: ...]')` message
      format.
    - `regression: package.json version is 0.68.0 (R163 bump)`.

### `v2/tests/indexer/r161-root-snapshot-identity.test.ts` (UPDATED)

12. Bumped version assertion from 0.67.0 to 0.68.0.

### `v2/tests/indexer/r160-full-orchestrator-failure-taxonomy.test.ts` (UPDATED)

13. Bumped version assertion from 0.67.0 to 0.68.0.

## Verification

| Step | Command | Result |
|------|---------|--------|
| Typecheck | `cd v2 && npx tsc -p tsconfig.json --noEmit` | PASS (no output) |
| Build | `cd v2 && npm run build` | PASS (clean exit, dist/ produced) |
| Tests | `cd v2 && npx vitest run` | PASS — 94 files, 939 tests, 0 failures |

## Files changed

- `v2/src/indexer/indexer.ts` (state fix + hasExistingGraphData expansion + preservedSnapshot + comments)
- `v2/src/indexer/schema.ts` (success predicate fix)
- `v2/package.json` (version bump)
- `v2/CHANGELOG.md` (R163 entry)
- `docs/V2_CURRENT_STATE.md` (R163 section)
- `v2/tests/indexer/r163-atomic-refusal-success-predicate.test.ts` (NEW — 12 tests)
- `v2/tests/indexer/r162-root-early-refusal.test.ts` (4 R162 tests updated for R163)
- `v2/tests/indexer/r161-root-snapshot-identity.test.ts` (version bump)
- `v2/tests/indexer/r160-full-orchestrator-failure-taxonomy.test.ts` (version bump)

## Known limitations (carried over)

- **No cross-process alias_history lock** (carryover): concurrent indexers
  on the same project could race on the alias_history table. Same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. Future round will add
  `GraphDbDialect` detection.
- **Stale-without-error still clears `last_index_error`** (new, R163):
  R163-02 prevents `last_successful_index_at` from advancing on a stale
  run with no error text, but `last_index_error = excluded.last_index_error`
  in the UPSERT still clears the prior error when `indexError=null` is
  passed. A future round may add a CASE WHEN to preserve the prior error
  text in this case.
